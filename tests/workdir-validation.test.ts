/**
 * Working directory validation tests.
 *
 * Verifies that submitTask() fails fast with a clear error when
 * the working directory does not exist, instead of entering the
 * execution pipeline and becoming a dead job.
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
  const dir = mkdtempSync(join(tmpdir(), 'workdir-validation-test-'));
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

function getResult(wsClient: ReturnType<typeof createMockWsClient>, taskId: string) {
  const call = (wsClient.sendTaskResult as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: unknown[]) => (c[0] as { taskId: string }).taskId === taskId
  );
  return call ? (call[0] as { taskId: string; status: string; error?: string }) : undefined;
}

// ============================================================================
// Tests
// ============================================================================

describe('working directory validation', () => {
  it('fails fast when working directory does not exist', async () => {
    const wsClient = createMockWsClient();
    const executor = new TaskExecutor({
      wsClient: wsClient as unknown as WebSocketClient,
      defaultIdleTimeout: 30_000,
      defaultTimeout: 30_000,
      useWorktree: false,
    });

    const task = createTask('/tmp/this-directory-does-not-exist-' + Date.now());
    await executor.submitTask(task);

    // Should fail immediately — no need to sleep
    const result = getResult(wsClient, task.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe('failed');
    expect(result!.error).toContain('Working directory does not exist');
  });

  it('fails fast with a descriptive error including the path', async () => {
    const wsClient = createMockWsClient();
    const executor = new TaskExecutor({
      wsClient: wsClient as unknown as WebSocketClient,
      useWorktree: false,
    });

    const badPath = '/tmp/nonexistent-path-' + Date.now();
    const task = createTask(badPath);
    await executor.submitTask(task);

    const result = getResult(wsClient, task.id);
    expect(result).toBeDefined();
    expect(result!.error).toContain(badPath);
  });

  it('calls removeActiveTask on directory validation failure', async () => {
    const wsClient = createMockWsClient();
    const executor = new TaskExecutor({
      wsClient: wsClient as unknown as WebSocketClient,
      useWorktree: false,
    });

    const task = createTask('/tmp/nonexistent-' + Date.now());
    await executor.submitTask(task);

    expect(wsClient.removeActiveTask).toHaveBeenCalledWith(task.id);
  });

  it('does not call the provider when directory does not exist', async () => {
    const wsClient = createMockWsClient();
    const executor = new TaskExecutor({
      wsClient: wsClient as unknown as WebSocketClient,
      useWorktree: false,
    });

    mockExecute.mockClear();
    const task = createTask('/tmp/nonexistent-' + Date.now());
    await executor.submitTask(task);

    // The mock provider should never have been called
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('succeeds when working directory exists', async () => {
    const workDir = createGitRepo();
    const wsClient = createMockWsClient();
    const executor = new TaskExecutor({
      wsClient: wsClient as unknown as WebSocketClient,
      defaultIdleTimeout: 500,
      defaultTimeout: 30_000,
      useWorktree: false,
    });

    mockExecute.mockImplementation(async (_task: Task) => ({
      taskId: _task.id,
      status: 'completed',
      output: 'done',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }));

    const task = createTask(workDir);
    await executor.submitTask(task);

    // Wait for async execution to complete
    await new Promise(r => setTimeout(r, 1500));

    const result = getResult(wsClient, task.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe('completed');
  }, 10000);

  it('skips directory validation for text-only tasks without workingDirectory', async () => {
    const wsClient = createMockWsClient();
    const executor = new TaskExecutor({
      wsClient: wsClient as unknown as WebSocketClient,
      defaultIdleTimeout: 500,
      defaultTimeout: 30_000,
      useWorktree: false,
    });

    mockExecute.mockImplementation(async (_task: Task) => ({
      taskId: _task.id,
      status: 'completed',
      output: 'summarized',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }));

    // Text-only task with no working directory — should NOT fail
    const task = createTask('', {
      type: 'summarize' as Task['type'],
      workingDirectory: undefined as unknown as string,
    });
    await executor.submitTask(task);

    await new Promise(r => setTimeout(r, 1500));

    const result = getResult(wsClient, task.id);
    expect(result).toBeDefined();
    // Should complete, not fail with "Working directory does not exist"
    expect(result!.status).toBe('completed');
  }, 10000);
});
