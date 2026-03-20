/**
 * Claude Agent SDK Adapter
 *
 * Executes tasks using the @anthropic-ai/claude-agent-sdk.
 * Runs in-process with zero serialization overhead.
 * Supports mid-execution steering via Query.streamInput().
 */

import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Resolve the path to the Claude Code executable.
 *
 * Prefers the globally installed `claude` binary (via `which claude`) over the
 * SDK-bundled `cli.js`.  This is more robust on remote machines where the SDK's
 * `cli.js` may be missing from `node_modules`, and it ensures we always use the
 * same Claude Code version the operator installed.
 *
 * Returns `undefined` to let the SDK fall back to its built-in resolution if
 * the global binary cannot be located.
 */
function resolveClaudeExecutable(): string | undefined {
  try {
    const which = execSync('which claude', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (which) {
      console.log(`[claude-sdk] Using global Claude Code binary: ${which}`);
      return which;
    }
  } catch {
    // `which` failed — claude not on PATH
  }
  console.log('[claude-sdk] Global claude binary not found, falling back to SDK bundled cli.js');
  return undefined;
}

/** Cached result of resolveClaudeExecutable() — computed once at module load. */
const claudeExecutablePath = resolveClaudeExecutable();
import type { Task, TaskResult, TaskArtifact, ExecutionSummary, HpcCapability } from '../types.js';
import { writeImagesToDir, cleanupImages } from '../lib/image-utils.js';
import { type ProviderAdapter, type NormalizedTask, type TaskOutputStream, type ProviderStatus, SUMMARY_PROMPT, SUMMARY_TIMEOUT_MS, parseSummaryResponse, getAugmentedPath } from './base-adapter.js';
import { buildHpcContext, type HpcContext } from '../lib/hpc-context.js';
import type { SlurmJobMonitor } from '../lib/slurm-job-monitor.js';
import { config } from '../lib/config.js';

/** Shell execution tools whose output may contain real sbatch submissions */
const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'execute_command', 'terminal']);

/**
 * Determine whether to enable sandbox mode for Claude Code.
 *
 * - If config.sandbox is explicitly set, use that value.
 * - Otherwise, auto-detect: enable for standard 'claude-*' models,
 *   skip for Bedrock/custom models (which crash with non-undefined sandbox).
 *
 * Returns an object to spread into options (empty object means don't set sandbox).
 */
function getSandboxOption(model: string | undefined): { sandbox?: { enabled: boolean } } {
  const configSandbox = config.getSandbox();

  // Explicit config override
  if (configSandbox !== undefined) {
    return { sandbox: { enabled: configSandbox } };
  }

  // Auto-detect: skip sandbox for custom/Bedrock models
  // Bedrock models typically use formats like "anthropic.claude-3-sonnet" or contain ':'
  const isCustomModel = model && (
    !model.startsWith('claude-') ||
    model.includes(':') ||
    model.includes('.')
  );

  if (isCustomModel) {
    return {}; // Don't pass sandbox option at all (undefined behavior for Bedrock)
  }

  // Standard Claude model — enable sandbox
  return { sandbox: { enabled: true } };
}

/** Active query state for a running task */
interface ActiveQuery {
  query: Query | null;  // null after completion (session preserved for resume)
  sessionId: string;
  workingDirectory?: string;
  /** Original project directory (before worktree), for fallback when worktree is cleaned up */
  originalWorkingDirectory?: string;
}

/** How long to preserve completed session state for potential steering (ms) */
const SESSION_PRESERVE_MS = 10 * 60 * 1000; // 10 minutes


export class ClaudeSdkAdapter implements ProviderAdapter {
  readonly type = 'claude-sdk';
  readonly name = 'Claude Agent SDK';

  private activeTasks = 0;
  private maxTasks = 4; // SDK supports concurrent tasks
  private lastError?: string;
  private isAuthenticated = false;
  private model = 'unknown';

  /** Active Query instances per task ID for steering */
  private activeQueries = new Map<string, ActiveQuery>();

  /** Lazily-initialized HPC context (undefined = not checked, null = not available) */
  private hpcContext: HpcContext | null | undefined = undefined;

  /** Pre-classified HPC capability from startup detection (avoids re-scanning) */
  private hpcCapability: HpcCapability | null;

  /** Optional Slurm job monitor for tracking sbatch submissions */
  private jobMonitor?: SlurmJobMonitor;

  /**
   * @param hpcCapability Pre-classified HPC info from provider detection at startup.
   *   null = machine is known to not have HPC. undefined = not provided (will auto-detect once).
   */
  constructor(hpcCapability?: HpcCapability | null) {
    this.hpcCapability = hpcCapability ?? null;
    // If we know at construction time there's no HPC, mark context as resolved
    if (hpcCapability === null || hpcCapability === undefined) {
      // No HPC capability declared — skip lazy detection entirely
      this.hpcContext = null;
    }
    // else: hpcCapability is truthy → will build context lazily using pre-classified info
  }

  /**
   * Set a SlurmJobMonitor for tracking batch job submissions.
   * Call this before executing tasks if HPC support is desired.
   */
  setJobMonitor(monitor: SlurmJobMonitor): void {
    this.jobMonitor = monitor;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const abortController = new AbortController();

      // Minimal prompt to check authentication.
      // Pass env and executable path so Bedrock/Vertex/third-party auth works.
      const gen = query({
        prompt: 'respond with ok',
        options: {
          abortController,
          maxTurns: 1,
          permissionMode: 'plan',
          tools: [],
          persistSession: true,
          ...(claudeExecutablePath ? { pathToClaudeCodeExecutable: claudeExecutablePath } : {}),
          env: { ...process.env },
        },
      });

      for await (const msg of gen) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.model = msg.model;
          this.isAuthenticated = true;
          abortController.abort();
          break;
        }
        if (msg.type === 'result') {
          this.isAuthenticated = true;
          break;
        }
      }

      return this.isAuthenticated;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.lastError = message;
      return false;
    }
  }

  async execute(task: NormalizedTask, stream: TaskOutputStream, signal: AbortSignal): Promise<TaskResult> {
    this.activeTasks++;
    const startedAt = new Date().toISOString();

    // Create an abort controller that respects the signal
    const abortController = new AbortController();
    const abortHandler = () => abortController.abort();
    signal.addEventListener('abort', abortHandler);

    try {
      stream.status('running', 0, 'Starting Claude Agent SDK');

      const result = await this.runQuery(task, stream, abortController);

      // Generate structured summary for execution tasks via a follow-up turn.
      // This resumes the same session, so the agent has full context of what it just did.
      // The summary uses structured output (json_schema) for guaranteed valid JSON.
      let summary: ExecutionSummary | undefined;
      const isExecutionTask = !task.type || task.type === 'execution';
      if (isExecutionTask && result.success) {
        try {
          stream.status('running', 80, 'Generating summary');
          summary = await this.generateSummary(task.id, task.workingDirectory);
          if (summary) {
            console.log(`[claude-sdk] Task ${task.id}: summary generated — status=${summary.status}, executiveSummary=${summary.executiveSummary ? `${summary.executiveSummary.length} chars` : 'MISSING'}, keyFindings=${summary.keyFindings?.length ?? 0}`);
          } else {
            console.warn(`[claude-sdk] Task ${task.id}: summary generation returned undefined`);
          }
        } catch (summaryError) {
          // Non-fatal — task result is still valid without summary
          console.warn(`[claude-sdk] Task ${task.id}: summary generation failed:`, summaryError);
        }
      } else {
        console.log(`[claude-sdk] Task ${task.id}: skipping summary — isExecutionTask=${isExecutionTask}, success=${result.success}, type=${task.type ?? 'undefined'}`);
      }

      return {
        taskId: task.id,
        status: result.success ? 'completed' : 'failed',
        exitCode: result.success ? 0 : 1,
        output: result.output,
        error: result.error,
        startedAt,
        completedAt: new Date().toISOString(),
        artifacts: result.artifacts,
        metrics: result.metrics,
        summary,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;

      const isAbort = error instanceof Error && error.name === 'AbortError';

      if (signal.aborted || isAbort) {
        return {
          taskId: task.id,
          status: 'cancelled',
          error: 'Task cancelled',
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }

      return {
        taskId: task.id,
        status: 'failed',
        error: errorMsg,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } finally {
      signal.removeEventListener('abort', abortHandler);

      // Clean up temp image files (runs even on abort/error)
      const imageCleanupPaths = (task as Task & { _imageCleanupPaths?: string[] })._imageCleanupPaths;
      if (imageCleanupPaths?.length) {
        cleanupImages(imageCleanupPaths).catch(() => {});
      }

      // Preserve session state for post-completion steering (mirrors server-side behavior).
      // The query generator is exhausted, but the sessionId is kept so `injectMessage()`
      // can still succeed on the SDK side and a `resumeTask()` could be implemented later.
      const existing = this.activeQueries.get(task.id);
      if (existing) {
        this.activeQueries.set(task.id, {
          query: null,
          sessionId: existing.sessionId,
          workingDirectory: task.workingDirectory,
        });
        // Auto-cleanup after a timeout to prevent memory leaks
        setTimeout(() => {
          const entry = this.activeQueries.get(task.id);
          if (entry && entry.query === null) {
            this.activeQueries.delete(task.id);
          }
        }, SESSION_PRESERVE_MS);
      }
      this.activeTasks--;
    }
  }

  /**
   * Inject a steering message into a running task's session.
   * Uses Query.streamInput() to feed a new user message into the running query.
   * When interrupt=true, calls Query.interrupt() first to stop the current turn.
   * Returns true if the message was successfully injected.
   */
  async injectMessage(taskId: string, content: string, interrupt = false): Promise<boolean> {
    const active = this.activeQueries.get(taskId);
    if (!active) return false;

    // Session completed — query is null but sessionId is preserved.
    // Cannot inject into a completed session; caller should use resume instead.
    if (!active.query) {
      console.log(`[claude-sdk] Cannot inject into completed session for task ${taskId} (sessionId: ${active.sessionId})`);
      return false;
    }

    if (interrupt) {
      // Fire interrupt without awaiting — interrupt() may block until the
      // current turn finishes, which can take a long time.  We don't need
      // to wait for it; the SDK will process the interrupt and streamInput
      // in order internally.
      active.query.interrupt().catch(() => {
        /* agent may be idle between turns */
      });

      // Small delay to let the interrupt signal propagate before injecting
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Create a single-message async iterable with proper SDKUserMessage shape
    const message = {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content,
      },
      parent_tool_use_id: null,
      session_id: active.sessionId,
    };

    // Single-shot async iterable
    const iterable = {
      async *[Symbol.asyncIterator]() {
        yield message;
      },
    };

    // streamInput returns a Promise — fire and forget
    active.query.streamInput(iterable).catch((err: Error) => {
      console.error(`[claude-sdk] Failed to inject steer message for task ${taskId}:`, err.message);
    });

    return true;
  }

  /**
   * Resume a completed task session to continue execution.
   * Uses the SDK's `resume` option to reconnect to a previous session.
   * This enables post-completion steering (follow-up questions after task finishes).
   */
  async resumeTask(
    taskId: string,
    message: string,
    workingDirectory: string,
    sessionId: string,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const abortController = new AbortController();
    const abortHandler = () => abortController.abort();
    signal.addEventListener('abort', abortHandler);

    try {
      // Ensure CLAUDE_CONFIG_DIR is set
      if (!process.env.CLAUDE_CONFIG_DIR) {
        process.env.CLAUDE_CONFIG_DIR = join(homedir(), '.claude');
      }

      const hasWorkdir = !!workingDirectory;

      const options: Parameters<typeof query>[0]['options'] = {
        abortController,
        permissionMode: 'bypassPermissions',
        // Enable sandbox for standard Claude models (skip for Bedrock/custom models which crash with sandbox option)
        ...getSandboxOption(undefined),
        settingSources: ['user', 'project', 'local'],
        persistSession: true,
        ...(hasWorkdir ? { cwd: workingDirectory, additionalDirectories: [workingDirectory] } : {}),
        env: {
          ...process.env,
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          // Inject Astro auth so astro-cli works inside the session without
          // a separate login step (works on local and remote machines).
          ...(config.getAccessToken() ? { ASTRO_AUTH_TOKEN: config.getAccessToken()! } : {}),
          ASTRO_SERVER_URL: config.getApiUrl(),
        },
      };

      // Resume the previous session
      (options as Record<string, unknown>).resume = sessionId;

      // Load MCP servers from config if available
      const agentConfig = config.getConfig();
      const mcpAllowedTools: string[] = [];
      if (agentConfig.mcpServers && Object.keys(agentConfig.mcpServers).length > 0) {
        const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
        for (const [name, serverConfig] of Object.entries(agentConfig.mcpServers)) {
          const server = serverConfig as { command: string; args: string[]; env?: Record<string, string> };
          mcpServers[name] = {
            ...server,
            env: {
              ...server.env,
              ASTRO_EXECUTION_ID: taskId,
            },
          };
        }
        (options as Record<string, unknown>).mcpServers = mcpServers;
        for (const name of Object.keys(mcpServers)) {
          mcpAllowedTools.push(`mcp__${name}__*`);
        }
      }

      // Restrict tools based on whether we have a working directory
      if (!hasWorkdir) {
        (options as Record<string, unknown>).allowedTools = ['Bash', 'WebSearch', 'WebFetch', ...mcpAllowedTools];
      } else if (mcpAllowedTools.length > 0) {
        (options as Record<string, unknown>).allowedTools = [
          'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
          'TodoWrite', 'AskUserQuestion', 'Skill', 'Task', 'NotebookEdit',
          ...mcpAllowedTools,
        ];
      }

      // Wrap prompt in async iterable so isSingleUserTurn=false and stdin stays open for steering
      const promptIterable = {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: message },
            parent_tool_use_id: null,
            session_id: '',
          };
        },
      };
      const gen = query({ prompt: promptIterable, options });

      let output = '';
      let success = true;
      let errorMessage: string | undefined;
      let newSessionId = sessionId;
      // Map tool_use_id → tool name for matching results back to uses
      const resumeToolUseNames = new Map<string, string>();

      for await (const msg of gen) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          newSessionId = (msg as unknown as Record<string, unknown>).session_id as string ?? sessionId;
          this.activeQueries.set(taskId, { query: gen, sessionId: newSessionId, workingDirectory });
          stream.sessionInit(newSessionId, msg.model);
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (typeof block === 'string') continue;
            if (block.type === 'text') {
              output += block.text;
              stream.text(block.text);
            } else if (block.type === 'tool_use') {
              if (block.id) resumeToolUseNames.set(block.id, block.name);
              stream.toolUse(block.name, block.input, block.id);
              if (block.name === 'Write' || block.name === 'Edit') {
                const input = block.input as Record<string, unknown>;
                if (input.file_path) {
                  const action = block.name === 'Write' ? 'created' : 'modified';
                  stream.fileChange(String(input.file_path), action as 'created' | 'modified' | 'deleted');
                }
              }
            }
          }
        } else if (msg.type === 'user') {
          for (const block of msg.message.content) {
            if (typeof block === 'string') continue;
            if (block.type === 'tool_result') {
              const resultContent = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content);
              const isError = block.is_error ?? false;
              const resolvedResumeName = block.tool_use_id ? resumeToolUseNames.get(block.tool_use_id) : undefined;
              stream.toolResult(resolvedResumeName || block.tool_use_id || 'unknown', resultContent, !isError, block.tool_use_id);
            }
          }
        } else if (msg.type === 'result') {
          newSessionId = (msg as unknown as Record<string, unknown>).session_id as string ?? newSessionId;
          if (msg.subtype === 'success') {
            success = true;
          } else {
            success = false;
            errorMessage = `Resume failed: ${msg.subtype}`;
          }
          break;
        }
      }

      // Preserve context after resume completes
      this.activeQueries.set(taskId, {
        query: null,
        sessionId: newSessionId,
        workingDirectory,
      });
      setTimeout(() => {
        const entry = this.activeQueries.get(taskId);
        if (entry && entry.query === null) {
          this.activeQueries.delete(taskId);
        }
      }, SESSION_PRESERVE_MS);

      return { success, output, error: errorMessage };
    } finally {
      signal.removeEventListener('abort', abortHandler);
    }
  }

  /**
   * Get session context for a task (active or recently completed).
   * Returns sessionId and workingDirectory if available.
   */
  getTaskContext(taskId: string): { sessionId: string; workingDirectory?: string; originalWorkingDirectory?: string } | null {
    const active = this.activeQueries.get(taskId);
    if (!active) return null;
    return { sessionId: active.sessionId, workingDirectory: active.workingDirectory, originalWorkingDirectory: active.originalWorkingDirectory };
  }

  /**
   * Set the original (pre-worktree) working directory on a session.
   * Called by the task executor after workspace preparation.
   */
  setOriginalWorkingDirectory(taskId: string, originalDir: string): void {
    const active = this.activeQueries.get(taskId);
    if (active) {
      active.originalWorkingDirectory = originalDir;
    }
  }

  async getStatus(): Promise<ProviderStatus> {
    const available = this.isAuthenticated || (await this.isAvailable());

    return {
      available,
      version: this.model,
      activeTasks: this.activeTasks,
      maxTasks: this.maxTasks,
      lastError: this.lastError,
    };
  }

  /**
   * Generate a structured execution summary by resuming the task session.
   * Resumes the session so the model has full context of what it did,
   * then parses JSON from the text response.
   *
   * Note: We intentionally avoid using `outputFormat` (structured output) here
   * because the `resume` + `outputFormat` combination is unreliable in the SDK —
   * it returns errors with no structured_output. Instead, we embed the JSON format
   * in the prompt and parse the text response.
   */
  async generateSummary(
    taskId: string,
    workingDirectory?: string,
  ): Promise<ExecutionSummary | undefined> {
    const sessionContext = this.activeQueries.get(taskId);
    if (!sessionContext?.sessionId) {
      console.log(`[claude-sdk] No session to resume for summary (task ${taskId})`);
      return undefined;
    }

    const summaryAbort = new AbortController();
    const summaryTimeout = setTimeout(() => summaryAbort.abort(), SUMMARY_TIMEOUT_MS);

    try {
      // Ensure CLAUDE_CONFIG_DIR is set
      if (!process.env.CLAUDE_CONFIG_DIR) {
        process.env.CLAUDE_CONFIG_DIR = join(homedir(), '.claude');
      }

      const options: Parameters<typeof query>[0]['options'] = {
        abortController: summaryAbort,
        maxTurns: 1,
        permissionMode: 'plan',
        persistSession: true,
        ...(workingDirectory ? { cwd: workingDirectory } : {}),
      };

      // Resume the execution session so the model has full context
      (options as Record<string, unknown>).resume = sessionContext.sessionId;

      const gen = query({
        prompt: SUMMARY_PROMPT,
        options,
      });

      let textOutput = '';

      for await (const msg of gen) {
        if (msg.type === 'result') {
          const msgAny = msg as Record<string, unknown>;
          console.log(`[claude-sdk] Task ${taskId}: summary result — subtype=${msg.subtype}, is_error=${msgAny.is_error}`);
          if (msg.subtype !== 'success') {
            console.warn(`[claude-sdk] Task ${taskId}: summary query failed with subtype=${msg.subtype}`);
            if (msgAny.errors) {
              console.error(`[claude-sdk] Task ${taskId}: summary errors: ${JSON.stringify(msgAny.errors)}`);
            }
          }
          break;
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (typeof block !== 'string' && block.type === 'text') {
              textOutput += block.text;
            }
          }
        }
      }

      return parseSummaryResponse(textOutput, `[claude-sdk] Task ${taskId}`);
    } finally {
      clearTimeout(summaryTimeout);
    }
  }

  /**
   * Fast path for summarize tasks.
   * Skips HPC context, MCP servers, tool infrastructure, canUseTool handler,
   * sandbox, and image handling to minimize time-to-first-token.
   * Uses no tools — pure structured text extraction.
   */
  private async runTextOnlyQuery(
    task: NormalizedTask,
    stream: TaskOutputStream,
    abortController: AbortController,
    hasWorkdir: boolean,
  ): Promise<{
    success: boolean;
    output: string;
    error?: string;
    artifacts?: TaskArtifact[];
    metrics?: TaskResult['metrics'];
  }> {
    const options: Parameters<typeof query>[0]['options'] = {
      abortController,
      ...(task.maxTurns != null ? { maxTurns: task.maxTurns } : {}),
      permissionMode: 'plan',
      tools: [],
      persistSession: true,
      ...(hasWorkdir ? { cwd: task.workingDirectory } : {}),
      ...(claudeExecutablePath ? { pathToClaudeCodeExecutable: claudeExecutablePath } : {}),
      stderr: (data: string) => {
        const trimmed = data.trim();
        if (trimmed) {
          console.error(`[claude-sdk][stderr][${task.id.slice(0, 8)}] ${trimmed}`);
        }
      },
      env: {
        ...process.env,
        ...task.environment,
        // Ensure bundled astro-cli version is found before any global/outdated install
        PATH: getAugmentedPath(),
      },
    };

    if (task.systemPrompt) {
      (options as Record<string, unknown>).systemPrompt = task.systemPrompt;
    }
    if (task.model) {
      (options as Record<string, unknown>).model = task.model;
    }

    // Build prompt with conversation history
    let effectivePrompt = task.prompt;
    if (task.messages && task.messages.length > 0) {
      const conversationContext = task.messages
        .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
      effectivePrompt = effectivePrompt
        ? `${effectivePrompt}\n\n---\n\nConversation history:\n${conversationContext}`
        : conversationContext;
    }

    console.log(`[claude-sdk] Fast path: summarize task (model=${task.model ?? 'default'})`);

    // Wrap prompt in async iterable so isSingleUserTurn=false and stdin stays open for steering
    const promptIterable = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'user' as const,
          message: { role: 'user' as const, content: effectivePrompt },
          parent_tool_use_id: null,
          session_id: '',
        };
      },
    };
    const gen = query({ prompt: promptIterable, options });

    let output = '';
    let success = true;
    let errorMessage: string | undefined;
    let resultMetrics: TaskResult['metrics'] | undefined;

    for await (const msg of gen) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        this.model = msg.model;
        const sessionId = (msg as unknown as Record<string, unknown>).session_id as string ?? '';
        stream.status('running', 5, `Model: ${msg.model}`);
        stream.sessionInit(sessionId, msg.model);
        this.activeQueries.set(task.id, { query: gen, sessionId });
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (typeof block === 'string') continue;
          if (block.type === 'text') {
            output += block.text;
            stream.text(block.text);
          }
        }
      } else if (msg.type === 'result') {
        const msgAny = msg as Record<string, unknown>;
        const usage = msgAny.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        resultMetrics = {
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          totalCost: (msgAny.total_cost_usd ?? msgAny.cost_usd) as number | undefined,
          numTurns: msgAny.num_turns as number | undefined,
          durationMs: (msgAny.duration_ms ?? msgAny.duration_api_ms) as number | undefined,
          model: this.model,
        };
        if (msg.subtype === 'success') {
          success = true;
          stream.status('completed', 100, 'Task completed successfully');
        } else {
          success = false;
          errorMessage = `Task failed: ${msg.subtype}`;
          stream.status('failed', 0, errorMessage);
        }
        break;
      }
    }

    return { success, output, error: errorMessage, metrics: resultMetrics };
  }

  private async runQuery(
    task: NormalizedTask,
    stream: TaskOutputStream,
    abortController: AbortController
  ): Promise<{
    success: boolean;
    output: string;
    error?: string;
    artifacts?: TaskArtifact[];
    metrics?: TaskResult['metrics'];
  }> {
    // Ensure CLAUDE_CONFIG_DIR points to a user-writable location.
    // The SDK derives internal storage paths from cwd, and /tmp/claude/ may be
    // owned by another user on shared machines, causing EACCES errors.
    if (!process.env.CLAUDE_CONFIG_DIR) {
      process.env.CLAUDE_CONFIG_DIR = join(homedir(), '.claude');
    }

    // Enable SDK debug logging only when explicitly requested
    if (process.env.ASTRO_LOG_LEVEL === 'debug') {
      process.env.DEBUG_SDK = '1';
      process.env.CLAUDE_CODE_DEBUG_LOGS_DIR = join(homedir(), '.astro', 'logs', 'sdk-debug');
    }

    // NOTE: We intentionally do NOT call process.chdir() here.
    // process.cwd() is global state shared across concurrent tasks, so calling
    // chdir() creates race conditions where one task captures another's worktree
    // path as its "original cwd", then fails to restore when that worktree is
    // cleaned up. The SDK's `cwd` option (line below) handles per-query working
    // directory correctly without mutating global state.

    // Remove nested-session guard: the agent runner may be launched from within
    // a Claude Code session, and the CLAUDECODE env var prevents the SDK from
    // starting a new session.
    delete process.env.CLAUDECODE;

    const isTextOnlyTask = task.type === 'summarize';

    const workdir: string | undefined = task.workingDirectory || undefined;
    const hasWorkdir = !!workdir;

    // ── Fast path for summarize tasks (no tools, no MCP) ──
    // Skip everything to minimize time-to-first-token.
    if (isTextOnlyTask) {
      return this.runTextOnlyQuery(task, stream, abortController, hasWorkdir);
    }

    // ── Standard path for all other task types (plan/chat/playground/execution) ──
    // All get full tool access; the prompt controls behavior.

    // Build options for the query
    const options: Parameters<typeof query>[0]['options'] = {
      abortController,
      ...(task.maxTurns != null ? { maxTurns: task.maxTurns } : {}),
      // All task types use bypassPermissions. The prompt controls behavior
      // (plan vs execute), not tool-level permission enforcement.
      permissionMode: 'bypassPermissions',
      // Enable sandbox for standard Claude models (skip for Bedrock/custom models which crash with sandbox option)
      ...getSandboxOption(task.model),
      settingSources: ['user', 'project', 'local'], // Load CLAUDE.md from user home, project dir, and cwd
      persistSession: true, // Keep session on disk so generateSummary() can resume it
      ...(workdir ? { cwd: workdir, additionalDirectories: [workdir] } : {}),
      // Use globally installed claude binary if available (avoids missing cli.js on remote machines)
      ...(claudeExecutablePath ? { pathToClaudeCodeExecutable: claudeExecutablePath } : {}),
      // Capture subprocess stderr for debugging exit code 1 crashes
      stderr: (data: string) => {
        const trimmed = data.trim();
        if (trimmed) {
          console.error(`[claude-sdk][stderr][${task.id.slice(0, 8)}] ${trimmed}`);
        }
      },
      env: {
        ...process.env,
        ...task.environment,
        PATH: getAugmentedPath(),
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1', // Enable additional directories for CLAUDE.md loading
        // Inject Astro auth + execution context so astro-cli works inside
        // the session without a separate login step. ASTRO_EXECUTION_ID
        // enables the CLI to link plan mutations back to the streaming pipeline.
        ...(config.getAccessToken() ? { ASTRO_AUTH_TOKEN: config.getAccessToken()! } : {}),
        ASTRO_SERVER_URL: config.getApiUrl(),
        ASTRO_EXECUTION_ID: task.id,
      },
      // Intercept built-in AskUserQuestion to handle approvals (following Cyrus pattern)
      canUseTool: async (toolName: string, input: Record<string, unknown>, options: { toolUseID: string; signal: AbortSignal }) => {
        if (toolName === 'AskUserQuestion') {
          console.log(`[claude-sdk] Intercepted AskUserQuestion (toolUseID: ${options.toolUseID})`);

          // Validate input structure
          const askInput = input as { questions?: Array<{ question: string; options: Array<{ label: string; description?: string }> }> };
          if (!askInput.questions || !Array.isArray(askInput.questions)) {
            console.error('[claude-sdk] Invalid AskUserQuestion input: questions array missing');
            return {
              behavior: 'deny' as const,
              message: 'Invalid AskUserQuestion input: questions array is required',
            };
          }

          // Only support one question at a time (following Cyrus pattern)
          if (askInput.questions.length !== 1) {
            console.log(`[claude-sdk] Rejecting AskUserQuestion with ${askInput.questions.length} questions (only 1 allowed)`);
            return {
              behavior: 'deny' as const,
              message: 'Only one question at a time is supported. Please ask each question separately.',
            };
          }

          const question = askInput.questions[0];
          const optionLabels = question.options.map(opt => opt.label);

          try {
            console.log(`[claude-sdk] Requesting approval from user: "${question.question}"`);

            // Call the approval request handler (emits event and waits for response)
            const result = await stream.approvalRequest(question.question, optionLabels);

            if (result.answered && result.answer) {
              console.log(`[claude-sdk] User approved with answer: "${result.answer}"`);

              // Return the answer via updatedInput (SDK will see this as the tool result)
              return {
                behavior: 'allow' as const,
                updatedInput: {
                  questions: askInput.questions,
                  answers: { [question.question]: result.answer },
                },
              };
            } else {
              console.log(`[claude-sdk] User denied approval: ${result.message || 'No response'}`);
              return {
                behavior: 'deny' as const,
                message: result.message || 'User did not respond to the question',
              };
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[claude-sdk] Error handling approval request: ${errorMessage}`);
            return {
              behavior: 'deny' as const,
              message: `Failed to get user approval: ${errorMessage}`,
            };
          }
        }

        // Allow all other tools
        return { behavior: 'allow' as const, updatedInput: input };
      },
    };

    // Lazily initialize HPC context on first query.
    // Uses pre-classified HpcCapability from startup detection to avoid
    // re-running SLURM detection commands on every first task.
    if (this.hpcContext === undefined && this.hpcCapability) {
      try {
        const cap = this.hpcCapability;
        const preclassifiedSlurm = {
          available: true,
          clusterName: cap.clusterName,
          partitions: cap.partitions,
          defaultPartition: cap.defaultPartition,
          accounts: cap.accounts,
          qosLevels: [],
        };
        this.hpcContext = await buildHpcContext(preclassifiedSlurm);
        if (this.hpcContext.available) {
          console.log(`[claude-sdk] HPC context loaded (cluster: ${this.hpcContext.slurmInfo?.clusterName ?? 'unknown'})`);
        }
      } catch {
        this.hpcContext = null;
      }
    }

    // Prepend HPC context to prompt if available
    let effectivePrompt = task.prompt;
    if (this.hpcContext?.available) {
      effectivePrompt = this.hpcContext.contextString + '\n\n---\n\n' + task.prompt;
    }

    // Write images to temp files for multimodal analysis.
    // The image paths are referenced in the prompt so the agent can view them
    // (Claude Code's Read tool supports images natively as it is multimodal).
    // Cleanup is handled by the caller (execute()) via try/finally.
    if (task.images && task.images.length > 0 && workdir) {
      const imageDir = join(workdir, '.astro', 'images');
      try {
        const imagePaths = await writeImagesToDir(task.images, imageDir);
        if (imagePaths.length > 0) {
          const imageList = imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n');
          effectivePrompt += `\n\n---\n\n## Attached Images\n\nThe following ${imagePaths.length} image(s) from the task description have been saved to disk. Use the Read tool to view them (it supports images natively):\n${imageList}`;
          // Store paths on task for cleanup by execute()
          (task as Task & { _imageCleanupPaths?: string[] })._imageCleanupPaths = imagePaths;
          console.log(`[claude-sdk] Wrote ${imagePaths.length} image(s) to ${imageDir}`);
        }
      } catch (err) {
        console.warn(`[claude-sdk] Failed to write images to disk:`, err);
      }
    }

    // Add structured output format if requested (e.g., plan generation)
    if (task.outputFormat) {
      (options as Record<string, unknown>).outputFormat = task.outputFormat;
    }

    // Apply system prompt if provided (new relay protocol field)
    // This keeps system instructions separate from user content.
    if (task.systemPrompt) {
      (options as Record<string, unknown>).systemPrompt = task.systemPrompt;
    }

    // Apply explicit model selection if provided (new relay protocol field)
    if (task.model) {
      (options as Record<string, unknown>).model = task.model;
    }

    // Load MCP servers from config if available
    const agentConfig = config.getConfig();
    const mcpAllowedTools: string[] = [];
    const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};

    if (agentConfig.mcpServers && Object.keys(agentConfig.mcpServers).length > 0) {
      console.log(`[claude-sdk] Loading ${Object.keys(agentConfig.mcpServers).length} MCP server(s): ${Object.keys(agentConfig.mcpServers).join(', ')}`);

      // Inject execution ID into MCP server environment variables
      for (const [name, serverConfig] of Object.entries(agentConfig.mcpServers)) {
        const server = serverConfig as { command: string; args: string[]; env?: Record<string, string> };
        mcpServers[name] = {
          ...server,
          env: {
            ...server.env,
            ASTRO_EXECUTION_ID: task.id, // Inject current task ID for approval routing
          },
        };
      }
    }

    if (Object.keys(mcpServers).length > 0) {
      (options as Record<string, unknown>).mcpServers = mcpServers;

      // Collect MCP tool patterns
      for (const name of Object.keys(mcpServers)) {
        mcpAllowedTools.push(`mcp__${name}__*`);
      }
    }

    // All task types (including plan) get the same tool set. Plan tasks
    // were previously restricted to read-only tools (Read/Glob/Grep/WebSearch/
    // WebFetch), but now need Bash for astro-cli plan mutations and full MCP
    // access. The system prompt constrains plan agent behavior, not tool-level
    // restrictions.
    if (!hasWorkdir) {
      // For tasks without a working directory, disable file system tools but keep
      // Bash + web search so the agent can run CLI tools (e.g. astro-cli plan create).
      const noWorkdirTools = ['Bash', 'WebSearch', 'WebFetch', ...mcpAllowedTools];
      (options as Record<string, unknown>).allowedTools = noWorkdirTools;
      console.log(`[claude-sdk] No workdir — allowed tools: [${noWorkdirTools.join(', ')}]`);
    } else if (mcpAllowedTools.length > 0) {
      // With a workdir, allow all built-in tools plus MCP tools.
      (options as Record<string, unknown>).allowedTools = [
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
        'TodoWrite', 'AskUserQuestion', 'Skill', 'Task', 'NotebookEdit',
        ...mcpAllowedTools,
      ];
    }

    // Build the prompt: use messages array if provided (chat tasks), otherwise flat string
    // The messages field carries multi-turn conversation history from chat endpoints,
    // preserving role structure (user/assistant turns) that would be lost with a flat string.
    let queryPrompt: string | AsyncIterable<{ role: 'user'; content: string }>;
    if (task.messages && task.messages.length > 0) {
      // For chat tasks with conversation history, build the prompt by appending
      // the conversation history to the effective prompt. The last user message
      // is the actual query; prior messages provide context.
      const conversationContext = task.messages
        .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
      queryPrompt = effectivePrompt
        ? `${effectivePrompt}\n\n---\n\nConversation history:\n${conversationContext}`
        : conversationContext;
    } else {
      queryPrompt = effectivePrompt;
    }

    // Wrap prompt in async iterable so isSingleUserTurn=false and stdin stays open for steering
    const promptIterable = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'user' as const,
          message: { role: 'user' as const, content: queryPrompt },
          parent_tool_use_id: null,
          session_id: '',
        };
      },
    };
    const gen = query({
      prompt: promptIterable,
      options,
    });

    let output = '';
    let success = true;
    let errorMessage: string | undefined;
    const artifacts: TaskArtifact[] = [];
    let progress = 0;
    let toolUseCount = 0;
    let resultMetrics: TaskResult['metrics'] | undefined;
    // Map tool_use_id → tool name for scoping side-effect detection to shell tools
    const toolUseNames = new Map<string, string>();

    let turnIndex = 0;

    for await (const msg of gen) {
      try {
      if (msg.type === 'system' && msg.subtype === 'init') {
        this.model = msg.model;
        const sessionId = (msg as unknown as Record<string, unknown>).session_id as string ?? '';
        stream.status('running', 5, `Model: ${msg.model}`);
        stream.sessionInit(sessionId, msg.model);

        // Store the query instance for steering
        this.activeQueries.set(task.id, { query: gen, sessionId });
      } else if (msg.type === 'assistant') {
        turnIndex++;
        let textLength = 0;
        let turnToolCount = 0;
        const turnToolNames: string[] = [];

        // Stream assistant content blocks
        for (const block of msg.message.content) {
          try {
          if (typeof block === 'string') continue;
          if (block.type === 'text') {
            output += block.text;
            textLength += block.text.length;
            stream.text(block.text);
          } else if (block.type === 'tool_use') {
            // Emit structured tool use — logarithmic curve caps at 75% to reserve space for delivery phases
            toolUseCount++;
            turnToolCount++;
            turnToolNames.push(block.name);
            if (block.id) toolUseNames.set(block.id, block.name);
            progress = Math.min(Math.round(75 * Math.log10(toolUseCount + 1) / Math.log10(150)), 75);
            stream.status('running', progress, `Using tool: ${block.name}`);
            stream.toolUse(block.name, block.input, block.id);

            const inputSummary = JSON.stringify(block.input).slice(0, 200);
            console.log(`[claude-sdk] Task ${task.id} tool: ${block.name} (input: ${inputSummary})`);

            // Record file operations as artifacts
            if (block.name === 'Write' || block.name === 'Edit') {
              const input = block.input as Record<string, unknown>;
              if (input.file_path) {
                artifacts.push({
                  type: 'file',
                  name: String(input.file_path),
                  path: String(input.file_path),
                  metadata: { tool: block.name },
                });
                // Emit file change event (line counts computed post-execution via git diff)
                const action = block.name === 'Write' ? 'created' : 'modified';
                stream.fileChange(String(input.file_path), action as 'created' | 'modified' | 'deleted');
              }
            }
          }
          } catch (blockErr) {
            console.error(`[claude-sdk] Task ${task.id} event processing error (continuing):`, blockErr);
          }
        }

        console.log(`[claude-sdk] Task ${task.id} turn ${turnIndex}: ${textLength} chars text, ${turnToolCount} tool calls [${turnToolNames.join(', ')}]`);
      } else if (msg.type === 'user') {
        // Tool results from the SDK
        for (const block of msg.message.content) {
          try {
          if (typeof block === 'string') continue;
          if (block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            const isError = block.is_error ?? false;
            // Resolve tool_use_id to actual tool name so the browser can match
            // tool_result back to its tool_use (both matched by toolName).
            const resolvedName = block.tool_use_id ? toolUseNames.get(block.tool_use_id) : undefined;
            const toolName = resolvedName || block.tool_use_id || 'unknown';
            stream.toolResult(
              toolName,
              resultContent,
              !isError,
              block.tool_use_id,
            );

            console.log(`[claude-sdk] Task ${task.id} tool_result: ${toolName} success=${!isError} (${resultContent.length} chars)`);

            // Detect sbatch submissions for job tracking.
            // Layer 1: Only scan results from shell execution tools to avoid false
            // positives when the AI reads docs containing example sbatch output.
            const resolvedToolName = block.tool_use_id ? toolUseNames.get(block.tool_use_id) : undefined;
            if (this.jobMonitor && typeof resultContent === 'string'
                && resolvedToolName && SHELL_TOOLS.has(resolvedToolName)) {
              const sbatchMatch = resultContent.match(/Submitted batch job (\d+)/);
              if (sbatchMatch) {
                const jobId = sbatchMatch[1];
                // Try to extract output path from sbatch script (common pattern: --output=...)
                const outputMatch = resultContent.match(/--output[= ](\S+)/);
                const outputPath = outputMatch?.[1]?.replace('%j', jobId);
                // Fire-and-forget: don't block message processing while sacct is probed
                this.jobMonitor.trackJob(jobId, task.id, task.planNodeId, outputPath).catch((err) => {
                  console.error(`[claude-sdk] Failed to track sbatch job ${jobId}:`, err);
                });
                console.log(`[claude-sdk] Detected sbatch submission: job ${jobId} (tool: ${resolvedToolName})`);
              }
            }
          }
          } catch (blockErr) {
            console.error(`[claude-sdk] Task ${task.id} event processing error (continuing):`, blockErr);
          }
        }
      } else if (msg.type === 'result') {
        // Extract metrics from SDK result (available on both success and error subtypes)
        const msgAny = msg as Record<string, unknown>;
        const usage = msgAny.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const totalCostUsd = (msgAny.total_cost_usd ?? msgAny.cost_usd) as number | undefined;
        const numTurns = msgAny.num_turns as number | undefined;
        const durationMs = (msgAny.duration_ms ?? msgAny.duration_api_ms) as number | undefined;

        // Log result message fields for debugging token extraction
        const msgKeys = Object.keys(msgAny).filter(k => k !== 'result').sort();
        console.log(`[claude-sdk] Result message fields: ${msgKeys.join(', ')}`);
        if (usage) {
          console.log(`[claude-sdk] Usage: input_tokens=${usage.input_tokens}, output_tokens=${usage.output_tokens}`);
        } else {
          console.log(`[claude-sdk] No usage field found on result message`);
        }

        resultMetrics = {
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          totalCost: totalCostUsd,
          numTurns,
          durationMs,
          model: this.model,
        };

        if (msg.subtype === 'success') {
          success = true;
          stream.status('running', 85, 'Agent work complete');

          // Capture structured output (produced when outputFormat is set)
          if (msgAny.structured_output) {
            const jsonStr = JSON.stringify(msgAny.structured_output);
            output += jsonStr;
            stream.text(jsonStr);
          } else if (msgAny.result && !output) {
            // Fallback: capture result text if no output was accumulated
            const resultStr = typeof msgAny.result === 'string'
              ? msgAny.result
              : JSON.stringify(msgAny.result);
            output += resultStr;
            stream.text(resultStr);
          }
        } else if (
          msg.subtype === 'error_during_execution' ||
          msg.subtype === 'error_max_turns' ||
          msg.subtype === 'error_max_budget_usd' ||
          msg.subtype === 'error_max_structured_output_retries'
        ) {
          success = false;
          errorMessage = `Task failed: ${msg.subtype}`;
          stream.status('failed', progress, errorMessage);
        }

        const tokenSummary = usage ? `${usage.input_tokens ?? 0}+${usage.output_tokens ?? 0}` : 'N/A';
        const costStr = totalCostUsd != null ? `$${totalCostUsd.toFixed(4)}` : 'N/A';
        console.log(`[claude-sdk] Task ${task.id} completed: status=${success ? 'success' : 'failure'} turns=${numTurns ?? turnIndex} tokens=${tokenSummary} cost=${costStr}`);
        break;
      }
      } catch (err) {
        console.error(`[claude-sdk] Task ${task.id} event processing error (continuing):`, err);
      }
    }

    // Detect unauthenticated Claude Code sessions.
    // When the keychain token is missing (common on remote/HPC machines), the CLI
    // streams "Not logged in · Please run /login" for every turn instead of doing work.
    // The SDK still reports subtype=success because the process exited cleanly.
    // We must detect this and fail the task — otherwise it gets auto-verified despite
    // producing zero useful output.
    if (success && (output.includes('Not logged in') || output.includes('Please run /login'))) {
      success = false;
      errorMessage =
        'Claude Code is not authenticated on this machine. The CLI reported "Not logged in · Please run /login".\n\n' +
        'The Mac keychain credential is not accessible (common on remote or headless machines).\n' +
        'To fix this, configure one of the following authentication methods:\n' +
        '  1. OAuth token: export CLAUDE_CODE_OAUTH_TOKEN=<token> (run `claude setup-token` first)\n' +
        '  2. API key: export ANTHROPIC_API_KEY=sk-ant-...\n' +
        '  3. Bedrock: export CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-2 AWS_PROFILE=default\n' +
        '  4. Vertex AI: export CLAUDE_CODE_USE_VERTEX=1 CLOUD_ML_REGION=us-east5 ANTHROPIC_VERTEX_PROJECT_ID=...\n' +
        '  (add to your shell profile or ~/.astro/config.json under "environment")';
      stream.status('failed', progress, 'Authentication error: Claude Code not logged in — set CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, or configure Bedrock/Vertex');
    }

    return {
      success,
      output,
      error: errorMessage,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      metrics: resultMetrics,
    };
  }
}
