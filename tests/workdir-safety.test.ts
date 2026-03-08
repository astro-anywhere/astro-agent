/**
 * Working directory safety check tests.
 *
 * Tests both the low-level checkWorkdirSafety() function (with real git repos)
 * and the TaskExecutor.submitTask() safety-skip logic when worktree isolation
 * is enabled for git repos.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkWorkdirSafety,
  WorkdirSafetyTier,
} from '../src/lib/workdir-safety.js';

// ============================================================================
// Helpers
// ============================================================================

const tmpDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function createGitRepo(options?: { dirty?: boolean }): string {
  const dir = createTempDir('safety-test-git-');
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'file.txt'), 'initial content\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir });

  if (options?.dirty) {
    writeFileSync(join(dir, 'file.txt'), 'modified content\n');
  }

  return dir;
}

afterAll(async () => {
  for (const dir of tmpDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ============================================================================
// checkWorkdirSafety — unit tests with real git repos
// ============================================================================

describe('checkWorkdirSafety', () => {
  // --- Git + clean ---
  it('returns SAFE for clean git repo (no worktree)', async () => {
    const dir = createGitRepo();
    const result = await checkWorkdirSafety(dir, 0, true, false);

    expect(result.tier).toBe(WorkdirSafetyTier.SAFE);
    expect(result.isGitRepo).toBe(true);
    expect(result.hasUncommittedChanges).toBe(false);
    expect(result.warning).toBeUndefined();
    expect(result.blockReason).toBeUndefined();
  });

  it('returns SAFE for clean git repo (with worktree)', async () => {
    const dir = createGitRepo();
    const result = await checkWorkdirSafety(dir, 0, true, true);

    expect(result.tier).toBe(WorkdirSafetyTier.SAFE);
    expect(result.isGitRepo).toBe(true);
    expect(result.hasUncommittedChanges).toBe(false);
  });

  // --- Git + uncommitted + worktree ---
  it('returns SAFE for git repo with uncommitted changes when worktree is enabled', async () => {
    const dir = createGitRepo({ dirty: true });
    const result = await checkWorkdirSafety(dir, 0, true, true);

    expect(result.tier).toBe(WorkdirSafetyTier.SAFE);
    expect(result.isGitRepo).toBe(true);
    expect(result.hasUncommittedChanges).toBe(true);
    expect(result.blockReason).toBeUndefined();
  });

  // --- Git + uncommitted + no worktree (single task) → RISKY ---
  it('returns RISKY for git repo with uncommitted changes when worktree is disabled (single task)', async () => {
    const dir = createGitRepo({ dirty: true });
    const result = await checkWorkdirSafety(dir, 0, true, false);

    expect(result.tier).toBe(WorkdirSafetyTier.RISKY);
    expect(result.isGitRepo).toBe(true);
    expect(result.hasUncommittedChanges).toBe(true);
    expect(result.warning).toContain('UNCOMMITTED CHANGES WITHOUT WORKTREE');
  });

  it('returns RISKY for git repo with uncommitted changes when willUseWorktree is undefined', async () => {
    const dir = createGitRepo({ dirty: true });
    // No willUseWorktree param → defaults to undefined (falsy)
    const result = await checkWorkdirSafety(dir, 0, true);

    expect(result.tier).toBe(WorkdirSafetyTier.RISKY);
    expect(result.isGitRepo).toBe(true);
    expect(result.hasUncommittedChanges).toBe(true);
  });

  // --- Git + uncommitted + no worktree (parallel) → UNSAFE ---
  it('returns UNSAFE for git repo with uncommitted changes + no worktree + parallel tasks', async () => {
    const dir = createGitRepo({ dirty: true });
    const result = await checkWorkdirSafety(dir, 2, true, false);

    expect(result.tier).toBe(WorkdirSafetyTier.UNSAFE);
    expect(result.isGitRepo).toBe(true);
    expect(result.hasUncommittedChanges).toBe(true);
    expect(result.blockReason).toContain('PARALLEL EXECUTION WITH UNCOMMITTED');
    expect(result.parallelTaskCount).toBe(2);
  });

  // --- Non-git ---
  it('returns RISKY for non-git directory', async () => {
    const dir = createTempDir('safety-test-nongit-');
    const result = await checkWorkdirSafety(dir, 0, true);

    expect(result.tier).toBe(WorkdirSafetyTier.RISKY);
    expect(result.isGitRepo).toBe(false);
    expect(result.warning).toContain('NO GIT REPOSITORY');
  });

  it('returns UNSAFE for non-git directory with parallel tasks', async () => {
    const dir = createTempDir('safety-test-unsafe-');
    const result = await checkWorkdirSafety(dir, 2, true);

    expect(result.tier).toBe(WorkdirSafetyTier.UNSAFE);
    expect(result.isGitRepo).toBe(false);
    expect(result.blockReason).toContain('PARALLEL EXECUTION BLOCKED');
    expect(result.parallelTaskCount).toBe(2);
  });

  it('returns RISKY when git is not available', async () => {
    const dir = createGitRepo();
    // Even though it's a git repo, if git is not available we can't detect it
    const result = await checkWorkdirSafety(dir, 0, false);

    expect(result.tier).toBe(WorkdirSafetyTier.RISKY);
    expect(result.isGitRepo).toBe(false);
  });

  // --- Git + parallel tasks ---
  it('returns SAFE for clean git repo even with parallel tasks', async () => {
    const dir = createGitRepo();
    const result = await checkWorkdirSafety(dir, 3, true, true);

    expect(result.tier).toBe(WorkdirSafetyTier.SAFE);
    expect(result.isGitRepo).toBe(true);
    expect(result.parallelTaskCount).toBe(3);
  });
});

// ============================================================================
// TaskExecutor.submitTask — safety-skip logic with worktree
// ============================================================================

// We test the safety-skip logic by mocking the TaskExecutor's dependencies
// and verifying which WebSocket messages are sent.

// Mock worktree and provider modules that TaskExecutor imports
vi.mock('../src/lib/worktree.js', () => ({
  createWorktree: vi.fn().mockResolvedValue({
    workingDirectory: '/tmp/mock-worktree',
    branchName: 'astro/mock-task',
    cleanup: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../src/lib/worktree-include.js', () => ({
  applyWorktreeInclude: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/worktree-setup.js', () => ({
  runSetupScript: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/git-pr.js', () => ({
  pushAndCreatePR: vi.fn().mockResolvedValue({
    branchName: 'astro/mock-task',
    pushed: false,
  }),
}));

vi.mock('../src/providers/index.js', () => ({
  createProviderAdapter: vi.fn().mockReturnValue(null),
}));

import { TaskExecutor } from '../src/lib/task-executor.js';
import type { Task } from '../src/types.js';

function createMockWsClient() {
  return {
    sendTaskResult: vi.fn(),
    sendTaskStatus: vi.fn(),
    sendTaskOutput: vi.fn(),
    sendTaskText: vi.fn(),
    sendToolTrace: vi.fn(),
    sendTaskToolUse: vi.fn(),
    sendTaskToolResult: vi.fn(),
    sendTaskFileChange: vi.fn(),
    sendTaskSessionInit: vi.fn(),
    sendSafetyPrompt: vi.fn(),
    sendApprovalRequest: vi.fn(),
    addActiveTask: vi.fn(),
    removeActiveTask: vi.fn(),
  } as any;
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Date.now()}`,
    projectId: 'proj-1',
    planNodeId: 'node-1',
    provider: 'claude-sdk',
    prompt: 'Do something',
    workingDirectory: '/tmp/test',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('TaskExecutor safety with worktree', () => {
  let wsClient: ReturnType<typeof createMockWsClient>;

  beforeEach(() => {
    wsClient = createMockWsClient();
    vi.clearAllMocks();
  });

  it('SAFE: git + uncommitted + worktree → proceeds without warning', async () => {
    const gitDir = createGitRepo({ dirty: true });

    const executor = new TaskExecutor({
      wsClient,
      useWorktree: true, // default
    });
    await new Promise((r) => setTimeout(r, 100));

    const task = createTask({
      workingDirectory: gitDir,
      deliveryMode: 'pr',
    });

    await executor.submitTask(task);

    // Should NOT send any safety warning or block
    const statusCalls = wsClient.sendTaskStatus.mock.calls;
    const safetyWarning = statusCalls.find(
      (call: any[]) => typeof call[3] === 'string' && call[3].includes('UNCOMMITTED'),
    );
    expect(safetyWarning).toBeUndefined();

    // Should NOT have been blocked
    const resultCalls = wsClient.sendTaskResult.mock.calls;
    const blockedResult = resultCalls.find(
      (call: any[]) => call[0]?.error?.includes('UNCOMMITTED'),
    );
    expect(blockedResult).toBeUndefined();
  });

  it('RISKY: git + uncommitted + no worktree → prompts user', async () => {
    const gitDir = createGitRepo({ dirty: true });

    const executor = new TaskExecutor({
      wsClient,
      useWorktree: false, // explicitly disabled
    });
    await new Promise((r) => setTimeout(r, 100));

    const task = createTask({
      workingDirectory: gitDir,
      deliveryMode: 'pr',
    });

    const submitPromise = executor.submitTask(task);
    await new Promise((r) => setTimeout(r, 200));

    // Should prompt (RISKY tier) not block
    expect(wsClient.sendSafetyPrompt).toHaveBeenCalledWith(
      task.id,
      WorkdirSafetyTier.RISKY,
      expect.stringContaining('UNCOMMITTED CHANGES WITHOUT WORKTREE'),
      expect.any(Array),
    );

    executor.handleSafetyDecision(task.id, 'cancel');
    await submitPromise;
  });

  it('RISKY: git + uncommitted + task.useWorktree=false → prompts user', async () => {
    const gitDir = createGitRepo({ dirty: true });

    const executor = new TaskExecutor({
      wsClient,
      useWorktree: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const task = createTask({
      workingDirectory: gitDir,
      deliveryMode: 'pr',
      useWorktree: false, // per-task override
    });

    const submitPromise = executor.submitTask(task);
    await new Promise((r) => setTimeout(r, 200));

    expect(wsClient.sendSafetyPrompt).toHaveBeenCalledWith(
      task.id,
      WorkdirSafetyTier.RISKY,
      expect.stringContaining('UNCOMMITTED CHANGES WITHOUT WORKTREE'),
      expect.any(Array),
    );

    executor.handleSafetyDecision(task.id, 'cancel');
    await submitPromise;
  });

  it('RISKY: git + uncommitted + deliveryMode=direct → prompts user', async () => {
    const gitDir = createGitRepo({ dirty: true });

    const executor = new TaskExecutor({
      wsClient,
      useWorktree: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const task = createTask({
      workingDirectory: gitDir,
      deliveryMode: 'direct', // no worktree for direct mode
    });

    const submitPromise = executor.submitTask(task);
    await new Promise((r) => setTimeout(r, 200));

    expect(wsClient.sendSafetyPrompt).toHaveBeenCalledWith(
      task.id,
      WorkdirSafetyTier.RISKY,
      expect.stringContaining('UNCOMMITTED CHANGES WITHOUT WORKTREE'),
      expect.any(Array),
    );

    executor.handleSafetyDecision(task.id, 'cancel');
    await submitPromise;
  });

  it('RISKY: non-git → prompts user even when worktree is enabled', async () => {
    const nonGitDir = createTempDir('safety-test-risky-');

    const executor = new TaskExecutor({
      wsClient,
      useWorktree: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const task = createTask({
      workingDirectory: nonGitDir,
      deliveryMode: 'pr',
    });

    const submitPromise = executor.submitTask(task);
    await new Promise((r) => setTimeout(r, 200));

    expect(wsClient.sendSafetyPrompt).toHaveBeenCalledWith(
      task.id,
      WorkdirSafetyTier.RISKY,
      expect.stringContaining('NO GIT REPOSITORY'),
      expect.any(Array),
    );

    executor.handleSafetyDecision(task.id, 'cancel');
    await submitPromise;
  });

  it('non-git + allowNonGit → bypasses RISKY prompt, proceeds to execution', async () => {
    const nonGitDir = createTempDir('safety-test-nongit-allow-');

    const executor = new TaskExecutor({
      wsClient,
      useWorktree: true,
      allowNonGit: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const task = createTask({
      workingDirectory: nonGitDir,
      deliveryMode: 'pr',
    });

    await executor.submitTask(task);

    const resultCalls = wsClient.sendTaskResult.mock.calls;
    const failedResult = resultCalls.find(
      (call: any[]) => call[0]?.taskId === task.id && call[0]?.status === 'failed',
    );
    // Provider is mocked as null, so task should fail with "provider not available"
    expect(failedResult).toBeDefined();
    expect(failedResult![0].error).toContain('not available');
    expect(wsClient.sendSafetyPrompt).not.toHaveBeenCalled();
  });

  it('skips safety check entirely for text-only tasks', async () => {
    const nonGitDir = createTempDir('safety-test-textonly-');

    const executor = new TaskExecutor({
      wsClient,
      useWorktree: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const task = createTask({
      workingDirectory: nonGitDir,
      type: 'plan',
    });

    await executor.submitTask(task);

    expect(wsClient.sendSafetyPrompt).not.toHaveBeenCalled();
    const statusCalls = wsClient.sendTaskStatus.mock.calls;
    const safetyWarning = statusCalls.find(
      (call: any[]) => typeof call[3] === 'string' && call[3].includes('UNCOMMITTED'),
    );
    expect(safetyWarning).toBeUndefined();
  });

  it('SAFE: git + uncommitted + worktree for all non-direct delivery modes', async () => {
    for (const mode of ['pr', 'push', 'branch', 'copy'] as const) {
      const gitDir = createGitRepo({ dirty: true });
      const client = createMockWsClient();

      const executor = new TaskExecutor({
        wsClient: client,
        useWorktree: true,
      });
      await new Promise((r) => setTimeout(r, 100));

      const task = createTask({
        workingDirectory: gitDir,
        deliveryMode: mode,
      });

      await executor.submitTask(task);

      // Should not be blocked
      const resultCalls = client.sendTaskResult.mock.calls;
      const blockedResult = resultCalls.find(
        (call: any[]) => call[0]?.error?.includes('UNCOMMITTED'),
      );
      expect(blockedResult).toBeUndefined();
    }
  });
});
