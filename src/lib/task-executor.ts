/**
 * Task executor with multiplexing support
 *
 * Handles concurrent task execution, routing to providers,
 * and streaming output back over WebSocket
 */

import { homedir } from 'node:os';
import type { Task, TaskStatus, ProviderType } from '../types.js';
import type { WebSocketClient } from './websocket-client.js';
import { createProviderAdapter, type ProviderAdapter } from '../providers/index.js';
import { ClaudeSdkAdapter } from '../providers/claude-sdk-adapter.js';
import { SlurmJobMonitor } from './slurm-job-monitor.js';
import { createWorktree } from './worktree.js';
import { pushAndCreatePR } from './git-pr.js';
import {
  checkWorkdirSafety,
  isGitAvailable,
  isGitRepo,
  createSandbox,
  WorkdirSafetyTier,
  type SafetyCheckResult,
  type SandboxSetup,
} from './workdir-safety.js';

interface RunningTask {
  task: Task;
  abortController: AbortController;
  adapter: ProviderAdapter;
  outputSequence: { stdout: number; stderr: number };
  sandbox?: SandboxSetup;
}

interface PendingSafetyCheck {
  task: Task;
  safetyResult: SafetyCheckResult;
  resolveDecision: (decision: 'proceed' | 'init-git' | 'sandbox' | 'cancel') => void;
}

export interface TaskExecutorOptions {
  wsClient: WebSocketClient;
  maxConcurrentTasks?: number;
  defaultTimeout?: number;
  useWorktree?: boolean;
  worktreeRoot?: string;
  preserveWorktrees?: boolean; // Don't cleanup worktrees for debugging
  allowNonGit?: boolean; // Allow execution in non-git directories without prompting
  useSandbox?: boolean; // Always use sandbox mode
  maxSandboxSize?: number; // Max sandbox size in bytes
}

export class TaskExecutor {
  private wsClient: WebSocketClient;
  private runningTasks: Map<string, RunningTask> = new Map();
  private taskQueue: Task[] = [];
  private maxConcurrentTasks: number;
  private defaultTimeout: number;
  private adapters: Map<ProviderType, ProviderAdapter> = new Map();
  private useWorktree: boolean;
  private worktreeRoot?: string;
  private preserveWorktrees: boolean;
  private jobMonitor: SlurmJobMonitor;
  private allowNonGit: boolean;
  private useSandbox: boolean;
  private maxSandboxSize: number;
  private gitAvailable: boolean = false;

  // Safety tracking
  private tasksByDirectory: Map<string, Set<string>> = new Map(); // workdir -> taskIds
  private pendingSafetyChecks: Map<string, PendingSafetyCheck> = new Map(); // taskId -> pending check

  constructor(options: TaskExecutorOptions) {
    this.wsClient = options.wsClient;
    this.maxConcurrentTasks = options.maxConcurrentTasks ?? 4;
    this.defaultTimeout = options.defaultTimeout ?? 3600000; // 1 hour
    this.useWorktree = options.useWorktree ?? true;
    this.worktreeRoot = options.worktreeRoot;
    this.preserveWorktrees = options.preserveWorktrees ?? false;
    this.allowNonGit = options.allowNonGit ?? false;
    this.useSandbox = options.useSandbox ?? false;
    this.maxSandboxSize = options.maxSandboxSize ?? 100 * 1024 * 1024; // 100MB
    this.jobMonitor = new SlurmJobMonitor(options.wsClient);

    // Check git availability on startup
    isGitAvailable().then((available) => {
      this.gitAvailable = available;
      console.log(`[executor] Git ${available ? 'available' : 'not available'}`);
    }).catch(() => {
      this.gitAvailable = false;
    });
  }

  /**
   * Submit a task for execution (with safety checks)
   */
  async submitTask(task: Task): Promise<void> {
    // Skip workingDirectory resolution for lightweight text-only tasks (no file system access)
    const isTextOnlyTask = task.type === 'summarize' || task.type === 'chat' || task.type === 'plan';

    const normalizedTask = {
      ...task,
      workingDirectory: isTextOnlyTask && !task.workingDirectory
        ? undefined!  // Text-only tasks can run without a working directory
        : resolveWorkingDirectory(task.workingDirectory),
    };

    // Determine if worktree isolation will be used for this task.
    const willUseWorktree = this.useWorktree
      && normalizedTask.useWorktree !== false
      && normalizedTask.deliveryMode !== 'direct';

    if (!isTextOnlyTask && task.skipSafetyCheck) {
      // Server already approved safety for this directory — skip the prompt.
      // Still need to handle init-git if directory isn't a git repo.
      const needsGitInit = this.gitAvailable && !(await isGitRepo(normalizedTask.workingDirectory));
      if (needsGitInit) {
        await this.initializeGit(normalizedTask.workingDirectory);
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

    if (!isTextOnlyTask) {
      // Perform safety check (worktree flag affects tier assignment)
      const safetyCheck = await this.performSafetyCheck(normalizedTask, willUseWorktree);

      // Handle safety tiers
      if (safetyCheck.tier === WorkdirSafetyTier.UNSAFE) {
        // BLOCK: unsafe conditions (non-git parallel, or git + uncommitted + no worktree)
        this.wsClient.sendTaskResult({
          taskId: normalizedTask.id,
          status: 'failed',
          error: safetyCheck.blockReason,
          completedAt: new Date().toISOString(),
        });
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

    // Track task by directory
    this.trackTaskDirectory(normalizedTask);

    // Check if we can run immediately
    if (this.runningTasks.size < this.maxConcurrentTasks) {
      await this.executeTask(normalizedTask, this.useSandbox);
    } else {
      // Queue the task
      this.taskQueue.push(normalizedTask);
      this.wsClient.sendTaskStatus(normalizedTask.id, 'queued', 0, 'Waiting for available slot');
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
      this.taskQueue.splice(queueIndex, 1);
      this.wsClient.sendTaskResult({
        taskId,
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      });
      return true;
    }

    return false;
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
    }
    this.runningTasks.clear();

    // Clear queue
    for (const task of this.taskQueue) {
      this.wsClient.sendTaskResult({
        taskId: task.id,
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      });
    }
    this.taskQueue = [];

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
  async steerTask(taskId: string, message: string, interrupt = false): Promise<{ accepted: boolean; reason?: string }> {
    const running = this.runningTasks.get(taskId);

    if (running) {
      // Task is still running — inject message into the live session
      if (running.adapter instanceof ClaudeSdkAdapter && typeof running.adapter.injectMessage === 'function') {
        const injected = await running.adapter.injectMessage(taskId, message, interrupt);
        if (injected) {
          return { accepted: true };
        }
        return { accepted: false, reason: 'Failed to inject message into running session' };
      }
      return { accepted: false, reason: 'Provider does not support mid-execution steering' };
    }

    // Task is not running — check if we have a preserved session for resume
    const adapter = this.findAdapterWithSession(taskId);
    if (adapter) {
      const context = adapter.getTaskContext(taskId);
      if (context) {
        // Launch a resume as a new "task" execution
        this.resumeCompletedTask(taskId, message, adapter, context);
        return { accepted: true };
      }
    }

    return { accepted: false, reason: 'Task not found or session expired' };
  }

  /**
   * Find the ClaudeSdkAdapter that has a preserved session for the given task.
   */
  private findAdapterWithSession(taskId: string): ClaudeSdkAdapter | null {
    for (const adapter of this.adapters.values()) {
      if (adapter instanceof ClaudeSdkAdapter) {
        const context = adapter.getTaskContext(taskId);
        if (context) return adapter;
      }
    }
    return null;
  }

  /**
   * Resume a completed task session for post-completion steering.
   * Runs in the background, streaming output back through the WebSocket.
   */
  private async resumeCompletedTask(
    taskId: string,
    message: string,
    adapter: ClaudeSdkAdapter,
    context: { sessionId: string; workingDirectory?: string },
  ): Promise<void> {
    const abortController = new AbortController();
    let textSequence = 0;

    const stream = {
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
      toolUse: (toolName: string, toolInput: unknown) => {
        this.wsClient.sendTaskToolUse(taskId, toolName, toolInput);
      },
      toolResult: (toolName: string, result: unknown, success: boolean) => {
        this.wsClient.sendTaskToolResult(taskId, toolName, result, success);
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

    try {
      this.wsClient.sendTaskStatus(taskId, 'running', 0, 'Resuming session...');
      const result = await adapter.resumeTask(
        taskId,
        message,
        context.workingDirectory ?? process.cwd(),
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
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Perform safety check on working directory
   */
  private async performSafetyCheck(task: Task, willUseWorktree: boolean): Promise<SafetyCheckResult> {
    const activeTasksInDir = this.getActiveTasksInDirectory(task.workingDirectory);
    return await checkWorkdirSafety(task.workingDirectory, activeTasksInDir, this.gitAvailable, willUseWorktree);
  }

  /**
   * Request safety decision from user
   */
  private async requestSafetyDecision(
    task: Task,
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
    const SAFETY_DECISION_TIMEOUT_MS = 5 * 60 * 1000;
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
          await this.initializeGit(task.workingDirectory);
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
        }
        break;

      case 'cancel':
        // Cancel the task
        this.wsClient.sendTaskResult({
          taskId: task.id,
          status: 'cancelled',
          completedAt: new Date().toISOString(),
        });
        break;
    }
  }

  /**
   * Initialize git repository in a directory.
   * Creates .gitignore and CLAUDE.md if they don't exist before the initial commit.
   */
  private async initializeGit(workdir: string): Promise<void> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { writeFile, access } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const execFileAsync = promisify(execFile);

    await execFileAsync('git', ['init', '-b', 'main'], { cwd: workdir, timeout: 10_000 });

    // Bootstrap with .gitignore and CLAUDE.md if they don't exist
    const gitignorePath = join(workdir, '.gitignore');
    const claudeMdPath = join(workdir, 'CLAUDE.md');

    try { await access(gitignorePath); } catch {
      await writeFile(gitignorePath, '.astro\nnode_modules\n.env\n.env.local\n');
    }
    try { await access(claudeMdPath); } catch {
      await writeFile(claudeMdPath, '# Project\n\nThis project is managed by Astro.\n');
    }

    await execFileAsync('git', ['add', '.'], { cwd: workdir, timeout: 10_000 });
    await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: workdir, timeout: 10_000 });
  }

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

  /**
   * Track task by directory for parallel execution safety
   */
  private trackTaskDirectory(task: Task): void {
    const tasks = this.tasksByDirectory.get(task.workingDirectory) || new Set();
    tasks.add(task.id);
    this.tasksByDirectory.set(task.workingDirectory, tasks);
  }

  /**
   * Untrack task from directory
   */
  private untrackTaskDirectory(task: Task): void {
    const tasks = this.tasksByDirectory.get(task.workingDirectory);
    if (tasks) {
      tasks.delete(task.id);
      if (tasks.size === 0) {
        this.tasksByDirectory.delete(task.workingDirectory);
      }
    }
  }

  /**
   * Get count of active tasks in a directory
   */
  private getActiveTasksInDirectory(workdir: string): number {
    const tasks = this.tasksByDirectory.get(workdir);
    return tasks ? tasks.size : 0;
  }

  private async executeTask(task: Task, useSandbox = false): Promise<void> {
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
      this.untrackTaskDirectory(task);
      this.processQueue();
      return;
    }
    console.log(`[executor] Task ${task.id}: adapter ${adapter.name} (${adapter.type}) ready`);

    const abortController = new AbortController();
    const outputSequence = { stdout: 0, stderr: 0 };

    // Create stream handlers before workspace prep so setup output is captured
    let textSequence = 0;
    const stream = {
      stdout: (data: string) => {
        this.wsClient.sendTaskOutput(normalizedTask.id, 'stdout', data, outputSequence.stdout++);
      },
      stderr: (data: string) => {
        this.wsClient.sendTaskOutput(normalizedTask.id, 'stderr', data, outputSequence.stderr++);
      },
      status: (status: TaskStatus, progress?: number, message?: string) => {
        this.wsClient.sendTaskStatus(normalizedTask.id, status, progress, message);
      },
      toolTrace: (toolName: string, toolInput?: unknown, toolResult?: unknown, success?: boolean) => {
        this.wsClient.sendToolTrace(normalizedTask.id, toolName, toolInput, toolResult, success);
      },
      text: (data: string) => {
        this.wsClient.sendTaskText(normalizedTask.id, data, textSequence++);
      },
      toolUse: (toolName: string, toolInput: unknown) => {
        this.wsClient.sendTaskToolUse(normalizedTask.id, toolName, toolInput);
      },
      toolResult: (toolName: string, result: unknown, success: boolean) => {
        this.wsClient.sendTaskToolResult(normalizedTask.id, toolName, result, success);
      },
      fileChange: (path: string, action: 'created' | 'modified' | 'deleted', linesAdded?: number, linesRemoved?: number, diff?: string) => {
        this.wsClient.sendTaskFileChange(normalizedTask.id, path, action, linesAdded, linesRemoved, diff);
      },
      sessionInit: (sessionId: string, model?: string) => {
        this.wsClient.sendTaskSessionInit(normalizedTask.id, sessionId, model);
      },
      approvalRequest: async (question: string, options: string[]) => {
        return this.wsClient.sendApprovalRequest(normalizedTask.id, question, options);
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

    // Text-only tasks (plan/chat/summarize) without a working directory skip workspace prep
    const isTextOnly = normalizedTask.type === 'summarize' || normalizedTask.type === 'chat' || normalizedTask.type === 'plan';
    const prepared = isTextOnly && !normalizedTask.workingDirectory
      ? { workingDirectory: '', cleanup: async () => {} }
      : await this.prepareTaskWorkspace(normalizedTask, stream);
    const taskWithWorkspace = { ...normalizedTask, workingDirectory: prepared.workingDirectory };
    runningTask.task = taskWithWorkspace;
    console.log(`[executor] Task ${task.id}: workspace prepared, cwd=${prepared.workingDirectory}`);

    // Execute with timeout
    const timeout = task.timeout ?? this.defaultTimeout;
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, timeout);

    let keepBranch = false;
    try {
      // Notify task started
      this.wsClient.sendTaskStatus(task.id, 'running', 0, 'Starting');
      console.log(`[executor] Task ${task.id}: executing with ${adapter.name}...`);

      // Execute the task
      const result = await adapter.execute(taskWithWorkspace, stream, abortController.signal);

      // Delivery-mode-aware result handling
      const deliveryMode = task.deliveryMode ?? 'pr';
      // Build PR title with short hex prefix for linking back to Astro app
      const rawTitle = task.title || task.prompt.slice(0, 100);
      const prTitle = task.shortProjectId && task.shortNodeId
        ? `[${task.shortProjectId}/${task.shortNodeId}] ${rawTitle}`
        : rawTitle;
      if (prepared.branchName && (result.status === 'completed' || !result.error)) {
        try {
          if (deliveryMode === 'direct') {
            // No git delivery — files modified in-place
            console.log(`[executor] Task ${task.id}: direct mode, skipping git delivery`);
          } else if (deliveryMode === 'copy') {
            // Copy mode: worktree preserved, no git operations
            console.log(`[executor] Task ${task.id}: copy mode, worktree preserved at ${prepared.workingDirectory}`);
          } else if (deliveryMode === 'branch') {
            // Auto-commit but don't push — branch stays local
            console.log(`[executor] Task ${task.id}: branch mode, committing locally`);
            result.branchName = prepared.branchName;
            keepBranch = true;
          } else if (deliveryMode === 'push') {
            // Push branch to remote, but don't create a PR — user creates PR manually
            console.log(`[executor] Task ${task.id}: push mode, pushing branch ${prepared.branchName}`);
            const prResult = await pushAndCreatePR(prepared.workingDirectory, {
              branchName: prepared.branchName,
              taskTitle: prTitle,
              taskDescription: task.description || task.prompt.slice(0, 500),
              skipPR: true,
            });
            result.branchName = prResult.branchName;
            if (prResult.pushed) {
              keepBranch = true;
              console.log(`[executor] Task ${task.id}: branch pushed (${prepared.branchName})`);
            } else {
              console.log(`[executor] Task ${task.id}: no changes to push`);
            }
          } else {
            // 'pr' — push + create PR (existing behavior)
            console.log(`[executor] Task ${task.id}: pr mode, attempting PR creation for branch ${prepared.branchName}`);
            const prResult = await pushAndCreatePR(prepared.workingDirectory, {
              branchName: prepared.branchName,
              taskTitle: prTitle,
              taskDescription: task.description || task.prompt.slice(0, 500),
            });
            result.branchName = prResult.branchName;
            if (prResult.prUrl) {
              result.prUrl = prResult.prUrl;
              result.prNumber = prResult.prNumber;
              keepBranch = true;
              console.log(`[executor] Task ${task.id}: PR created at ${prResult.prUrl}`);
            } else if (prResult.pushed) {
              keepBranch = true;
              console.log(`[executor] Task ${task.id}: branch pushed, no PR created (gh not available?)`);
            } else {
              console.log(`[executor] Task ${task.id}: no changes to push`);
            }
          }
        } catch (prError) {
          const prMsg = prError instanceof Error ? prError.message : String(prError);
          console.warn(`[executor] Task ${task.id}: delivery (${deliveryMode}) failed: ${prMsg}`);
          // Non-fatal: still report the task result without PR info
        }
      }

      console.log(`[executor] Task ${task.id}: completed with status=${result.status}${result.error ? ` error=${result.error}` : ''}`);

      // Check if there are tracked Slurm jobs still running for this task.
      // If so, don't send the final result yet — let the job monitor handle it.
      const pendingJobs = this.jobMonitor.getJobsForExecution(task.id);
      if (pendingJobs.length > 0) {
        console.log(`[executor] Task ${task.id}: ${pendingJobs.length} Slurm job(s) still tracked, deferring completion`);
        this.wsClient.sendTaskStatus(task.id, 'running', 80, `Waiting for ${pendingJobs.length} Slurm job(s): ${pendingJobs.join(', ')}`);
        // Don't send final result — the SlurmJobMonitor will send it when jobs finish
      } else {
        // Send final result
        this.wsClient.sendTaskResult(result);
      }
    } catch (error) {
      // Unexpected error during execution
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[executor] Task ${task.id}: execution error: ${errorMsg}`);
      this.wsClient.sendTaskResult({
        taskId: task.id,
        status: 'failed',
        error: errorMsg,
        completedAt: new Date().toISOString(),
      });
    } finally {
      clearTimeout(timeoutId);

      // Cleanup worktree — but preserve it if a branch was pushed/PR created,
      // so the worktree remains available for post-execution steering or inspection.
      // The server will trigger explicit cleanup when the task is fully completed.
      if (this.preserveWorktrees || keepBranch) {
        console.log(`[executor] Task ${task.id}: worktree preserved (${this.preserveWorktrees ? 'debug mode' : 'branch pushed'})`);
      } else {
        await prepared.cleanup({ keepBranch: false });
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

      // Untrack task from directory
      this.untrackTaskDirectory(task);

      this.runningTasks.delete(task.id);
      this.wsClient.removeActiveTask(task.id);
      this.processQueue();
    }
  }

  private async prepareTaskWorkspace(
    task: Task,
    stream: { stdout: (data: string) => void; stderr: (data: string) => void },
  ): Promise<{
    workingDirectory: string;
    branchName?: string;
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

    // Direct delivery mode: skip worktree, work in-place
    if (task.deliveryMode === 'direct') {
      console.log(`[executor] Task ${task.id}: direct delivery mode, using raw workdir: ${task.workingDirectory}`);
      return { workingDirectory: task.workingDirectory, cleanup: async () => {} };
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
        console.error(`[executor] Task ${task.id}: copy worktree failed: ${errorMsg}, using raw workdir`);
        return { workingDirectory: task.workingDirectory, cleanup: async () => {} };
      }
    }

    // Non-git directory: fall back to direct execution (no worktree possible).
    // The safety check (checkWorkdirSafety) already handles blocking parallel
    // execution in non-git dirs, so single-task direct execution is safe here.
    if (this.gitAvailable && !(await isGitRepo(task.workingDirectory))) {
      console.warn(`[executor] Task ${task.id}: not a git repo (${task.workingDirectory}), falling back to direct execution`);
      return { workingDirectory: task.workingDirectory, cleanup: async () => {} };
    }

    // Zero-commit git repo: bootstrap with .gitignore + CLAUDE.md + initial commit
    // so that worktree creation and PR delivery work correctly.
    if (this.gitAvailable && !(await this.repoHasCommits(task.workingDirectory))) {
      console.log(`[executor] Task ${task.id}: git repo has no commits, bootstrapping...`);
      stream.stdout(`[astro] Bootstrapping empty git repo with initial commit...\n`);
      await this.initializeGit(task.workingDirectory);
    }

    // Git worktree path — worktree creation must succeed or fail the task.
    // Running in the raw workdir without isolation risks cross-task commit
    // contamination and breaks PR creation.
    try {
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
        stdout: stream.stdout,
        stderr: stream.stderr,
      });
      if (!worktree) {
        throw new Error(`Worktree creation returned null for ${task.workingDirectory}. Cannot proceed without isolation.`);
      }
      console.log(`[executor] Task ${task.id}: worktree created at ${worktree.workingDirectory} (branch: ${worktree.branchName})`);
      return worktree;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[executor] Task ${task.id}: worktree creation FAILED: ${errorMsg}`);
      this.wsClient.sendTaskStatus(task.id, 'failed', 0, `Worktree setup failed: ${errorMsg}`);
      throw error;
    }
  }

  private async getAdapter(type: ProviderType): Promise<ProviderAdapter | null> {
    // Check cache
    const cached = this.adapters.get(type);
    if (cached) {
      return cached;
    }

    // Create new adapter
    const adapter = createProviderAdapter(type);
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
          console.error(`[executor] Queued task ${task.id} failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  }
}

/**
 * Resolve a working directory value.
 * - Empty/missing → error (must be explicitly set to prevent operating on the agent runner's own repo)
 * - Git URL → error (repo setup should have resolved this to a local path)
 * - Otherwise → return as-is
 */
function resolveWorkingDirectory(value: string | undefined): string {
  if (!value) {
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
  if (value === '~') {
    return homedir();
  }
  if (value.startsWith('~/')) {
    return homedir() + value.slice(1);
  }

  return value;
}
