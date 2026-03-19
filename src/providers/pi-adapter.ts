/**
 * Pi provider adapter
 *
 * Executes tasks using the Pi coding agent (@mariozechner/pi-coding-agent)
 * via the official TypeScript SDK (in-process, no subprocess).
 *
 * Supports multi-turn resume by preserving AgentSession instances with a
 * 10-minute TTL.
 */

import type { TaskResult, ExecutionSummary } from '../types.js';
import {
  type ProviderAdapter,
  type NormalizedTask,
  type TaskOutputStream,
  type ProviderStatus,
  SUMMARY_PROMPT,
  SUMMARY_TIMEOUT_MS,
  parseSummaryResponse,
  createNoopStream,
} from './base-adapter.js';
import type { AgentSession, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { config } from '../lib/config.js';

// ---------------------------------------------------------------------------
// Session Preservation
// ---------------------------------------------------------------------------

interface PreservedSession {
  session: AgentSession;
  taskId: string;
  workingDirectory?: string;
  originalWorkingDirectory?: string;
  createdAt: number;
}

/** TTL for preserved sessions (10 minutes) */
const SESSION_TTL_MS = 10 * 60 * 1000;

/** Interval for proactive session cleanup (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** File-modifying tool names — emit fileChange events for these */
const FILE_TOOLS = new Set([
  'Write', 'Edit', 'Create', 'MultiEdit',
  'write', 'edit', 'create', 'multi_edit',
  'write_file', 'edit_file', 'create_file',
]);

/**
 * Extract text from a Pi content-block array.
 * Returns the concatenated text of all `{ type: "text", text: "..." }` blocks,
 * or null if the input is not a valid Pi content array.
 */
function extractContentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block != null && (block as Record<string, unknown>).type === 'text') {
      texts.push(String((block as Record<string, string>).text ?? ''));
    }
  }
  return texts.length > 0 ? texts.join('') : null;
}

/**
 * Extract plain text from a Pi SDK tool result.
 *
 * Pi tools return `{ content: [{ type: "text", text: "..." }, ...], details: ... }`.
 * Handles three forms:
 *   1. Already a string → try JSON parse for Pi content structure, else return as-is
 *   2. Object with `content` array → extract text blocks
 *   3. Other object → JSON.stringify
 */
function extractToolResultText(value: unknown): string {
  if (value == null) return '';

  // String: might be pre-serialized Pi content JSON
  if (typeof value === 'string') {
    if (value.startsWith('{"content":')) {
      try {
        const parsed = JSON.parse(value);
        const text = extractContentText(parsed.content);
        if (text != null) return text;
      } catch { /* not valid JSON, return as-is */ }
    }
    return value;
  }

  // Object: check for Pi content structure
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('content' in obj) {
      const text = extractContentText(obj.content);
      if (text != null) return text;
    }
  }

  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Custom Tool: ask_user_question
// ---------------------------------------------------------------------------

/** Approval request timeout (5 minutes) — same as MCP approval server */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Build a Pi-compatible `ask_user_question` custom tool that posts to the
 * same HTTP approval endpoint used by the Codex MCP approval server.
 *
 * This is intentionally identical to the Codex approach: the tool is
 * stateless — it only needs the server URL and execution ID, both stable
 * for the lifetime of the session. No stream reference, no closure issues
 * across resume/summary calls.
 */
async function buildAskUserQuestionTool(executionId: string, serverUrl: string): Promise<ToolDefinition> {
  const { Type } = await import('@sinclair/typebox');

  return {
    name: 'ask_user_question',
    label: 'Ask User',
    description:
      'Ask the user a clarifying question before proceeding. ' +
      'Execution pauses until the user selects one of the provided options. ' +
      'Use this when multiple approaches are valid and the decision depends on user preference.',
    parameters: Type.Object({
      question: Type.String({ description: 'The question to ask the user.' }),
      options: Type.Array(Type.String(), {
        description: 'Array of 2-5 option strings the user can choose from.',
        minItems: 2,
        maxItems: 5,
      }),
    }),
    async execute(
      _toolCallId: string,
      params: { question: string; options: string[] },
      signal?: AbortSignal,
    ): Promise<{ content: { type: string; text: string }[]; details: unknown }> {
      const { question, options } = params;

      try {
        const abortCtl = new AbortController();
        const timeout = setTimeout(() => abortCtl.abort(), APPROVAL_TIMEOUT_MS);
        signal?.addEventListener('abort', () => abortCtl.abort(), { once: true });
        let response: Response;
        try {
          response = await fetch(`${serverUrl}/api/dispatch/request-dynamic-approval`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ executionId, question, options }),
            signal: abortCtl.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Unknown error' }));
          return {
            content: [{ type: 'text', text: `Approval request failed: ${(error as Record<string, string>).error || response.status}` }],
            details: { answered: false },
          };
        }

        const result = await response.json() as { selectedOption: string };
        return {
          content: [{ type: 'text', text: `User selected: ${result.selectedOption}` }],
          details: { answered: true, answer: result.selectedOption },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Failed to get user approval: ${errorMessage}. Proceeding with best judgment.` }],
          details: { answered: false, error: errorMessage },
        };
      }
    },
  } as ToolDefinition;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PiAdapter implements ProviderAdapter {
  readonly type = 'pi';
  readonly name = 'Pi';

  private activeTasks = 0;
  private maxTasks = 2;
  private lastError?: string;

  /** Preserved sessions for multi-turn resume, keyed by taskId */
  private preservedSessions = new Map<string, PreservedSession>();

  /** Timer for proactive cleanup of expired sessions */
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    for (const session of this.preservedSessions.values()) {
      session.session.abort().catch(() => {});
    }
    this.preservedSessions.clear();
  }

  async isAvailable(): Promise<boolean> {
    try {
      await import('@mariozechner/pi-coding-agent');
      return true;
    } catch {
      return false;
    }
  }

  async execute(
    task: NormalizedTask,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<TaskResult> {
    const startedAt = new Date().toISOString();
    this.activeTasks++;

    try {
      const { createAgentSession, SessionManager } = await import('@mariozechner/pi-coding-agent');

      stream.status('running', 0, 'Starting Pi agent');

      const { session } = await createAgentSession({
        cwd: task.workingDirectory,
        sessionManager: SessionManager.inMemory(),
        customTools: [await buildAskUserQuestionTool(
          task.id,
          config.getConfig().apiUrl || 'http://localhost:3001',
        )],
      });

      // Build prompt
      let effectivePrompt = task.systemPrompt
        ? `${task.systemPrompt}\n\n---\n\n${task.prompt}`
        : task.prompt;

      if (task.messages && task.messages.length > 0) {
        const conversationContext = task.messages
          .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
          .join('\n\n');
        effectivePrompt = `${conversationContext}\n\nHuman: ${effectivePrompt}`;
      }

      let agentFailed = false;

      const modelStr = session.model
        ? `${(session.model as any).provider ?? 'unknown'}/${(session.model as any).id ?? 'unknown'}`
        : undefined;

      const { unsubscribe, getOutputText } = this.subscribeToSessionEvents(
        session, stream, { includeLifecycle: true, modelStr },
      );

      const abortHandler = () => { session.abort().catch(() => {}); };
      signal.addEventListener('abort', abortHandler, { once: true });

      try {
        await session.prompt(effectivePrompt);
      } catch (err) {
        agentFailed = true;
        throw err;
      } finally {
        signal.removeEventListener('abort', abortHandler);
        unsubscribe();
      }

      // Collect metrics from session stats
      const stats = session.getSessionStats();
      const model = session.model as any;
      const metrics: TaskResult['metrics'] = {
        inputTokens: stats.tokens?.input,
        outputTokens: stats.tokens?.output,
        totalCost: stats.cost,
        model: model ? `${model.provider ?? ''}/${model.id ?? ''}` : undefined,
        numTurns: stats.assistantMessages,
      };

      // Preserve session for multi-turn resume
      if (!agentFailed && !signal.aborted) {
        this.cleanupExpiredSessions();
        this.preservedSessions.set(task.id, {
          session,
          taskId: task.id,
          workingDirectory: task.workingDirectory,
          createdAt: Date.now(),
        });
      }

      // Generate summary for execution tasks
      let summary: ExecutionSummary | undefined;
      const isExecutionTask = !task.type || task.type === 'execution';
      if (isExecutionTask && !agentFailed && !signal.aborted) {
        try {
          stream.status('running', 85, 'Generating summary');
          summary = await this.generateSummary(task.id, task.workingDirectory);
        } catch (summaryError) {
          console.warn(`[pi] Task ${task.id}: summary generation failed:`, summaryError);
        }
      }

      return {
        taskId: task.id,
        status: signal.aborted ? 'cancelled' : 'completed',
        output: getOutputText(),
        startedAt,
        completedAt: new Date().toISOString(),
        metrics,
        summary,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;

      if (signal.aborted) {
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
      this.activeTasks--;
    }
  }

  async getStatus(): Promise<ProviderStatus> {
    const available = await this.isAvailable();
    return {
      available,
      version: null,
      activeTasks: this.activeTasks,
      maxTasks: this.maxTasks,
      lastError: this.lastError,
    };
  }

  // ─── Shared Event Subscriber ─────────────────────────────────

  /**
   * Subscribe to Pi session events and route them to a TaskOutputStream.
   * Returns { unsubscribe, getOutputText } for the caller to manage.
   *
   * @param includeLifecycle - emit sessionInit/agent_end (true for initial execute, false for resume)
   */
  private subscribeToSessionEvents(
    session: AgentSession,
    stream: TaskOutputStream,
    options: { includeLifecycle: boolean; modelStr?: string },
  ): { unsubscribe: () => void; getOutputText: () => string } {
    let outputText = '';
    let toolCount = 0;
    const toolArgsMap = new Map<string, Record<string, unknown>>();

    const unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case 'agent_start':
          if (options.includeLifecycle) {
            stream.sessionInit(
              `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              options.modelStr,
            );
          }
          break;

        case 'message_update': {
          const msgEvent = (event as any).assistantMessageEvent;
          if (!msgEvent) break;

          switch (msgEvent.type) {
            case 'text_delta': {
              const delta: string = msgEvent.delta ?? '';
              if (delta) {
                outputText += delta;
                stream.text(delta);
              }
              break;
            }
            case 'thinking_delta': {
              const delta: string = msgEvent.delta ?? '';
              if (delta) {
                stream.text(delta);
              }
              break;
            }
            case 'error': {
              const errMsg = msgEvent.error?.errorMessage ?? 'Unknown Pi error';
              stream.text(`\n[Pi error] ${errMsg}\n`);
              break;
            }
            // text_start, text_end, thinking_start, thinking_end, toolcall_*,
            // start, done — no action needed (covered by other events)
          }
          break;
        }

        case 'tool_execution_start': {
          const ev = event as any;
          if (ev.toolCallId && ev.args) toolArgsMap.set(ev.toolCallId, ev.args);
          toolCount++;
          stream.toolUse(ev.toolName, ev.args, ev.toolCallId);
          stream.status('running', Math.min(80, Math.round(20 * Math.log2(toolCount + 1))), `Tool: ${ev.toolName}`);
          break;
        }

        case 'tool_execution_update': {
          // Partial/streaming tool output (e.g., bash stdout in real time).
          // Do NOT emit as stream.text() — that pollutes the assistant text
          // stream and causes raw tool output (file paths, bash lines) to
          // display as unformatted text in the web UI conversation view.
          // The complete result arrives via tool_execution_end → stream.toolResult()
          // which renders properly in structured tool blocks.
          break;
        }

        case 'tool_execution_end': {
          const ev = event as any;
          const resultText = extractToolResultText(ev.result);
          stream.toolResult(ev.toolName, resultText, !ev.isError, ev.toolCallId);

          if (FILE_TOOLS.has(ev.toolName)) {
            const args = (ev.toolCallId ? toolArgsMap.get(ev.toolCallId) : undefined) ?? {};
            const filePath = (args.path || args.file_path || args.filePath || '') as string;
            if (filePath) {
              const action = ev.toolName.toLowerCase().includes('create') ? 'created' : 'modified';
              stream.fileChange(filePath, action);
            }
          }
          if (ev.toolCallId) toolArgsMap.delete(ev.toolCallId);
          break;
        }

        case 'agent_end':
          if (options.includeLifecycle) {
            stream.status('running', 100, 'Completed');
          }
          break;

        case 'auto_compaction_start':
          stream.status('running', undefined, 'Compacting context');
          break;

        case 'auto_compaction_end': {
          const ev = event as any;
          if (ev.aborted || ev.errorMessage) {
            stream.status('running', undefined, `Compaction ${ev.aborted ? 'aborted' : 'failed'}`);
          }
          break;
        }

        case 'auto_retry_start': {
          const ev = event as any;
          stream.status('running', undefined, `Retrying (attempt ${ev.attempt}/${ev.maxAttempts})`);
          break;
        }

        case 'auto_retry_end': {
          const ev = event as any;
          if (!ev.success) {
            stream.text(`\n[Pi] Retry failed: ${ev.finalError ?? 'unknown error'}\n`);
          }
          break;
        }
      }
    });

    return { unsubscribe, getOutputText: () => outputText };
  }

  // ─── Multi-Turn Resume ─────────────────────────────────────────

  async resumeTask(
    taskId: string,
    message: string,
    _workingDirectory: string,
    _sessionId: string,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    if (signal.aborted) {
      return { success: false, output: '', error: 'Resume aborted' };
    }

    const preserved = this.preservedSessions.get(taskId);
    if (!preserved || Date.now() - preserved.createdAt > SESSION_TTL_MS) {
      if (preserved) this.preservedSessions.delete(taskId);
      return { success: false, output: '', error: 'No active Pi session for this task' };
    }

    this.activeTasks++;
    try {
      const { session } = preserved;

      const { unsubscribe, getOutputText } = this.subscribeToSessionEvents(
        session, stream, { includeLifecycle: false },
      );

      const abortHandler = () => { session.abort().catch(() => {}); };
      signal.addEventListener('abort', abortHandler, { once: true });

      let failed = false;
      try {
        await session.prompt(message, { streamingBehavior: 'followUp' });
        preserved.createdAt = Date.now();
      } catch (err) {
        failed = true;
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.lastError = errorMsg;
        return { success: false, output: getOutputText(), error: errorMsg };
      } finally {
        signal.removeEventListener('abort', abortHandler);
        unsubscribe();
      }

      return { success: !failed, output: getOutputText() };
    } finally {
      this.activeTasks--;
    }
  }

  async injectMessage(): Promise<boolean> {
    return false;
  }

  getTaskContext(taskId: string): { sessionId: string; workingDirectory: string; originalWorkingDirectory?: string } | null {
    const preserved = this.preservedSessions.get(taskId);
    if (!preserved) return null;
    if (Date.now() - preserved.createdAt > SESSION_TTL_MS) {
      this.preservedSessions.delete(taskId);
      return null;
    }
    return {
      sessionId: taskId,
      workingDirectory: preserved.workingDirectory || '',
      originalWorkingDirectory: preserved.originalWorkingDirectory,
    };
  }

  setOriginalWorkingDirectory(taskId: string, originalDir: string): void {
    const preserved = this.preservedSessions.get(taskId);
    if (preserved) {
      preserved.originalWorkingDirectory = originalDir;
    }
  }

  // ─── Summary Generation ──────────────────────────────────────

  async generateSummary(taskId: string, workingDirectory?: string): Promise<ExecutionSummary | undefined> {
    const preserved = this.preservedSessions.get(taskId);
    if (!preserved) return undefined;

    const summaryAbort = new AbortController();
    const summaryTimeout = setTimeout(() => {
      console.warn(`[pi] Task ${taskId}: summary generation timed out after ${SUMMARY_TIMEOUT_MS}ms`);
      summaryAbort.abort();
    }, SUMMARY_TIMEOUT_MS);

    try {
      const result = await this.resumeTask(
        taskId,
        SUMMARY_PROMPT,
        workingDirectory || preserved.workingDirectory || '',
        taskId,
        createNoopStream(),
        summaryAbort.signal,
      );

      if (!result.success || !result.output) return undefined;
      return parseSummaryResponse(result.output, `[pi] Task ${taskId}`);
    } finally {
      clearTimeout(summaryTimeout);
    }
  }

  // ─── Session Cleanup ─────────────────────────────────────────

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [key, preserved] of this.preservedSessions) {
      if (now - preserved.createdAt > SESSION_TTL_MS) {
        preserved.session.abort().catch(() => {});
        this.preservedSessions.delete(key);
      }
    }
  }
}
