/**
 * Integration tests for parallel task execution with merge-only lock.
 *
 * Verifies that tasks execute in parallel (not blocked during execution)
 * and serialize only at merge time. Tests the core behavior change from
 * execution-wide locking to merge-only locking.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/lib/worktree-include.js', () => ({
  applyWorktreeInclude: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/lib/worktree-setup.js', () => ({
  runSetupScript: vi.fn().mockResolvedValue(undefined),
}));

import { localMergeIntoDeliveryBranch } from '../../src/lib/local-merge.js';
import { createWorktree } from '../../src/lib/worktree.js';
import { BranchLockManager } from '../../src/lib/branch-lock.js';

const tmpDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function createLocalRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'astro-parallel-test-'));
  tmpDirs.push(dir);
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'test@test.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'readme.txt'), 'initial content\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial commit');
  return dir;
}

afterAll(async () => {
  for (const dir of tmpDirs) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});

describe('Parallel execution with merge-only lock (real git)', { timeout: 30_000 }, () => {
  it('two parallel tasks with non-overlapping changes both merge successfully', async () => {
    const repo = createLocalRepo();
    const deliveryBranch = 'astro/parallel1';

    // Create delivery branch
    git(repo, 'branch', deliveryBranch, 'main');
    const initialTip = git(repo, 'rev-parse', deliveryBranch);

    // Simulate parallel execution: both tasks branch from the SAME delivery branch tip
    // (this is what happens when execution-wide lock is removed)
    git(repo, 'checkout', '-b', 'astro/parallel1-n1', deliveryBranch);
    writeFileSync(join(repo, 'file-a.txt'), 'task 1 content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 1: add file-a');
    git(repo, 'checkout', 'main');

    git(repo, 'checkout', '-b', 'astro/parallel1-n2', deliveryBranch);
    writeFileSync(join(repo, 'file-b.txt'), 'task 2 content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 2: add file-b');
    git(repo, 'checkout', 'main');

    // Both branched from the same tip — delivery branch hasn't moved yet
    expect(git(repo, 'rev-parse', deliveryBranch)).toBe(initialTip);

    // Merge task 1 (acquires merge lock, merges, releases)
    const manager = new BranchLockManager();
    const lockKey = BranchLockManager.computeLockKey(repo, 'parallel1');

    const lock1 = await manager.acquire(lockKey, 'task-1');
    const r1 = await localMergeIntoDeliveryBranch(
      repo, 'astro/parallel1-n1', deliveryBranch, 'Task 1',
    );
    lock1.release();

    expect(r1.merged).toBe(true);
    const tipAfterTask1 = git(repo, 'rev-parse', deliveryBranch);
    expect(tipAfterTask1).not.toBe(initialTip); // Project branch moved

    // Merge task 2 — delivery branch has moved (task 1 merged), but task 2
    // branched from the original tip. The squash merge should handle this
    // naturally because it computes diff from merge-base.
    const lock2 = await manager.acquire(lockKey, 'task-2');
    const r2 = await localMergeIntoDeliveryBranch(
      repo, 'astro/parallel1-n2', deliveryBranch, 'Task 2',
    );
    lock2.release();

    expect(r2.merged).toBe(true);
    const tipAfterTask2 = git(repo, 'rev-parse', deliveryBranch);
    expect(tipAfterTask2).not.toBe(tipAfterTask1); // Moved again

    // Project branch should have BOTH files
    const projectFiles = git(repo, 'ls-tree', '--name-only', deliveryBranch);
    expect(projectFiles).toContain('file-a.txt');
    expect(projectFiles).toContain('file-b.txt');
    expect(projectFiles).toContain('readme.txt');

    // 3 commits: initial + task1 squash + task2 squash
    const logCount = git(repo, 'rev-list', '--count', deliveryBranch);
    expect(parseInt(logCount)).toBe(3);
  });

  it('parallel tasks with conflicting changes: second merge fails', async () => {
    const repo = createLocalRepo();
    const deliveryBranch = 'astro/conflict1';

    git(repo, 'branch', deliveryBranch, 'main');

    // Both tasks branch from the same tip and modify the SAME file
    git(repo, 'checkout', '-b', 'astro/conflict1-n1', deliveryBranch);
    writeFileSync(join(repo, 'readme.txt'), 'task 1 version of readme\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 1: modify readme');
    git(repo, 'checkout', 'main');

    git(repo, 'checkout', '-b', 'astro/conflict1-n2', deliveryBranch);
    writeFileSync(join(repo, 'readme.txt'), 'task 2 conflicting version\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 2: modify readme differently');
    git(repo, 'checkout', 'main');

    // Task 1 merges first — succeeds
    const r1 = await localMergeIntoDeliveryBranch(
      repo, 'astro/conflict1-n1', deliveryBranch, 'Task 1',
    );
    expect(r1.merged).toBe(true);

    // Task 2 tries to merge — delivery branch now has task 1's version of readme.txt
    // Task 2's version conflicts with it
    const r2 = await localMergeIntoDeliveryBranch(
      repo, 'astro/conflict1-n2', deliveryBranch, 'Task 2',
    );
    expect(r2.merged).toBe(false);
    expect(r2.conflict).toBe(true);
    expect(r2.conflictFiles).toContain('readme.txt');

    // Project branch should still have task 1's content (not corrupted)
    const content = git(repo, 'show', `${deliveryBranch}:readme.txt`);
    expect(content).toBe('task 1 version of readme');

    // Repo should be clean (no leftover merge state)
    const status = git(repo, 'status', '--porcelain');
    expect(status).toBe('');
  });

  it('merge lock serializes concurrent merge attempts', async () => {
    const repo = createLocalRepo();
    const deliveryBranch = 'astro/serial1';
    git(repo, 'branch', deliveryBranch, 'main');

    // Create two task branches with non-overlapping changes
    git(repo, 'checkout', '-b', 'astro/serial1-n1', deliveryBranch);
    writeFileSync(join(repo, 'alpha.txt'), 'alpha\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add alpha');
    git(repo, 'checkout', 'main');

    git(repo, 'checkout', '-b', 'astro/serial1-n2', deliveryBranch);
    writeFileSync(join(repo, 'beta.txt'), 'beta\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add beta');
    git(repo, 'checkout', 'main');

    const manager = new BranchLockManager();
    const lockKey = BranchLockManager.computeLockKey(repo, 'serial1');
    const timeline: string[] = [];

    // Task 1 acquires lock
    const lock1 = await manager.acquire(lockKey, 'task-1');
    timeline.push('lock1-acquired');

    // Task 2 tries to acquire — should queue
    let lock2Resolved = false;
    const p2 = manager.acquire(lockKey, 'task-2').then((handle) => {
      lock2Resolved = true;
      timeline.push('lock2-acquired');
      return handle;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(lock2Resolved).toBe(false);
    expect(manager.getQueueLength(lockKey)).toBe(1);

    // Task 1 merges and releases
    const r1 = await localMergeIntoDeliveryBranch(
      repo, 'astro/serial1-n1', deliveryBranch, 'Task 1',
    );
    expect(r1.merged).toBe(true);
    timeline.push('merge1-done');
    lock1.release();
    timeline.push('lock1-released');

    // Task 2 should now acquire
    const lock2 = await p2;
    expect(lock2Resolved).toBe(true);

    const r2 = await localMergeIntoDeliveryBranch(
      repo, 'astro/serial1-n2', deliveryBranch, 'Task 2',
    );
    expect(r2.merged).toBe(true);
    timeline.push('merge2-done');
    lock2.release();

    // Verify ordering: merge1 completed before merge2 started
    expect(timeline).toEqual([
      'lock1-acquired',
      'merge1-done',
      'lock1-released',
      'lock2-acquired',
      'merge2-done',
    ]);

    // Both files present
    const files = git(repo, 'ls-tree', '--name-only', deliveryBranch);
    expect(files).toContain('alpha.txt');
    expect(files).toContain('beta.txt');
  });

  it('three parallel tasks accumulate correctly', async () => {
    const repo = createLocalRepo();
    const deliveryBranch = 'astro/triple1';
    git(repo, 'branch', deliveryBranch, 'main');

    // All three tasks branch from the same initial tip
    for (const [name, file, content] of [
      ['n1', 'one.txt', 'first'],
      ['n2', 'two.txt', 'second'],
      ['n3', 'three.txt', 'third'],
    ] as const) {
      git(repo, 'checkout', '-b', `astro/triple1-${name}`, deliveryBranch);
      writeFileSync(join(repo, file), `${content}\n`);
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', `Add ${file}`);
      git(repo, 'checkout', 'main');
    }

    // Merge all three sequentially (simulating merge lock serialization)
    for (const name of ['n1', 'n2', 'n3']) {
      const r = await localMergeIntoDeliveryBranch(
        repo, `astro/triple1-${name}`, deliveryBranch, `Task ${name}`,
      );
      expect(r.merged).toBe(true);
    }

    // All files present
    const files = git(repo, 'ls-tree', '--name-only', deliveryBranch);
    expect(files).toContain('one.txt');
    expect(files).toContain('two.txt');
    expect(files).toContain('three.txt');
    expect(files).toContain('readme.txt');

    // 4 commits: initial + 3 squash merges
    const logCount = git(repo, 'rev-list', '--count', deliveryBranch);
    expect(parseInt(logCount)).toBe(4);
  });

  it('parallel worktree creation handles ensureDeliveryBranch race (local mode)', async () => {
    const repo = createLocalRepo();
    const shortProjectId = 'race01';

    // Both tasks create worktrees concurrently. The first call to createWorktree
    // will trigger ensureDeliveryBranch() which creates the delivery branch.
    // The second call races — ensureDeliveryBranch() must handle "already exists"
    // gracefully and not throw.
    const [wt1, wt2] = await Promise.all([
      createWorktree({
        workingDirectory: repo,
        taskId: 'race-task-1',
        shortProjectId,
        shortNodeId: 'n1',
        deliveryBranch: `astro/${shortProjectId}`,
      }),
      createWorktree({
        workingDirectory: repo,
        taskId: 'race-task-2',
        shortProjectId,
        shortNodeId: 'n2',
        deliveryBranch: `astro/${shortProjectId}`,
      }),
    ]);

    // Both worktrees should have been created successfully
    expect(wt1).not.toBeNull();
    expect(wt2).not.toBeNull();
    expect(wt1!.branchName).toContain('n1');
    expect(wt2!.branchName).toContain('n2');

    // The delivery branch should exist
    const branches = git(repo, 'branch', '--list', `astro/${shortProjectId}`);
    expect(branches.trim()).toContain(`astro/${shortProjectId}`);

    // Both worktrees branched from the same delivery branch
    expect(wt1!.deliveryBranch).toBe(`astro/${shortProjectId}`);
    expect(wt2!.deliveryBranch).toBe(`astro/${shortProjectId}`);

    // Cleanup
    await wt1!.cleanup();
    await wt2!.cleanup();
  });
});
