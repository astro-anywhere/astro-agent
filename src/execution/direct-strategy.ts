/**
 * Direct Execution Strategy
 *
 * Always available. Wraps child_process.spawn for local command execution.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type {
  ExecutionStrategy,
  ExecutionSpec,
  ExecutionCallbacks,
  ExecutionResult,
  ExecutionStrategyDetection,
  ExecutionJobStatus,
} from './types.js';

export class DirectStrategy implements ExecutionStrategy {
  readonly id = 'direct' as const;
  readonly name = 'Direct (local)';
  readonly isAsync = false;

  private processes = new Map<string, { child: ChildProcess; signal: AbortSignal }>();

  async detect(): Promise<ExecutionStrategyDetection> {
    return {
      available: true,
      version: process.version,
      metadata: {
        platform: process.platform,
        arch: process.arch,
      },
    };
  }

  async buildContext(): Promise<string> {
    const sections: string[] = [];
    sections.push('# Direct Execution Environment');
    sections.push('');
    sections.push('Commands run directly on the host machine. Follow these rules:');
    sections.push('');
    sections.push('## Python Package Safety');
    sections.push('- **NEVER** run `pip install` or `pip3 install` in the global/system Python');
    sections.push('- **ALWAYS** use a virtual environment: `conda`, `venv`, `uv`, or `poetry`');
    sections.push('- Prefer `uv` for speed: `uv venv .venv && source .venv/bin/activate`');
    sections.push('- Or use conda: `conda create -n myenv python=3.12 && conda activate myenv`');
    sections.push('- If a `pyproject.toml`, `requirements.txt`, or `environment.yml` exists, use it');
    sections.push('- Only install packages globally if explicitly inside a container');
    sections.push('');
    return sections.join('\n');
  }

  async execute(
    spec: ExecutionSpec,
    callbacks: ExecutionCallbacks,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    if (signal.aborted) {
      return { status: 'cancelled' };
    }

    return new Promise<ExecutionResult>((resolve) => {
      let child: ChildProcess;

      if (typeof spec.command === 'string') {
        child = spawn('sh', ['-c', spec.command], {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        const [cmd, ...args] = spec.command;
        child = spawn(cmd!, args, {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }

      this.processes.set(spec.jobId, { child, signal });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: ExecutionResult) => {
        if (settled) return;
        settled = true;
        this.processes.delete(spec.jobId);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        resolve(result);
      };

      // Handle abort signal
      const onAbort = () => {
        if (!settled) {
          child.kill('SIGTERM');
          // Force kill after 5s
          setTimeout(() => {
            if (!settled) {
              child.kill('SIGKILL');
            }
          }, 5000).unref();
          finish({ status: 'cancelled', output: stdout, error: stderr });
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Handle timeout
      let timeoutHandle: NodeJS.Timeout | undefined;
      if (spec.timeout && spec.timeout > 0) {
        timeoutHandle = setTimeout(() => {
          if (!settled) {
            child.kill('SIGTERM');
            setTimeout(() => {
              if (!settled) {
                child.kill('SIGKILL');
              }
            }, 5000).unref();
            finish({ status: 'timeout', output: stdout, error: stderr });
          }
        }, spec.timeout);
        timeoutHandle.unref();
      }

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        callbacks.onStdout(text);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        callbacks.onStderr(text);
      });

      child.on('error', (err) => {
        finish({
          status: 'failed',
          error: err.message,
          output: stdout,
        });
      });

      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        const exitCode = code ?? 1;
        finish({
          status: exitCode === 0 ? 'completed' : 'failed',
          exitCode,
          output: stdout,
          error: stderr || undefined,
        });
      });

      callbacks.onStatus('running', 0, 'Process started');
    });
  }

  async cancel(jobId: string): Promise<void> {
    const entry = this.processes.get(jobId);
    if (!entry) return;

    entry.child.kill('SIGTERM');
    // Force kill after 5s
    setTimeout(() => {
      if (!entry.child.killed) {
        entry.child.kill('SIGKILL');
      }
    }, 5000).unref();
  }

  async getStatus(jobId: string): Promise<ExecutionJobStatus | null> {
    const entry = this.processes.get(jobId);
    if (!entry) return null;

    return {
      jobId,
      externalJobId: String(entry.child.pid ?? ''),
      state: entry.child.exitCode !== null ? 'exited' : 'running',
      exitCode: entry.child.exitCode ?? undefined,
    };
  }
}
