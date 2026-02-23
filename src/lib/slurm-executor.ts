/**
 * Slurm Executor
 *
 * Handles Slurm job submission and monitoring.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SlurmInfo, SlurmJobStatus, SlurmJobConfig } from '../types.js';

const execFileAsync = promisify(execFile);

/** SLURM job IDs are numeric (optionally with array syntax like 12345_1). Validates and returns. */
function sanitizedSlurmJobId(id: string): string {
  if (!/^\d+(_\d+)?$/.test(id)) {
    throw new Error(`Invalid SLURM job ID (possible command injection): ${id}`);
  }
  return id;
}

export interface SlurmTaskInput {
  taskId: string;
  projectId: string;
  nodeId: string;
  title: string;
  description: string;
  workingDirectory?: string;
  config?: SlurmJobConfig;
}

export interface SlurmExecuteOptions {
  onStatus: (status: SlurmJobStatus) => void;
  onOutput: (stream: 'stdout' | 'stderr', data: string) => void;
  signal?: AbortSignal;
}

export interface SlurmExecuteResult {
  status: string;
  output?: string;
  error?: string;
  exitCode?: number;
  slurmJobId?: string;
}

interface JobTracker {
  taskId: string;
  slurmJobId: string;
  outputPath: string;
  errorPath: string;
  watcher?: NodeJS.Timeout;
}

export class SlurmExecutor {
  private jobs = new Map<string, JobTracker>();
  private scriptDir: string;

  constructor(private slurmInfo: SlurmInfo) {
    this.scriptDir = path.join(os.tmpdir(), 'astro-slurm-scripts');
    fs.mkdir(this.scriptDir, { recursive: true }).catch(() => {
      // Ignore if already exists
    });
  }

  /**
   * Execute a task via Slurm
   */
  async execute(task: SlurmTaskInput, options: SlurmExecuteOptions): Promise<SlurmExecuteResult> {
    // Check if already aborted
    if (options.signal?.aborted) {
      return { status: 'cancelled' };
    }

    const slurmConfig = task.config ?? {};

    // Generate batch script
    const script = this.generateScript(task, slurmConfig);
    const scriptPath = path.join(this.scriptDir, `astro_${task.taskId}.sh`);

    await fs.writeFile(scriptPath, script, { mode: 0o755 });

    // Submit job
    const submitResult = await this.submitJob(scriptPath);

    if (!submitResult.success || !submitResult.jobId) {
      return {
        status: 'failed',
        error: submitResult.error || 'Job submission failed',
      };
    }

    const slurmJobId = submitResult.jobId;

    // Set up output paths
    const workdir = task.workingDirectory || process.cwd();
    const outputPath = path.join(workdir, `astro_${task.taskId}_${slurmJobId}.out`);
    const errorPath = path.join(workdir, `astro_${task.taskId}_${slurmJobId}.err`);

    // Track the job
    const tracker: JobTracker = {
      taskId: task.taskId,
      slurmJobId,
      outputPath,
      errorPath,
    };
    this.jobs.set(task.taskId, tracker);

    // Wire abort signal to scancel
    if (options.signal) {
      const onAbort = () => {
        this.cancel(task.taskId);
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Monitor job
    const result = await this.monitorJob(tracker, options);
    return { ...result, slurmJobId };
  }

  /**
   * Cancel a task
   */
  async cancel(taskId: string): Promise<boolean> {
    const tracker = this.jobs.get(taskId);
    if (!tracker) return false;

    // Stop watcher
    if (tracker.watcher) {
      clearInterval(tracker.watcher);
    }

    // Cancel Slurm job
    try {
      await execFileAsync('scancel', [sanitizedSlurmJobId(tracker.slurmJobId)], { timeout: 10000 });
    } catch {
      // Failed to cancel — job may have already finished
    }

    this.jobs.delete(taskId);
    return true;
  }

  /**
   * Cancel all tasks
   */
  async cancelAll(): Promise<void> {
    for (const [taskId] of this.jobs) {
      await this.cancel(taskId);
    }
  }

  /**
   * Generate Slurm batch script
   */
  private generateScript(task: SlurmTaskInput, config: SlurmJobConfig): string {
    const lines: string[] = [];

    lines.push('#!/bin/bash');
    lines.push('');

    // Job name
    lines.push(`#SBATCH --job-name=astro_${this.sanitizeName(task.title)}`);

    // Output files
    const workdir = task.workingDirectory || '$HOME';
    lines.push(`#SBATCH --output=${workdir}/astro_${task.taskId}_%j.out`);
    lines.push(`#SBATCH --error=${workdir}/astro_${task.taskId}_%j.err`);

    // Partition
    if (config.partition) {
      lines.push(`#SBATCH --partition=${config.partition}`);
    } else if (this.slurmInfo.defaultPartition) {
      lines.push(`#SBATCH --partition=${this.slurmInfo.defaultPartition}`);
    }

    // Resources
    if (config.nodes) lines.push(`#SBATCH --nodes=${config.nodes}`);
    if (config.ntasks) lines.push(`#SBATCH --ntasks=${config.ntasks}`);
    if (config.cpusPerTask) lines.push(`#SBATCH --cpus-per-task=${config.cpusPerTask}`);
    if (config.mem) lines.push(`#SBATCH --mem=${config.mem}`);

    // GPU
    if (config.gpu) {
      const gpuSpec = config.gpu.type
        ? `${config.gpu.type}:${config.gpu.count}`
        : config.gpu.count.toString();
      lines.push(`#SBATCH --gres=gpu:${gpuSpec}`);
    }

    // Time limit
    if (config.time) {
      lines.push(`#SBATCH --time=${config.time}`);
    } else {
      lines.push('#SBATCH --time=02:00:00'); // Default 2 hours
    }

    // QOS and account
    if (config.qos) lines.push(`#SBATCH --qos=${config.qos}`);
    if (config.account) {
      lines.push(`#SBATCH --account=${config.account}`);
    } else if (this.slurmInfo.accounts.length > 0) {
      lines.push(`#SBATCH --account=${this.slurmInfo.accounts[0]}`);
    }

    lines.push('');
    lines.push('# Exit on error');
    lines.push('set -e');
    lines.push('');
    lines.push('# Job info');
    lines.push('echo "=== Astro Job ==="');
    lines.push('echo "Job ID: $SLURM_JOB_ID"');
    lines.push('echo "Job Name: $SLURM_JOB_NAME"');
    lines.push('echo "Node: $SLURMD_NODENAME"');
    lines.push('echo "Start: $(date)"');
    lines.push('echo "Working directory: $(pwd)"');
    lines.push('echo "=================="');
    lines.push('');

    // Load modules
    if (config.modules && config.modules.length > 0) {
      lines.push('# Load modules');
      for (const mod of config.modules) {
        lines.push(`module load ${mod}`);
      }
      lines.push('');
    }

    // Environment variables (shell-escaped with single quotes)
    lines.push('# Environment');
    lines.push(`export ASTRO_TASK_ID='${shellEscape(task.taskId)}'`);
    lines.push(`export ASTRO_PROJECT_ID='${shellEscape(task.projectId)}'`);
    lines.push('');

    // Extract and add commands from task description
    lines.push('# Task commands');
    const commands = this.extractCommands(task.description);
    for (const cmd of commands) {
      lines.push(cmd);
    }

    lines.push('');
    lines.push('echo "=================="');
    lines.push('echo "End: $(date)"');
    lines.push('echo "Exit code: $?"');

    return lines.join('\n');
  }

  /**
   * Extract commands from task description
   */
  private extractCommands(description: string): string[] {
    const commands: string[] = [];

    // Look for code blocks
    const codeBlockMatch = description.match(/```(?:bash|sh|shell)?\n([\s\S]*?)```/g);
    if (codeBlockMatch) {
      for (const block of codeBlockMatch) {
        const code = block.replace(/```(?:bash|sh|shell)?\n?/, '').replace(/```$/, '').trim();
        commands.push(code);
      }
      return commands;
    }

    // Look for command patterns in lines
    const lines = description.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (
        trimmed.startsWith('python ') ||
        trimmed.startsWith('python3 ') ||
        trimmed.startsWith('Rscript ') ||
        trimmed.startsWith('bash ') ||
        trimmed.startsWith('./') ||
        trimmed.startsWith('make ') ||
        trimmed.match(/^\w+\s+/)
      ) {
        commands.push(trimmed);
      }
    }

    if (commands.length === 0) {
      commands.push(`# Task: ${description.substring(0, 200).replace(/\n/g, ' ')}`);
      commands.push('echo "No explicit commands found. Task description stored above."');
    }

    return commands;
  }

  /**
   * Submit job to Slurm
   */
  private async submitJob(scriptPath: string): Promise<{ success: boolean; jobId?: string; error?: string }> {
    try {
      const { stdout, stderr } = await execFileAsync('sbatch', [scriptPath], { timeout: 30000 });

      const jobIdMatch = stdout.match(/Submitted batch job (\d+)/);
      if (jobIdMatch) {
        return { success: true, jobId: jobIdMatch[1] };
      }

      return { success: false, error: stderr || stdout || 'Unknown submission error' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Submission failed',
      };
    }
  }

  /**
   * Monitor job until completion
   */
  private async monitorJob(tracker: JobTracker, options: SlurmExecuteOptions): Promise<SlurmExecuteResult> {
    return new Promise((resolve) => {
      let lastOutputOffset = 0;
      let lastErrorOffset = 0;
      let lastState = '';

      const checkJob = async () => {
        // Check if aborted
        if (options.signal?.aborted) {
          if (tracker.watcher) {
            clearInterval(tracker.watcher);
          }
          this.cancel(tracker.taskId);
          resolve({ status: 'cancelled' });
          return;
        }

        // Check job status
        const status = await this.getJobStatus(tracker.slurmJobId);

        if (status && status.state !== lastState) {
          lastState = status.state;
          options.onStatus(status);
        }

        // Stream stdout
        try {
          const stat = await fs.stat(tracker.outputPath);
          if (stat.size > lastOutputOffset) {
            const fd = await fs.open(tracker.outputPath, 'r');
            const buffer = Buffer.alloc(stat.size - lastOutputOffset);
            await fd.read(buffer, 0, buffer.length, lastOutputOffset);
            await fd.close();
            lastOutputOffset = stat.size;
            const data = buffer.toString('utf-8');
            if (data) options.onOutput('stdout', data);
          }
        } catch {
          // File doesn't exist yet
        }

        // Stream stderr
        try {
          const stat = await fs.stat(tracker.errorPath);
          if (stat.size > lastErrorOffset) {
            const fd = await fs.open(tracker.errorPath, 'r');
            const buffer = Buffer.alloc(stat.size - lastErrorOffset);
            await fd.read(buffer, 0, buffer.length, lastErrorOffset);
            await fd.close();
            lastErrorOffset = stat.size;
            const data = buffer.toString('utf-8');
            if (data) options.onOutput('stderr', data);
          }
        } catch {
          // File doesn't exist yet
        }

        // Check for completion
        if (status && ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAIL', 'OUT_OF_MEMORY'].includes(status.state)) {
          if (tracker.watcher) {
            clearInterval(tracker.watcher);
          }
          this.jobs.delete(tracker.taskId);

          // Read final output
          let output = '';
          try {
            output = await fs.readFile(tracker.outputPath, 'utf-8');
          } catch {
            // Ignore
          }

          let error = '';
          try {
            error = await fs.readFile(tracker.errorPath, 'utf-8');
          } catch {
            // Ignore
          }

          resolve({
            status: status.state === 'COMPLETED' && status.exitCode === 0 ? 'completed' : 'failed',
            output,
            error: error || (status.exitCode !== 0 ? `Exit code: ${status.exitCode}` : undefined),
            exitCode: status.exitCode,
          });
        }
      };

      // Initial check
      checkJob();

      // Poll every 5 seconds
      tracker.watcher = setInterval(checkJob, 5000);
    });
  }

  /**
   * Get job status from squeue/sacct
   */
  private async getJobStatus(jobId: string): Promise<SlurmJobStatus | null> {
    const safeJobId = sanitizedSlurmJobId(jobId);
    // Try squeue first (for running jobs)
    try {
      const { stdout } = await execFileAsync(
        'squeue', ['-j', safeJobId, '-h', '-o', '%T|%r|%N|%e'],
        { timeout: 10000 }
      );
      const trimmed = stdout.trim();
      if (trimmed) {
        const [state, stateReason, nodeList] = trimmed.split('|');
        return {
          jobId,
          state: state || 'UNKNOWN',
          stateReason: stateReason !== '(null)' ? stateReason : undefined,
          nodeList: nodeList !== '(null)' ? nodeList : undefined,
        };
      }
    } catch {
      // Job not in queue, check sacct
    }

    // Try sacct (for completed jobs)
    try {
      const { stdout } = await execFileAsync(
        'sacct', ['-j', safeJobId, '--parsable2', '--noheader', '-o', 'State,ExitCode,NodeList'],
        { timeout: 10000 }
      );
      const lines = stdout.trim().split('\n');
      const mainLine = lines.find((l) => !l.includes('.'));
      if (mainLine) {
        const [state, exitCodeRaw, nodeList] = mainLine.split('|');
        let exitCode: number | undefined;
        if (exitCodeRaw && exitCodeRaw.includes(':')) {
          exitCode = parseInt(exitCodeRaw.split(':')[0]);
        }
        return {
          jobId,
          state: state?.split(' ')[0] || 'UNKNOWN',
          nodeList: nodeList || undefined,
          exitCode,
        };
      }
    } catch {
      // sacct failed
    }

    return null;
  }

  /**
   * Sanitize job name for Slurm
   */
  private sanitizeName(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 40);
  }
}

/** Shell-escape a string by replacing single quotes with '\'' */
function shellEscape(value: string): string {
  return value.replace(/'/g, "'\\''");
}
