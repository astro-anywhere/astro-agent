/**
 * OpenCode provider adapter
 *
 * Executes tasks using the OpenCode CLI in headless/print mode.
 *
 * CLI invocation:
 *   opencode run --print --output-format json "<task>"
 *
 * Output: JSONL streaming to stdout with event types similar to Claude Code:
 *   system, assistant, tool_result, result
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Task, TaskResult, TaskArtifact } from '../types.js';
import type { ProviderAdapter, TaskOutputStream, ProviderStatus } from './base-adapter.js';
import { getProvider } from '../lib/providers.js';

export class OpenCodeAdapter implements ProviderAdapter {
  readonly type = 'opencode';
  readonly name = 'OpenCode';

  private activeTasks = 0;
  private maxTasks = 1;
  private lastError?: string;
  private opencodePath: string | null = null;
  private configModel: string | null = null;
  private lastResultMetrics?: TaskResult['metrics'];
  /** Maps tool_use_id → tool name for correlating tool_use with tool_result */
  private toolIdToName = new Map<string, string>();

  async isAvailable(): Promise<boolean> {
    const provider = await getProvider('opencode');
    if (provider?.available) {
      this.opencodePath = provider.path;
      this.configModel = this.readConfigModel();
      return true;
    }
    return false;
  }

  /**
   * Read the default model from ~/.opencode/config.json
   */
  private readConfigModel(): string | null {
    try {
      const configPath = join(homedir(), '.opencode', 'config.json');
      if (!existsSync(configPath)) return null;
      const content = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content) as { model?: string };
      return config.model ?? null;
    } catch {
      return null;
    }
  }

  async execute(task: Task, stream: TaskOutputStream, signal: AbortSignal): Promise<TaskResult> {
    if (!this.opencodePath) {
      const available = await this.isAvailable();
      if (!available) {
        return {
          taskId: task.id,
          status: 'failed',
          error: 'OpenCode not available',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      }
    }

    this.activeTasks++;
    const startedAt = new Date().toISOString();

    try {
      stream.status('running', 0, 'Starting OpenCode');

      this.lastResultMetrics = undefined;
      this.toolIdToName.clear();
      const result = await this.runOpenCode(task, stream, signal);

      return {
        taskId: task.id,
        status: result.exitCode === 0 ? 'completed' : 'failed',
        exitCode: result.exitCode,
        output: result.output,
        error: result.error,
        startedAt,
        completedAt: new Date().toISOString(),
        artifacts: result.artifacts,
        metrics: this.lastResultMetrics,
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
    const provider = await getProvider('opencode');

    return {
      available,
      version: provider?.version ?? null,
      activeTasks: this.activeTasks,
      maxTasks: this.maxTasks,
      lastError: this.lastError,
    };
  }

  private runOpenCode(
    task: Task,
    stream: TaskOutputStream,
    signal: AbortSignal
  ): Promise<{ exitCode: number; output: string; error?: string; artifacts?: TaskArtifact[] }> {
    return new Promise((resolve, reject) => {
      // OpenCode CLI: run --print --output-format json
      // --print: Non-interactive mode (no TUI)
      // --output-format json: JSONL streaming output
      const model = task.model || this.configModel;

      const args = [
        'run',
        '--print',
        '--output-format', 'json',
        ...(model ? ['--model', model] : []),
        task.prompt,
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
        proc = spawn(this.opencodePath!, args, {
          cwd: task.workingDirectory || undefined,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }

      // Close stdin immediately
      proc.stdin?.end();

      let stdout = '';
      let stderr = '';
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
            this.handleStreamLine(line, stream);
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
          this.handleStreamLine(lineBuf, stream);
        }

        signal.removeEventListener('abort', abortHandler);

        resolve({
          exitCode: code ?? 1,
          output: stdout,
          error: stderr || undefined,
          artifacts: artifacts.length > 0 ? artifacts : undefined,
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
   * Handle a single JSONL line from OpenCode's streaming output.
   *
   * OpenCode events follow a pattern similar to Claude Code's stream-json:
   * - system         → sessionInit (session_id, model)
   * - assistant      → text + tool_use content blocks
   * - tool_result    → tool results
   * - result         → final metrics (cost, tokens, turns)
   */
  /** Extract tool_result content blocks from an event and emit toolResult calls. */
  handleToolResultBlocks(
    event: Record<string, unknown>,
    stream: TaskOutputStream,
  ): void {
    const content = Array.isArray(event.content) ? event.content as Array<{
      type: string;
      tool_use_id?: string;
      content?: string;
      is_error?: boolean;
    }> : undefined;

    const message = event.message as {
      content?: Array<{
        type: string;
        tool_use_id?: string;
        content?: string;
        is_error?: boolean;
      }>;
    } | undefined;

    const blocks = content || message?.content;
    if (blocks) {
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const toolName = (block.tool_use_id && this.toolIdToName.get(block.tool_use_id)) ?? 'unknown';
          stream.toolResult(
            toolName,
            block.content || '',
            !block.is_error,
          );
        }
      }
    }
  }

  handleStreamLine(
    line: string,
    stream: TaskOutputStream,
  ): void {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = event.type as string;

      switch (type) {
        case 'system': {
          // Init event — extract session info
          const sessionId = event.session_id as string | undefined;
          const model = event.model as string | undefined;
          if (sessionId) {
            stream.sessionInit(sessionId, model);
          }
          break;
        }

        case 'assistant': {
          // Assistant message with content blocks
          const content = event.content as Array<{
            type: string;
            id?: string;
            text?: string;
            name?: string;
            input?: unknown;
          }> | undefined;

          // Also handle message wrapper format
          const message = event.message as {
            content?: Array<{
              type: string;
              id?: string;
              text?: string;
              name?: string;
              input?: unknown;
            }>;
          } | undefined;

          const blocks = content || message?.content;
          if (blocks) {
            for (const block of blocks) {
              if (block.type === 'text' && block.text) {
                stream.text(block.text + '\n');
              } else if (block.type === 'tool_use') {
                if (block.id && block.name) {
                  this.toolIdToName.set(block.id, block.name);
                }
                stream.toolUse(block.name ?? 'unknown', block.input);
              }
            }
          }
          break;
        }

        case 'tool_result': {
          // Direct tool_result format: { type: 'tool_result', tool_name, content, is_error }
          if (typeof event.content === 'string' || !event.content) {
            const toolName = event.tool_name as string || 'unknown';
            const resultContent = (event.content as string) || '';
            const isError = event.is_error as boolean || false;
            stream.toolResult(toolName, resultContent, !isError);
            break;
          }
          // Content is an array — handle via content blocks (same as 'user')
          this.handleToolResultBlocks(event, stream);
          break;
        }

        case 'user': {
          this.handleToolResultBlocks(event, stream);
          break;
        }

        case 'result': {
          // Final result — extract cost/usage metrics
          const cost = (event.total_cost_usd ?? event.cost_usd ?? event.cost) as number | undefined;
          const numTurns = (event.num_turns ?? event.turns) as number | undefined;
          const durationMs = (event.duration_ms ?? event.duration_api_ms) as number | undefined;
          const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          const tokens = event.tokens as { input?: number; output?: number } | undefined;
          const model = event.model as string | undefined;

          this.lastResultMetrics = {
            inputTokens: usage?.input_tokens ?? tokens?.input,
            outputTokens: usage?.output_tokens ?? tokens?.output,
            totalCost: cost,
            numTurns,
            durationMs,
            model,
          };

          if (cost !== undefined) {
            stream.status('running', 100, `Completed (${numTurns ?? 0} turns, $${cost.toFixed(4)})`);
          } else {
            stream.status('running', 100, 'Completed');
          }
          break;
        }

        default:
          // Unknown event type — skip
          break;
      }
    } catch {
      // Not valid JSON — send as raw text
      stream.stdout(line);
    }
  }
}
