/**
 * OpenAI Codex CLI provider adapter
 *
 * Executes tasks using the Codex CLI
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Task, TaskResult, TaskArtifact } from '../types.js';
import type { ProviderAdapter, TaskOutputStream, ProviderStatus } from './base-adapter.js';
import { getProvider } from '../lib/providers.js';

export class CodexAdapter implements ProviderAdapter {
  readonly type = 'codex';
  readonly name = 'OpenAI Codex';

  private activeTasks = 0;
  private maxTasks = 1;
  private lastError?: string;
  private codexPath: string | null = null;
  private configModel: string | null = null;

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
    const startedAt = new Date().toISOString();

    try {
      stream.status('running', 0, 'Starting Codex');

      const result = await this.runCodex(task, stream, signal);

      return {
        taskId: task.id,
        status: result.exitCode === 0 ? 'completed' : 'failed',
        exitCode: result.exitCode,
        output: result.output,
        error: result.error,
        startedAt,
        completedAt: new Date().toISOString(),
        artifacts: result.artifacts,
        metrics: result.model ? { model: result.model } : undefined,
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

  private runCodex(
    task: Task,
    stream: TaskOutputStream,
    signal: AbortSignal
  ): Promise<{ exitCode: number; output: string; error?: string; artifacts?: TaskArtifact[]; model?: string }> {
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

      // Codex requires --skip-git-repo-check when running outside a git repository.
      // The task executor already handles git safety at a higher level (worktree creation,
      // safety checks), so we can safely allow non-git directories here.
      const isGitRepo = task.workingDirectory
        && existsSync(join(task.workingDirectory, '.git'));

      // Resolve model: task-level override > config file default
      const model = task.model || this.configModel;

      const args = [
        'exec',
        '-s', 'danger-full-access',       // Full filesystem + network access
        ...(model ? ['-m', model] : []),   // Explicit model selection
        ...(!isGitRepo ? ['--skip-git-repo-check'] : []),
        '--json',                         // JSONL output for structured parsing
        task.prompt,
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
   * Handle a single JSON line from Codex CLI's --json JSONL output.
   *
   * Codex JSONL event types:
   * - thread.started   → sessionInit (thread_id)
   * - turn.started     → status update
   * - item.started     → toolUse for command_execution
   * - item.completed   → text for reasoning/agent_message, toolResult for command_execution
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

      switch (type) {
        case 'thread.started': {
          // Session init — extract thread_id and pass model
          const threadId = event.thread_id as string | undefined;
          if (threadId) {
            stream.sessionInit(threadId, model);
          }
          break;
        }

        case 'turn.started': {
          stream.status('running', undefined, 'Agent thinking...');
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
