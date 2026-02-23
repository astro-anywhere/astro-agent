/**
 * OpenAI Codex CLI provider adapter
 *
 * Executes tasks using the Codex CLI
 */

import { spawn, type ChildProcess } from 'node:child_process';
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

  async isAvailable(): Promise<boolean> {
    const provider = await getProvider('codex');
    if (provider?.available) {
      this.codexPath = provider.path;
      return true;
    }
    return false;
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
  ): Promise<{ exitCode: number; output: string; error?: string; artifacts?: TaskArtifact[] }> {
    return new Promise((resolve, reject) => {
      // Codex CLI: use `exec` subcommand for non-interactive execution
      // -a never: fully autonomous, never ask for terminal approval
      // --json: structured JSONL output for parsing
      //
      // Sandbox policy depends on execution context:
      // - docker/k8s/slurm: container/job IS the sandbox → danger-full-access
      // - direct/local: use workspace-write for safety
      const isContainerized = task.executionStrategy
        && ['docker', 'k8s-exec', 'slurm'].includes(task.executionStrategy);
      const sandboxMode = isContainerized ? 'danger-full-access' : 'workspace-write';

      const args = [
        'exec',
        '-a', 'never',                // Fully autonomous — no approval prompts
        '--sandbox', sandboxMode,      // OS-level sandbox (relaxed if already containerized)
        '--json',                      // JSONL output for structured parsing
        task.prompt,
      ];

      const env = {
        ...process.env,
        ...task.environment,
      };

      let proc: ChildProcess;

      try {
        proc = spawn(this.codexPath!, args, {
          cwd: task.workingDirectory,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }

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

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        stream.stdout(text);
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
        signal.removeEventListener('abort', abortHandler);

        // Parse output for any file artifacts mentioned
        this.extractArtifacts(stdout, artifacts);

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
