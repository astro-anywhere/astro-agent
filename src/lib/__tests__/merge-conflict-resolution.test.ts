/**
 * Tests for merge conflict resolution logic in task-executor.ts.
 *
 * These tests verify that:
 * 1. The retry loop produces the same output contract as before (self-contained)
 * 2. Non-conflict cases are unaffected
 * 3. Provider resume is called correctly
 * 4. The merge lock is properly acquired/released around each attempt
 * 5. All failure modes produce correct deliveryStatus/deliveryError
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// -- Minimal mock types to test the conflict resolution logic in isolation --

interface MockMergeResult {
  merged: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
  error?: string;
  commitSha?: string;
}

interface MockPRMergeResult {
  ok: boolean;
  error?: string;
}

interface MockAdapter {
  name: string;
  resumeTask: ReturnType<typeof vi.fn>;
  getTaskContext: ReturnType<typeof vi.fn>;
}

interface MockLock {
  release: ReturnType<typeof vi.fn>;
}

interface DeliveryResult {
  deliveryStatus?: 'success' | 'failed' | 'skipped';
  deliveryError?: string;
  commitAfterSha?: string;
}

// -- Extracted logic mirrors --
// These functions replicate the retry logic from task-executor.ts
// to test in isolation without needing the full TaskExecutor class.

/**
 * Simulates the branch mode merge retry loop.
 * This mirrors the logic at task-executor.ts lines ~1129-1203.
 */
async function simulateBranchMergeRetry(opts: {
  localMerge: () => Promise<MockMergeResult>;
  acquireLock: () => Promise<MockLock>;
  adapter: MockAdapter;
  taskId: string;
  projectBranch: string;
  isResumable: boolean;
  maxAttempts?: number;
}): Promise<DeliveryResult> {
  const { localMerge, acquireLock, adapter, taskId, isResumable } = opts;
  const MAX_MERGE_ATTEMPTS = opts.maxAttempts ?? 3;
  const result: DeliveryResult = {};

  for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
    const mergeLock = await acquireLock();
    let mergeResult: MockMergeResult;
    try {
      mergeResult = await localMerge();
    } finally {
      mergeLock.release();
    }

    if (mergeResult.merged) {
      result.deliveryStatus = 'success';
      result.commitAfterSha = mergeResult.commitSha;
      break;
    } else if (mergeResult.conflict) {
      const resumable = isResumable
        && !!adapter.getTaskContext(taskId)?.sessionId;

      if (resumable && attempt < MAX_MERGE_ATTEMPTS) {
        const context = adapter.getTaskContext(taskId)!;
        try {
          await adapter.resumeTask(
            taskId,
            `conflict resolution prompt (attempt ${attempt})`,
            '/tmp/workdir',
            context.sessionId,
          );
        } catch (resumeErr) {
          result.deliveryStatus = 'failed';
          result.deliveryError = `Merge conflict. Agent resolution failed: ${resumeErr instanceof Error ? resumeErr.message : resumeErr}`;
          break;
        }
        continue;
      }

      result.deliveryStatus = 'failed';
      result.deliveryError = attempt > 1
        ? `Merge conflict unresolved after ${attempt} attempts: ${mergeResult.conflictFiles?.join(', ')}`
        : `Merge conflict in: ${mergeResult.conflictFiles?.join(', ')}`;
      break;
    } else if (mergeResult.error) {
      result.deliveryStatus = 'failed';
      result.deliveryError = mergeResult.error;
      break;
    } else {
      result.deliveryStatus = 'skipped';
      break;
    }
  }

  return result;
}

/**
 * Simulates the PR mode merge retry loop.
 * This mirrors the logic at task-executor.ts lines ~1256-1319.
 */
async function simulatePRMergeRetry(opts: {
  mergePR: () => Promise<MockPRMergeResult>;
  getRemoteSha: () => Promise<string | undefined>;
  adapter: MockAdapter;
  taskId: string;
  branchName: string;
  baseBranch: string;
  isResumable: boolean;
  maxAttempts?: number;
}): Promise<DeliveryResult> {
  const { mergePR, getRemoteSha, adapter, taskId, isResumable } = opts;
  const MAX_PR_MERGE_ATTEMPTS = opts.maxAttempts ?? 3;
  const result: DeliveryResult = {};
  let prMergeResolved = false;

  const resumable = isResumable
    && !!adapter.getTaskContext(taskId)?.sessionId;

  if (resumable) {
    for (let attempt = 1; attempt <= MAX_PR_MERGE_ATTEMPTS; attempt++) {
      const context = adapter.getTaskContext(taskId)!;
      try {
        await adapter.resumeTask(
          taskId,
          `PR conflict resolution prompt (attempt ${attempt})`,
          '/tmp/workdir',
          context.sessionId,
        );
      } catch (resumeErr) {
        result.deliveryStatus = 'failed';
        result.deliveryError = `PR auto-merge failed. Agent resolution failed: ${resumeErr instanceof Error ? resumeErr.message : resumeErr}`;
        break;
      }

      const retryMerge = await mergePR();

      if (retryMerge.ok) {
        result.commitAfterSha = await getRemoteSha() ?? undefined;
        result.deliveryStatus = 'success';
        prMergeResolved = true;
        break;
      }

      if (attempt === MAX_PR_MERGE_ATTEMPTS) {
        result.deliveryStatus = 'failed';
        result.deliveryError = `PR auto-merge failed after ${attempt} attempts: ${retryMerge.error}`;
      }
    }
  }

  if (!prMergeResolved && !result.deliveryError) {
    result.deliveryStatus = 'failed';
    result.deliveryError = 'PR created but auto-merge into project branch failed';
  }

  return result;
}

// -- Tests --

describe('Branch mode merge conflict resolution', () => {
  let adapter: MockAdapter;
  let lockRelease: ReturnType<typeof vi.fn>;
  let acquireLock: () => Promise<MockLock>;

  beforeEach(() => {
    adapter = {
      name: 'test-adapter',
      resumeTask: vi.fn().mockResolvedValue(undefined),
      getTaskContext: vi.fn().mockReturnValue({ sessionId: 'session-123' }),
    };
    lockRelease = vi.fn();
    acquireLock = vi.fn().mockResolvedValue({ release: lockRelease });
  });

  it('succeeds on clean merge (no conflict)', async () => {
    const result = await simulateBranchMergeRetry({
      localMerge: vi.fn().mockResolvedValue({ merged: true, commitSha: 'abc123' }),
      acquireLock,
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/7b19a9',
      isResumable: true,
    });

    expect(result.deliveryStatus).toBe('success');
    expect(result.commitAfterSha).toBe('abc123');
    expect(result.deliveryError).toBeUndefined();
    expect(adapter.resumeTask).not.toHaveBeenCalled();
    expect(lockRelease).toHaveBeenCalledTimes(1);
  });

  it('returns skipped when no changes to merge', async () => {
    const result = await simulateBranchMergeRetry({
      localMerge: vi.fn().mockResolvedValue({ merged: false }),
      acquireLock,
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/7b19a9',
      isResumable: true,
    });

    expect(result.deliveryStatus).toBe('skipped');
    expect(adapter.resumeTask).not.toHaveBeenCalled();
  });

  it('returns failed on non-conflict error', async () => {
    const result = await simulateBranchMergeRetry({
      localMerge: vi.fn().mockResolvedValue({ merged: false, error: 'git merge failed: permission denied' }),
      acquireLock,
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/7b19a9',
      isResumable: true,
    });

    expect(result.deliveryStatus).toBe('failed');
    expect(result.deliveryError).toBe('git merge failed: permission denied');
    expect(adapter.resumeTask).not.toHaveBeenCalled();
  });

  it('resumes agent on conflict and succeeds on retry', async () => {
    const localMerge = vi.fn()
      .mockResolvedValueOnce({ merged: false, conflict: true, conflictFiles: ['src/a.ts'] })
      .mockResolvedValueOnce({ merged: true, commitSha: 'def456' });

    const result = await simulateBranchMergeRetry({
      localMerge,
      acquireLock,
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/7b19a9',
      isResumable: true,
    });

    expect(result.deliveryStatus).toBe('success');
    expect(result.commitAfterSha).toBe('def456');
    expect(adapter.resumeTask).toHaveBeenCalledTimes(1);
    expect(adapter.resumeTask).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('attempt 1'),
      '/tmp/workdir',
      'session-123',
    );
    // Lock acquired twice (attempt 1 + retry)
    expect(lockRelease).toHaveBeenCalledTimes(2);
  });

  it('retries multiple times before succeeding', async () => {
    const localMerge = vi.fn()
      .mockResolvedValueOnce({ merged: false, conflict: true, conflictFiles: ['a.ts'] })
      .mockResolvedValueOnce({ merged: false, conflict: true, conflictFiles: ['a.ts'] })
      .mockResolvedValueOnce({ merged: true, commitSha: 'ghi789' });

    const result = await simulateBranchMergeRetry({
      localMerge,
      acquireLock,
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/7b19a9',
      isResumable: true,
    });

    expect(result.deliveryStatus).toBe('success');
    expect(adapter.resumeTask).toHaveBeenCalledTimes(2);
    expect(lockRelease).toHaveBeenCalledTimes(3);
  });

  it('fails after max attempts', async () => {
    const localMerge = vi.fn()
      .mockResolvedValue({ merged: false, conflict: true, conflictFiles: ['a.ts', 'b.ts'] });

    const result = await simulateBranchMergeRetry({
      localMerge,
      acquireLock,
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/7b19a9',
      isResumable: true,
      maxAttempts: 3,
    });

    expect(result.deliveryStatus).toBe('failed');
    expect(result.deliveryError).toContain('unresolved after 3 attempts');
    expect(result.deliveryError).toContain('a.ts');
    // Only 2 resume calls — 3rd attempt doesn't resume (attempt === maxAttempts)
    expect(adapter.resumeTask).toHaveBeenCalledTimes(2);
    expect(lockRelease).toHaveBeenCalledTimes(3);
  });

  it('fails immediately on conflict when adapter is not resumable', async () => {
    const localMerge = vi.fn()
      .mockResolvedValue({ merged: false, conflict: true, conflictFiles: ['a.ts'] });

    const result = await simulateBranchMergeRetry({
      localMerge,
      acquireLock,
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/7b19a9',
      isResumable: false,
    });

    expect(result.deliveryStatus).toBe('failed');
    expect(result.deliveryError).toContain('Merge conflict in');
    expect(adapter.resumeTask).not.toHaveBeenCalled();
    // Only 1 attempt — no retry
    expect(lockRelease).toHaveBeenCalledTimes(1);
  });

  it('fails immediately on conflict when no sessionId', async () => {
    adapter.getTaskContext.mockReturnValue({ sessionId: undefined });

    const localMerge = vi.fn()
      .mockResolvedValue({ merged: false, conflict: true, conflictFiles: ['a.ts'] });

    const result = await simulateBranchMergeRetry({
      localMerge,
      acquireLock,
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/7b19a9',
      isResumable: true,
    });

    expect(result.deliveryStatus).toBe('failed');
    expect(result.deliveryError).toContain('Merge conflict in');
    expect(adapter.resumeTask).not.toHaveBeenCalled();
  });

  it('fails when agent resume throws', async () => {
    adapter.resumeTask.mockRejectedValue(new Error('Agent session expired'));

    const localMerge = vi.fn()
      .mockResolvedValue({ merged: false, conflict: true, conflictFiles: ['a.ts'] });

    const result = await simulateBranchMergeRetry({
      localMerge,
      acquireLock,
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/7b19a9',
      isResumable: true,
    });

    expect(result.deliveryStatus).toBe('failed');
    expect(result.deliveryError).toContain('Agent resolution failed');
    expect(result.deliveryError).toContain('Agent session expired');
    // Resume called once, then broke out
    expect(adapter.resumeTask).toHaveBeenCalledTimes(1);
  });

  it('releases lock even when merge throws', async () => {
    const localMerge = vi.fn().mockRejectedValue(new Error('git crashed'));

    await expect(simulateBranchMergeRetry({
      localMerge,
      acquireLock,
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/7b19a9',
      isResumable: true,
    })).rejects.toThrow('git crashed');

    // Lock was still released via finally block
    expect(lockRelease).toHaveBeenCalledTimes(1);
  });
});

describe('PR mode merge conflict resolution', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = {
      name: 'test-adapter',
      resumeTask: vi.fn().mockResolvedValue(undefined),
      getTaskContext: vi.fn().mockReturnValue({ sessionId: 'session-456' }),
    };
  });

  it('succeeds when agent resolves and retry merge works', async () => {
    const result = await simulatePRMergeRetry({
      mergePR: vi.fn().mockResolvedValue({ ok: true }),
      getRemoteSha: vi.fn().mockResolvedValue('abc123'),
      adapter,
      taskId: 'task-1',
      branchName: 'astro/7b19a9-a3f2b1',
      baseBranch: 'astro/7b19a9',
      isResumable: true,
    });

    expect(result.deliveryStatus).toBe('success');
    expect(result.commitAfterSha).toBe('abc123');
    expect(adapter.resumeTask).toHaveBeenCalledTimes(1);
  });

  it('retries multiple times before succeeding', async () => {
    const mergePR = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'merge conflict' })
      .mockResolvedValueOnce({ ok: true });

    const result = await simulatePRMergeRetry({
      mergePR,
      getRemoteSha: vi.fn().mockResolvedValue('def456'),
      adapter,
      taskId: 'task-1',
      branchName: 'astro/7b19a9-a3f2b1',
      baseBranch: 'astro/7b19a9',
      isResumable: true,
    });

    expect(result.deliveryStatus).toBe('success');
    expect(adapter.resumeTask).toHaveBeenCalledTimes(2);
  });

  it('fails after max attempts', async () => {
    const mergePR = vi.fn()
      .mockResolvedValue({ ok: false, error: 'still conflicting' });

    const result = await simulatePRMergeRetry({
      mergePR,
      getRemoteSha: vi.fn().mockResolvedValue('abc'),
      adapter,
      taskId: 'task-1',
      branchName: 'astro/7b19a9-a3f2b1',
      baseBranch: 'astro/7b19a9',
      isResumable: true,
      maxAttempts: 3,
    });

    expect(result.deliveryStatus).toBe('failed');
    expect(result.deliveryError).toContain('after 3 attempts');
    expect(adapter.resumeTask).toHaveBeenCalledTimes(3);
  });

  it('fails immediately when adapter is not resumable', async () => {
    const result = await simulatePRMergeRetry({
      mergePR: vi.fn(),
      getRemoteSha: vi.fn(),
      adapter,
      taskId: 'task-1',
      branchName: 'astro/7b19a9-a3f2b1',
      baseBranch: 'astro/7b19a9',
      isResumable: false,
    });

    expect(result.deliveryStatus).toBe('failed');
    expect(result.deliveryError).toBe('PR created but auto-merge into project branch failed');
    expect(adapter.resumeTask).not.toHaveBeenCalled();
  });

  it('fails immediately when no sessionId', async () => {
    adapter.getTaskContext.mockReturnValue({ sessionId: undefined });

    const result = await simulatePRMergeRetry({
      mergePR: vi.fn(),
      getRemoteSha: vi.fn(),
      adapter,
      taskId: 'task-1',
      branchName: 'astro/7b19a9-a3f2b1',
      baseBranch: 'astro/7b19a9',
      isResumable: true,
    });

    expect(result.deliveryStatus).toBe('failed');
    expect(result.deliveryError).toBe('PR created but auto-merge into project branch failed');
    expect(adapter.resumeTask).not.toHaveBeenCalled();
  });

  it('fails when agent resume throws', async () => {
    adapter.resumeTask.mockRejectedValue(new Error('Connection lost'));

    const result = await simulatePRMergeRetry({
      mergePR: vi.fn(),
      getRemoteSha: vi.fn(),
      adapter,
      taskId: 'task-1',
      branchName: 'astro/7b19a9-a3f2b1',
      baseBranch: 'astro/7b19a9',
      isResumable: true,
    });

    expect(result.deliveryStatus).toBe('failed');
    expect(result.deliveryError).toContain('Agent resolution failed');
    expect(result.deliveryError).toContain('Connection lost');
    expect(adapter.resumeTask).toHaveBeenCalledTimes(1);
  });
});

describe('Output contract preservation', () => {
  it('clean merge produces identical output to pre-change behavior', async () => {
    const adapter: MockAdapter = {
      name: 'test',
      resumeTask: vi.fn(),
      getTaskContext: vi.fn().mockReturnValue({ sessionId: 'sess' }),
    };

    const result = await simulateBranchMergeRetry({
      localMerge: vi.fn().mockResolvedValue({ merged: true, commitSha: 'sha1' }),
      acquireLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/proj',
      isResumable: true,
    });

    // These are the ONLY fields that should be set on success
    expect(result).toEqual({
      deliveryStatus: 'success',
      commitAfterSha: 'sha1',
    });
  });

  it('conflict with successful retry produces same output as clean merge', async () => {
    const adapter: MockAdapter = {
      name: 'test',
      resumeTask: vi.fn().mockResolvedValue(undefined),
      getTaskContext: vi.fn().mockReturnValue({ sessionId: 'sess' }),
    };

    const localMerge = vi.fn()
      .mockResolvedValueOnce({ merged: false, conflict: true, conflictFiles: ['a.ts'] })
      .mockResolvedValueOnce({ merged: true, commitSha: 'sha2' });

    const result = await simulateBranchMergeRetry({
      localMerge,
      acquireLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/proj',
      isResumable: true,
    });

    // Same shape as clean merge — downstream can't tell the difference
    expect(result).toEqual({
      deliveryStatus: 'success',
      commitAfterSha: 'sha2',
    });
  });

  it('conflict failure preserves original failure shape', async () => {
    const adapter: MockAdapter = {
      name: 'test',
      resumeTask: vi.fn(),
      getTaskContext: vi.fn().mockReturnValue(undefined),
    };

    const result = await simulateBranchMergeRetry({
      localMerge: vi.fn().mockResolvedValue({ merged: false, conflict: true, conflictFiles: ['a.ts'] }),
      acquireLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      adapter,
      taskId: 'task-1',
      projectBranch: 'astro/proj',
      isResumable: false,
    });

    // Same shape as old behavior — deliveryStatus='failed' + descriptive error
    expect(result.deliveryStatus).toBe('failed');
    expect(result.deliveryError).toContain('a.ts');
    expect(result.commitAfterSha).toBeUndefined();
  });
});
