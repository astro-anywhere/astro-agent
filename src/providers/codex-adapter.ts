/**
 * OpenAI Codex CLI provider adapter
 *
 * Executes tasks using the Codex CLI
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeImagesToDir, cleanupImages } from '../lib/image-utils.js';
import type { Task, TaskResult, TaskArtifact } from '../types.js';
import type { ProviderAdapter, TaskOutputStream, ProviderStatus } from './base-adapter.js';
import { getProvider } from '../lib/providers.js';

/** Metrics shape extracted from TaskResult (non-optional) */
interface CodexMetrics {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalCost?: number;
  model?: string;
  numTurns?: number;
}

/** Active session state for steering/resume support */
interface ActiveSession {
  threadId: string;
  taskId: string;
  workingDirectory?: string;
  model?: string;
}

export class CodexAdapter implements ProviderAdapter {
  readonly type = 'codex';
  readonly name = 'OpenAI Codex';

  private activeTasks = 0;
  private maxTasks = 1;
  private lastError?: string;
  private codexPath: string | null = null;
  private configModel: string | null = null;

  /** Active sessions per task ID for steering/resume */
  private activeSessions = new Map<string, ActiveSession>();

  /**
   * Accumulated metrics from the current execution.
   * Populated by handleStreamLine() as usage events arrive,
   * then read by execute() when producing the final TaskResult.
   */
  private lastResultMetrics?: CodexMetrics;
  private turnCount = 0;
  /** Thread ID from the most recent execution (populated by handleStreamLine) */
  private lastThreadId?: string;

  async isAvailable(): Promise<boolean> {
    const provider = await getProvider('codex');
    if (provider?.available) {
      this.codexPath = provider.path;
      this.configModel = this.readConfigModel();
      return true;
    }
    return false;
  }

  /**
   * Read the default model from ~/.codex/config.toml
   */
  private readConfigModel(): string | null {
    try {
      const configPath = join(homedir(), '.codex', 'config.toml');
      if (!existsSync(configPath)) return null;
      const content = readFileSync(configPath, 'utf-8');
      // Simple TOML parsing for top-level model key: model = "gpt-5.3-codex"
      const match = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }

  async execute(task: Task, stream: TaskOutputStream, signal: AbortSignal): Promise<TaskResult> {
    if (!this.codexPath) {
      const available = await this.isAvailable();
      if (!available) {
        return {
          taskId: task.id,
          status: 'failed',
          error: 'Codex not available',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      }
    }

    this.activeTasks++;
    this.lastResultMetrics = undefined;
    this.turnCount = 0;
    this.lastThreadId = undefined;
    const startedAt = new Date().toISOString();

    try {
      stream.status('running', 0, 'Starting Codex');

      const result = await this.runCodex(task, stream, signal);

      // Store session for potential steering/resume
      if (this.lastThreadId) {
        this.activeSessions.set(task.id, {
          threadId: this.lastThreadId,
          taskId: task.id,
          workingDirectory: task.workingDirectory,
          model: result.model,
        });
      }

      // Build metrics from accumulated stream data + result model.
      // lastResultMetrics is populated by extractUsageFromEvent() during streaming.
      const finalMetrics = this.buildFinalMetrics(result.model, startedAt);

      return {
        taskId: task.id,
        status: result.exitCode === 0 ? 'completed' : 'failed',
        exitCode: result.exitCode,
        output: result.output,
        error: result.error,
        startedAt,
        completedAt: new Date().toISOString(),
        artifacts: result.artifacts,
        metrics: finalMetrics,
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
    const provider = await getProvider('codex');

    return {
      available,
      version: provider?.version ?? null,
      activeTasks: this.activeTasks,
      maxTasks: this.maxTasks,
      lastError: this.lastError,
    };
  }

  /**
   * Inject a steering message into a completed task's session.
   * Uses `codex exec resume <threadId> <message> --json` to continue the conversation.
   * Returns true if the message was successfully injected.
   */
  async injectMessage(taskId: string, _content: string, _interrupt = false): Promise<boolean> {
    const session = this.activeSessions.get(taskId);
    if (!session) {
      console.log(`[codex] Cannot inject message: no session for task ${taskId}`);
      return false;
    }
    // For Codex, injection means starting a new resume process.
    // The caller (resumeTask) handles the full lifecycle.
    // This is a simplified check — return true if we have a session.
    return true;
  }

  /**
   * Resume a completed Codex session to continue execution.
   * Uses `codex exec resume <threadId> <prompt> --json` for multi-turn conversations.
   */
  async resumeTask(
    taskId: string,
    message: string,
    workingDirectory: string,
    sessionId: string,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    if (!this.codexPath) {
      const available = await this.isAvailable();
      if (!available) {
        return { success: false, output: '', error: 'Codex not available' };
      }
    }

    // Use sessionId as the threadId (the Codex thread UUID)
    const threadId = sessionId;

    const isGitRepo = workingDirectory && existsSync(join(workingDirectory, '.git'));
    const model = this.activeSessions.get(taskId)?.model || this.configModel;

    const args = [
      'exec', 'resume',
      threadId,
      message,
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      ...(model ? ['-m', model] : []),
      ...(!isGitRepo ? ['--skip-git-repo-check'] : []),
    ];

    return new Promise((resolve) => {
      let proc: ChildProcess;

      try {
        proc = spawn(this.codexPath!, args, {
          cwd: workingDirectory || undefined,
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({
          success: false,
          output: '',
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      const artifacts: TaskArtifact[] = [];
      this.lastResultMetrics = undefined;
      this.turnCount = 0;

      const abortHandler = () => {
        proc.kill('SIGTERM');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
      };
      signal.addEventListener('abort', abortHandler);

      let lineBuf = '';
      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            this.handleStreamLine(line, stream, artifacts, model || undefined);
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        stream.stderr(data.toString());
      });

      proc.on('error', (error) => {
        signal.removeEventListener('abort', abortHandler);
        resolve({
          success: false,
          output: stdout,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      proc.on('close', (code) => {
        if (lineBuf.trim()) {
          this.handleStreamLine(lineBuf, stream, artifacts, model || undefined);
        }
        signal.removeEventListener('abort', abortHandler);
        resolve({
          success: code === 0,
          output: stdout,
          error: stderr || undefined,
        });
      });
    });
  }

  private async runCodex(
    task: Task,
    stream: TaskOutputStream,
    signal: AbortSignal
  ): Promise<{ exitCode: number; output: string; error?: string; artifacts?: TaskArtifact[]; model?: string }> {
    // Codex requires --skip-git-repo-check when running outside a git repository.
    // The task executor already handles git safety at a higher level (worktree creation,
    // safety checks), so we can safely allow non-git directories here.
    const isGitRepo = task.workingDirectory
      && existsSync(join(task.workingDirectory, '.git'));

    // Resolve model: task-level override > config file default
    const model = task.model || this.configModel;

    // Write images to temp files for the --image flag
    let imagePaths: string[] = [];
    if (task.images && task.images.length > 0) {
      const imageDir = join(task.workingDirectory || homedir(), '.astro', 'images');
      try {
        imagePaths = await writeImagesToDir(task.images, imageDir);
        console.log(`[codex] Wrote ${imagePaths.length} image(s) to ${imageDir}`);
      } catch (err) {
        console.warn(`[codex] Failed to write images to disk:`, err);
      }
    }

    return new Promise((resolve, reject) => {
      // Codex CLI: use `exec` subcommand for non-interactive execution
      // --json: structured JSONL output for parsing
      //
      // Sandbox policy: `-s danger-full-access` gives full filesystem + network access.
      // Note: `codex exec` does NOT support `-a` (approval flag) — that's only for
      // the interactive CLI. exec mode is non-interactive by default.
      //
      // `danger-full-access` enables network (git clone, pip install, etc.)
      // which `workspace-write` (used by --full-auto) blocks.
      // The task executor provides isolation at a higher level (worktree creation,
      // working directory restriction).

      // Build prompt: prepend systemPrompt when provided (e.g., interactive plan sessions).
      // Codex CLI's `exec` subcommand doesn't have a --system-prompt flag,
      // so we inline the system prompt into the user prompt.
      let effectivePrompt = task.systemPrompt
        ? `${task.systemPrompt}\n\n---\n\n${task.prompt}`
        : task.prompt;

      // Add image references if images were written to disk.
      // The --image flag may not be available in all Codex CLI versions,
      // so we also reference files in the prompt text as a fallback.
      if (imagePaths.length > 0) {
        const imageList = imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n');
        effectivePrompt += `\n\n---\n\n## Attached Images\n\nThe following ${imagePaths.length} image(s) from the task description have been saved to disk for your analysis:\n${imageList}`;
      }

      const args = [
        'exec',
        '-s', 'danger-full-access',       // Full filesystem + network access
        ...(model ? ['-m', model] : []),   // Explicit model selection
        ...(!isGitRepo ? ['--skip-git-repo-check'] : []),
        '--json',                         // JSONL output for structured parsing
        // Pass images via --image flag if available (Codex CLI feature)
        ...(imagePaths.length > 0 ? ['--image', imagePaths.join(',')] : []),
        effectivePrompt,
      ];

      const env = {
        ...process.env,
        ...task.environment,
      };

      let proc: ChildProcess;

      // Validate working directory exists before spawning.
      // Node.js spawn throws a misleading "ENOENT" (which looks like the
      // binary is missing) when the cwd doesn't exist.
      if (task.workingDirectory && !existsSync(task.workingDirectory)) {
        reject(new Error(
          `Working directory does not exist: ${task.workingDirectory}. ` +
          `Ensure the directory exists on this machine before dispatching.`
        ));
        return;
      }

      try {
        proc = spawn(this.codexPath!, args, {
          cwd: task.workingDirectory || undefined,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }

      let stdout = '';
      let stderr = '';
      let detectedModel: string | undefined = model || undefined;
      const artifacts: TaskArtifact[] = [];

      const abortHandler = () => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 5000);
      };

      signal.addEventListener('abort', abortHandler);

      // Line buffer for incomplete JSONL lines (data chunks don't
      // align with line boundaries)
      let lineBuf = '';

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;

        // Parse JSONL lines and emit structured events
        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || ''; // keep incomplete last line in buffer
        for (const line of lines) {
          if (line.trim()) {
            this.handleStreamLine(line, stream, artifacts, detectedModel);
            // Extract model from any event that has it
            if (!detectedModel) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.model && typeof parsed.model === 'string') {
                  detectedModel = parsed.model;
                }
              } catch { /* not JSON, skip */ }
            }
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        stream.stderr(text);
      });

      proc.on('error', (error) => {
        signal.removeEventListener('abort', abortHandler);
        if (imagePaths.length > 0) {
          cleanupImages(imagePaths).catch(() => {});
        }
        reject(error);
      });

      proc.on('close', (code) => {
        // Flush remaining buffer
        if (lineBuf.trim()) {
          this.handleStreamLine(lineBuf, stream, artifacts, detectedModel);
        }

        signal.removeEventListener('abort', abortHandler);

        // Also extract artifacts from heuristic patterns in raw output
        this.extractArtifacts(stdout, artifacts);

        // Clean up temp image files
        if (imagePaths.length > 0) {
          cleanupImages(imagePaths).catch(() => {});
        }

        resolve({
          exitCode: code ?? 1,
          output: stdout,
          error: stderr || undefined,
          artifacts: artifacts.length > 0 ? artifacts : undefined,
          model: detectedModel,
        });
      });

      if (task.timeout) {
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGTERM');
            setTimeout(() => {
              if (!proc.killed) {
                proc.kill('SIGKILL');
              }
            }, 5000);
          }
        }, task.timeout);
      }
    });
  }

  /**
   * Build the final metrics object from accumulated stream data.
   * Called after runCodex() completes, when this.lastResultMetrics
   * has been populated by extractUsageFromEvent() during streaming.
   */
  private buildFinalMetrics(resultModel: string | undefined, startedAt: string): CodexMetrics | undefined {
    const durationMs = Date.now() - new Date(startedAt).getTime();
    const accum = this.lastResultMetrics;
    const model = resultModel || accum?.model;
    const metrics: CodexMetrics = {
      inputTokens: accum?.inputTokens,
      outputTokens: accum?.outputTokens,
      totalCost: accum?.totalCost,
      model,
      durationMs,
      numTurns: this.turnCount || accum?.numTurns,
    };

    // Only include metrics if we have meaningful data
    const hasMetrics = model || metrics.inputTokens || metrics.outputTokens || metrics.totalCost;
    return hasMetrics ? metrics : undefined;
  }

  /**
   * Handle a single JSON line from Codex CLI's --json JSONL output.
   *
   * Codex JSONL event types:
   * - thread.started     → sessionInit (thread_id)
   * - turn.started       → status update, turn counter
   * - turn.completed     → may contain usage data
   * - item.started       → toolUse for command_execution
   * - item.completed     → text for reasoning/agent_message, toolResult for command_execution
   * - response.completed → final usage summary (input_tokens, output_tokens, total_tokens)
   */
  private handleStreamLine(
    line: string,
    stream: TaskOutputStream,
    artifacts: TaskArtifact[],
    model?: string,
  ): void {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = event.type as string;

      // Extract usage from any event that carries it (OpenAI Responses API pattern).
      // This catches both `response.completed` and `turn.completed` events.
      this.extractUsageFromEvent(event);

      switch (type) {
        case 'thread.started': {
          // Session init — extract thread_id and pass model
          const threadId = event.thread_id as string | undefined;
          if (threadId) {
            this.lastThreadId = threadId;
            stream.sessionInit(threadId, model);
          }
          break;
        }

        case 'turn.started': {
          this.turnCount++;
          stream.status('running', undefined, 'Agent thinking...');
          break;
        }

        case 'response.completed': {
          // Final response event — log fields for debugging token extraction
          const eventKeys = Object.keys(event).filter(k => k !== 'type').sort();
          console.log(`[codex] response.completed fields: ${eventKeys.join(', ')}`);

          // Extract usage from response object if present
          const response = event.response as Record<string, unknown> | undefined;
          if (response) {
            this.extractUsageFromEvent(response);
            const responseKeys = Object.keys(response).sort();
            console.log(`[codex] response object fields: ${responseKeys.join(', ')}`);
          }

          // Log accumulated metrics
          if (this.lastResultMetrics) {
            console.log(`[codex] Accumulated metrics: input_tokens=${this.lastResultMetrics.inputTokens}, output_tokens=${this.lastResultMetrics.outputTokens}, total_cost=${this.lastResultMetrics.totalCost}`);
          } else {
            console.log(`[codex] No usage metrics found in response.completed`);
          }
          break;
        }

        case 'item.started': {
          // Emit toolUse for command_execution items that are starting
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === 'command_execution') {
            const command = item.command as string || '';
            stream.toolUse(command, { command, status: 'in_progress' });
          }
          break;
        }

        case 'item.completed': {
          const item = event.item as Record<string, unknown> | undefined;
          if (!item) break;

          const itemType = item.type as string;

          switch (itemType) {
            case 'reasoning': {
              // Reasoning text — send as structured text with a marker
              const text = item.text as string;
              if (text) {
                stream.text(`[thinking] ${text}\n`);
              }
              break;
            }

            case 'agent_message': {
              // Agent response text
              const text = item.text as string;
              if (text) {
                stream.text(text + '\n');
              }
              break;
            }

            case 'command_execution': {
              // Completed command — emit toolResult
              const command = item.command as string || '';
              const output = item.aggregated_output as string || '';
              const exitCode = item.exit_code as number | null;
              const status = item.status as string;
              const success = exitCode === 0 || status === 'completed';

              stream.toolResult(
                command,
                { output, exit_code: exitCode, status },
                success,
              );

              // Extract file artifacts from command output
              this.extractFileArtifactsFromCommand(command, output, artifacts);
              break;
            }

            case 'file_change': {
              // Codex native file edit events (patches applied without shell commands)
              const changes = item.changes as Array<{ path: string; kind: string }> | undefined;
              if (changes && Array.isArray(changes)) {
                for (const change of changes) {
                  const action = change.kind === 'create' ? 'created'
                    : change.kind === 'delete' ? 'deleted'
                    : 'modified';
                  stream.fileChange(change.path, action);
                }
              }
              break;
            }

            default:
              // Unknown item type — forward as raw text if it has content
              if (item.text && typeof item.text === 'string') {
                stream.text(item.text as string + '\n');
              }
              break;
          }
          break;
        }

        default:
          // Unknown event type — skip silently
          break;
      }
    } catch {
      // Not valid JSON — send as raw stdout
      stream.stdout(line + '\n');
    }
  }

  /**
   * Extract token usage metrics from a Codex JSONL event object.
   *
   * Codex CLI (using the OpenAI Responses API) may include usage data in:
   * - Top-level `usage` field: `{ input_tokens, output_tokens, total_tokens }`
   * - Nested `response.usage` field on `response.completed` events
   * - `total_cost` or `cost_usd` at the event or response level
   *
   * This method is called on every parsed event, accumulating the latest usage
   * data into `lastResultMetrics`. Later events overwrite earlier ones, so
   * `response.completed` (which appears last) provides the authoritative totals.
   */
  private extractUsageFromEvent(event: Record<string, unknown>): void {
    // Check for usage object (OpenAI Responses API format)
    const usage = event.usage as {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    } | undefined;

    if (usage && (usage.input_tokens != null || usage.output_tokens != null)) {
      if (!this.lastResultMetrics) {
        this.lastResultMetrics = {};
      }
      if (usage.input_tokens != null) {
        this.lastResultMetrics.inputTokens = usage.input_tokens;
      }
      if (usage.output_tokens != null) {
        this.lastResultMetrics.outputTokens = usage.output_tokens;
      }
    }

    // Check for cost fields (may be present on response.completed or top-level)
    const totalCost = (event.total_cost ?? event.total_cost_usd ?? event.cost_usd) as number | undefined;
    if (totalCost != null) {
      if (!this.lastResultMetrics) {
        this.lastResultMetrics = {};
      }
      this.lastResultMetrics.totalCost = totalCost;
    }

    // Check for model field
    const eventModel = event.model as string | undefined;
    if (eventModel) {
      if (!this.lastResultMetrics) {
        this.lastResultMetrics = {};
      }
      this.lastResultMetrics.model = eventModel;
    }
  }

  /**
   * Extract file artifacts from command execution output.
   * Looks at both the command itself and its output for file creation/modification signals.
   */
  private extractFileArtifactsFromCommand(
    command: string,
    output: string,
    artifacts: TaskArtifact[],
  ): void {
    // Extract files from common write commands in the command string
    const writeCommandPatterns = [
      /cat\s*>\s*(\S+)/g,                  // cat > file
      /tee\s+(\S+)/g,                      // tee file
      /(?:cp|mv)\s+\S+\s+(\S+)/g,         // cp/mv src dest
      /mkdir\s+-p?\s*(\S+)/g,             // mkdir -p dir
      /touch\s+(\S+)/g,                    // touch file
    ];

    for (const pattern of writeCommandPatterns) {
      let match;
      while ((match = pattern.exec(command)) !== null) {
        const filePath = match[1]?.trim().replace(/['"]/g, '');
        if (filePath && !artifacts.some((a) => a.path === filePath)) {
          artifacts.push({ type: 'file', name: filePath, path: filePath });
        }
      }
    }

    // Also check output for file creation messages
    this.extractArtifacts(output, artifacts);
  }

  private extractArtifacts(output: string, artifacts: TaskArtifact[]): void {
    // Look for common patterns indicating file creation/modification
    // This is a heuristic approach as Codex output format may vary
    const filePatterns = [
      /Created file: (.+)/gi,
      /Writing to (.+)/gi,
      /Modified: (.+)/gi,
      /Wrote (.+)/gi,
    ];

    for (const pattern of filePatterns) {
      let match;
      while ((match = pattern.exec(output)) !== null) {
        const filePath = match[1]?.trim();
        if (filePath && !artifacts.some((a) => a.path === filePath)) {
          artifacts.push({
            type: 'file',
            name: filePath,
            path: filePath,
          });
        }
      }
    }
  }
}
