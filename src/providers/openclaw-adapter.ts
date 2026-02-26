/**
 * OpenClaw provider adapter
 *
 * Executes tasks using the OpenClaw CLI in RPC/JSON streaming mode.
 *
 * CLI invocation:
 *   openclaw agent --mode rpc --json --prompt "<task>"
 *
 * Output: JSONL streaming to stdout with event types:
 *   session.start, content.text, tool_use.start, tool_use.end,
 *   file.change, message.start, message.end, session.end
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Task, TaskResult, TaskArtifact } from '../types.js';
import type { ProviderAdapter, TaskOutputStream, ProviderStatus } from './base-adapter.js';
import { getProvider } from '../lib/providers.js';

export class OpenClawAdapter implements ProviderAdapter {
  readonly type = 'openclaw';
  readonly name = 'OpenClaw';

  private activeTasks = 0;
  private maxTasks = 1;
  private lastError?: string;
  private openclawPath: string | null = null;
  private configModel: string | null = null;

  async isAvailable(): Promise<boolean> {
    const provider = await getProvider('openclaw');
    if (provider?.available) {
      this.openclawPath = provider.path;
      this.configModel = this.readConfigModel();
      return true;
    }
    return false;
  }

  /**
   * Read the default model from ~/.openclaw/config.json
   */
  private readConfigModel(): string | null {
    try {
      const configPath = join(homedir(), '.openclaw', 'config.json');
      if (!existsSync(configPath)) return null;
      const content = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content) as { model?: string };
      return config.model ?? null;
    } catch {
      return null;
    }
  }

  async execute(task: Task, stream: TaskOutputStream, signal: AbortSignal): Promise<TaskResult> {
    if (!this.openclawPath) {
      const available = await this.isAvailable();
      if (!available) {
        return {
          taskId: task.id,
          status: 'failed',
          error: 'OpenClaw not available',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      }
    }

    this.activeTasks++;
    const startedAt = new Date().toISOString();

    try {
      stream.status('running', 0, 'Starting OpenClaw');

      const result = await this.runOpenClaw(task, stream, signal);

      return {
        taskId: task.id,
        status: result.exitCode === 0 ? 'completed' : 'failed',
        exitCode: result.exitCode,
        output: result.output,
        error: result.error,
        startedAt,
        completedAt: new Date().toISOString(),
        artifacts: result.artifacts,
        metrics: result.metrics,
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
    const provider = await getProvider('openclaw');

    return {
      available,
      version: provider?.version ?? null,
      activeTasks: this.activeTasks,
      maxTasks: this.maxTasks,
      lastError: this.lastError,
    };
  }

  private runOpenClaw(
    task: Task,
    stream: TaskOutputStream,
    signal: AbortSignal
  ): Promise<{
    exitCode: number;
    output: string;
    error?: string;
    artifacts?: TaskArtifact[];
    metrics?: TaskResult['metrics'];
  }> {
    return new Promise((resolve, reject) => {
      // OpenClaw CLI: agent --mode rpc --json
      // --mode rpc: Non-interactive RPC mode (no TUI)
      // --json: JSONL streaming output to stdout
      const model = task.model || this.configModel;

      // Combine systemPrompt with prompt when provided (e.g., interactive plan sessions)
      const effectivePrompt = task.systemPrompt
        ? `${task.systemPrompt}\n\n---\n\n${task.prompt}`
        : task.prompt;

      const args = [
        'agent',
        '--mode', 'rpc',
        '--json',
        ...(model ? ['--model', model] : []),
        '--prompt', effectivePrompt,
      ];

      const env = {
        ...process.env,
        ...task.environment,
      };

      // Validate working directory exists before spawning
      if (task.workingDirectory && !existsSync(task.workingDirectory)) {
        reject(new Error(
          `Working directory does not exist: ${task.workingDirectory}. ` +
          `Ensure the directory exists on this machine before dispatching.`
        ));
        return;
      }

      let proc: ChildProcess;

      try {
        proc = spawn(this.openclawPath!, args, {
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
      let lastMetrics: TaskResult['metrics'] | undefined;
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

      // Line buffer for incomplete JSONL lines
      let lineBuf = '';

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;

        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            const metrics = this.handleStreamLine(line, stream, artifacts);
            if (metrics) {
              lastMetrics = metrics;
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
        reject(error);
      });

      proc.on('close', (code) => {
        // Flush remaining buffer
        if (lineBuf.trim()) {
          const metrics = this.handleStreamLine(lineBuf, stream, artifacts);
          if (metrics) {
            lastMetrics = metrics;
          }
        }

        signal.removeEventListener('abort', abortHandler);

        resolve({
          exitCode: code ?? 1,
          output: stdout,
          error: stderr || undefined,
          artifacts: artifacts.length > 0 ? artifacts : undefined,
          metrics: lastMetrics,
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
   * Handle a single JSONL line from OpenClaw's RPC output.
   *
   * OpenClaw JSONL event types:
   * - session.start     → sessionInit
   * - content.text      → text output
   * - tool_use.start    → toolUse
   * - tool_use.end      → toolResult
   * - file.change       → fileChange
   * - message.start     → status update (agent thinking)
   * - message.end       → status update (turn complete)
   * - session.end       → metrics extraction
   *
   * Returns metrics if a session.end event is processed.
   */
  handleStreamLine(
    line: string,
    stream: TaskOutputStream,
    artifacts: TaskArtifact[],
  ): TaskResult['metrics'] | undefined {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = event.type as string;

      switch (type) {
        case 'session.start': {
          const sessionId = event.session_id as string | undefined;
          const model = event.model as string | undefined;
          if (sessionId) {
            stream.sessionInit(sessionId, model);
          }
          break;
        }

        case 'message.start': {
          stream.status('running', undefined, 'Agent thinking...');
          break;
        }

        case 'content.text': {
          const text = event.text as string | undefined;
          if (text) {
            stream.text(text);
          }
          break;
        }

        case 'tool_use.start': {
          const toolName = event.tool_name as string || 'unknown';
          const toolInput = event.tool_input ?? {};
          stream.toolUse(toolName, toolInput);
          break;
        }

        case 'tool_use.end': {
          const toolName = event.tool_name as string || 'unknown';
          const result = event.result;
          const success = event.success !== false;
          stream.toolResult(toolName, result, success);
          break;
        }

        case 'file.change': {
          const path = event.path as string;
          const action = (event.action as 'created' | 'modified' | 'deleted') || 'modified';
          const linesAdded = event.lines_added as number | undefined;
          const linesRemoved = event.lines_removed as number | undefined;
          if (path) {
            stream.fileChange(path, action, linesAdded, linesRemoved);
            if (!artifacts.some((a) => a.path === path)) {
              artifacts.push({ type: 'file', name: path, path });
            }
          }
          break;
        }

        case 'message.end': {
          stream.status('running', undefined, 'Turn complete');
          break;
        }

        case 'session.end': {
          const cost = event.cost as number | undefined;
          const inputTokens = event.input_tokens as number | undefined;
          const outputTokens = event.output_tokens as number | undefined;
          const turns = event.turns as number | undefined;
          const model = event.model as string | undefined;
          const durationMs = event.duration_ms as number | undefined;

          if (cost !== undefined) {
            stream.status('running', 100, `Completed (${turns ?? 0} turns, $${cost.toFixed(4)})`);
          } else {
            stream.status('running', 100, 'Completed');
          }

          return {
            totalCost: cost,
            inputTokens,
            outputTokens,
            numTurns: turns,
            model,
            durationMs,
          };
        }

        default:
          // Unknown event type — skip silently
          break;
      }
    } catch {
      // Not valid JSON — send as raw stdout
      stream.stdout(line + '\n');
    }

    return undefined;
  }
}
