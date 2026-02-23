/**
 * Docker Execution Strategy
 *
 * Runs commands inside Docker containers via `docker run`.
 */

import { spawn, exec, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ExecutionStrategy,
  ExecutionSpec,
  ExecutionCallbacks,
  ExecutionResult,
  ExecutionStrategyDetection,
  ExecutionJobStatus,
} from './types.js';

const execAsync = promisify(exec);

const DEFAULT_IMAGE = 'node:22-slim';

export interface DockerExecOptions {
  image?: string;
  volumes?: string[];
  network?: string;
  user?: string;
}

export class DockerStrategy implements ExecutionStrategy {
  readonly id = 'docker' as const;
  readonly name = 'Docker';
  readonly isAsync = false;

  /** Maps jobId → container ID */
  private containers = new Map<string, string>();
  private processes = new Map<string, ChildProcess>();

  async detect(): Promise<ExecutionStrategyDetection> {
    try {
      const { stdout } = await execAsync("docker info --format '{{.ServerVersion}}'", {
        timeout: 10000,
      });
      const version = stdout.trim();
      if (!version) {
        return { available: false };
      }

      // Get additional metadata
      let osArch: string | undefined;
      try {
        const { stdout: infoOut } = await execAsync(
          "docker info --format '{{.OSType}}/{{.Architecture}}'",
          { timeout: 5000 },
        );
        osArch = infoOut.trim();
      } catch {
        // Ignore
      }

      return {
        available: true,
        version,
        metadata: {
          osArch,
        },
      };
    } catch {
      return { available: false };
    }
  }

  async buildContext(): Promise<string> {
    const sections: string[] = [];
    sections.push('# Docker Execution Environment');
    sections.push('');
    sections.push('Commands may be executed inside Docker containers.');
    sections.push('- Volume mounts map the working directory into the container');
    sections.push('- Environment variables are passed through');
    sections.push('- The default image is `node:22-slim` unless overridden');
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

    const opts = (spec.options ?? {}) as DockerExecOptions;
    const image = opts.image || DEFAULT_IMAGE;

    // Build docker run arguments
    const args: string[] = ['run', '--rm'];

    // Container name for tracking
    const containerName = `astro-${spec.jobId}`;
    args.push('--name', containerName);

    // Volume mount: map cwd into container
    args.push('-v', `${spec.cwd}:${spec.cwd}`);
    args.push('-w', spec.cwd);

    // Additional volumes
    if (opts.volumes) {
      for (const vol of opts.volumes) {
        args.push('-v', vol);
      }
    }

    // Network
    if (opts.network) {
      args.push('--network', opts.network);
    }

    // User
    if (opts.user) {
      args.push('--user', opts.user);
    }

    // Environment variables
    if (spec.env) {
      for (const [key, value] of Object.entries(spec.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    // Image
    args.push(image);

    // Command
    if (typeof spec.command === 'string') {
      args.push('sh', '-c', spec.command);
    } else {
      args.push(...spec.command);
    }

    return new Promise<ExecutionResult>((resolve) => {
      const child = spawn('docker', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.processes.set(spec.jobId, child);
      this.containers.set(spec.jobId, containerName);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: ExecutionResult) => {
        if (settled) return;
        settled = true;
        this.processes.delete(spec.jobId);
        this.containers.delete(spec.jobId);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        resolve(result);
      };

      // Handle abort signal
      const onAbort = () => {
        if (!settled) {
          // Stop the container gracefully
          execAsync(`docker stop ${containerName}`, { timeout: 15000 }).catch(() => {
            // Container might already be stopped
          });
          finish({ status: 'cancelled', output: stdout, error: stderr, externalJobId: containerName });
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Handle timeout
      let timeoutHandle: NodeJS.Timeout | undefined;
      if (spec.timeout && spec.timeout > 0) {
        timeoutHandle = setTimeout(() => {
          if (!settled) {
            execAsync(`docker stop ${containerName}`, { timeout: 15000 }).catch(() => {});
            finish({ status: 'timeout', output: stdout, error: stderr, externalJobId: containerName });
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
          externalJobId: containerName,
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
          externalJobId: containerName,
        });
      });

      callbacks.onStatus('running', 0, `Container ${containerName} started (image: ${image})`);
    });
  }

  async cancel(jobId: string): Promise<void> {
    const containerName = this.containers.get(jobId);
    if (containerName) {
      try {
        await execAsync(`docker stop ${containerName}`, { timeout: 15000 });
      } catch {
        // Container might already be stopped
      }
      try {
        await execAsync(`docker rm -f ${containerName}`, { timeout: 10000 });
      } catch {
        // Ignore
      }
      this.containers.delete(jobId);
    }

    const child = this.processes.get(jobId);
    if (child) {
      child.kill('SIGTERM');
      this.processes.delete(jobId);
    }
  }

  async getStatus(jobId: string): Promise<ExecutionJobStatus | null> {
    const containerName = this.containers.get(jobId);
    if (!containerName) return null;

    try {
      const { stdout } = await execAsync(
        `docker inspect --format '{{.State.Status}}' ${containerName}`,
        { timeout: 5000 },
      );
      const state = stdout.trim();
      return {
        jobId,
        externalJobId: containerName,
        state,
      };
    } catch {
      return null;
    }
  }
}
