/**
 * Task executor with multiplexing support
 *
 * Handles concurrent task execution, routing to providers,
 * and streaming output back over WebSocket
 */

import { homedir } from 'node:os';
import { statSync, realpathSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Task, TaskResult, TaskStatus, ProviderType, HpcCapability } from '../types.js';
import type { WebSocketClient } from './websocket-client.js';
import { createProviderAdapter, type ProviderAdapter, type TaskOutputStream } from '../providers/index.js';
import { ClaudeSdkAdapter } from '../providers/claude-sdk-adapter.js';
import { OpenClawAdapter } from '../providers/openclaw-adapter.js';
import type { OpenClawBridge } from './openclaw-bridge.js';
import { SlurmJobMonitor } from './slurm-job-monitor.js';
import { createWorktree, syncDeliveryWorktree, getGitRoot } from './worktree.js';
import { ensureProjectWorkspace } from './workspace-root.js';
import { BranchLockManager } from './branch-lock.js';
import { pushAndCreatePR, mergePullRequest, getRemoteBranchSha, isGhAvailable, getRepoSlug } from './git-pr.js';
import { localMergeIntoDeliveryBranch } from './local-merge.js';
import {
  checkWorkdirSafety,
  isGitAvailable,
  isGitRepo,
  isUntrackedInParentRepo,
  createSandbox,
  WorkdirSafetyTier,
  type SafetyCheckResult,
  type SandboxSetup,
} from './workdir-safety.js';
import { initializeGit } from './git-bootstrap.js';

const execFileAsync = promisify(execFileCb);

/**
 * Sanitize a git ref name for embedding in prompt shell commands.
 * Strips characters that could enable command injection (;, $, `, |, &, etc.)
 * while preserving valid git ref characters (alphanumeric, /, -, _, .).
 */
function sanitizeGitRef(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9/_.-]/g, '');
}

/**
 * Build a prompt instructing the agent to resolve merge conflicts.
 * The agent's worktree has the task branch checked out; it needs to
 * rebase onto the delivery branch to resolve conflicts, then commit.
 */
function buildConflictResolutionPrompt(
  conflictFiles: string[],
  deliveryBranch: string,
  attempt: number,
  maxAttempts: number,
): string {
  const safeBranch = sanitizeGitRef(deliveryBranch);
  const fileList = conflictFiles.map(f => `- ${f}`).join('\n');
  return `MERGE CONFLICT DETECTED (attempt ${attempt}/${maxAttempts})

Your task branch cannot be cleanly merged into the delivery branch because
parallel tasks have modified overlapping files since you branched.

Conflicting files:
${fileList}

The delivery branch is: ${safeBranch}

Please resolve this:
1. Fetch the latest delivery branch: git fetch origin 2>/dev/null; git fetch . ${safeBranch}:${safeBranch} 2>/dev/null || true
2. Rebase onto the delivery branch: git rebase ${safeBranch}
3. For each conflict, open the file, resolve the conflict markers (<<<<<<< / ======= / >>>>>>>), keeping the correct combination of both changes
4. Stage resolved files: git add <resolved-files>
5. Continue the rebase: git rebase --continue
6. Verify your changes still work (run a quick build/test if applicable)

IMPORTANT: Do NOT create a merge commit. Use rebase so the merge will be clean.
After you finish resolving, I will automatically retry the merge.`;
}

/**
 * Build a prompt for PR mode conflict resolution.
 * Similar to local mode, but the agent must also force-push after rebasing
 * because the merge happens via GitHub API (gh pr merge), not locally.
 */
function buildPRConflictResolutionPrompt(
  deliveryBranch: string,
  branchName: string,
  attempt: number,
  maxAttempts: number,
): string {
  const safeBranch = sanitizeGitRef(deliveryBranch);
  const safeTaskBranch = sanitizeGitRef(branchName);
  return `MERGE CONFLICT DETECTED ON GITHUB (attempt ${attempt}/${maxAttempts})

Your pull request cannot be automatically merged into the delivery branch because
parallel tasks have modified overlapping files.

Your task branch is: ${safeTaskBranch}
The target branch is: ${safeBranch}

Please resolve this:
1. Fetch the latest target branch: git fetch origin ${safeBranch}
2. Rebase onto the target branch: git rebase origin/${safeBranch}
3. For each conflict, open the file, resolve the conflict markers (<<<<<<< / ======= / >>>>>>>), keeping the correct combination of both changes
4. Stage resolved files: git add <resolved-files>
5. Continue the rebase: git rebase --continue
6. Verify your changes still work (run a quick build/test if applicable)
7. Force-push the rebased branch: git push --force-with-lease origin ${safeTaskBranch}

IMPORTANT: Do NOT create a merge commit. Use rebase so the history is clean.
After you force-push, I will automatically retry the GitHub merge.`;
}

/**
 * Best-effort pre-merge rebase: if the delivery branch has moved forward
 * (another task merged), rebase the task branch onto the latest tip before
 * attempting the squash merge. This avoids conflicts in the common case
 * where changes don't overlap. On any failure, silently aborts — the
 * existing merge retry loop handles real conflicts.
 */
async function tryPreMergeRebase(
  workdir: string,
  targetBranch: string,
  isRemote: boolean,
): Promise<{ rebased: boolean; skipped?: boolean }> {
  // `git rebase` always operates on the currently checked-out branch (HEAD).
  // It cannot rebase a detached branch ref. When the worktree is gone, HEAD
  // in gitRoot is the user's main checkout (e.g., main) — NOT the task branch.
  // Rebasing from gitRoot would corrupt the user's working directory.
  // Skip the rebase entirely; the merge/PR flow handles conflicts anyway.
  //
  // Best-effort check — worktree could still be deleted after this (TOCTOU),
  // but the git commands will fail safely and be caught by the outer catch.
  try {
    statSync(workdir);
  } catch {
    console.log(`[git] Worktree at ${workdir} gone — skipping rebase (cannot rebase non-checked-out branch)`);
    return { rebased: false, skipped: true };
  }

  try {
    const rebaseTarget = isRemote ? `origin/${targetBranch}` : targetBranch;
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

    if (isRemote) {
      console.log(`[git] fetch origin ${targetBranch} (cwd: ${workdir})`);
      await execFileAsync('git', ['fetch', 'origin', targetBranch], { cwd: workdir, env: gitEnv, timeout: 30_000 });
    }

    // Check if rebase is needed (target branch moved since we branched)
    console.log(`[git] merge-base HEAD ${rebaseTarget} (cwd: ${workdir})`);
    const { stdout: mergeBase } = await execFileAsync('git', ['merge-base', 'HEAD', rebaseTarget], { cwd: workdir, env: gitEnv });
    const { stdout: targetTip } = await execFileAsync('git', ['rev-parse', rebaseTarget], { cwd: workdir, env: gitEnv });

    if (mergeBase.trim() === targetTip.trim()) {
      console.log(`[git] Already up to date (merge-base = target tip: ${targetTip.trim().slice(0, 7)})`);
      return { rebased: false, skipped: true };
    }

    // Try automatic rebase — timeout after 60s (should be fast for non-conflicting changes)
    console.log(`[git] rebase ${rebaseTarget} (cwd: ${workdir})`);
    await execFileAsync('git', ['rebase', rebaseTarget], { cwd: workdir, env: gitEnv, timeout: 60_000 });
    console.log(`[git] Rebase onto ${rebaseTarget} succeeded`);
    return { rebased: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[git] Rebase onto ${targetBranch} failed: ${msg}`);
    // Abort on failure — existing retry loop will handle conflicts
    await execFileAsync('git', ['rebase', '--abort'], { cwd: workdir }).catch(() => {});
    return { rebased: false };
  }
}

interface RunningTask {
  task: Task & { workingDirectory: string };
  abortController: AbortController;
  adapter: ProviderAdapter;
  outputSequence: { stdout: number; stderr: number };
  sandbox?: SandboxSetup;
}

interface PendingSafetyCheck {
  task: Task & { workingDirectory: string };
  safetyResult: SafetyCheckResult;
  resolveDecision: (decision: 'proceed' | 'init-git' | 'sandbox' | 'cancel') => void;
}

export interface TaskExecutorOptions {
  wsClient: WebSocketClient;
  maxConcurrentTasks?: number;
  defaultTimeout?: number; // Hard cap timeout in ms (default 8h)
  defaultIdleTimeout?: number; // Idle timeout in ms, resets on activity (default 15min)
  useWorktree?: boolean;
  worktreeRoot?: string;
  preserveWorktrees?: boolean; // Don't cleanup worktrees for debugging
  allowNonGit?: boolean; // Allow execution in non-git directories without prompting
  useSandbox?: boolean; // Always use sandbox mode
  maxSandboxSize?: number; // Max sandbox size in bytes
  hpcCapability?: HpcCapability | null; // Pre-classified HPC info from startup detection
}

/** Resolve a canonical absolute path for a directory (follows symlinks, normalizes). */
function canonicalDirPath(workdir: string): string {
  try {
    return realpathSync(workdir);
  } catch {
    return resolve(workdir);
  }
}

/** Canonicalize a directory path for use as a lock key. */
function canonicalDirLockKey(workdir: string): string {
  return `dir::${canonicalDirPath(workdir)}`;
}

/** Format a duration in ms to a human-readable string (e.g., "2h 30m", "15m"). */
function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export class TaskExecutor {
  private wsClient: WebSocketClient;
  private runningTasks: Map<string, RunningTask> = new Map();
  private taskQueue: (Task & { workingDirectory: string })[] = [];
  private maxConcurrentTasks: number;
  private defaultTimeout: number; // Hard cap
  private defaultIdleTimeout: number; // Resets on activity
  private adapters: Map<ProviderType, ProviderAdapter> = new Map();
  private useWorktree: boolean;
  private worktreeRoot?: string;
  private preserveWorktrees: boolean;
  private jobMonitor: SlurmJobMonitor;
  private allowNonGit: boolean;
  private useSandbox: boolean;
  private maxSandboxSize: number;
  private gitAvailable: boolean = false;
  private hpcCapability: HpcCapability | null;
  private branchLockManager = new BranchLockManager();
  /** Per-directory lock for serializing tasks on non-git directories (no worktree isolation). */
  private directoryLockManager = new BranchLockManager();
  /** Tasks claimed by submitTask() but not yet in runningTasks (closes TOCTOU dedup gap). */
  private claimedTasks: Set<string> = new Set();
  private openclawBridge: OpenClawBridge | null = null;

  /** Branch names that are singleton delivery branches — must not be deleted by cleanupTask. */
  private singletonBranches: Set<string> = new Set();

  // Safety tracking
  private tasksByDirectory: Map<string, Set<string>> = new Map(); // workdir -> taskIds
  private pendingSafetyChecks: Map<string, PendingSafetyCheck> = new Map(); // taskId -> pending check

  /** Preserved task metadata for worktree recreation on post-completion resume */
  private completedTaskMeta: Map<string, {
    originalWorkingDirectory: string;
    deliveryBranch?: string;
    baseBranch?: string;
    agentDir?: string;
    shortProjectId?: string;
    shortNodeId?: string;
    projectId?: string;
    deliveryBranchIsSingleton?: boolean;
    storedAt: number;
  }> = new Map();

  /** TTL for completed task metadata (10 minutes, matches adapter session TTL) */
  private static readonly COMPLETED_TASK_META_TTL_MS = 10 * 60 * 1000;

  constructor(options: TaskExecutorOptions) {
    this.wsClient = options.wsClient;
    this.maxConcurrentTasks = options.maxConcurrentTasks ?? 40;
    this.defaultTimeout = options.defaultTimeout ?? 8 * 60 * 60 * 1000; // 8 hours hard cap
    this.defaultIdleTimeout = options.defaultIdleTimeout ?? 15 * 60 * 1000; // 15 min idle
    this.useWorktree = options.useWorktree ?? true;
    this.worktreeRoot = options.worktreeRoot;
    this.preserveWorktrees = options.preserveWorktrees ?? false;
    this.allowNonGit = options.allowNonGit ?? false;
    this.useSandbox = options.useSandbox ?? false;
    this.maxSandboxSize = options.maxSandboxSize ?? 100 * 1024 * 1024; // 100MB
    this.hpcCapability = options.hpcCapability ?? null;
    this.jobMonitor = new SlurmJobMonitor(options.wsClient);

    // Check git availability on startup
    isGitAvailable().then((available) => {
      this.gitAvailable = available;
      console.log(`[executor] Git ${available ? 'available' : 'not available'}`);
    }).catch(() => {
      this.gitAvailable = false;
    });

    console.log('[executor] Tip: Filter logs for a specific task with: npx @astroanywhere/agent logs -f | grep "taskId"');
  }

  /**
   * Inject the OpenClaw bridge for task execution delegation.
   * If an OpenClawAdapter is already cached, wire the bridge to it immediately.
   */
  setOpenClawBridge(bridge: OpenClawBridge): void {
    this.openclawBridge = bridge;

    // Wire to existing cached adapter if present
    const cached = this.adapters.get('openclaw');
    if (cached instanceof OpenClawAdapter) {
      cached.setBridge(bridge);
      console.log('[executor] OpenClaw bridge wired to existing adapter');
    }
  }

  /**
   * Submit a task for execution (with safety checks)
   */
  async submitTask(task: Task): Promise<void> {
    // Dedup: reject if this task is already running OR claimed by a concurrent submitTask().
    // runningTasks is only populated inside executeTask() (line ~1079), but submitTask()
    // does async work (safety checks, git detection) before reaching executeTask(). Without
    // claimedTasks, two rapid dispatches for the same taskId could both pass the runningTasks
    // check and execute concurrently (TOCTOU race).
    if (this.runningTasks.has(task.id) || this.claimedTasks.has(task.id)) {
      console.warn(`[executor] Task ${task.id}: already running or claimed, skipping duplicate dispatch`);
      return;
    }
    this.claimedTasks.add(task.id);
    try {

    // Only execution tasks need workingDirectory resolution, safety checks,
    // git diff, and summary generation. All other types (plan/chat/summarize/
    // playground) skip this overhead but still get full tool access when they
    // have a working directory.
    const isExecutionTask = !task.type || task.type === 'execution';

    // Non-execution tasks can run without a working directory.
    // For execution tasks, resolve the directory or auto-provision one.
    let resolvedWorkDir: string | undefined;
    if (!isExecutionTask && !task.workingDirectory) {
      resolvedWorkDir = undefined;
    } else {
      try {
        resolvedWorkDir = resolveWorkingDirectory(task.workingDirectory, task.projectId);
      } catch (err) {
        // Fail fast with a clear error instead of entering the execution pipeline.
        // Without this, tasks with non-existent directories become dead jobs.
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[executor] Task ${task.id}: ${errorMsg}`);
        this.wsClient.sendTaskResult({
          taskId: task.id,
          status: 'failed',
          error: errorMsg,
          completedAt: new Date().toISOString(),
        });
        this.wsClient.removeActiveTask(task.id);
        return;
      }
    }

    const normalizedTask = {
      ...task,
      workingDirectory: resolvedWorkDir ?? '',
    } as Task & { workingDirectory: string };

    // Determine if worktree isolation will be used for this task.
    // Check git availability early: non-git directories cannot use git worktrees,
    // so willUseWorktree must be false for them. Without this, the safety check
    // thinks worktree isolation is active and allows parallel execution, but
    // prepareTaskWorkspace() later falls back to direct in-place execution —
    // causing file conflicts when multiple tasks run on the same non-git directory.
    const isGitDir = isExecutionTask && normalizedTask.workingDirectory && this.gitAvailable
      ? await isGitRepo(normalizedTask.workingDirectory)
      : false;
    const willUseWorktree = this.useWorktree
      && normalizedTask.useWorktree !== false
      && normalizedTask.deliveryMode !== 'direct'
      && (isGitDir || normalizedTask.deliveryMode === 'copy');

    if (isExecutionTask && task.skipSafetyCheck) {
      // Server already approved safety for this directory — skip the prompt.
      // Only init git when the original safety decision was 'init-git'.
      // When safetyDecision is 'proceed' (user chose non-git direct execution)
      // or undefined (builtin template, text-only, etc.), skip git init entirely.
      if (normalizedTask.safetyDecision === 'init-git') {
        const needsGitInit = this.gitAvailable && !(await isGitRepo(normalizedTask.workingDirectory));
        if (needsGitInit) {
          await initializeGit(normalizedTask.workingDirectory);
        }
      }
      this.trackTaskDirectory(normalizedTask);
      if (this.runningTasks.size < this.maxConcurrentTasks) {
        await this.executeTask(normalizedTask, false);
      } else {
        this.taskQueue.push(normalizedTask);
        this.wsClient.sendTaskStatus(normalizedTask.id, 'queued', 0, 'Waiting for available slot');
      }
      return;
    }

    if (isExecutionTask) {
      // Perform safety check (worktree flag affects tier assignment)
      const safetyCheck = await this.performSafetyCheck(normalizedTask, willUseWorktree);

      // Handle safety tiers
      if (safetyCheck.tier === WorkdirSafetyTier.UNSAFE) {
        // QUEUE: serial execution required (non-git parallel, or git + uncommitted + no worktree).
        // Instead of failing, queue the task and execute it once the current task
        // in this directory completes. Track it so further tasks also queue behind it.
        console.log(`[executor] Task ${normalizedTask.id}: queued for serial execution (${safetyCheck.parallelTaskCount} active in dir)`);
        this.trackTaskDirectory(normalizedTask);
        this.taskQueue.push(normalizedTask);
        const reason = safetyCheck.isGitRepo
          ? 'uncommitted changes without worktree isolation'
          : 'non-git directory';
        this.wsClient.sendTaskStatus(
          normalizedTask.id, 'queued', 0,
          `Waiting for ${safetyCheck.parallelTaskCount} task(s) in this directory to complete (serial execution: ${reason})`,
        );
        return;
      }

      if (safetyCheck.tier === WorkdirSafetyTier.RISKY && !this.allowNonGit) {
        // PROMPT: risky conditions require user decision
        await this.requestSafetyDecision(normalizedTask, safetyCheck);
        // Execution will continue when decision is received
        return;
      }

      if (safetyCheck.tier === WorkdirSafetyTier.GUARDED) {
        // WARN: inform user but continue
        this.wsClient.sendTaskStatus(normalizedTask.id, 'queued', 0, safetyCheck.warning);
      }
    }

    // Track task by directory (skip for text-only tasks without a working directory)
    if (normalizedTask.workingDirectory) {
      this.trackTaskDirectory(normalizedTask);
    }

    // Check if we can run immediately
    if (this.runningTasks.size < this.maxConcurrentTasks) {
      await this.executeTask(normalizedTask, this.useSandbox);
    } else {
      // Queue the task
      this.taskQueue.push(normalizedTask);
      this.wsClient.sendTaskStatus(normalizedTask.id, 'queued', 0, 'Waiting for available slot');
    }

    } finally {
      this.claimedTasks.delete(task.id);
    }
  }

  /**
   * Handle safety decision from user (via server)
   */
  async handleSafetyDecision(
    taskId: string,
    decision: 'proceed' | 'init-git' | 'sandbox' | 'cancel',
  ): Promise<void> {
    const pending = this.pendingSafetyChecks.get(taskId);
    if (!pending) {
      console.warn(`[executor] Safety decision for ${taskId} but no pending check`);
      return;
    }

    this.pendingSafetyChecks.delete(taskId);
    pending.resolveDecision(decision);
  }

  /**
   * Cancel a running or queued task
   */
  cancelTask(taskId: string): boolean {
    // Check running tasks
    const running = this.runningTasks.get(taskId);
    if (running) {
      running.abortController.abort();
      return true;
    }

    // Check queue
    const queueIndex = this.taskQueue.findIndex((t) => t.id === taskId);
    if (queueIndex >= 0) {
      const task = this.taskQueue[queueIndex];
      this.taskQueue.splice(queueIndex, 1);
      this.untrackTaskDirectory(task);
      this.wsClient.sendTaskResult({
        taskId,
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      });
      // Note: for cancellation the ordering is reversed compared to
      // completion/failure paths (which do sendTaskResult → removeActiveTask).
      // handleTaskCancel in websocket-client.ts removes from activeTasks BEFORE
      // calling onTaskCancel, so the task is already gone from the heartbeat by
      // the time we reach here. This defensive call is a no-op in the normal
      // cancel flow, but ensures cleanup if cancelTask is ever called directly.
      this.wsClient.removeActiveTask(taskId);
      return true;
    }

    return false;
  }

  /**
   * Clean up a completed task's worktree and branch.
   * Called when the server sends a reset/re-execute command.
   */
  async cleanupTask(taskId: string, branchName?: string): Promise<void> {
    console.log(`[executor] Task ${taskId}: cleanup requested${branchName ? ` (branch: ${branchName})` : ''}`);

    // If the task is still running, cancel it first
    const running = this.runningTasks.get(taskId);
    if (running) {
      console.log(`[executor] Task ${taskId}: cancelling running task before cleanup`);
      running.abortController.abort();
    }

    // Find and clean up worktree for this branch
    if (branchName) {
      try {
        const { execSync } = await import('node:child_process');
        // Find worktrees that use this branch
        const worktreeList = execSync('git worktree list --porcelain', {
          encoding: 'utf-8',
          timeout: 10_000,
        });

        let worktreePath: string | undefined;
        let currentPath: string | undefined;
        for (const line of worktreeList.split('\n')) {
          if (line.startsWith('worktree ')) {
            currentPath = line.slice('worktree '.length).trim();
          } else if (line.startsWith('branch ') && line.includes(branchName)) {
            worktreePath = currentPath;
            break;
          }
        }

        if (worktreePath) {
          console.log(`[executor] Task ${taskId}: removing worktree at ${worktreePath}`);
          try {
            execSync(`git worktree remove --force "${worktreePath}"`, { encoding: 'utf-8', timeout: 30_000 });
          } catch {
            // Force remove directory if git worktree remove fails
            execSync(`rm -rf "${worktreePath}"`, { encoding: 'utf-8', timeout: 10_000 });
            execSync('git worktree prune', { encoding: 'utf-8', timeout: 10_000 });
          }
          console.log(`[executor] Task ${taskId}: worktree removed`);
        }

        // Skip branch deletion for singleton delivery branches — these are shared
        // accumulation branches that outlive individual tasks and will be used for
        // the component's final PR to the base branch.
        if (this.singletonBranches.has(branchName)) {
          console.log(`[executor] Task ${taskId}: skipping branch deletion — ${branchName} is a singleton delivery branch`);
        } else {
          // Delete local branch
          try {
            execSync(`git branch -D "${branchName}"`, { encoding: 'utf-8', timeout: 10_000 });
            console.log(`[executor] Task ${taskId}: local branch ${branchName} deleted`);
          } catch {
            console.log(`[executor] Task ${taskId}: local branch ${branchName} not found or already deleted`);
          }

          // Delete remote branch
          try {
            execSync(`git push origin --delete "${branchName}"`, { encoding: 'utf-8', timeout: 30_000 });
            console.log(`[executor] Task ${taskId}: remote branch ${branchName} deleted`);
          } catch {
            console.log(`[executor] Task ${taskId}: remote branch ${branchName} not found or already deleted`);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[executor] Task ${taskId}: cleanup failed: ${msg}`);
      }
    }
  }

  /**
   * Get current task counts
   */
  getTaskCounts(): { running: number; queued: number } {
    return {
      running: this.runningTasks.size,
      queued: this.taskQueue.length,
    };
  }

  /**
   * Cancel all tasks and clear queue
   */
  cancelAll(): void {
    // Cancel all running tasks
    for (const [taskId, running] of this.runningTasks) {
      running.abortController.abort();
      this.wsClient.sendTaskResult({
        taskId,
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      });
      this.wsClient.removeActiveTask(taskId);
    }
    this.runningTasks.clear();

    // Clear queue — queued tasks may be in activeTasks (added in handleTaskDispatch)
    for (const task of this.taskQueue) {
      this.wsClient.sendTaskResult({
        taskId: task.id,
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      });
      this.wsClient.removeActiveTask(task.id);
    }
    this.taskQueue = [];

    // Clear directory tracking so stale entries don't inflate parallel task counts
    this.tasksByDirectory.clear();

    // Release all locks to unblock any waiting tasks
    this.branchLockManager.releaseAll();
    this.directoryLockManager.releaseAll();

    // Clear singleton tracking — all tasks cancelled, no branches to protect
    this.singletonBranches.clear();

    // Stop job monitor
    this.jobMonitor.stop();
  }

  /**
   * Update max concurrent tasks
   */
  setMaxConcurrentTasks(max: number): void {
    this.maxConcurrentTasks = max;
    // Process queue in case we can now run more tasks
    this.processQueue();
  }

  /**
   * Steer a running task by injecting a message into the agent session.
   * When interrupt=true, interrupts the current turn before injecting.
   *
   * For completed tasks with a preserved session, this triggers a full
   * resume via the SDK's `resume` option for post-completion follow-up.
   */
  async steerTask(taskId: string, message: string, interrupt = false, sessionId?: string): Promise<{ accepted: boolean; reason?: string }> {
    const running = this.runningTasks.get(taskId);

    if (running) {
      // Task is still running — inject message into the live session
      if (running.adapter.injectMessage) {
        const injected = await running.adapter.injectMessage(taskId, message, interrupt);
        if (injected) {
          return { accepted: true };
        }
        return { accepted: false, reason: 'Failed to inject message into running session' };
      }
      return { accepted: false, reason: 'Provider does not support mid-execution steering' };
    }

    // Task is not running — check if we have a preserved session for resume
    // sessionId hint from frontend can be used for validation; primary lookup is by taskId
    const resumeAdapter = this.findAdapterWithSession(taskId);
    if (resumeAdapter) {
      const context = resumeAdapter.getTaskContext!(taskId);
      if (context) {
        if (sessionId && context.sessionId !== sessionId) {
          console.warn(`[task-executor] Session hint mismatch for task ${taskId}: hint=${sessionId}, actual=${context.sessionId}`);
        }
        this.resumeCompletedSession(taskId, message, resumeAdapter, context);
        return { accepted: true };
      }
    }

    return { accepted: false, reason: 'Task not found or session expired' };
  }

  /** Check if an adapter supports session persistence and resume */
  private isResumableAdapter(adapter: ProviderAdapter): adapter is ProviderAdapter & Required<Pick<ProviderAdapter, 'getTaskContext' | 'resumeTask'>> {
    return typeof adapter.getTaskContext === 'function' && typeof adapter.resumeTask === 'function';
  }

  /** Remove completedTaskMeta entries older than TTL */
  private cleanupExpiredTaskMeta(): void {
    const now = Date.now();
    for (const [key, meta] of this.completedTaskMeta) {
      if (now - meta.storedAt > TaskExecutor.COMPLETED_TASK_META_TTL_MS) {
        this.completedTaskMeta.delete(key);
      }
    }
  }

  /**
   * Find the adapter that has a preserved session for the given task.
   */
  private findAdapterWithSession(taskId: string): ProviderAdapter | null {
    for (const adapter of this.adapters.values()) {
      if (this.isResumableAdapter(adapter)) {
        const context = adapter.getTaskContext!(taskId);
        if (context) return adapter;
      }
    }
    return null;
  }

  /**
   * Resume a completed task session for post-completion steering.
   * Provider-agnostic — works with any adapter that implements resumeTask().
   * Handles worktree cleanup by falling back to the original project directory.
   */
  private async resumeCompletedSession(
    taskId: string,
    message: string,
    adapter: ProviderAdapter,
    context: { sessionId: string; workingDirectory?: string; originalWorkingDirectory?: string },
  ): Promise<void> {
    const abortController = new AbortController();
    let textSequence = 0;

    const stream: TaskOutputStream = {
      stdout: (data: string) => {
        this.wsClient.sendTaskOutput(taskId, 'stdout', data, 0);
      },
      stderr: (data: string) => {
        this.wsClient.sendTaskOutput(taskId, 'stderr', data, 0);
      },
      status: (status: TaskStatus, progress?: number, statusMessage?: string) => {
        this.wsClient.sendTaskStatus(taskId, status, progress, statusMessage);
      },
      toolTrace: (toolName: string, toolInput?: unknown, toolResult?: unknown, success?: boolean) => {
        this.wsClient.sendToolTrace(taskId, toolName, toolInput, toolResult, success);
      },
      text: (data: string) => {
        this.wsClient.sendTaskText(taskId, data, textSequence++);
      },
      operational: (message: string, source: 'astro' | 'git' | 'delivery') => {
        this.wsClient.sendTaskOperational(taskId, message, source);
      },
      toolUse: (toolName: string, toolInput: unknown, toolUseId?: string) => {
        this.wsClient.sendTaskToolUse(taskId, toolName, toolInput, toolUseId);
      },
      toolResult: (toolName: string, result: unknown, success: boolean, toolUseId?: string) => {
        this.wsClient.sendTaskToolResult(taskId, toolName, result, success, toolUseId);
      },
      fileChange: (path: string, action: 'created' | 'modified' | 'deleted', linesAdded?: number, linesRemoved?: number, diff?: string) => {
        this.wsClient.sendTaskFileChange(taskId, path, action, linesAdded, linesRemoved, diff);
      },
      sessionInit: (sessionId: string, model?: string) => {
        this.wsClient.sendTaskSessionInit(taskId, sessionId, model);
      },
      approvalRequest: async (question: string, options: string[]) => {
        return this.wsClient.sendApprovalRequest(taskId, question, options);
      },
    };

    // Resolve working directory: existing worktree → recreate worktree → project dir → cwd
    let resumeDir = context.workingDirectory;
    let resumeWorktreeCleanup: (() => Promise<void>) | undefined;

    if (resumeDir && !existsSync(resumeDir)) {
      const meta = this.completedTaskMeta.get(taskId);
      if (meta?.originalWorkingDirectory && existsSync(meta.originalWorkingDirectory)) {
        // Try to recreate a worktree from the delivery branch (like a new task)
        try {
          console.log(`[executor] Task ${taskId}: worktree gone, recreating from delivery branch at ${meta.originalWorkingDirectory}`);
          const worktree = await createWorktree({
            workingDirectory: meta.originalWorkingDirectory,
            taskId: `resume-${taskId.slice(0, 12)}-${Date.now()}`,
            projectId: meta.projectId,
            shortProjectId: meta.shortProjectId,
            shortNodeId: meta.shortNodeId,
            agentDir: meta.agentDir,
            baseBranch: meta.baseBranch,
            deliveryBranch: meta.deliveryBranch,
            deliveryBranchIsSingleton: meta.deliveryBranchIsSingleton,
            stdout: stream.stdout,
            stderr: stream.stderr,
            operational: stream.operational,
          });
          if (worktree) {
            resumeDir = worktree.workingDirectory;
            resumeWorktreeCleanup = () => worktree.cleanup();
            console.log(`[executor] Task ${taskId}: resume worktree created at ${resumeDir}`);
          }
        } catch (err) {
          console.warn(`[executor] Task ${taskId}: worktree recreation failed (${err instanceof Error ? err.message : err}), using project dir`);
        }
        // If worktree creation failed, fall back to project dir
        if (!resumeWorktreeCleanup) {
          resumeDir = meta.originalWorkingDirectory;
        }
      } else {
        console.warn(`[executor] Task ${taskId}: worktree gone and no project dir available, using process.cwd()`);
        resumeDir = process.cwd();
      }
    }

    try {
      this.wsClient.sendTaskStatus(taskId, 'running', 0, `Resuming ${adapter.name} session...`);
      const result = await adapter.resumeTask!(
        taskId,
        message,
        resumeDir ?? process.cwd(),
        context.sessionId,
        stream,
        abortController.signal,
      );

      this.wsClient.sendTaskResult({
        taskId,
        status: result.success ? 'completed' : 'failed',
        output: result.output,
        error: result.error,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.wsClient.sendTaskResult({
        taskId,
        status: 'failed',
        error: `Resume failed: ${errorMsg}`,
        completedAt: new Date().toISOString(),
      });
    } finally {
      // Clean up the resume worktree (if one was created)
      if (resumeWorktreeCleanup) {
        try {
          await resumeWorktreeCleanup();
          console.log(`[executor] Task ${taskId}: resume worktree cleaned up`);
        } catch (err) {
          console.warn(`[executor] Task ${taskId}: resume worktree cleanup failed:`, err);
        }
      }
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Perform safety check on working directory
   */
  private async performSafetyCheck(task: Task & { workingDirectory: string }, willUseWorktree: boolean): Promise<SafetyCheckResult> {
    const activeTasksInDir = this.getActiveTasksInDirectory(task.workingDirectory);
    return await checkWorkdirSafety(task.workingDirectory, activeTasksInDir, this.gitAvailable, willUseWorktree);
  }

  /**
   * Request safety decision from user
   */
  private async requestSafetyDecision(
    task: Task & { workingDirectory: string },
    safetyCheck: SafetyCheckResult,
  ): Promise<void> {
    // Send safety prompt to server (which forwards to UI)
    const options = [
      { id: 'proceed', label: 'Continue anyway', description: 'Execute in non-git directory at your own risk' },
      { id: 'init-git', label: 'Initialize git first', description: 'Create git repository before execution' },
      { id: 'sandbox', label: 'Use sandbox mode', description: 'Work on a copy, review changes before applying' },
      { id: 'cancel', label: 'Cancel task', description: 'Do not execute this task' },
    ];

    // Create promise that will be resolved when decision arrives, with a 5-minute timeout
    const SAFETY_DECISION_TIMEOUT_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
    const decisionPromise = new Promise<'proceed' | 'init-git' | 'sandbox' | 'cancel'>((resolve) => {
      this.pendingSafetyChecks.set(task.id, {
        task,
        safetyResult: safetyCheck,
        resolveDecision: resolve,
      });

      // Auto-cancel if no decision within timeout
      setTimeout(() => {
        if (this.pendingSafetyChecks.has(task.id)) {
          console.warn(`[executor] Safety decision for task ${task.id} timed out after ${SAFETY_DECISION_TIMEOUT_MS / 1000}s, auto-cancelling`);
          this.pendingSafetyChecks.delete(task.id);
          resolve('cancel');
        }
      }, SAFETY_DECISION_TIMEOUT_MS).unref();
    });

    // Send prompt
    this.wsClient.sendSafetyPrompt(task.id, safetyCheck.tier, safetyCheck.warning, options);

    // Wait for decision
    const decision = await decisionPromise;

    // Handle decision
    switch (decision) {
      case 'proceed':
        // Mark as allowed and continue
        this.trackTaskDirectory(task);
        if (this.runningTasks.size < this.maxConcurrentTasks) {
          await this.executeTask(task, false);
        } else {
          this.taskQueue.push(task);
          this.wsClient.sendTaskStatus(task.id, 'queued', 0, 'Waiting for available slot');
        }
        break;

      case 'sandbox':
        // Execute in sandbox mode
        this.trackTaskDirectory(task);
        if (this.runningTasks.size < this.maxConcurrentTasks) {
          await this.executeTask(task, true); // Force sandbox mode
        } else {
          this.taskQueue.push(task);
          this.wsClient.sendTaskStatus(task.id, 'queued', 0, 'Waiting for available slot (sandbox)');
        }
        break;

      case 'init-git':
        // Initialize git and retry
        try {
          await initializeGit(task.workingDirectory);
          this.wsClient.sendTaskStatus(task.id, 'queued', 0, 'Git initialized, proceeding...');
          this.trackTaskDirectory(task);
          if (this.runningTasks.size < this.maxConcurrentTasks) {
            await this.executeTask(task, false);
          } else {
            this.taskQueue.push(task);
            this.wsClient.sendTaskStatus(task.id, 'queued', 0, 'Waiting for available slot');
          }
        } catch (error) {
          this.wsClient.sendTaskResult({
            taskId: task.id,
            status: 'failed',
            error: `Failed to initialize git: ${error instanceof Error ? error.message : String(error)}`,
            completedAt: new Date().toISOString(),
          });
          this.wsClient.removeActiveTask(task.id);
        }
        break;

      case 'cancel':
        // Cancel the task
        this.wsClient.sendTaskResult({
          taskId: task.id,
          status: 'cancelled',
          completedAt: new Date().toISOString(),
        });
        this.wsClient.removeActiveTask(task.id);
        break;
    }
  }

  // initializeGit() extracted to git-bootstrap.ts (shared with start.ts onGitInit)

  /**
   * Check if a git repo has any commits.
   */
  private async repoHasCommits(workdir: string): Promise<boolean> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync('git', ['-C', workdir, 'rev-list', '--count', 'HEAD'], { timeout: 5_000 });
      return parseInt(stdout.trim(), 10) > 0;
    } catch {
      return false;
    }
  }

  /** Resolve a canonical directory key for task tracking (matches lock keys). */
  private canonicalDirKey(workdir: string): string {
    return canonicalDirPath(workdir);
  }

  /**
   * Track task by directory for parallel execution safety
   */
  private trackTaskDirectory(task: Pick<Task & { workingDirectory: string }, 'id' | 'workingDirectory'>): void {
    const key = this.canonicalDirKey(task.workingDirectory);
    const tasks = this.tasksByDirectory.get(key) || new Set();
    tasks.add(task.id);
    this.tasksByDirectory.set(key, tasks);
  }

  /**
   * Untrack task from directory
   */
  private untrackTaskDirectory(task: Task): void {
    if (!task.workingDirectory) return;
    const key = this.canonicalDirKey(task.workingDirectory);
    const tasks = this.tasksByDirectory.get(key);
    if (tasks) {
      tasks.delete(task.id);
      if (tasks.size === 0) {
        this.tasksByDirectory.delete(key);
      }
    }
  }

  /**
   * Get count of active tasks in a directory
   */
  private getActiveTasksInDirectory(workdir: string): number {
    const key = this.canonicalDirKey(workdir);
    const tasks = this.tasksByDirectory.get(key);
    return tasks ? tasks.size : 0;
  }

  private async executeTask(task: Task & { workingDirectory: string }, useSandbox = false): Promise<void> {
    console.log(`[executor] Task ${task.id}: workingDirectory=${task.workingDirectory} sandbox=${useSandbox}`);

    // Setup sandbox if requested
    let sandbox: SandboxSetup | undefined;
    let workdir = task.workingDirectory;

    if (useSandbox) {
      try {
        this.wsClient.sendTaskStatus(task.id, 'running', 0, 'Creating sandbox...');
        sandbox = await createSandbox({
          workdir: task.workingDirectory,
          taskId: task.id,
          maxSize: this.maxSandboxSize,
        });
        workdir = sandbox.sandboxPath;
        console.log(`[executor] Task ${task.id}: sandbox created at ${sandbox.sandboxPath}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[executor] Task ${task.id}: sandbox creation failed: ${errorMsg}`);
        this.wsClient.sendTaskResult({
          taskId: task.id,
          status: 'failed',
          error: `Sandbox creation failed: ${errorMsg}`,
          completedAt: new Date().toISOString(),
        });
        this.runningTasks.delete(task.id);
        this.wsClient.removeActiveTask(task.id);
        this.untrackTaskDirectory(task);
        this.processQueue();
        return;
      }
    }

    const normalizedTask = { ...task, workingDirectory: workdir };

    // Get or create adapter for this provider
    const adapter = await this.getAdapter(normalizedTask.provider);
    if (!adapter) {
      console.error(`[executor] Task ${task.id}: provider ${normalizedTask.provider} not available`);
      this.wsClient.sendTaskResult({
        taskId: normalizedTask.id,
        status: 'failed',
        error: `Provider ${normalizedTask.provider} not available`,
        completedAt: new Date().toISOString(),
      });
      if (sandbox) await sandbox.cleanup();
      this.runningTasks.delete(task.id);
      this.wsClient.removeActiveTask(task.id);
      this.untrackTaskDirectory(task);
      this.processQueue();
      return;
    }
    console.log(`[executor] Task ${task.id}: adapter ${adapter.name} (${adapter.type}) ready, taskType=${normalizedTask.type ?? 'undefined'}, provider=${normalizedTask.provider}, resumeSessionId=${normalizedTask.resumeSessionId ?? 'none'}`);

    const abortController = new AbortController();
    const outputSequence = { stdout: 0, stderr: 0 };

    // Create stream handlers before workspace prep so setup output is captured
    let textSequence = 0;

    // Idle timeout: resets every time the agent emits activity.
    // If no activity for defaultIdleTimeout ms, the task is aborted.
    const idleTimeoutMs = this.defaultIdleTimeout;
    let idleTimerId: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimeout = () => {
      if (idleTimerId !== undefined) clearTimeout(idleTimerId);
      idleTimerId = setTimeout(() => {
        console.log(`[executor] Task ${task.id}: idle timeout -- no activity for ${formatDuration(idleTimeoutMs)}, aborting`);
        abortController.abort();
      }, idleTimeoutMs);
    };

    const stream = {
      stdout: (data: string) => {
        resetIdleTimeout();
        this.wsClient.sendTaskOutput(normalizedTask.id, 'stdout', data, outputSequence.stdout++);
      },
      stderr: (data: string) => {
        resetIdleTimeout();
        this.wsClient.sendTaskOutput(normalizedTask.id, 'stderr', data, outputSequence.stderr++);
      },
      status: (status: TaskStatus, progress?: number, message?: string) => {
        resetIdleTimeout();
        this.wsClient.sendTaskStatus(normalizedTask.id, status, progress, message);
      },
      toolTrace: (toolName: string, toolInput?: unknown, toolResult?: unknown, success?: boolean) => {
        resetIdleTimeout();
        this.wsClient.sendToolTrace(normalizedTask.id, toolName, toolInput, toolResult, success);
      },
      text: (data: string) => {
        resetIdleTimeout();
        this.wsClient.sendTaskText(normalizedTask.id, data, textSequence++);
      },
      operational: (message: string, source: 'astro' | 'git' | 'delivery') => {
        resetIdleTimeout();
        this.wsClient.sendTaskOperational(normalizedTask.id, message, source);
      },
      toolUse: (toolName: string, toolInput: unknown, toolUseId?: string) => {
        resetIdleTimeout();
        this.wsClient.sendTaskToolUse(normalizedTask.id, toolName, toolInput, toolUseId);
      },
      toolResult: (toolName: string, result: unknown, success: boolean, toolUseId?: string) => {
        resetIdleTimeout();
        this.wsClient.sendTaskToolResult(normalizedTask.id, toolName, result, success, toolUseId);
      },
      fileChange: (path: string, action: 'created' | 'modified' | 'deleted', linesAdded?: number, linesRemoved?: number, diff?: string) => {
        resetIdleTimeout();
        this.wsClient.sendTaskFileChange(normalizedTask.id, path, action, linesAdded, linesRemoved, diff);
      },
      sessionInit: (sessionId: string, model?: string) => {
        resetIdleTimeout();
        this.wsClient.sendTaskSessionInit(normalizedTask.id, sessionId, model);
      },
      approvalRequest: async (question: string, options: string[]) => {
        // Pause idle timeout while waiting for user response — they may take a while.
        // The hard cap still protects against infinite waits.
        if (idleTimerId !== undefined) clearTimeout(idleTimerId);
        const response = await this.wsClient.sendApprovalRequest(normalizedTask.id, question, options);
        resetIdleTimeout();
        return response;
      },
    };

    const runningTask: RunningTask = {
      task: normalizedTask,
      abortController,
      adapter,
      outputSequence,
      sandbox,
    };

    this.runningTasks.set(normalizedTask.id, runningTask);
    this.wsClient.addActiveTask(normalizedTask.id);

    // Task-level heartbeat: send a lightweight text event every 30s to keep the
    // server's activity timer alive. This prevents the server's startup timeout
    // from resetting the node to "planned" while we're doing workspace prep,
    // delivery, cleanup, or any other long-running phase. The server only resets
    // hasReceivedEvent from execution events (text, tool_use, etc.) — without
    // this heartbeat, phases that don't produce those events (git operations,
    // worktree creation, PR delivery) leave the server blind.
    // 30s aligns with the server's heartbeat check interval and is well under
    // the 3-minute startup timeout (STARTUP_TIMEOUT_MS in dispatch.ts).
    const TASK_HEARTBEAT_INTERVAL_MS = 30_000;
    let heartbeatSeq = 0;
    const taskHeartbeatTimer = setInterval(() => {
      // Send directly via wsClient to keep the server's activity timer alive
      // WITHOUT resetting the agent-side idle timeout. stream.text() calls
      // resetIdleTimeout(), which would make a hung agent run until hard cap
      // instead of idle-timing out after 15 minutes of no real activity.
      // Heartbeat text is intentionally empty — it exists only to keep the
      // server's activity timer alive, not to display anything to the user.
      this.wsClient.sendTaskText(
        normalizedTask.id,
        '',
        -(++heartbeatSeq),  // negative sequence to avoid colliding with real text
      );
    }, TASK_HEARTBEAT_INTERVAL_MS);

    // Only execution tasks get git diff, delivery, and summary — all other types (chat, plan, playground, summarize) skip them.
    // These non-execution types still get full tool access when they have a working directory.
    const isExecutionTask = !normalizedTask.type || normalizedTask.type === 'execution';
    let prepared: Awaited<ReturnType<typeof this.prepareTaskWorkspace>>;
    try {
      prepared = !isExecutionTask && !normalizedTask.workingDirectory
        ? { workingDirectory: '', cleanup: async () => {} }
        : await this.prepareTaskWorkspace(normalizedTask, stream, abortController.signal);
    } catch (prepErr) {
      clearInterval(taskHeartbeatTimer);
      this.runningTasks.delete(normalizedTask.id);
      this.untrackTaskDirectory(task);
      // Do NOT removeActiveTask here — the caller's catch will send
      // sendTaskResult first, then removeActiveTask. Removing from heartbeat
      // before the result is sent is the exact race this PR fixes.
      throw prepErr;
    }
    const taskWithWorkspace = { ...normalizedTask, workingDirectory: prepared.workingDirectory };
    runningTask.task = taskWithWorkspace;
    console.log(`[executor] Task ${task.id}: workspace prepared, cwd=${prepared.workingDirectory}`);

    // Execute with idle timeout + hard cap.
    // Idle timeout resets on every stream activity (text, tool, file, etc.).
    // Hard cap is a non-resettable safety limit.
    const hardCapMs = task.timeout ?? this.defaultTimeout;
    const hardCapTimeoutId = setTimeout(() => {
      console.log(`[executor] Task ${task.id}: hard cap timeout (${formatDuration(hardCapMs)}), aborting`);
      abortController.abort();
    }, hardCapMs);
    // Start the idle timer
    resetIdleTimeout();

    let keepBranch = false;
    // Deferred result — sent AFTER cleanup to prevent auto-dispatch race.
    // The server dispatches downstream tasks immediately on receiving the result,
    // and the new task's createWorktree() would fight with this task's cleanupWorktree()
    // over the same .git directory (concurrent git worktree prune, branch -D, etc.).
    let pendingResult: TaskResult | undefined;
    try {
      // Notify task started
      this.wsClient.sendTaskStatus(task.id, 'running', 0, 'Starting');

      // Resume existing session if resumeSessionId is provided
      const canResume = taskWithWorkspace.resumeSessionId
        && this.isResumableAdapter(adapter)
        && !isExecutionTask;

      let result: Awaited<ReturnType<typeof adapter.execute>>;
      if (canResume) {
        console.log(`[executor] Task ${task.id}: resuming session ${taskWithWorkspace.resumeSessionId} with ${adapter.name} (type=${adapter.type}, hasMessages=${!!taskWithWorkspace.messages?.length})...`);
        const resumeStartedAt = new Date().toISOString();
        try {
          const resumeResult = await adapter.resumeTask(
            taskWithWorkspace.id,
            taskWithWorkspace.prompt,
            taskWithWorkspace.workingDirectory || process.cwd(),
            taskWithWorkspace.resumeSessionId!,
            stream,
            abortController.signal,
          );
          if (resumeResult.success) {
            result = {
              taskId: taskWithWorkspace.id,
              status: 'completed',
              output: resumeResult.output,
              startedAt: resumeStartedAt,
              completedAt: new Date().toISOString(),
            };
          } else {
            // Resume resolved but failed (e.g. Codex session expired, CLI error) —
            // fall back to fresh execution. Codex/OpenCode adapters resolve with
            // { success: false } instead of throwing, so the catch block won't fire.
            console.warn(`[executor] Task ${task.id}: resume returned failure (${resumeResult.error}), falling back to fresh execution`);
            result = await adapter.execute(taskWithWorkspace, stream, abortController.signal);
          }
        } catch (resumeErr) {
          // Resume threw (Claude SDK throws on session errors) —
          // fall back to fresh execution with conversation history in messages
          console.warn(`[executor] Task ${task.id}: resume threw (${resumeErr instanceof Error ? resumeErr.message : resumeErr}), falling back to fresh execution`);
          result = await adapter.execute(taskWithWorkspace, stream, abortController.signal);
        }
      } else {
        console.log(`[executor] Task ${task.id}: executing with ${adapter.name}...`);
        result = await adapter.execute(taskWithWorkspace, stream, abortController.signal);
      }

      // Store original working directory on the adapter's session so post-completion
      // resume can fall back to it when the worktree has been cleaned up.
      if (normalizedTask.workingDirectory && prepared.workingDirectory !== normalizedTask.workingDirectory) {
        adapter.setOriginalWorkingDirectory?.(task.id, normalizedTask.workingDirectory);
        // Preserve task metadata for worktree recreation on resume
        this.cleanupExpiredTaskMeta();
        this.completedTaskMeta.set(task.id, {
          originalWorkingDirectory: normalizedTask.workingDirectory,
          deliveryBranch: normalizedTask.deliveryBranch ?? normalizedTask.projectBranch,
          baseBranch: normalizedTask.baseBranch,
          agentDir: normalizedTask.agentDir,
          shortProjectId: normalizedTask.shortProjectId,
          shortNodeId: normalizedTask.shortNodeId,
          projectId: normalizedTask.projectId,
          deliveryBranchIsSingleton: normalizedTask.deliveryBranchIsSingleton,
          storedAt: Date.now(),
        });
      }

      // Emit accurate file change events via git diff (covers all change methods)
      if (isExecutionTask && prepared.workingDirectory) {
        await this.emitGitDiffFileChanges(task.id, prepared.workingDirectory, prepared.commitBeforeSha, stream);
      }

      // Delivery-mode-aware result handling
      // If pr mode is requested but gh is unavailable, fall back to branch mode
      // so the work is still merged locally into the delivery branch.
      let deliveryMode = task.deliveryMode ?? 'pr';
      if (deliveryMode === 'pr' && !(await isGhAvailable())) {
        console.log(`[executor] Task ${task.id}: gh CLI not available, falling back from 'pr' to 'branch' mode`);
        this.wsClient.sendTaskStatus(task.id, 'running', 90, 'GitHub CLI (gh) not available — falling back to local branch merge');
        deliveryMode = 'branch';
      }
      // Build PR title: prefer summary.workCompleted (agent knows what it did),
      // fall back to static task title
      const summary = result.summary;
      if (summary) {
        console.log(`[executor] Task ${task.id}: summary available — status=${summary.status}, workCompleted=${!!summary.workCompleted}, executiveSummary=${!!summary.executiveSummary}, keyFindings=${summary.keyFindings?.length ?? 0}, filesChanged=${summary.filesChanged?.length ?? 0}`);
      } else if (isExecutionTask) {
        console.warn(`[executor] Task ${task.id}: no summary available for PR body`);
      }
      const rawTitle = summary?.workCompleted || task.title || task.prompt.slice(0, 100);
      const prTitle = task.shortProjectId && task.shortNodeId
        ? `[${task.shortProjectId}/${task.shortNodeId}] ${rawTitle}`
        : rawTitle;
      if (prepared.branchName && result.status === 'completed') {
        stream.operational?.(`Delivering changes (mode: ${deliveryMode})...`, 'astro');
        this.wsClient.sendTaskStatus(task.id, 'running', 90, 'Delivering changes...');
        // Resolve GitHub repo slug (OWNER/REPO) for explicit gh --repo targeting.
        // This makes gh pr create/merge independent of local filesystem state
        // (worktree may be cleaned up by the agent during execution).
        const repoSlug = prepared.gitRoot ? await getRepoSlug(prepared.gitRoot) : undefined;
        // Build PR body: enrich with summary data when available
        const prBodyParts: string[] = [];
        if (summary) {
          // Use structured summary for a richer PR description
          prBodyParts.push(`## Summary\n\n${summary.workCompleted}`);
          if (summary.executiveSummary) {
            prBodyParts.push(`## Overview\n\n${summary.executiveSummary}`);
          }
          if (summary.keyFindings.length > 0) {
            prBodyParts.push(`## Changes\n\n${summary.keyFindings.map(f => `- ${f}`).join('\n')}`);
          }
          if (summary.filesChanged.length > 0) {
            prBodyParts.push(`## Files Changed\n\n${summary.filesChanged.map(f => `- \`${f}\``).join('\n')}`);
          }
        } else if (task.description || task.prompt) {
          prBodyParts.push(`## Task\n\n${task.description || task.prompt.slice(0, 500)}`);
        }
        if (task.astroBaseUrl && task.projectId && task.planNodeId) {
          prBodyParts.push(`## Astro\n\n[View task in Astro](${task.astroBaseUrl}/project/${task.projectId}/task/${task.planNodeId})`);
        }
        if (task.githubIssueUrl) {
          prBodyParts.push(`## Related Issue\n\nCloses ${task.githubIssueUrl}`);
        } else if (task.githubIssueNumber) {
          prBodyParts.push(`## Related Issue\n\nCloses #${task.githubIssueNumber}`);
        }
        prBodyParts.push('---\n*Created by Astro task automation*');
        const prBody = prBodyParts.join('\n\n');

        try {
          if (deliveryMode === 'direct') {
            // No git delivery — files modified in-place
            stream.operational?.('Changes applied in-place (direct mode)', 'delivery');
            console.log(`[executor] Task ${task.id}: direct mode, skipping git delivery`);
          } else if (deliveryMode === 'copy') {
            // Copy mode: worktree preserved, no git operations
            stream.operational?.('Worktree preserved (copy mode)', 'delivery');
            console.log(`[executor] Task ${task.id}: copy mode, worktree preserved at ${prepared.workingDirectory}`);
          } else if (deliveryMode === 'branch') {
            stream.operational?.(`Merging into delivery branch ${prepared.deliveryBranch ?? 'local'}...`, 'git');
            // Branch mode: commit locally, merge into delivery branch if available.
            // The merge lock is held only during the squash-merge (seconds, not minutes),
            // allowing tasks to execute in parallel. The squash merge naturally handles
            // the case where the delivery branch moved forward (another task merged first)
            // because it computes the diff from the merge-base and applies it on the
            // current delivery branch tip.
            //
            // On conflict: if the provider supports session resume (Claude SDK), we
            // resume the agent session to let it resolve the conflict, then retry.
            result.branchName = prepared.branchName;
            keepBranch = true;

            if (prepared.gitRoot && prepared.deliveryBranch && prepared.branchName) {
              // Pre-merge rebase: if the delivery branch moved forward (another task
              // merged), rebase our task branch first. Avoids conflicts when changes
              // don't overlap, and saves one retry cycle when they do.
              const preRebase = await tryPreMergeRebase(prepared.workingDirectory, prepared.deliveryBranch, false);
              if (preRebase.rebased) {
                stream.operational?.(`Rebased onto ${prepared.deliveryBranch}`, 'git');
                console.log(`[executor] Task ${task.id}: pre-merge rebase onto ${prepared.deliveryBranch} succeeded`);
              } else if (!preRebase.skipped) {
                stream.operational?.('Rebase skipped (conflicts), retrying via merge', 'git');
                console.log(`[executor] Task ${task.id}: pre-merge rebase had conflicts, falling back to merge retry loop`);
              }

              const mergeLockKey = BranchLockManager.computeLockKey(
                prepared.gitRoot,
                task.shortProjectId,
                task.shortNodeId,
                task.id,
              );
              const commitMessage = `[${task.shortProjectId ?? 'astro'}/${task.shortNodeId ?? task.id.slice(0, 6)}] ${rawTitle}`;
              const MAX_MERGE_ATTEMPTS = 3;

              for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
                // Acquire merge lock — held only during the squash-merge (seconds).
                this.wsClient.sendTaskStatus(task.id, 'running', 95, attempt === 1 ? 'Waiting for merge lock...' : `Retrying merge (attempt ${attempt}/${MAX_MERGE_ATTEMPTS})...`);
                const mergeLock = await this.branchLockManager.acquire(mergeLockKey, task.id);
                let mergeResult;
                try {
                  this.wsClient.sendTaskStatus(task.id, 'running', 96, 'Merging into delivery branch...');
                  mergeResult = await localMergeIntoDeliveryBranch(
                    prepared.gitRoot,
                    prepared.branchName,
                    prepared.deliveryBranch,
                    commitMessage,
                    (msg) => stream.operational?.(msg, 'git'),
                  );
                } finally {
                  mergeLock.release();
                  console.log(`[executor] Task ${task.id}: merge lock released (attempt ${attempt})`);
                }

                if (mergeResult.merged) {
                  result.deliveryStatus = 'success';
                  result.commitAfterSha = mergeResult.commitSha;
                  stream.operational?.(`Merged into ${prepared.deliveryBranch} (${mergeResult.commitSha?.slice(0, 7)})`, 'git');
                  console.log(`[executor] Task ${task.id}: merged into ${prepared.deliveryBranch} (${mergeResult.commitSha})`);
                  // Sync delivery worktree to reflect the merged changes on disk
                  if (prepared.deliveryWorktreePath && prepared.deliveryBranch && prepared.gitRoot) {
                    await syncDeliveryWorktree(prepared.deliveryWorktreePath, prepared.deliveryBranch, prepared.gitRoot);
                  }
                  break;
                } else if (mergeResult.conflict) {
                  // Can the agent resolve this? Check if adapter supports session resume.
                  // Get context once; isResumableAdapter narrows adapter type for resumeTask().
                  const taskContext = this.isResumableAdapter(adapter)
                    ? adapter.getTaskContext(task.id)
                    : null;

                  if (taskContext?.sessionId && this.isResumableAdapter(adapter) && attempt < MAX_MERGE_ATTEMPTS) {
                    const conflictFiles = mergeResult.conflictFiles?.join(', ') ?? 'unknown files';
                    stream.operational?.(`Merge conflict: ${conflictFiles} — agent resolving (attempt ${attempt})...`, 'git');
                    console.log(`[executor] Task ${task.id}: merge conflict (attempt ${attempt}), resuming ${adapter.name} to resolve: ${conflictFiles}`);
                    this.wsClient.sendTaskStatus(task.id, 'running', 97, `Merge conflict — agent resolving (attempt ${attempt})...`);

                    // Resume agent session with conflict resolution instructions.
                    // No merge lock held during this — agent may take minutes.
                    try {
                      await adapter.resumeTask(
                        task.id,
                        buildConflictResolutionPrompt(mergeResult.conflictFiles ?? [], prepared.deliveryBranch, attempt, MAX_MERGE_ATTEMPTS),
                        prepared.workingDirectory,
                        taskContext.sessionId,
                        stream,
                        abortController.signal,
                      );
                      console.log(`[executor] Task ${task.id}: agent conflict resolution session completed (attempt ${attempt})`);
                    } catch (resumeErr) {
                      console.error(`[executor] Task ${task.id}: agent conflict resolution failed: ${resumeErr instanceof Error ? resumeErr.message : resumeErr}`);
                      result.deliveryStatus = 'failed';
                      result.deliveryError = `Merge conflict in: ${mergeResult.conflictFiles?.join(', ') ?? 'unknown files'}. Agent resolution failed: ${resumeErr instanceof Error ? resumeErr.message : resumeErr}`;
                      break;
                    }
                    // Loop continues — will retry merge
                    continue;
                  }

                  // No resume capability or final attempt — fail
                  result.deliveryStatus = 'failed';
                  result.deliveryError = attempt > 1
                    ? `Merge conflict unresolved after ${attempt} attempts: ${mergeResult.conflictFiles?.join(', ')}`
                    : `Merge conflict in: ${mergeResult.conflictFiles?.join(', ')}`;
                  console.error(`[executor] Task ${task.id}: merge conflict — ${result.deliveryError}`);
                  break;
                } else if (mergeResult.error) {
                  result.deliveryStatus = 'failed';
                  result.deliveryError = mergeResult.error;
                  console.error(`[executor] Task ${task.id}: merge failed — ${mergeResult.error}`);
                  break;
                } else {
                  // No changes to merge
                  result.deliveryStatus = 'skipped';
                  console.log(`[executor] Task ${task.id}: no changes to merge`);
                  break;
                }
              }
            } else if (prepared.deliveryBranch) {
              console.warn(`[executor] Task ${task.id}: deliveryBranch=${prepared.deliveryBranch} but gitRoot=${prepared.gitRoot}, branchName=${prepared.branchName} — skipping local merge`);
            } else {
              console.log(`[executor] Task ${task.id}: branch mode, committing locally (no delivery branch)`);
            }
          } else if (deliveryMode === 'push') {
            // Push branch to remote, but don't create a PR — user creates PR manually
            stream.operational?.(`Pushing ${prepared.branchName} to origin...`, 'git');
            this.wsClient.sendTaskStatus(task.id, 'running', 95, 'Pushing branch...');
            console.log(`[executor] Task ${task.id}: push mode, pushing branch ${prepared.branchName}`);
            const prResult = await pushAndCreatePR(prepared.workingDirectory, {
              branchName: prepared.branchName,
              taskTitle: prTitle,
              taskDescription: task.description || task.prompt.slice(0, 500),
              skipPR: true,
              baseBranch: prepared.baseBranch,
              gitRoot: prepared.gitRoot,
            });
            result.branchName = prResult.branchName;
            if (prResult.error) {
              // Delivery failure — don't override execution status
              result.deliveryStatus = 'failed';
              result.deliveryError = `Push delivery failed: ${prResult.error}`;
              stream.operational?.(`Push failed: ${prResult.error}`, 'git');
              console.error(`[executor] Task ${task.id}: push delivery failed: ${prResult.error}`);
            } else if (prResult.pushed) {
              result.deliveryStatus = 'success';
              keepBranch = true;
              stream.operational?.(`Pushed to origin: ${prepared.branchName}`, 'git');
              console.log(`[executor] Task ${task.id}: branch pushed (${prepared.branchName})`);
            } else {
              result.deliveryStatus = 'skipped';
              stream.operational?.('No changes to push', 'git');
              console.log(`[executor] Task ${task.id}: no changes to push`);
            }
          } else {
            // 'pr' — push + create PR, auto-merge into delivery branch if applicable
            stream.operational?.(`Creating PR: ${prepared.branchName} → ${prepared.baseBranch ?? 'main'}...`, 'git');
            this.wsClient.sendTaskStatus(task.id, 'running', 94, 'Rebasing before push...');
            // Pre-push rebase: if the target branch moved forward, rebase our task
            // branch so the PR will be cleanly mergeable. The branch hasn't been
            // pushed yet, so no force-push is needed.
            if (prepared.baseBranch) {
              const preRebase = await tryPreMergeRebase(prepared.workingDirectory, prepared.baseBranch, true);
              if (preRebase.rebased) {
                stream.operational?.(`Rebased onto origin/${prepared.baseBranch}`, 'git');
                console.log(`[executor] Task ${task.id}: pre-push rebase onto origin/${prepared.baseBranch} succeeded`);
              } else if (!preRebase.skipped) {
                stream.operational?.('Rebase skipped (conflicts), proceeding without rebase', 'git');
                console.log(`[executor] Task ${task.id}: pre-push rebase had conflicts, proceeding without rebase`);
              }
            }

            this.wsClient.sendTaskStatus(task.id, 'running', 95, 'Creating pull request...');
            console.log(`[executor] Task ${task.id}: pr mode, attempting PR creation for branch ${prepared.branchName}`);
            // Singleton delivery branches create PRs directly to the base branch
            // (no auto-merge into an accumulation branch). Multi-task components
            // auto-merge per-task PRs into the delivery branch.
            const hasDeliveryBranch = !!(task.deliveryBranch ?? task.projectBranch) && !task.deliveryBranchIsSingleton;
            const prResult = await pushAndCreatePR(prepared.workingDirectory, {
              branchName: prepared.branchName,
              taskTitle: prTitle,
              taskDescription: task.description || task.prompt.slice(0, 500),
              body: prBody,
              baseBranch: prepared.baseBranch,
              autoMerge: hasDeliveryBranch,
              commitBeforeSha: prepared.commitBeforeSha,
              gitRoot: prepared.gitRoot,
            });
            result.branchName = prResult.branchName;
            if (prResult.prUrl) {
              result.prUrl = prResult.prUrl;
              result.prNumber = prResult.prNumber;
              result.commitBeforeSha = prResult.commitBeforeSha;
              result.commitAfterSha = prResult.commitAfterSha;
              keepBranch = true;
              stream.operational?.(`PR created: ${prResult.prUrl}`, 'git');

              if (prResult.autoMergeFailed) {
                // PR was created but auto-merge failed (likely conflict).
                // If the adapter supports session resume, ask the agent to
                // rebase and force-push, then retry the GitHub merge.
                const MAX_PR_MERGE_ATTEMPTS = 3;
                let prMergeResolved = false;

                const prTaskContext = this.isResumableAdapter(adapter)
                  ? adapter.getTaskContext(task.id)
                  : null;

                if (prTaskContext?.sessionId && this.isResumableAdapter(adapter) && hasDeliveryBranch && prepared.branchName && prepared.baseBranch && prResult.prNumber && prepared.gitRoot) {
                  for (let attempt = 1; attempt <= MAX_PR_MERGE_ATTEMPTS; attempt++) {
                    stream.operational?.(`Auto-merge failed — agent resolving conflict (attempt ${attempt})...`, 'git');
                    console.log(`[executor] Task ${task.id}: PR auto-merge failed (attempt ${attempt}), resuming ${adapter.name} to resolve`);
                    this.wsClient.sendTaskStatus(task.id, 'running', 97, `PR merge conflict — agent resolving (attempt ${attempt})...`);

                    // Resume agent session — agent rebases and force-pushes.
                    try {
                      await adapter.resumeTask(
                        task.id,
                        buildPRConflictResolutionPrompt(prepared.baseBranch, prepared.branchName, attempt, MAX_PR_MERGE_ATTEMPTS),
                        prepared.workingDirectory,
                        prTaskContext.sessionId,
                        stream,
                        abortController.signal,
                      );
                      console.log(`[executor] Task ${task.id}: agent PR conflict resolution completed (attempt ${attempt})`);
                    } catch (resumeErr) {
                      console.error(`[executor] Task ${task.id}: agent PR conflict resolution failed: ${resumeErr instanceof Error ? resumeErr.message : resumeErr}`);
                      result.deliveryStatus = 'failed';
                      result.deliveryError = `PR created but auto-merge failed. Agent resolution failed: ${resumeErr instanceof Error ? resumeErr.message : resumeErr}`;
                      break;
                    }

                    // Retry the GitHub merge.
                    // Use gitRoot as cwd (always valid, guarded at L1518) instead of
                    // worktree path which may have been deleted during resolution.
                    this.wsClient.sendTaskStatus(task.id, 'running', 98, `Retrying PR merge (attempt ${attempt})...`);
                    const retryMerge = await mergePullRequest(prepared.gitRoot!, prResult.prNumber, {
                      method: 'squash',
                      deleteBranch: true,
                      repoSlug: repoSlug ?? undefined,
                    });

                    if (retryMerge.ok) {
                      result.commitAfterSha = await getRemoteBranchSha(prepared.gitRoot, prepared.baseBranch) ?? undefined;
                      result.deliveryStatus = 'success';
                      prMergeResolved = true;
                      console.log(`[executor] Task ${task.id}: PR merged on retry (attempt ${attempt}), commitAfterSha=${result.commitAfterSha}`);
                      if (prepared.deliveryWorktreePath && prepared.deliveryBranch && prepared.gitRoot) {
                        await syncDeliveryWorktree(prepared.deliveryWorktreePath, prepared.deliveryBranch, prepared.gitRoot);
                      }
                      break;
                    }

                    if (attempt === MAX_PR_MERGE_ATTEMPTS) {
                      result.deliveryStatus = 'failed';
                      result.deliveryError = `PR created but auto-merge failed after ${attempt} attempts: ${retryMerge.error ?? 'merge conflict'}`;
                      console.error(`[executor] Task ${task.id}: PR merge failed after ${attempt} attempts`);
                    }
                    // Loop continues — agent will try again
                  }
                }

                if (!prMergeResolved && !result.deliveryError) {
                  // No resume capability or not applicable — original failure
                  result.deliveryStatus = 'failed';
                  result.deliveryError = 'PR created but auto-merge into delivery branch failed';
                  console.error(`[executor] Task ${task.id}: PR created at ${prResult.prUrl} but auto-merge failed (no resume capability)`);
                }
              } else {
                result.deliveryStatus = 'success';
                console.log(`[executor] Task ${task.id}: PR created at ${prResult.prUrl}`);
                if (prepared.deliveryWorktreePath && prepared.deliveryBranch && prepared.gitRoot) {
                  await syncDeliveryWorktree(prepared.deliveryWorktreePath, prepared.deliveryBranch, prepared.gitRoot);
                }
              }
            } else if (prResult.error) {
              // Delivery failure — don't override execution status
              result.deliveryStatus = 'failed';
              result.deliveryError = `PR delivery failed: ${prResult.error}`;
              keepBranch = prResult.pushed ?? false; // Keep branch if it was pushed
              stream.operational?.(`PR delivery failed: ${prResult.error}`, 'git');
              console.error(`[executor] Task ${task.id}: PR delivery failed: ${prResult.error}`);
            } else {
              stream.operational?.('No changes to deliver', 'git');
              console.log(`[executor] Task ${task.id}: no changes to push`);
            }
          }
        } catch (prError) {
          const prMsg = prError instanceof Error ? prError.message : String(prError);
          stream.operational?.(`Failed: ${prMsg}`, 'delivery');
          console.error(`[executor] Task ${task.id}: delivery (${deliveryMode}) failed: ${prMsg}`);
          // Delivery failure — don't override execution status
          result.deliveryStatus = 'failed';
          result.deliveryError = `Delivery failed: ${prMsg}`;
        }
      }

      // PR data extraction: prefer structured summary (agent reports via follow-up turn),
      // fall back to regex scanning output for backward compatibility.
      if (!result.prUrl) {
        if (summary?.prUrl && summary?.prNumber) {
          result.prUrl = summary.prUrl;
          result.prNumber = summary.prNumber;
          console.log(`[executor] Task ${task.id}: PR extracted from summary: ${summary.prUrl}`);
        } else if (result.output) {
          const prMatch = result.output.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
          if (prMatch) {
            result.prUrl = prMatch[0];
            result.prNumber = parseInt(prMatch[1], 10);
            console.log(`[executor] Task ${task.id}: PR extracted from output via regex: ${result.prUrl}`);
          }
        }
      }
      // Branch name from summary (if agent worked on a branch but delivery didn't capture it)
      if (!result.branchName && summary?.branchName) {
        result.branchName = summary.branchName;
      }

      console.log(`[executor] Task ${task.id}: completed with status=${result.status}${result.deliveryStatus ? ` delivery=${result.deliveryStatus}` : ''}${result.error ? ` error=${result.error}` : ''}`);

      // Check if there are tracked Slurm jobs still running for this task.
      // If so, don't send the final result yet — let the job monitor handle it.
      const pendingJobs = this.jobMonitor.getJobsForExecution(task.id);
      if (pendingJobs.length > 0) {
        console.log(`[executor] Task ${task.id}: ${pendingJobs.length} Slurm job(s) still tracked, deferring completion`);
        this.wsClient.sendTaskStatus(task.id, 'running', 80, `Waiting for ${pendingJobs.length} Slurm job(s): ${pendingJobs.join(', ')}`);
        // Don't send final result — the SlurmJobMonitor will send it when jobs finish
      } else {
        // Defer result to after cleanup (sent in the finally block).
        pendingResult = result;
      }
    } catch (error) {
      // Unexpected error during execution
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[executor] Task ${task.id}: execution error: ${errorMsg}`);
      pendingResult = {
        taskId: task.id,
        status: 'failed',
        error: errorMsg,
        completedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(hardCapTimeoutId);
      if (idleTimerId !== undefined) clearTimeout(idleTimerId);

      // Always cleanup the local worktree directory to reclaim disk space
      // (node_modules alone is ~680MB per worktree). When keepBranch is true
      // (PR created or branch pushed), we preserve the git branch but still
      // remove the working copy — the branch lives on remote/local refs,
      // and re-execution will create a fresh worktree if needed.
      if (prepared.branchName) {
        stream.operational?.(`Cleaning up worktree (branch: ${prepared.branchName})...`, 'astro');
      }
      if (this.preserveWorktrees) {
        console.log(`[executor] Task ${task.id}: worktree preserved (debug mode)`);
        // Still release directory locks even in debug mode to avoid deadlocks.
        // Git worktree paths set branchName and are preserved for inspection.
        // Lock-only paths (direct, non-git fallback) and copy worktrees don't
        // set branchName — always clean those up.
        if (!prepared.branchName) {
          await prepared.cleanup({ keepBranch });
        }
      } else {
        await prepared.cleanup({ keepBranch });
      }

      // Sandbox: copy back results then cleanup
      if (sandbox) {
        try {
          console.log(`[executor] Task ${task.id}: copying back sandbox results`);
          await sandbox.copyBack();
        } catch (copyBackErr) {
          const msg = copyBackErr instanceof Error ? copyBackErr.message : String(copyBackErr);
          console.error(`[executor] Task ${task.id}: sandbox copyBack failed: ${msg}`);
        }
        console.log(`[executor] Task ${task.id}: cleaning up sandbox`);
        await sandbox.cleanup();
      }

      // Stop heartbeat — cleanup is done, we're about to send the result.
      clearInterval(taskHeartbeatTimer);

      // Send deferred result AFTER cleanup completes.
      // This ensures the server's auto-dispatch doesn't start the next task
      // while this task's worktree cleanup is still running on the same git repo.
      // Without this, the new task's createWorktree() fights with cleanupWorktree()
      // over the same .git directory (concurrent git worktree prune, branch -D, etc.).
      if (pendingResult) {
        const isSuccess = pendingResult.status !== 'failed';
        this.wsClient.sendTaskStatus(task.id, isSuccess ? 'completed' : 'failed' as TaskStatus, 100,
          isSuccess ? 'Task complete' : 'Task failed');
        this.wsClient.sendTaskResult(pendingResult);
      }

      // Untrack task from directory
      this.untrackTaskDirectory(task);

      this.runningTasks.delete(task.id);

      // If Slurm jobs are still tracked for this task, keep it in the heartbeat
      // so the server's dead-job detector doesn't flag it prematurely. The
      // SlurmJobMonitor will call removeActiveTask after sending the final result.
      const deferredJobs = this.jobMonitor.getJobsForExecution(task.id);
      if (deferredJobs.length === 0) {
        this.wsClient.removeActiveTask(task.id);
      } else {
        console.log(`[executor] Task ${task.id}: ${deferredJobs.length} Slurm job(s) still running — keeping in heartbeat until completion`);
      }

      this.processQueue();
    }
  }

  private async prepareTaskWorkspace(
    task: Task & { workingDirectory: string },
    stream: { stdout: (data: string) => void; stderr: (data: string) => void; operational?: (message: string, source: 'astro' | 'git' | 'delivery') => void },
    signal?: AbortSignal,
  ): Promise<{
    workingDirectory: string;
    branchName?: string;
    baseBranch?: string;
    commitBeforeSha?: string;
    gitRoot?: string;
    deliveryBranch?: string;
    deliveryWorktreePath?: string;
    cleanup: (options?: { keepBranch?: boolean }) => Promise<void>;
  }> {
    // Per-task explicit opt-out: user consciously chose to skip worktree
    if (task.useWorktree === false) {
      console.log(`[executor] Task ${task.id}: worktree explicitly disabled by user, using raw workdir: ${task.workingDirectory}`);
      return { workingDirectory: task.workingDirectory, cleanup: async () => {} };
    }

    if (!this.useWorktree) {
      console.warn(`[executor] Task ${task.id}: worktree disabled (executor-level), using raw workdir: ${task.workingDirectory}`);
      return { workingDirectory: task.workingDirectory, cleanup: async () => {} };
    }

    // Direct delivery mode: skip worktree, work in-place.
    // Acquire directory lock to serialize tasks on the same directory.
    if (task.deliveryMode === 'direct') {
      const lockKey = canonicalDirLockKey(task.workingDirectory);
      console.log(`[executor] Task ${task.id}: direct delivery mode, acquiring directory lock`);
      const lockHandle = await this.directoryLockManager.acquire(lockKey, task.id);
      console.log(`[executor] Task ${task.id}: directory lock acquired, using raw workdir: ${task.workingDirectory}`);
      return {
        workingDirectory: task.workingDirectory,
        cleanup: async () => { lockHandle.release(); },
      };
    }

    // Copy delivery mode: copy project to worktree dir (non-git)
    if (task.deliveryMode === 'copy') {
      try {
        const agentDirName = task.agentDir ?? '.astro';
        if (task.worktreeStrategy === 'reference') {
          const { createReferenceWorktree } = await import('./copy-worktree.js');
          const ref = await createReferenceWorktree(task.workingDirectory, agentDirName, task.id);
          console.log(`[executor] Task ${task.id}: reference worktree at ${ref.worktreePath}`);
          return { workingDirectory: ref.worktreePath, cleanup: async () => { await ref.cleanup(); } };
        }
        const { createCopyWorktree } = await import('./copy-worktree.js');
        const copy = await createCopyWorktree(task.workingDirectory, agentDirName, task.id);
        console.log(`[executor] Task ${task.id}: copy worktree at ${copy.worktreePath}`);
        return { workingDirectory: copy.worktreePath, cleanup: async () => { await copy.cleanup(); } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[executor] Task ${task.id}: copy worktree failed: ${errorMsg}, falling back to locked direct execution`);
        const lockKey = canonicalDirLockKey(task.workingDirectory);
        const lockHandle = await this.directoryLockManager.acquire(lockKey, task.id);
        return {
          workingDirectory: task.workingDirectory,
          cleanup: async () => { lockHandle.release(); },
        };
      }
    }

    // Non-git directory: fall back to direct execution (no worktree possible).
    // Acquire a per-directory lock to serialize tasks — without git worktree
    // isolation, concurrent modification of the same files causes conflicts.
    if (this.gitAvailable && !(await isGitRepo(task.workingDirectory))) {
      const lockKey = canonicalDirLockKey(task.workingDirectory);
      console.log(`[executor] Task ${task.id}: not a git repo, acquiring directory lock for ${task.workingDirectory}`);
      stream.stdout(`[astro] Non-git directory — waiting for exclusive access...\n`);
      const lockHandle = await this.directoryLockManager.acquire(lockKey, task.id);
      const cleanup = async () => { lockHandle.release(); };
      try {
        console.log(`[executor] Task ${task.id}: directory lock acquired, proceeding with direct execution`);
        stream.stdout(`[astro] Directory lock acquired, working directly on files.\n`);
      } catch (err) {
        await cleanup();
        throw err;
      }
      return { workingDirectory: task.workingDirectory, cleanup };
    }

    // Untracked subdirectory of a parent repo: the workdir inherits a git repo
    // from a parent directory but has zero tracked files in it. This happens when
    // a project folder is placed inside a directory that happens to have a .git
    // (e.g., ~/tmp/.git exists and the project is at ~/tmp/my-project/).
    // Bootstrap a LOCAL git repo in the workdir so worktree creation uses the
    // local repo (closest .git wins) instead of the irrelevant parent repo.
    if (this.gitAvailable && await isUntrackedInParentRepo(task.workingDirectory)) {
      console.log(`[executor] Task ${task.id}: workdir is untracked in parent repo, bootstrapping local git`);
      stream.stdout(`[astro] Working directory is untracked in parent repo, initializing local git...\n`);
      await initializeGit(task.workingDirectory);
    }

    // Zero-commit git repo: bootstrap with .gitignore + initial commit
    // so that worktree creation and PR delivery work correctly.
    if (this.gitAvailable && !(await this.repoHasCommits(task.workingDirectory))) {
      console.log(`[executor] Task ${task.id}: git repo has no commits, bootstrapping...`);
      stream.stdout(`[astro] Bootstrapping empty git repo with initial commit...\n`);
      await initializeGit(task.workingDirectory);
    }

    // Git worktree path — worktree creation must succeed or fail the task.
    // Running in the raw workdir without isolation risks cross-task commit
    // contamination and breaks PR creation.
    //
    // Singleton delivery branches: acquire a branch-level lock during worktree
    // creation to prevent concurrent dispatches (if server-side invariant fails)
    // from fighting over the same branch. The lock is held only during worktree
    // setup (seconds), not the entire task execution.
    let singletonLock: { release: () => void } | undefined;
    try {
      if (task.deliveryBranchIsSingleton && (task.deliveryBranch ?? task.projectBranch)) {
        // Use git root (not workingDirectory) for the lock key so that tasks
        // dispatched to different subdirectories of the same repo (e.g., repo/
        // and repo/subdir/) share the same lock for the same branch.
        const gitRoot = await getGitRoot(task.workingDirectory);
        const lockKey = BranchLockManager.computeLockKey(
          gitRoot ?? task.workingDirectory,
          undefined,
          undefined,
          `singleton::${task.deliveryBranch ?? task.projectBranch}`,
        );
        console.log(`[executor] Task ${task.id}: acquiring singleton branch lock: ${lockKey}`);
        singletonLock = await this.branchLockManager.acquire(lockKey, task.id);
      }

      console.log(`[executor] Task ${task.id}: creating worktree for workdir=${task.workingDirectory}`);
      const worktree = await createWorktree({
        workingDirectory: task.workingDirectory,
        taskId: task.id,
        rootOverride: this.worktreeRoot,
        projectId: task.projectId,
        nodeId: task.planNodeId,
        shortProjectId: task.shortProjectId,
        shortNodeId: task.shortNodeId,
        agentDir: task.agentDir,
        baseBranch: task.baseBranch,
        deliveryBranch: task.deliveryBranch ?? task.projectBranch,
        deliveryBranchIsSingleton: task.deliveryBranchIsSingleton,
        stdout: stream.stdout,
        stderr: stream.stderr,
        operational: stream.operational,
        signal,
      });
      if (!worktree) {
        throw new Error(`Worktree creation returned null for ${task.workingDirectory}. Cannot proceed without isolation.`);
      }
      console.log(`[executor] Task ${task.id}: worktree created at ${worktree.workingDirectory} (branch: ${worktree.branchName})`);

      // Track singleton delivery branches so cleanupTask won't destroy them.
      // Singleton branches are shared across the delivery lifecycle — deleting
      // them would orphan the delivery branch and its eventual PR.
      if (task.deliveryBranchIsSingleton && worktree.branchName) {
        this.singletonBranches.add(worktree.branchName);
      }

      return worktree;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[executor] Task ${task.id}: worktree creation FAILED: ${errorMsg}`);
      this.wsClient.sendTaskStatus(task.id, 'failed', 0, `Worktree setup failed: ${errorMsg}`);
      throw error;
    } finally {
      singletonLock?.release();
    }
  }

  /**
   * Run `git diff --numstat` after task execution to emit accurate file_change
   * events with real line counts. Covers all changes (Write, Edit, Bash sed/cat, etc.)
   * and correctly handles binary files (skipped for line counts).
   */
  private async emitGitDiffFileChanges(
    taskId: string,
    workdir: string,
    commitBeforeSha: string | undefined,
    stream: { fileChange: (path: string, action: 'created' | 'modified' | 'deleted', linesAdded?: number, linesRemoved?: number) => void },
  ): Promise<void> {
    try {
      // Collect diff output from both committed and uncommitted changes.
      // commitBeforeSha..HEAD covers committed work; HEAD vs working tree covers uncommitted.
      let output = '';

      if (commitBeforeSha) {
        // Diff committed changes since the task started
        const { stdout } = await execFileAsync(
          'git', ['-C', workdir, 'diff', '--numstat', commitBeforeSha, 'HEAD'],
          { timeout: 30_000 },
        );
        output = stdout;

        // Also include uncommitted changes (staged + unstaged) on top of HEAD
        const { stdout: uncommitted } = await execFileAsync(
          'git', ['-C', workdir, 'diff', '--numstat', 'HEAD'],
          { timeout: 30_000 },
        );
        if (uncommitted.trim()) {
          output = output ? output + '\n' + uncommitted : uncommitted;
        }
      } else {
        // No commitBeforeSha — diff working tree against HEAD
        const { stdout } = await execFileAsync(
          'git', ['-C', workdir, 'diff', '--numstat', 'HEAD'],
          { timeout: 30_000 },
        );
        output = stdout;
      }

      if (!output.trim()) return;

      // Deduplicate: same file may appear in both committed and uncommitted diffs.
      // Accumulate line counts per file.
      const fileStats = new Map<string, { added: number; removed: number; binary: boolean }>();

      for (const line of output.trim().split('\n')) {
        // Format: "added\tremoved\tfilename" or "-\t-\tfilename" for binary
        const parts = line.split('\t');
        if (parts.length < 3) continue;

        const [addedStr, removedStr, ...pathParts] = parts;
        const filePath = pathParts.join('\t'); // Handle filenames with tabs

        if (addedStr === '-' || removedStr === '-') {
          // Binary file
          if (!fileStats.has(filePath)) {
            fileStats.set(filePath, { added: 0, removed: 0, binary: true });
          }
          continue;
        }

        const added = parseInt(addedStr, 10) || 0;
        const removed = parseInt(removedStr, 10) || 0;
        const existing = fileStats.get(filePath);
        if (existing && !existing.binary) {
          existing.added += added;
          existing.removed += removed;
        } else if (!existing) {
          fileStats.set(filePath, { added, removed, binary: false });
        }
      }

      for (const [filePath, stats] of fileStats) {
        if (stats.binary) {
          stream.fileChange(filePath, 'modified');
        } else {
          const action = stats.removed === 0 && stats.added > 0 ? 'created' : 'modified';
          stream.fileChange(filePath, action, stats.added, stats.removed);
        }
      }
    } catch (err) {
      // Non-fatal — stats are best-effort
      console.warn(`[executor] Task ${taskId}: git diff for file stats failed:`, err instanceof Error ? err.message : err);
    }
  }

  private async getAdapter(type: ProviderType): Promise<ProviderAdapter | null> {
    // Check cache
    const cached = this.adapters.get(type);
    if (cached) {
      return cached;
    }

    // Create new adapter — pass pre-classified HPC capability and bridge to avoid runtime detection
    const adapter = createProviderAdapter(type, this.hpcCapability, this.openclawBridge);
    if (!adapter) {
      return null;
    }

    // Wire up job monitor for HPC-aware adapters
    if (adapter instanceof ClaudeSdkAdapter) {
      adapter.setJobMonitor(this.jobMonitor);
    }

    // Check availability
    const available = await adapter.isAvailable();
    if (!available) {
      return null;
    }

    // Cache and return
    this.adapters.set(type, adapter);
    return adapter;
  }

  private processQueue(): void {
    while (this.runningTasks.size < this.maxConcurrentTasks && this.taskQueue.length > 0) {
      const task = this.taskQueue.shift();
      if (task) {
        this.executeTask(task).catch((err) => {
          console.error(`[executor] Queued task ${task.id} (project=${task.projectId}) failed:`, err);
          // Report failure to server so the task doesn't stay stuck forever.
          // executeTask's internal catches may have already done partial cleanup,
          // but sendTaskResult and the deletes are idempotent (Set/Map operations).
          this.wsClient.sendTaskResult({
            taskId: task.id,
            status: 'failed',
            error: `Execution failed: ${err instanceof Error ? err.message : String(err)}`,
            completedAt: new Date().toISOString(),
          });
          this.runningTasks.delete(task.id);
          this.wsClient.removeActiveTask(task.id);
          this.untrackTaskDirectory(task);
          this.processQueue();
        });
      }
    }
  }
}

/**
 * Resolve a working directory value.
 * - Empty/missing + projectId → auto-provision workspace under workspace root
 * - Empty/missing + no projectId → error
 * - Git URL → error (repo setup should have resolved this to a local path)
 * - Otherwise → return as-is
 */
function resolveWorkingDirectory(value: string | undefined, projectId?: string): string {
  if (!value) {
    if (projectId) {
      // Auto-provision a temporary workspace for this project (no git init)
      const dir = ensureProjectWorkspace(projectId);
      console.log(`[executor] Auto-provisioned workspace for project ${projectId}: ${dir}`);
      return dir;
    }
    throw new Error(
      'workingDirectory is required but was not provided. ' +
      'Configure a project directory or repository before dispatching tasks.'
    );
  }

  const isGitUrl = value.startsWith('http://') || value.startsWith('https://') || value.startsWith('git@');
  if (isGitUrl) {
    throw new Error(`workingDirectory is still a git URL at dispatch time. Run repo setup first.`);
  }

  // Expand tilde to the user's home directory.
  // Node.js path APIs (resolve, join, etc.) don't expand ~ — that's a shell feature.
  // Without this, paths like "~/Documents/code" are treated as relative, causing
  // worktree creation to produce broken paths like ".astro/worktrees/.../~/Documents/code".
  let resolved = value;
  if (resolved === '~') {
    resolved = homedir();
  } else if (resolved.startsWith('~/')) {
    resolved = homedir() + resolved.slice(1);
  }

  // Validate that the path exists and is a directory.
  // Without this, tasks silently enter the execution pipeline and only fail
  // deep in the adapter (or worse, become dead jobs when the adapter crashes).
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(
        `Working directory path is not a directory: ${resolved}. ` +
        'Check that the project directory path is correct.'
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Working directory does not exist: ${resolved}. ` +
        'Check that the project directory path is correct and accessible.'
      );
    }
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error(
        `Working directory is not accessible (permission denied): ${resolved}.`
      );
    }
    throw err; // re-throw "not a directory" or other unexpected errors
  }

  return resolved;
}
