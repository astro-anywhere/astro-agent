/**
 * SLURM Execution Strategy
 *
 * Wraps existing lib/slurm-detect.ts, lib/slurm-executor.ts, and lib/hpc-context.ts.
 * Does not duplicate logic — delegates to the proven SLURM modules.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { detectSlurm } from '../lib/slurm-detect.js';
import { SlurmExecutor } from '../lib/slurm-executor.js';
import { buildHpcContext } from '../lib/hpc-context.js';
import type { SlurmInfo, SlurmJobConfig } from '../types.js';
import type {
  ExecutionStrategy,
  ExecutionSpec,
  ExecutionCallbacks,
  ExecutionResult,
  ExecutionStrategyDetection,
  ExecutionJobStatus,
} from './types.js';

const execAsync = promisify(exec);

export class SlurmStrategy implements ExecutionStrategy {
  readonly id = 'slurm' as const;
  readonly name = 'SLURM HPC';
  readonly isAsync = true;

  private slurmInfo: SlurmInfo | null = null;
  private executor: SlurmExecutor | null = null;
  /** Maps jobId → slurmJobId */
  private jobMap = new Map<string, string>();

  async detect(): Promise<ExecutionStrategyDetection> {
    try {
      this.slurmInfo = await detectSlurm();

      if (!this.slurmInfo.available) {
        return { available: false };
      }

      return {
        available: true,
        version: this.slurmInfo.version,
        metadata: {
          clusterName: this.slurmInfo.clusterName,
          partitions: this.slurmInfo.partitions,
          defaultPartition: this.slurmInfo.defaultPartition,
          accounts: this.slurmInfo.accounts,
          qosLevels: this.slurmInfo.qosLevels,
        },
      };
    } catch {
      return { available: false };
    }
  }

  async buildContext(): Promise<string> {
    const hpcContext = await buildHpcContext();
    return hpcContext.contextString;
  }

  async execute(
    spec: ExecutionSpec,
    callbacks: ExecutionCallbacks,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    if (signal.aborted) {
      return { status: 'cancelled' };
    }

    // Ensure detection has run
    if (!this.slurmInfo?.available) {
      const detection = await this.detect();
      if (!detection.available || !this.slurmInfo) {
        return {
          status: 'failed',
          error: 'SLURM is not available on this machine',
        };
      }
    }

    if (!this.executor) {
      this.executor = new SlurmExecutor(this.slurmInfo);
    }

    // Parse slurm config from spec.options
    const slurmConfig: SlurmJobConfig = {};
    const opts = spec.options ?? {};
    if (opts.partition) slurmConfig.partition = String(opts.partition);
    if (opts.nodes) slurmConfig.nodes = Number(opts.nodes);
    if (opts.ntasks) slurmConfig.ntasks = Number(opts.ntasks);
    if (opts.cpusPerTask) slurmConfig.cpusPerTask = Number(opts.cpusPerTask);
    if (opts.mem) slurmConfig.mem = String(opts.mem);
    if (opts.time) slurmConfig.time = String(opts.time);
    if (opts.qos) slurmConfig.qos = String(opts.qos);
    if (opts.account) slurmConfig.account = String(opts.account);
    if (opts.modules) slurmConfig.modules = opts.modules as string[];
    if (opts.gpu) slurmConfig.gpu = opts.gpu as { type?: string; count: number };

    const command = typeof spec.command === 'string' ? spec.command : spec.command.join(' ');

    const slurmTask = {
      taskId: spec.jobId,
      projectId: (opts.projectId as string) || 'unknown',
      nodeId: (opts.nodeId as string) || 'unknown',
      title: command.substring(0, 80),
      description: command,
      workingDirectory: spec.cwd,
      config: slurmConfig,
    };

    try {
      const result = await this.executor.execute(slurmTask, {
        onStatus: (jobStatus) => {
          const stateMap: Record<string, string> = {
            'PENDING': 'Job pending in queue',
            'RUNNING': 'Job running',
            'COMPLETING': 'Job completing',
            'COMPLETED': 'Job completed',
            'FAILED': 'Job failed',
            'CANCELLED': 'Job cancelled',
            'TIMEOUT': 'Job timed out',
          };
          const message = stateMap[jobStatus.state] || `Job state: ${jobStatus.state}`;
          const progress = jobStatus.state === 'RUNNING' ? 50 : jobStatus.state === 'COMPLETING' ? 90 : undefined;
          callbacks.onStatus(jobStatus.state, progress, message);
        },
        onOutput: (stream, data) => {
          if (stream === 'stdout') {
            callbacks.onStdout(data);
          } else {
            callbacks.onStderr(data);
          }
        },
        signal,
      });

      if (result.slurmJobId) {
        this.jobMap.set(spec.jobId, result.slurmJobId);
      }

      return {
        status: result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed',
        exitCode: result.exitCode,
        output: result.output,
        error: result.error,
        externalJobId: result.slurmJobId,
      };
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async cancel(jobId: string): Promise<void> {
    // Try executor's cancel (by taskId)
    if (this.executor) {
      await this.executor.cancel(jobId);
    }

    // Also try scancel with the slurm job ID
    const slurmJobId = this.jobMap.get(jobId);
    if (slurmJobId) {
      try {
        await execAsync(`scancel ${sanitizedSlurmJobId(slurmJobId)}`, { timeout: 10000 });
      } catch {
        // Job may have already finished
      }
      this.jobMap.delete(jobId);
    }
  }

  async getStatus(jobId: string): Promise<ExecutionJobStatus | null> {
    const slurmJobId = this.jobMap.get(jobId);
    if (!slurmJobId) return null;

    const safeJobId = sanitizedSlurmJobId(slurmJobId);

    // Try squeue first (running jobs)
    try {
      const { stdout } = await execAsync(
        `squeue -j ${safeJobId} -h -o "%T|%r" 2>/dev/null`,
        { timeout: 10000 },
      );
      const trimmed = stdout.trim();
      if (trimmed) {
        const [state, reason] = trimmed.split('|');
        return {
          jobId,
          externalJobId: slurmJobId,
          state: state || 'UNKNOWN',
          message: reason !== '(null)' ? reason : undefined,
        };
      }
    } catch {
      // Not in queue
    }

    // Try sacct (completed jobs)
    try {
      const { stdout } = await execAsync(
        `sacct -j ${safeJobId} --parsable2 --noheader -o State,ExitCode 2>/dev/null`,
        { timeout: 10000 },
      );
      const lines = stdout.trim().split('\n');
      const mainLine = lines.find((l) => !l.includes('.'));
      if (mainLine) {
        const [state, exitCodeRaw] = mainLine.split('|');
        let exitCode: number | undefined;
        if (exitCodeRaw?.includes(':')) {
          exitCode = parseInt(exitCodeRaw.split(':')[0]!);
        }
        return {
          jobId,
          externalJobId: slurmJobId,
          state: state?.split(' ')[0] || 'UNKNOWN',
          exitCode,
        };
      }
    } catch {
      // sacct failed
    }

    return null;
  }
}

// ============================================================================
// Input Validation
// ============================================================================

/** SLURM job IDs are always numeric (optionally with array syntax like 12345_1) */
function isValidSlurmJobId(id: string): boolean {
  return /^\d+(_\d+)?$/.test(id);
}

/** Validate and return a safe SLURM job ID, or throw. Prevents command injection. */
function sanitizedSlurmJobId(id: string): string {
  if (!isValidSlurmJobId(id)) {
    throw new Error(`Invalid SLURM job ID (possible command injection): ${id}`);
  }
  return id;
}
