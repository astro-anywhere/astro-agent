/**
 * Idle timeout tests.
 *
 * Verifies the two-tier timeout system in task-executor.ts:
 * 1. Idle timeout fires when no stream activity occurs
 * 2. Idle timeout resets on stream activity
 * 3. Hard cap timeout fires regardless of activity
 * 4. Approval requests pause idle timeout
 * 5. task.timeout overrides hard cap per-task
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  isGhAvailable: vi.fn().mockResolvedValue(false),
}));

// Mock provider — execute fn is replaced per test
const mockExecute = vi.fn();
vi.mock('../src/providers/index.js', () => ({
  createProviderAdapter: vi.fn().mockReturnValue({
    name: 'mock-adapter',
    type: 'claude-sdk',
    isAvailable: vi.fn().mockResolvedValue(true),
    execute: (...args: unknown[]) => mockExecute(...args),
    resumeTask: vi.fn(),
  }),
}));

import { TaskExecutor } from '../src/lib/task-executor.js';
import type { Task } from '../src/types.js';
import type { WebSocketClient } from '../src/lib/websocket-client.js';

// ============================================================================
// Helpers
// ============================================================================

const tmpDirs: string[] = [];

function createGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'idle-timeout-test-'));
  tmpDirs.push(dir);
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
    try { await rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
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
    sendApprovalRequest: vi.fn().mockResolvedValue({ answered: true, answer: 'yes' }),
    addActiveTask: vi.fn(),
    removeActiveTask: vi.fn(),
  } as unknown as WebSocketClient;
}

function createTask(workDir: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'proj-test-1',
    planNodeId: 'node-1',
    provider: 'claude-sdk',
    prompt: 'Do something',
    workingDirectory: workDir,
    createdAt: new Date().toISOString(),
    skipSafetyCheck: true,
    ...overrides,
  } as Task;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getResult(wsClient: ReturnType<typeof createMockWsClient>, taskId: string) {
  const call = (wsClient.sendTaskResult as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: unknown[]) => (c[0] as { taskId: string }).taskId === taskId
  );
  return call ? (call[0] as { taskId: string; status: string; error?: string }) : undefined;
}

// ============================================================================
// Tests
// ============================================================================

describe('idle timeout', () => {
  it('fires when no stream activity occurs within the idle period', async () => {
    const workDir = createGitRepo();
    const wsClient = createMockWsClient();
    const executor = new TaskExecutor({
      wsClient: wsClient as unknown as WebSocketClient,
      defaultIdleTimeout: 300,   // 300ms idle
      defaultTimeout: 30_000,    // 30s hard cap (won't interfere)
      useWorktree: false,
    });

    // Execute hangs silently — no stream events, waits for abort
    mockExecute.mockImplementation((_task: Task, _stream: unknown, signal: AbortSignal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({
          taskId: _task.id, status: 'cancelled', error: 'Task cancelled',
          startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        }));
      })
    );

    const task = createTask(workDir);
    // submitTask with skipSafetyCheck goes straight to executeTask (async, doesn't block)
    await executor.submitTask(task);

    // Wait for idle timeout to fire (~300ms + buffer)
    await sleep(700);

    const result = getResult(wsClient, task.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe('cancelled');
  }, 10000);

  it('resets on stream activity, preventing premature abort', async () => {
    const workDir = createGitRepo();
    const wsClient = createMockWsClient();
    const executor = new TaskExecutor({
      wsClient: wsClient as unknown as WebSocketClient,
      defaultIdleTimeout: 400,   // 400ms idle
      defaultTimeout: 30_000,
      useWorktree: false,
    });

    // Execute emits text every 200ms for 5 rounds, then completes
    mockExecute.mockImplementation(async (_task: Task, stream: { text: (s: string) => void }) => {
      for (let i = 0; i < 5; i++) {
        await sleep(200); // Always less than 400ms idle timeout
        stream.text(`chunk ${i}`);
      }
      return {
        taskId: _task.id, status: 'completed', output: 'done',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      };
    });

    const task = createTask(workDir);
    await executor.submitTask(task);

    // Total execution: ~1000ms (5 × 200ms), but idle never exceeds 400ms
    await sleep(1500);

    const result = getResult(wsClient, task.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe('completed');
  }, 10000);

  it('hard cap fires regardless of stream activity', async () => {
    const workDir = createGitRepo();
    const wsClient = createMockWsClient();
    const executor = new TaskExecutor({
      wsClient: wsClient as unknown as WebSocketClient,
      defaultIdleTimeout: 30_000, // idle won't interfere
      defaultTimeout: 500,        // 500ms hard cap
      useWorktree: false,
    });

    // Execute emits text continuously but never finishes
    mockExecute.mockImplementation((_task: Task, stream: { text: (s: string) => void }, signal: AbortSignal) =>
      new Promise((resolve) => {
        const interval = setInterval(() => stream.text('alive'), 50);
        signal.addEventListener('abort', () => {
          clearInterval(interval);
          resolve({
            taskId: _task.id, status: 'cancelled', error: 'Task cancelled',
            startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          });
        });
      })
    );

    const task = createTask(workDir);
    await executor.submitTask(task);

    // Wait for hard cap to fire
    await sleep(900);

    const result = getResult(wsClient, task.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe('cancelled');
  }, 10000);

  it('pauses idle timeout during approval waits', async () => {
    const workDir = createGitRepo();
    const wsClient = createMockWsClient();
    const executor = new TaskExecutor({
      wsClient: wsClient as unknown as WebSocketClient,
      defaultIdleTimeout: 200,   // very short idle
      defaultTimeout: 30_000,
      useWorktree: false,
    });

    // Mock approval to resolve after 600ms (well past idle timeout)
    (wsClient.sendApprovalRequest as ReturnType<typeof vi.fn>).mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve({ answered: true, answer: 'yes' }), 600))
    );

    // Execute: emit text, then request approval (which takes 600ms), then complete
    mockExecute.mockImplementation(async (_task: Task, stream: { text: (s: string) => void; approvalRequest: (q: string, o: string[]) => Promise<unknown> }) => {
      stream.text('working...');
      await stream.approvalRequest('Allow?', ['yes', 'no']);
      return {
        taskId: _task.id, status: 'completed', output: 'approved',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      };
    });

    const task = createTask(workDir);
    await executor.submitTask(task);

    // Wait for approval + completion (600ms approval + buffer)
    await sleep(1200);

    const result = getResult(wsClient, task.id);
    expect(result).toBeDefined();
    // Should be completed, NOT cancelled — idle timer was paused during approval
    expect(result!.status).toBe('completed');
  }, 10000);

  it('task.timeout overrides hard cap per-task', async () => {
    const workDir = createGitRepo();
    const wsClient = createMockWsClient();
    const executor = new TaskExecutor({
      wsClient: wsClient as unknown as WebSocketClient,
      defaultIdleTimeout: 30_000,
      defaultTimeout: 30_000,    // default hard cap (won't interfere)
      useWorktree: false,
    });

    // Execute hangs forever
    mockExecute.mockImplementation((_task: Task, _stream: unknown, signal: AbortSignal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({
          taskId: _task.id, status: 'cancelled', error: 'Task cancelled',
          startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        }));
      })
    );

    // Per-task timeout override: 300ms
    const task = createTask(workDir, { timeout: 300 });
    await executor.submitTask(task);

    await sleep(700);

    const result = getResult(wsClient, task.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe('cancelled');
  }, 10000);
});
