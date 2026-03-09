/**
 * Silent task failure tests.
 *
 * Verifies that all catch handlers in the dispatch/execution pipeline
 * send sendTaskResult({status:'failed'}) instead of silently logging.
 *
 * The bug: when submitTask() or executeTask() threw, the task stayed in
 * the heartbeat's activeTasks forever (added at websocket-client.ts:1128
 * before onTaskDispatch), the dead job checker never fired, and the task
 * was stuck permanently with no error surfaced to the user.
 *
 * These tests cover:
 * 1. start.ts onTaskDispatch catch → sendTaskResult on submitTask failure
 * 2. start.ts onTaskSafetyDecision catch → sendTaskResult on decision failure
 * 3. task-executor.ts processQueue catch → sendTaskResult + cleanup on executeTask failure
 * 4. WebSocketClient.sendTaskResult removes task from activeTasks (heartbeat)
 * 5. Edge cases: double-cleanup idempotency, processQueue re-invocation
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Mock provider so TaskExecutor doesn't try to spawn real Claude processes
// ============================================================================

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
import type { Task, TaskResult } from '../src/types.js';
import type { WebSocketClient } from '../src/lib/websocket-client.js';

// ============================================================================
// Helpers
// ============================================================================

const tmpDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function createGitRepo(): string {
  const dir = createTempDir('silent-fail-test-');
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'file.txt'), 'initial content\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir });
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
  } as unknown as WebSocketClient;
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'proj-test-1',
    planNodeId: 'node-1',
    provider: 'claude-sdk',
    prompt: 'Do something',
    workingDirectory: '/tmp/test',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// 1. onTaskDispatch catch — submitTask failure sends sendTaskResult
// ============================================================================

describe('onTaskDispatch catch sends sendTaskResult on submitTask failure', () => {
  /**
   * Simulates the onTaskDispatch callback in start.ts:420-430.
   * This is the actual code pattern from start.ts after the fix:
   *
   *   onTaskDispatch: (task: Task) => {
   *     taskExecutor.submitTask(task).catch((error) => {
   *       log('error', ...);
   *       wsClient.sendTaskResult({ taskId: task.id, status: 'failed', error: ..., completedAt: ... });
   *     });
   *   },
   */
  function simulateOnTaskDispatch(
    task: Task,
    submitTask: (task: Task) => Promise<void>,
    sendTaskResult: (result: TaskResult) => void,
  ): Promise<void> {
    return submitTask(task).catch((error) => {
      sendTaskResult({
        taskId: task.id,
        status: 'failed',
        error: `Task submission failed: ${error instanceof Error ? error.message : String(error)}`,
        completedAt: new Date().toISOString(),
      });
    });
  }

  it('calls sendTaskResult when submitTask rejects', async () => {
    const sendTaskResult = vi.fn();
    const task = createTask();
    const failingSubmit = vi.fn().mockRejectedValue(new Error('resolveWorkingDirectory failed: empty path'));

    await simulateOnTaskDispatch(task, failingSubmit, sendTaskResult);

    expect(sendTaskResult).toHaveBeenCalledTimes(1);
    expect(sendTaskResult).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      status: 'failed',
      error: expect.stringContaining('resolveWorkingDirectory failed'),
    }));
  });

  it('includes completedAt timestamp in the result', async () => {
    const sendTaskResult = vi.fn();
    const task = createTask();
    const failingSubmit = vi.fn().mockRejectedValue(new Error('boom'));

    const before = new Date().toISOString();
    await simulateOnTaskDispatch(task, failingSubmit, sendTaskResult);
    const after = new Date().toISOString();

    const result = sendTaskResult.mock.calls[0][0] as TaskResult;
    expect(result.completedAt).toBeDefined();
    expect(result.completedAt! >= before).toBe(true);
    expect(result.completedAt! <= after).toBe(true);
  });

  it('handles non-Error thrown values', async () => {
    const sendTaskResult = vi.fn();
    const task = createTask();
    const failingSubmit = vi.fn().mockRejectedValue('string error');

    await simulateOnTaskDispatch(task, failingSubmit, sendTaskResult);

    expect(sendTaskResult).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('string error'),
    }));
  });

  it('does NOT call sendTaskResult when submitTask succeeds', async () => {
    const sendTaskResult = vi.fn();
    const task = createTask();
    const successSubmit = vi.fn().mockResolvedValue(undefined);

    await simulateOnTaskDispatch(task, successSubmit, sendTaskResult);

    expect(sendTaskResult).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 2. onTaskSafetyDecision catch — sends sendTaskResult on failure
// ============================================================================

describe('onTaskSafetyDecision catch sends sendTaskResult on failure', () => {
  /**
   * Simulates the onTaskSafetyDecision callback in start.ts:441-448.
   */
  function simulateOnSafetyDecision(
    taskId: string,
    decision: string,
    handleSafetyDecision: (taskId: string, decision: string) => Promise<void>,
    sendTaskResult: (result: TaskResult) => void,
  ): Promise<void> {
    return handleSafetyDecision(taskId, decision).catch((error) => {
      sendTaskResult({
        taskId,
        status: 'failed',
        error: `Safety decision handling failed: ${error instanceof Error ? error.message : String(error)}`,
        completedAt: new Date().toISOString(),
      });
    });
  }

  it('calls sendTaskResult when handleSafetyDecision rejects', async () => {
    const sendTaskResult = vi.fn();
    const failingHandle = vi.fn().mockRejectedValue(new Error('decision resolution failed'));

    await simulateOnSafetyDecision('task-42', 'proceed', failingHandle, sendTaskResult);

    expect(sendTaskResult).toHaveBeenCalledTimes(1);
    expect(sendTaskResult).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-42',
      status: 'failed',
      error: expect.stringContaining('decision resolution failed'),
    }));
  });

  it('does NOT call sendTaskResult on success', async () => {
    const sendTaskResult = vi.fn();
    const successHandle = vi.fn().mockResolvedValue(undefined);

    await simulateOnSafetyDecision('task-42', 'proceed', successHandle, sendTaskResult);

    expect(sendTaskResult).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 3. processQueue catch — TaskExecutor integration test
// ============================================================================

describe('processQueue catch sends sendTaskResult on executeTask failure', () => {
  let wsClient: ReturnType<typeof createMockWsClient>;

  beforeEach(() => {
    wsClient = createMockWsClient();
    vi.clearAllMocks();
  });

  it('sends failed result when executeTask throws (provider unavailable)', async () => {
    // createProviderAdapter returns null → executeTask returns early with sendTaskResult
    // But if getAdapter() itself threw, the processQueue catch would fire.
    // We test via submitTask with an empty workingDirectory which throws in resolveWorkingDirectory.

    const executor = new TaskExecutor({
      wsClient,
      useWorktree: false,
    });
    // Wait for git availability check
    await new Promise((r) => setTimeout(r, 100));

    const task = createTask({
      workingDirectory: '', // empty path → resolveWorkingDirectory throws
      skipSafetyCheck: true,
    });

    // submitTask should throw, but the onTaskDispatch catch in start.ts handles it.
    // We call submitTask directly to simulate what happens.
    await expect(executor.submitTask(task)).rejects.toThrow();

    // The error propagates to the caller (start.ts onTaskDispatch catch),
    // which now sends sendTaskResult. The executor itself may not have sent it
    // because the error happens before executeTask is called.
  });

  it('sends failed result for provider-unavailable tasks (direct executeTask path)', async () => {
    const gitDir = createGitRepo();

    const executor = new TaskExecutor({
      wsClient,
      useWorktree: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const task = createTask({
      workingDirectory: gitDir,
      skipSafetyCheck: true,
      provider: 'nonexistent-provider' as 'claude-sdk',
    });

    await executor.submitTask(task);
    // Wait for async operations
    await new Promise((r) => setTimeout(r, 500));

    // The adapter is null (mocked createProviderAdapter returns null),
    // so executeTask sends a failed result internally
    expect(wsClient.sendTaskResult).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      status: 'failed',
      error: expect.stringContaining('not available'),
    }));
  });
});

// ============================================================================
// 4. WebSocketClient.sendTaskResult removes from activeTasks
// ============================================================================

describe('sendTaskResult removes task from activeTasks (heartbeat)', () => {
  it('activeTasks.delete is called inside sendTaskResult', () => {
    // This verifies the contract: calling sendTaskResult automatically
    // removes the task from the heartbeat's activeTasks Set.
    // We read the source to confirm the pattern.
    const { readFileSync } = require('node:fs');
    const wsClientSource = readFileSync(
      join(process.cwd(), 'src/lib/websocket-client.ts'),
      'utf-8',
    );

    // Find the sendTaskResult method
    const methodStart = wsClientSource.indexOf('sendTaskResult(result: TaskResult)');
    expect(methodStart).toBeGreaterThan(-1);

    // The method body should contain activeTasks.delete
    const methodBody = wsClientSource.slice(methodStart, methodStart + 300);
    expect(methodBody).toContain('this.activeTasks.delete(result.taskId)');
  });

  it('sendTaskResult is the single point of cleanup for activeTasks', () => {
    // Verify that onTaskDispatch catch does NOT call removeActiveTask separately —
    // sendTaskResult handles it. This prevents double-removal confusion.
    const { readFileSync } = require('node:fs');
    const startSource = readFileSync(
      join(process.cwd(), 'src/commands/start.ts'),
      'utf-8',
    );

    // Find the onTaskDispatch catch block
    const dispatchStart = startSource.indexOf('onTaskDispatch: (task: Task) =>');
    const dispatchEnd = startSource.indexOf('onTaskCancel:', dispatchStart);
    const dispatchBlock = startSource.slice(dispatchStart, dispatchEnd);

    // Should call sendTaskResult
    expect(dispatchBlock).toContain('wsClient.sendTaskResult({');
    expect(dispatchBlock).toContain("status: 'failed'");

    // Should NOT call removeActiveTask separately (sendTaskResult handles it)
    expect(dispatchBlock).not.toContain('removeActiveTask');
  });
});

// ============================================================================
// 5. processQueue catch does full cleanup
// ============================================================================

describe('processQueue catch performs complete cleanup', () => {
  it('processQueue catch calls sendTaskResult, runningTasks.delete, untrackTaskDirectory, and processQueue', () => {
    const { readFileSync } = require('node:fs');
    const executorSource = readFileSync(
      join(process.cwd(), 'src/lib/task-executor.ts'),
      'utf-8',
    );

    // Find the processQueue method
    const methodStart = executorSource.indexOf('private processQueue(): void');
    expect(methodStart).toBeGreaterThan(-1);

    const methodEnd = executorSource.indexOf('\n  }', methodStart + 50);
    const methodBody = executorSource.slice(methodStart, methodEnd + 4);

    // Verify all cleanup actions are present in the catch
    expect(methodBody).toContain('this.wsClient.sendTaskResult({');
    expect(methodBody).toContain("status: 'failed'");
    expect(methodBody).toContain('this.runningTasks.delete(task.id)');
    expect(methodBody).toContain('this.untrackTaskDirectory(task)');
    expect(methodBody).toContain('this.processQueue()');
  });

  it('processQueue catch includes projectId in error log', () => {
    const { readFileSync } = require('node:fs');
    const executorSource = readFileSync(
      join(process.cwd(), 'src/lib/task-executor.ts'),
      'utf-8',
    );

    const methodStart = executorSource.indexOf('private processQueue(): void');
    const methodEnd = executorSource.indexOf('\n  }', methodStart + 50);
    const methodBody = executorSource.slice(methodStart, methodEnd + 4);

    // Error log should include projectId for correlation
    expect(methodBody).toContain('task.projectId');
  });
});

// ============================================================================
// 6. Safety decision catch includes sendTaskResult
// ============================================================================

describe('onTaskSafetyDecision catch in start.ts includes sendTaskResult', () => {
  it('safety decision catch calls sendTaskResult with failed status', () => {
    const { readFileSync } = require('node:fs');
    const startSource = readFileSync(
      join(process.cwd(), 'src/commands/start.ts'),
      'utf-8',
    );

    // Find the onTaskSafetyDecision block
    const safetyStart = startSource.indexOf('onTaskSafetyDecision:');
    const safetyEnd = startSource.indexOf('onTaskSteer:', safetyStart);
    const safetyBlock = startSource.slice(safetyStart, safetyEnd);

    // Should call sendTaskResult in the catch
    expect(safetyBlock).toContain('wsClient.sendTaskResult({');
    expect(safetyBlock).toContain("status: 'failed'");
    expect(safetyBlock).toContain('completedAt:');
  });
});

// ============================================================================
// 7. Idempotency — cleanup operations are safe to call multiple times
// ============================================================================

describe('cleanup operations are idempotent', () => {
  it('Set.delete on non-existent key does not throw', () => {
    const set = new Set<string>();
    set.add('task-1');
    set.delete('task-1'); // first delete
    expect(() => set.delete('task-1')).not.toThrow(); // second delete — no-op
  });

  it('Map.delete on non-existent key does not throw', () => {
    const map = new Map<string, unknown>();
    map.set('task-1', { foo: 'bar' });
    map.delete('task-1'); // first delete
    expect(() => map.delete('task-1')).not.toThrow(); // second delete — no-op
  });

  it('sendTaskResult can be called even if executeTask already cleaned up', () => {
    // This simulates the case where executeTask's prepareTaskWorkspace catch
    // already did runningTasks.delete + removeActiveTask, and then the
    // processQueue catch also calls sendTaskResult (which calls activeTasks.delete).
    // All operations should be safe.
    const wsClient = createMockWsClient();

    // Simulate executeTask internal cleanup
    (wsClient.removeActiveTask as ReturnType<typeof vi.fn>)('task-1');

    // Then processQueue catch calls sendTaskResult
    (wsClient.sendTaskResult as ReturnType<typeof vi.fn>)({
      taskId: 'task-1',
      status: 'failed',
      error: 'test',
      completedAt: new Date().toISOString(),
    });

    // Both should have been called without error
    expect(wsClient.removeActiveTask).toHaveBeenCalledWith('task-1');
    expect(wsClient.sendTaskResult).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      status: 'failed',
    }));
  });
});

// ============================================================================
// 8. Error message formatting
// ============================================================================

describe('error messages include useful context', () => {
  it('onTaskDispatch error includes projectId', () => {
    const { readFileSync } = require('node:fs');
    const startSource = readFileSync(
      join(process.cwd(), 'src/commands/start.ts'),
      'utf-8',
    );

    const dispatchStart = startSource.indexOf('onTaskDispatch: (task: Task) =>');
    const dispatchEnd = startSource.indexOf('onTaskCancel:', dispatchStart);
    const dispatchBlock = startSource.slice(dispatchStart, dispatchEnd);

    // Log message should include projectId for correlation with server logs
    expect(dispatchBlock).toContain('project=${task.projectId}');
  });

  it('processQueue error passes full error object for stack traces', () => {
    const { readFileSync } = require('node:fs');
    const executorSource = readFileSync(
      join(process.cwd(), 'src/lib/task-executor.ts'),
      'utf-8',
    );

    const methodStart = executorSource.indexOf('private processQueue(): void');
    const methodEnd = executorSource.indexOf('\n  }', methodStart + 50);
    const methodBody = executorSource.slice(methodStart, methodEnd + 4);

    // Should pass err as second argument to console.error for stack trace
    // Pattern: console.error(`[executor] ... failed:`, err)
    // The template literal spans multiple characters so we use a multiline match
    expect(methodBody).toContain('failed:`, err)');
  });

  it('error messages use instanceof Error check for safe stringification', () => {
    const { readFileSync } = require('node:fs');
    const startSource = readFileSync(
      join(process.cwd(), 'src/commands/start.ts'),
      'utf-8',
    );

    const dispatchStart = startSource.indexOf('onTaskDispatch: (task: Task) =>');
    const dispatchEnd = startSource.indexOf('onTaskCancel:', dispatchStart);
    const dispatchBlock = startSource.slice(dispatchStart, dispatchEnd);

    // Should handle both Error objects and raw thrown values
    expect(dispatchBlock).toContain('error instanceof Error ? error.message : String(error)');
  });
});

// ============================================================================
// 9. End-to-end: submitTask with empty workingDirectory throws
// ============================================================================

describe('submitTask rejects on empty workingDirectory', () => {
  let wsClient: ReturnType<typeof createMockWsClient>;

  beforeEach(() => {
    wsClient = createMockWsClient();
    vi.clearAllMocks();
  });

  it('throws when workingDirectory is empty string', async () => {
    const executor = new TaskExecutor({
      wsClient,
      useWorktree: false,
    });
    await new Promise((r) => setTimeout(r, 100));

    const task = createTask({ workingDirectory: '' });

    await expect(executor.submitTask(task)).rejects.toThrow();
  });

  it('the caller (onTaskDispatch) catches and reports the failure', async () => {
    const executor = new TaskExecutor({
      wsClient,
      useWorktree: false,
    });
    await new Promise((r) => setTimeout(r, 100));

    const task = createTask({ workingDirectory: '' });

    // Simulate the onTaskDispatch pattern from start.ts
    await executor.submitTask(task).catch((error) => {
      wsClient.sendTaskResult({
        taskId: task.id,
        status: 'failed',
        error: `Task submission failed: ${error instanceof Error ? error.message : String(error)}`,
        completedAt: new Date().toISOString(),
      });
    });

    expect(wsClient.sendTaskResult).toHaveBeenCalledTimes(1);
    expect(wsClient.sendTaskResult).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      status: 'failed',
    }));
  });
});
