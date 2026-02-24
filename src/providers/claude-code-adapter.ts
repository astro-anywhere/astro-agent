/**
 * Claude Code provider adapter
 *
 * Executes tasks using the Claude Code CLI (claude command)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Task, TaskResult, TaskArtifact } from '../types.js';
import type { ProviderAdapter, TaskOutputStream, ProviderStatus } from './base-adapter.js';
import { getProvider } from '../lib/providers.js';

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly type = 'claude-code';
  readonly name = 'Claude Code';

  private activeTasks = 0;
  private maxTasks = 1; // Claude Code runs one task at a time
  private lastError?: string;
  private claudePath: string | null = null;
  private lastResultMetrics?: TaskResult['metrics'];
  /** Maps tool_use_id → tool name for correlating tool_use with tool_result */
  private toolIdToName = new Map<string, string>();

  async isAvailable(): Promise<boolean> {
    const provider = await getProvider('claude-code');
    if (provider?.available) {
      this.claudePath = provider.path;
      return true;
    }
    return false;
  }

  async execute(task: Task, stream: TaskOutputStream, signal: AbortSignal): Promise<TaskResult> {
    if (!this.claudePath) {
      const available = await this.isAvailable();
      if (!available) {
        return {
          taskId: task.id,
          status: 'failed',
          error: 'Claude Code not available',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      }
    }

    this.activeTasks++;
    const startedAt = new Date().toISOString();

    try {
      stream.status('running', 0, 'Starting Claude Code');

      this.lastResultMetrics = undefined;
      this.toolIdToName.clear();
      const result = await this.runClaude(task, stream, signal);

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
    const provider = await getProvider('claude-code');

    return {
      available,
      version: provider?.version ?? null,
      activeTasks: this.activeTasks,
      maxTasks: this.maxTasks,
      lastError: this.lastError,
    };
  }

  private runClaude(
    task: Task,
    stream: TaskOutputStream,
    signal: AbortSignal
  ): Promise<{ exitCode: number; output: string; error?: string; artifacts?: TaskArtifact[] }> {
    return new Promise((resolve, reject) => {
      // Claude Code CLI: --print = fully autonomous non-interactive mode
      // No approval prompts, no terminal interaction.
      // Code executes locally on the host machine (not on Anthropic's cloud).
      const args = [
        '--print', // Fully autonomous — no permission prompts, runs to completion
        '--verbose', // Required for stream-json with --print
        '--output-format', 'stream-json', // JSON streaming output for structured parsing
      ];

      // Claude Code expects the prompt as the last argument or via stdin
      // We'll pass it as an argument for simplicity
      args.push(task.prompt);

      const env = {
        ...process.env,
        ...task.environment,
      };

      let proc: ChildProcess;

      console.log(`[claude-code] Spawning: ${this.claudePath} --print --output-format stream-json <prompt>`);
      console.log(`[claude-code] cwd: ${task.workingDirectory}`);
      console.log(`[claude-code] prompt length: ${task.prompt.length} chars`);

      try {
        proc = spawn(this.claudePath!, args, {
          cwd: task.workingDirectory,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        console.error(`[claude-code] Spawn failed:`, error);
        reject(error);
        return;
      }

      // Close stdin immediately - we pass the prompt as an argument, not via stdin
      proc.stdin?.end();

      console.log(`[claude-code] Process spawned, pid=${proc.pid}`);

      let stdout = '';
      let stderr = '';
      const artifacts: TaskArtifact[] = [];

      // Handle abort signal
      const abortHandler = () => {
        proc.kill('SIGTERM');
        // Give it a moment, then force kill
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 5000);
      };

      signal.addEventListener('abort', abortHandler);

      let lineBuf = '';
      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;

        // Parse stream-json lines and forward only meaningful content
        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || ''; // keep incomplete last line in buffer
        for (const line of lines) {
          if (line.trim()) {
            this.handleStreamLine(line, stream);
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        console.log(`[claude-code] stderr: ${text.slice(0, 200)}`);
        stderr += text;
        stream.stderr(text);
      });

      proc.on('error', (error) => {
        console.error(`[claude-code] Process error:`, error);
        signal.removeEventListener('abort', abortHandler);
        reject(error);
      });

      proc.on('close', (code) => {
        // Flush remaining buffer
        if (lineBuf.trim()) {
          this.handleStreamLine(lineBuf, stream);
        }
        console.log(`[claude-code] Process exited with code ${code}, stdout=${stdout.length} chars, stderr=${stderr.length} chars`);
        signal.removeEventListener('abort', abortHandler);

        resolve({
          exitCode: code ?? 1,
          output: stdout,
          error: stderr || undefined,
          artifacts: artifacts.length > 0 ? artifacts : undefined,
        });
      });

      // Set up timeout if specified
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
   * Handle a single JSON line from Claude Code's stream-json output.
   * Extracts human-readable text and structured events, forwarding only
   * meaningful content to the stream (not raw JSON).
   */
  private handleStreamLine(
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
          const message = event.message as { content?: Array<{ type: string; id?: string; text?: string; name?: string; input?: unknown }> } | undefined;
          if (message?.content) {
            for (const block of message.content) {
              if (block.type === 'text' && block.text) {
                // Use structured text instead of raw stdout
                stream.text(block.text + '\n');
              } else if (block.type === 'tool_use') {
                // Record id → name mapping for correlating with tool_result
                if (block.id && block.name) {
                  this.toolIdToName.set(block.id, block.name);
                }
                // Send structured tool use for the Tools panel
                stream.toolUse(block.name ?? 'unknown', block.input);
              }
            }
          }
          break;
        }

        case 'user': {
          // Tool results
          const message = event.message as { content?: Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }> } | undefined;
          const toolResultData = event.tool_use_result as { stdout?: string; stderr?: string } | undefined;

          // Send structured tool result for the Tools panel
          if (message?.content) {
            for (const block of message.content) {
              if (block.type === 'tool_result') {
                const resultContent = toolResultData?.stdout || block.content || '';
                // Look up the actual tool name from the tool_use_id → name map
                const toolName = (block.tool_use_id && this.toolIdToName.get(block.tool_use_id)) ?? 'unknown';
                stream.toolResult(
                  toolName,
                  resultContent,
                  !block.is_error,
                );
              }
            }
          }

          if (toolResultData?.stderr) {
            stream.stderr(toolResultData.stderr);
          }
          break;
        }

        case 'result': {
          // Final result — don't send text (already streamed via assistant events)
          // Extract cost/usage info and metrics
          // Claude Code CLI may use `cost_usd` or `total_cost_usd` depending on version
          const cost = (event.total_cost_usd ?? event.cost_usd) as number | undefined;
          const numTurns = event.num_turns as number | undefined;
          const durationMs = (event.duration_ms ?? event.duration_api_ms) as number | undefined;
          const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          const model = event.model as string | undefined;

          // Log result event fields for debugging token extraction
          const eventKeys = Object.keys(event).filter(k => k !== 'result').sort();
          console.log(`[claude-code] Result event fields: ${eventKeys.join(', ')}`);
          if (usage) {
            console.log(`[claude-code] Usage: input_tokens=${usage.input_tokens}, output_tokens=${usage.output_tokens}`);
          } else {
            console.log(`[claude-code] No usage field found on result event`);
          }

          this.lastResultMetrics = {
            inputTokens: usage?.input_tokens,
            outputTokens: usage?.output_tokens,
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
