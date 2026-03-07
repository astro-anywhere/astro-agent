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

import { localMergeIntoProjectBranch } from '../../src/lib/local-merge.js';
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
    const projectBranch = 'astro/parallel1';

    // Create project branch
    git(repo, 'branch', projectBranch, 'main');
    const initialTip = git(repo, 'rev-parse', projectBranch);

    // Simulate parallel execution: both tasks branch from the SAME project branch tip
    // (this is what happens when execution-wide lock is removed)
    git(repo, 'checkout', '-b', 'astro/parallel1-n1', projectBranch);
    writeFileSync(join(repo, 'file-a.txt'), 'task 1 content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 1: add file-a');
    git(repo, 'checkout', 'main');

    git(repo, 'checkout', '-b', 'astro/parallel1-n2', projectBranch);
    writeFileSync(join(repo, 'file-b.txt'), 'task 2 content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 2: add file-b');
    git(repo, 'checkout', 'main');

    // Both branched from the same tip — project branch hasn't moved yet
    expect(git(repo, 'rev-parse', projectBranch)).toBe(initialTip);

    // Merge task 1 (acquires merge lock, merges, releases)
    const manager = new BranchLockManager();
    const lockKey = BranchLockManager.computeLockKey(repo, 'parallel1');

    const lock1 = await manager.acquire(lockKey, 'task-1');
    const r1 = await localMergeIntoProjectBranch(
      repo, 'astro/parallel1-n1', projectBranch, 'Task 1',
    );
    lock1.release();

    expect(r1.merged).toBe(true);
    const tipAfterTask1 = git(repo, 'rev-parse', projectBranch);
    expect(tipAfterTask1).not.toBe(initialTip); // Project branch moved

    // Merge task 2 — project branch has moved (task 1 merged), but task 2
    // branched from the original tip. The squash merge should handle this
    // naturally because it computes diff from merge-base.
    const lock2 = await manager.acquire(lockKey, 'task-2');
    const r2 = await localMergeIntoProjectBranch(
      repo, 'astro/parallel1-n2', projectBranch, 'Task 2',
    );
    lock2.release();

    expect(r2.merged).toBe(true);
    const tipAfterTask2 = git(repo, 'rev-parse', projectBranch);
    expect(tipAfterTask2).not.toBe(tipAfterTask1); // Moved again

    // Project branch should have BOTH files
    const projectFiles = git(repo, 'ls-tree', '--name-only', projectBranch);
    expect(projectFiles).toContain('file-a.txt');
    expect(projectFiles).toContain('file-b.txt');
    expect(projectFiles).toContain('readme.txt');

    // 3 commits: initial + task1 squash + task2 squash
    const logCount = git(repo, 'rev-list', '--count', projectBranch);
    expect(parseInt(logCount)).toBe(3);
  });

  it('parallel tasks with conflicting changes: second merge fails', async () => {
    const repo = createLocalRepo();
    const projectBranch = 'astro/conflict1';

    git(repo, 'branch', projectBranch, 'main');

    // Both tasks branch from the same tip and modify the SAME file
    git(repo, 'checkout', '-b', 'astro/conflict1-n1', projectBranch);
    writeFileSync(join(repo, 'readme.txt'), 'task 1 version of readme\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 1: modify readme');
    git(repo, 'checkout', 'main');

    git(repo, 'checkout', '-b', 'astro/conflict1-n2', projectBranch);
    writeFileSync(join(repo, 'readme.txt'), 'task 2 conflicting version\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 2: modify readme differently');
    git(repo, 'checkout', 'main');

    // Task 1 merges first — succeeds
    const r1 = await localMergeIntoProjectBranch(
      repo, 'astro/conflict1-n1', projectBranch, 'Task 1',
    );
    expect(r1.merged).toBe(true);

    // Task 2 tries to merge — project branch now has task 1's version of readme.txt
    // Task 2's version conflicts with it
    const r2 = await localMergeIntoProjectBranch(
      repo, 'astro/conflict1-n2', projectBranch, 'Task 2',
    );
    expect(r2.merged).toBe(false);
    expect(r2.conflict).toBe(true);
    expect(r2.conflictFiles).toContain('readme.txt');

    // Project branch should still have task 1's content (not corrupted)
    const content = git(repo, 'show', `${projectBranch}:readme.txt`);
    expect(content).toBe('task 1 version of readme');

    // Repo should be clean (no leftover merge state)
    const status = git(repo, 'status', '--porcelain');
    expect(status).toBe('');
  });

  it('merge lock serializes concurrent merge attempts', async () => {
    const repo = createLocalRepo();
    const projectBranch = 'astro/serial1';
    git(repo, 'branch', projectBranch, 'main');

    // Create two task branches with non-overlapping changes
    git(repo, 'checkout', '-b', 'astro/serial1-n1', projectBranch);
    writeFileSync(join(repo, 'alpha.txt'), 'alpha\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add alpha');
    git(repo, 'checkout', 'main');

    git(repo, 'checkout', '-b', 'astro/serial1-n2', projectBranch);
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
    const r1 = await localMergeIntoProjectBranch(
      repo, 'astro/serial1-n1', projectBranch, 'Task 1',
    );
    expect(r1.merged).toBe(true);
    timeline.push('merge1-done');
    lock1.release();
    timeline.push('lock1-released');

    // Task 2 should now acquire
    const lock2 = await p2;
    expect(lock2Resolved).toBe(true);

    const r2 = await localMergeIntoProjectBranch(
      repo, 'astro/serial1-n2', projectBranch, 'Task 2',
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
    const files = git(repo, 'ls-tree', '--name-only', projectBranch);
    expect(files).toContain('alpha.txt');
    expect(files).toContain('beta.txt');
  });

  it('three parallel tasks accumulate correctly', async () => {
    const repo = createLocalRepo();
    const projectBranch = 'astro/triple1';
    git(repo, 'branch', projectBranch, 'main');

    // All three tasks branch from the same initial tip
    for (const [name, file, content] of [
      ['n1', 'one.txt', 'first'],
      ['n2', 'two.txt', 'second'],
      ['n3', 'three.txt', 'third'],
    ] as const) {
      git(repo, 'checkout', '-b', `astro/triple1-${name}`, projectBranch);
      writeFileSync(join(repo, file), `${content}\n`);
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', `Add ${file}`);
      git(repo, 'checkout', 'main');
    }

    // Merge all three sequentially (simulating merge lock serialization)
    for (const name of ['n1', 'n2', 'n3']) {
      const r = await localMergeIntoProjectBranch(
        repo, `astro/triple1-${name}`, projectBranch, `Task ${name}`,
      );
      expect(r.merged).toBe(true);
    }

    // All files present
    const files = git(repo, 'ls-tree', '--name-only', projectBranch);
    expect(files).toContain('one.txt');
    expect(files).toContain('two.txt');
    expect(files).toContain('three.txt');
    expect(files).toContain('readme.txt');

    // 4 commits: initial + 3 squash merges
    const logCount = git(repo, 'rev-list', '--count', projectBranch);
    expect(parseInt(logCount)).toBe(4);
  });
});
