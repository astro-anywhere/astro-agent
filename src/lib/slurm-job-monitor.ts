/**
 * Slurm Job Monitor
 *
 * Background poller that tracks submitted Slurm batch jobs (sbatch).
 * Monitors job status via sacct and streams updates through the
 * existing WebSocket relay protocol.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import type { WebSocketClient } from './websocket-client.js';
import type { TaskResult } from '../types.js';

const execFileAsync = promisify(execFile);

/** SLURM job IDs are numeric (optionally with array syntax like 12345_1). Validates and returns. */
function sanitizedSlurmJobId(id: string): string {
  if (!/^\d+(_\d+)?$/.test(id)) {
    throw new Error(`Invalid SLURM job ID (possible command injection): ${id}`);
  }
  return id;
}

/** Tracked Slurm job */
interface TrackedJob {
  slurmJobId: string;
  executionId: string;
  nodeId: string;
  outputPath?: string;
  lastState?: string;
  lastOutputOffset: number;
  stdoutSequence: number;
  trackingSince: Date;
  pollFailures: number;
}

/** Terminal Slurm states */
const TERMINAL_STATES = new Set([
  'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT',
  'PREEMPTED', 'NODE_FAIL', 'OUT_OF_MEMORY',
]);

/** Max consecutive sacct failures before untracking a job (Layer 3 safety net) */
const MAX_POLL_FAILURES = 3;

export class SlurmJobMonitor {
  private jobs = new Map<string, TrackedJob>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private wsClient: WebSocketClient;
  private pollIntervalMs: number;
  private sacctAvailable: boolean | null = null; // null = not yet checked

  constructor(wsClient: WebSocketClient, pollIntervalMs = 30_000) {
    this.wsClient = wsClient;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Layer 2: Check if sacct is available on this machine.
   * Caches the result so we only probe once.
   */
  async isSacctAvailable(): Promise<boolean> {
    if (this.sacctAvailable !== null) return this.sacctAvailable;
    try {
      await execFileAsync('sacct', ['--version'], { timeout: 5_000 });
      this.sacctAvailable = true;
    } catch (err) {
      console.log('[slurm-monitor] sacct not available:', err instanceof Error ? err.message : err);
      this.sacctAvailable = false;
    }
    return this.sacctAvailable;
  }

  /**
   * Track a submitted Slurm job.
   * Layer 2: Validates sacct is available before tracking. If sacct is not
   * installed, the job cannot be monitored and would block results forever.
   */
  async trackJob(
    slurmJobId: string,
    executionId: string,
    nodeId: string,
    outputPath?: string,
  ): Promise<void> {
    // Layer 2: Don't track if we can't monitor
    const canMonitor = await this.isSacctAvailable();
    if (!canMonitor) {
      console.warn(`[slurm-monitor] sacct not available — skipping tracking for job ${slurmJobId}`);
      return;
    }

    console.log(`[slurm-monitor] Tracking job ${slurmJobId} for task ${executionId}`);
    this.jobs.set(slurmJobId, {
      slurmJobId,
      executionId,
      nodeId,
      outputPath,
      lastOutputOffset: 0,
      stdoutSequence: 0,
      trackingSince: new Date(),
      pollFailures: 0,
    });

    // Start polling if not already running
    if (!this.pollInterval) {
      this.start();
    }
  }

  /**
   * Stop tracking a job
   */
  untrackJob(slurmJobId: string): void {
    this.jobs.delete(slurmJobId);
    if (this.jobs.size === 0) {
      this.stop();
    }
  }

  /**
   * Check if any jobs are being tracked
   */
  hasTrackedJobs(): boolean {
    return this.jobs.size > 0;
  }

  /**
   * Get tracked job IDs for a given execution
   */
  getJobsForExecution(executionId: string): string[] {
    return Array.from(this.jobs.values())
      .filter((j) => j.executionId === executionId)
      .map((j) => j.slurmJobId);
  }

  /**
   * Start the polling loop
   */
  start(): void {
    if (this.pollInterval) return;
    console.log(`[slurm-monitor] Starting poll loop (${this.pollIntervalMs}ms)`);
    // Immediate first poll so we don't wait a full interval before checking
    this.pollAll().catch((err) => {
      console.error('[slurm-monitor] Poll error:', err);
    });
    this.pollInterval = setInterval(() => {
      this.pollAll().catch((err) => {
        console.error('[slurm-monitor] Poll error:', err);
      });
    }, this.pollIntervalMs);
  }

  /**
   * Stop the polling loop
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log('[slurm-monitor] Stopped poll loop');
    }
  }

  /**
   * Poll all tracked jobs
   */
  private async pollAll(): Promise<void> {
    for (const [jobId, job] of this.jobs) {
      try {
        await this.pollJob(job);
      } catch (err) {
        console.error(`[slurm-monitor] Error polling job ${jobId}:`, err);
      }
    }
  }

  /**
   * Poll a single job's status via sacct
   */
  private async pollJob(job: TrackedJob): Promise<void> {
    const { slurmJobId, executionId } = job;

    let state = 'UNKNOWN';
    let exitCode: number | undefined;
    let elapsed: string | undefined;

    try {
      const { stdout } = await execFileAsync(
        'sacct',
        ['-j', sanitizedSlurmJobId(slurmJobId), '--format=State,ExitCode,Elapsed', '-n', '-P'],
        { timeout: 10_000 },
      );

      // sacct can return multiple lines (job + job.batch steps)
      // Take the first line (main job)
      // Reset failure counter on successful poll
      job.pollFailures = 0;

      const firstLine = stdout.trim().split('\n')[0];
      if (firstLine) {
        const parts = firstLine.split('|');
        state = (parts[0] || 'UNKNOWN').replace(/\+$/, ''); // Remove trailing + from CANCELLED+
        const exitParts = (parts[1] || '').split(':');
        exitCode = parseInt(exitParts[0]) || undefined;
        elapsed = parts[2] || undefined;
      }
    } catch {
      // Layer 3: sacct failed — increment failure count and untrack after threshold
      job.pollFailures++;
      if (job.pollFailures >= MAX_POLL_FAILURES) {
        console.warn(`[slurm-monitor] Job ${slurmJobId} unreachable after ${MAX_POLL_FAILURES} polls — untracking`);
        this.untrackJob(slurmJobId);
      }
      return;
    }

    // Report state changes
    if (state !== job.lastState) {
      job.lastState = state;

      if (TERMINAL_STATES.has(state)) {
        // Job finished — send result
        const isSuccess = state === 'COMPLETED' && (!exitCode || exitCode === 0);

        // Try to read final output
        let output: string | undefined;
        if (job.outputPath) {
          try {
            output = await readFile(job.outputPath, 'utf-8');
          } catch {
            // Output file not accessible
          }
        }

        const result: TaskResult = {
          taskId: executionId,
          status: isSuccess ? 'completed' : 'failed',
          exitCode: exitCode ?? (isSuccess ? 0 : 1),
          output: output || `Slurm job ${slurmJobId}: ${state}${elapsed ? ` (${elapsed})` : ''}`,
          error: isSuccess ? undefined : `Slurm job ${state}`,
          completedAt: new Date().toISOString(),
        };

        this.wsClient.sendTaskResult(result);
        console.log(`[slurm-monitor] Job ${slurmJobId} terminal: ${state}`);
        this.untrackJob(slurmJobId);
      } else {
        // Non-terminal state change — send progress
        const progress = state === 'RUNNING' ? 50 : state === 'PENDING' ? 10 : 25;
        const message = `Slurm job ${slurmJobId}: ${state}${elapsed ? ` (${elapsed})` : ''}`;
        this.wsClient.sendTaskStatus(executionId, 'running', progress, message);
      }
    }

    // Stream output file content if running
    if (state === 'RUNNING' && job.outputPath) {
      await this.streamOutput(job);
    }
  }

  /**
   * Stream new output from the job's output file
   */
  private async streamOutput(job: TrackedJob): Promise<void> {
    if (!job.outputPath) return;

    try {
      const fileStat = await stat(job.outputPath);
      if (fileStat.size <= job.lastOutputOffset) return;

      // Read only the new bytes to avoid byte/character offset mismatch
      const bytesToRead = fileStat.size - job.lastOutputOffset;
      const fd = await open(job.outputPath, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        await fd.read(buffer, 0, bytesToRead, job.lastOutputOffset);
        job.lastOutputOffset = fileStat.size;
        const newContent = buffer.toString('utf-8');

        if (newContent.length > 0) {
          this.wsClient.sendTaskOutput(
            job.executionId,
            'stdout',
            newContent,
            job.stdoutSequence++,
          );
        }
      } finally {
        await fd.close();
      }
    } catch {
      // File not yet created or not accessible
    }
  }
}
