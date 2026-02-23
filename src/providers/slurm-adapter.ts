/**
 * Slurm HPC provider adapter
 *
 * Bridges the ProviderAdapter interface to SlurmExecutor for HPC job execution.
 *
 * @deprecated Use {@link import('../execution/slurm-strategy.js').SlurmStrategy} instead.
 * The execution strategy abstraction separates execution backends (SLURM, Docker, K8s)
 * from AI model providers (Claude, Codex). This adapter is retained for backward
 * compatibility but new code should use SlurmStrategy.
 */

import type { Task, TaskResult, SlurmInfo, SlurmJobConfig } from '../types.js';
import type { ProviderAdapter, TaskOutputStream, ProviderStatus } from './base-adapter.js';
import { detectSlurm } from '../lib/slurm-detect.js';
import { SlurmExecutor } from '../lib/slurm-executor.js';
import type { SlurmTaskInput } from '../lib/slurm-executor.js';

/** @deprecated Use SlurmStrategy from execution/slurm-strategy.ts instead */
export class SlurmAdapter implements ProviderAdapter {
  readonly type = 'slurm';
  readonly name = 'Slurm HPC';

  private slurmInfo: SlurmInfo | null = null;
  private executor: SlurmExecutor | null = null;
  private activeTasks = 0;
  private readonly maxTasks = 50;
  private lastError?: string;

  async isAvailable(): Promise<boolean> {
    try {
      this.slurmInfo = await detectSlurm();
      return this.slurmInfo.available;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async execute(task: Task, stream: TaskOutputStream, signal: AbortSignal): Promise<TaskResult> {
    if (!this.slurmInfo?.available) {
      const available = await this.isAvailable();
      if (!available || !this.slurmInfo) {
        return {
          taskId: task.id,
          status: 'failed',
          error: 'Slurm is not available on this machine',
        };
      }
    }

    if (!this.executor) {
      this.executor = new SlurmExecutor(this.slurmInfo);
    }

    this.activeTasks++;
    const startedAt = new Date().toISOString();
    stream.status('running', 0, 'Submitting to Slurm');

    // Parse Slurm config from task environment
    let slurmConfig: SlurmJobConfig = {};
    if (task.environment?.SLURM_CONFIG) {
      try {
        slurmConfig = JSON.parse(task.environment.SLURM_CONFIG) as SlurmJobConfig;
      } catch {
        // Invalid config, use defaults
      }
    }

    // Bridge Task → SlurmTaskInput
    const slurmTask: SlurmTaskInput = {
      taskId: task.id,
      projectId: task.projectId,
      nodeId: task.planNodeId,
      title: task.prompt.substring(0, 80),
      description: task.prompt,
      workingDirectory: task.workingDirectory,
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
            'NODE_FAIL': 'Node failure',
            'OUT_OF_MEMORY': 'Out of memory',
          };
          const message = stateMap[jobStatus.state] || `Job state: ${jobStatus.state}`;
          const progress = jobStatus.state === 'RUNNING' ? 50 : jobStatus.state === 'COMPLETING' ? 90 : undefined;
          stream.status('running', progress, message);
        },
        onOutput: (outputStream, data) => {
          if (outputStream === 'stdout') {
            stream.stdout(data);
          } else {
            stream.stderr(data);
          }
        },
        signal,
      });

      this.activeTasks--;
      const completedAt = new Date().toISOString();

      if (result.status === 'cancelled') {
        stream.status('cancelled', undefined, 'Job cancelled');
        return {
          taskId: task.id,
          status: 'cancelled',
          startedAt,
          completedAt,
        };
      }

      const taskStatus = result.status === 'completed' ? 'completed' as const : 'failed' as const;
      stream.status(taskStatus, 100, result.status === 'completed' ? 'Job completed' : 'Job failed');

      return {
        taskId: task.id,
        status: taskStatus,
        exitCode: result.exitCode,
        output: result.output,
        error: result.error,
        startedAt,
        completedAt,
      };
    } catch (error) {
      this.activeTasks--;
      this.lastError = error instanceof Error ? error.message : String(error);

      stream.status('failed', undefined, this.lastError);
      return {
        taskId: task.id,
        status: 'failed',
        error: this.lastError,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  async getStatus(): Promise<ProviderStatus> {
    if (!this.slurmInfo) {
      await this.isAvailable();
    }

    return {
      available: this.slurmInfo?.available ?? false,
      version: this.slurmInfo?.version ?? null,
      activeTasks: this.activeTasks,
      maxTasks: this.maxTasks,
      lastError: this.lastError,
    };
  }
}
