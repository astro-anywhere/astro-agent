/**
 * Integration tests for BranchLockManager with real git repos.
 *
 * Verifies that two tasks sharing the same project ID serialize correctly
 * (one completes before the other starts), while tasks with different
 * project IDs run in parallel.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock worktree-include and worktree-setup (they depend on project-specific
// config files that won't exist in our ephemeral test repos).
vi.mock('../src/lib/worktree-include.js', () => ({
  applyWorktreeInclude: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/worktree-setup.js', () => ({
  runSetupScript: vi.fn().mockResolvedValue(undefined),
}));

import { createWorktree } from '../../src/lib/worktree.js';
import { BranchLockManager } from '../../src/lib/branch-lock.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function createTestGitRepo(): { repoDir: string; bareDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), 'astro-bl-test-repo-'));
  const bareDir = mkdtempSync(join(tmpdir(), 'astro-bl-test-bare-'));
  tmpDirs.push(repoDir, bareDir);

  execFileSync('git', ['init', '--bare', '--initial-branch=main'], { cwd: bareDir });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir });

  writeFileSync(join(repoDir, 'hello.txt'), 'hello world\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir });

  return { repoDir, bareDir };
}

afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BranchLockManager integration with real git worktrees', () => {
  it('should serialize two tasks sharing the same branch', async () => {
    const { repoDir } = createTestGitRepo();
    const manager = new BranchLockManager();

    const shortProjectId = 'aabbcc';
    const shortNodeId = 'ddeeff';
    const lockKey = BranchLockManager.computeLockKey(repoDir, shortProjectId, shortNodeId);

    const timeline: string[] = [];

    // Task 1 acquires the lock and creates a worktree
    const h1 = await manager.acquire(lockKey, 'task-1');
    timeline.push('task-1-locked');

    const wt1 = await createWorktree({
      workingDirectory: repoDir,
      taskId: 'task-1',
      shortProjectId,
      shortNodeId,
    });
    expect(wt1).not.toBeNull();
    timeline.push('task-1-worktree-created');

    // Task 2 tries to acquire — should queue
    let task2Resolved = false;
    const p2 = manager.acquire(lockKey, 'task-2').then((handle) => {
      task2Resolved = true;
      timeline.push('task-2-locked');
      return handle;
    });

    // Give microtask queue a chance to run
    await new Promise((r) => setTimeout(r, 10));
    expect(task2Resolved).toBe(false);
    expect(manager.getQueueLength(lockKey)).toBe(1);

    // Task 1 cleans up and releases
    await wt1!.cleanup();
    timeline.push('task-1-cleanup');
    h1.release();
    timeline.push('task-1-released');

    // Task 2 should now acquire
    const h2 = await p2;
    expect(task2Resolved).toBe(true);

    // Task 2 can now create a worktree with the same branch name
    const wt2 = await createWorktree({
      workingDirectory: repoDir,
      taskId: 'task-2',
      shortProjectId,
      shortNodeId,
    });
    expect(wt2).not.toBeNull();
    timeline.push('task-2-worktree-created');

    await wt2!.cleanup();
    h2.release();

    // Verify ordering: task-1 completed before task-2 started
    expect(timeline).toEqual([
      'task-1-locked',
      'task-1-worktree-created',
      'task-1-cleanup',
      'task-1-released',
      'task-2-locked',
      'task-2-worktree-created',
    ]);
  });

  it('should allow parallel execution for different projects', async () => {
    // Use separate repos to avoid git's internal .git/config lock contention
    // (concurrent `git worktree add` on the same repo races on that lock).
    // In practice, different projects typically live in different repos.
    const repoA = createTestGitRepo();
    const repoB = createTestGitRepo();
    const manager = new BranchLockManager();

    const keyA = BranchLockManager.computeLockKey(repoA.repoDir, 'proj-a', 'node-a');
    const keyB = BranchLockManager.computeLockKey(repoB.repoDir, 'proj-b', 'node-b');

    // Both should acquire immediately (different keys)
    const hA = await manager.acquire(keyA, 'task-a');
    const hB = await manager.acquire(keyB, 'task-b');

    expect(manager.isLocked(keyA)).toBe(true);
    expect(manager.isLocked(keyB)).toBe(true);

    // Both create worktrees concurrently in separate repos
    const [wtA, wtB] = await Promise.all([
      createWorktree({
        workingDirectory: repoA.repoDir,
        taskId: 'task-a',
        shortProjectId: 'proj-a',
        shortNodeId: 'node-a',
      }),
      createWorktree({
        workingDirectory: repoB.repoDir,
        taskId: 'task-b',
        shortProjectId: 'proj-b',
        shortNodeId: 'node-b',
      }),
    ]);

    expect(wtA).not.toBeNull();
    expect(wtB).not.toBeNull();
    // Branch names should be different
    expect(wtA!.branchName).not.toBe(wtB!.branchName);

    await wtA!.cleanup();
    await wtB!.cleanup();
    hA.release();
    hB.release();
  });
});
