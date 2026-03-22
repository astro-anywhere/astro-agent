/**
 * Integration tests for persistent project-level worktree.
 *
 * These tests use REAL git repos in temporary directories — no mocking of
 * git or filesystem operations. Only worktree-include and worktree-setup
 * are mocked (they depend on astro config files that won't exist in test repos).
 *
 * Key invariant: the delivery worktree uses detached HEAD so that
 * localMergeIntoDeliveryBranch() can check out the delivery branch in a
 * temporary worktree without hitting "branch already checked out" errors.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock worktree-include and worktree-setup
vi.mock('../src/lib/worktree-include.js', () => ({
  applyWorktreeInclude: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/lib/worktree-setup.js', () => ({
  runSetupScript: vi.fn().mockResolvedValue(undefined),
}));

import {
  createWorktree,
  createDeliveryWorktree,
  syncDeliveryWorktree,
  cleanupDeliveryWorktree,
} from '../../src/lib/worktree.js';
import { localMergeIntoDeliveryBranch } from '../../src/lib/local-merge.js';

const tmpDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

/** Create a local-only git repo with one commit on `main`. */
function createLocalRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'astro-pwt-test-')));
  tmpDirs.push(dir);
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'test@test.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'readme.txt'), 'initial content\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial commit');
  return dir;
}

/** Create a repo with a bare remote. */
function createRepoWithRemote(): { repoDir: string; bareDir: string } {
  const bareDir = realpathSync(mkdtempSync(join(tmpdir(), 'astro-pwt-bare-')));
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'astro-pwt-repo-')));
  tmpDirs.push(bareDir, repoDir);
  git(bareDir, 'init', '--bare', '--initial-branch=main');
  git(repoDir, 'init', '--initial-branch=main');
  git(repoDir, 'config', 'user.email', 'test@test.com');
  git(repoDir, 'config', 'user.name', 'Test');
  git(repoDir, 'remote', 'add', 'origin', bareDir);
  writeFileSync(join(repoDir, 'readme.txt'), 'initial content\n');
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-m', 'Initial commit');
  git(repoDir, 'push', '-u', 'origin', 'main');
  return { repoDir, bareDir };
}

function isDetached(cwd: string): boolean {
  try {
    git(cwd, 'symbolic-ref', '--short', 'HEAD');
    return false; // symbolic-ref succeeded → attached
  } catch {
    return true; // symbolic-ref failed → detached
  }
}

afterAll(async () => {
  for (const dir of tmpDirs) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});

// =============================================================================
// 1. createDeliveryWorktree — basic functionality
// =============================================================================

describe('createDeliveryWorktree (real git)', { timeout: 30_000 }, () => {
  it('creates a worktree at the expected path with detached HEAD', async () => {
    const repo = createLocalRepo();
    const deliveryBranch = 'astro/abc123';
    git(repo, 'branch', deliveryBranch, 'main');

    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });

    const result = await createDeliveryWorktree(repo, deliveryBranch, baseRoot, 'abc123');

    expect(result).not.toBeNull();
    expect(result).toBe(join(baseRoot, 'abc123'));
    expect(existsSync(result!)).toBe(true);

    // Files from the delivery branch should be present
    expect(readFileSync(join(result!, 'readme.txt'), 'utf-8')).toBe('initial content\n');

    // HEAD must be detached
    expect(isDetached(result!)).toBe(true);
  });

  it('is idempotent — second call returns existing path', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/def456', 'main');

    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });

    const first = await createDeliveryWorktree(repo, 'astro/def456', baseRoot, 'def456');
    const second = await createDeliveryWorktree(repo, 'astro/def456', baseRoot, 'def456');

    expect(first).toBe(second);
    expect(existsSync(first!)).toBe(true);
  });

  it('returns null when the start point does not exist', async () => {
    const repo = createLocalRepo();
    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });

    // No branch created — refs/heads/astro/ghost and origin/astro/ghost both missing
    const result = await createDeliveryWorktree(repo, 'astro/ghost', baseRoot, 'ghost');

    expect(result).toBeNull();
  });

  it('uses remote ref when local ref does not exist', async () => {
    const { repoDir } = createRepoWithRemote();
    const deliveryBranch = 'astro/remote1';

    // Create branch only on remote (push then delete local)
    git(repoDir, 'branch', deliveryBranch, 'main');
    git(repoDir, 'push', 'origin', deliveryBranch);
    git(repoDir, 'branch', '-D', deliveryBranch);

    const baseRoot = join(repoDir, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });

    const result = await createDeliveryWorktree(repoDir, deliveryBranch, baseRoot, 'remote1');

    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
    expect(isDetached(result!)).toBe(true);
  });
});

// =============================================================================
// 2. syncDeliveryWorktree — update after merge
// =============================================================================

describe('syncDeliveryWorktree (real git)', { timeout: 30_000 }, () => {
  it('updates the delivery worktree files after a branch merge', async () => {
    const repo = createLocalRepo();
    const deliveryBranch = 'astro/sync1';
    git(repo, 'branch', deliveryBranch, 'main');

    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });

    const wtPath = await createDeliveryWorktree(repo, deliveryBranch, baseRoot, 'sync1');
    expect(wtPath).not.toBeNull();

    // The delivery worktree should have the initial file
    expect(readFileSync(join(wtPath!, 'readme.txt'), 'utf-8')).toBe('initial content\n');

    // Create a task branch, add a file, and merge into the delivery branch
    git(repo, 'checkout', '-b', 'astro/sync1-task1', deliveryBranch);
    writeFileSync(join(repo, 'feature.txt'), 'new feature\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add feature');
    git(repo, 'checkout', 'main');

    const mergeResult = await localMergeIntoDeliveryBranch(
      repo,
      'astro/sync1-task1',
      deliveryBranch,
      'Squash: add feature',
    );
    expect(mergeResult.merged).toBe(true);

    // Before sync: delivery worktree still has old state
    expect(existsSync(join(wtPath!, 'feature.txt'))).toBe(false);

    // After sync: delivery worktree should reflect the merged changes
    await syncDeliveryWorktree(wtPath!, deliveryBranch, repo);

    expect(existsSync(join(wtPath!, 'feature.txt'))).toBe(true);
    expect(readFileSync(join(wtPath!, 'feature.txt'), 'utf-8')).toBe('new feature\n');

    // HEAD should still be detached after sync
    expect(isDetached(wtPath!)).toBe(true);
  });

  it('is a no-op when the worktree path does not exist', async () => {
    const repo = createLocalRepo();
    // Should not throw
    await syncDeliveryWorktree('/nonexistent/path', 'astro/nope', repo);
  });

  it('handles multiple sequential merges', async () => {
    const repo = createLocalRepo();
    const deliveryBranch = 'astro/multi';
    git(repo, 'branch', deliveryBranch, 'main');

    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });
    const wtPath = (await createDeliveryWorktree(repo, deliveryBranch, baseRoot, 'multi'))!;

    // Merge task 1
    git(repo, 'checkout', '-b', 'astro/multi-t1', deliveryBranch);
    writeFileSync(join(repo, 'file1.txt'), 'task1\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 1');
    git(repo, 'checkout', 'main');

    await localMergeIntoDeliveryBranch(repo, 'astro/multi-t1', deliveryBranch, 'Squash: task 1');
    await syncDeliveryWorktree(wtPath, deliveryBranch, repo);
    expect(readFileSync(join(wtPath, 'file1.txt'), 'utf-8')).toBe('task1\n');

    // Merge task 2 (branches from updated delivery branch)
    git(repo, 'checkout', '-b', 'astro/multi-t2', deliveryBranch);
    writeFileSync(join(repo, 'file2.txt'), 'task2\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 2');
    git(repo, 'checkout', 'main');

    await localMergeIntoDeliveryBranch(repo, 'astro/multi-t2', deliveryBranch, 'Squash: task 2');
    await syncDeliveryWorktree(wtPath, deliveryBranch, repo);

    // Both files should be present
    expect(readFileSync(join(wtPath, 'file1.txt'), 'utf-8')).toBe('task1\n');
    expect(readFileSync(join(wtPath, 'file2.txt'), 'utf-8')).toBe('task2\n');
    expect(isDetached(wtPath)).toBe(true);
  });
});

// =============================================================================
// 2b. syncDeliveryWorktree — remote mode (simulates PR merge on GitHub)
// =============================================================================

describe('syncDeliveryWorktree remote mode (real git)', { timeout: 30_000 }, () => {
  it('uses origin/ ref after fetch when remote is ahead (PR mode)', async () => {
    const { repoDir, bareDir } = createRepoWithRemote();
    const deliveryBranch = 'astro/prsync';

    // Create delivery branch and push to origin
    git(repoDir, 'branch', deliveryBranch, 'main');
    git(repoDir, 'push', 'origin', deliveryBranch);

    const baseRoot = join(repoDir, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });
    const wtPath = (await createDeliveryWorktree(repoDir, deliveryBranch, baseRoot, 'prsync'))!;

    // Simulate a PR merge on "GitHub" (the bare remote):
    // Clone the bare repo, make a commit on the delivery branch, push back.
    // This advances origin/{deliveryBranch} without touching refs/heads/ in repoDir.
    const cloneDir = realpathSync(mkdtempSync(join(tmpdir(), 'astro-pwt-clone-')));
    tmpDirs.push(cloneDir);
    git(cloneDir, 'clone', bareDir, '.');
    git(cloneDir, 'config', 'user.email', 'test@test.com');
    git(cloneDir, 'config', 'user.name', 'Test');
    git(cloneDir, 'checkout', deliveryBranch);
    writeFileSync(join(cloneDir, 'pr-merged.txt'), 'merged via PR\n');
    git(cloneDir, 'add', '.');
    git(cloneDir, 'commit', '-m', 'PR merge commit');
    git(cloneDir, 'push', 'origin', deliveryBranch);

    // At this point: origin/{deliveryBranch} is ahead, local refs/heads/ is stale
    // Verify the local ref is indeed stale
    const localSha = git(repoDir, 'rev-parse', `refs/heads/${deliveryBranch}`);
    git(repoDir, 'fetch', 'origin', deliveryBranch);
    const remoteSha = git(repoDir, 'rev-parse', `origin/${deliveryBranch}`);
    expect(localSha).not.toBe(remoteSha); // local is stale

    // Before sync: delivery worktree doesn't have the PR file
    expect(existsSync(join(wtPath, 'pr-merged.txt'))).toBe(false);

    // Sync — should fetch and checkout from origin/ (not stale refs/heads/)
    await syncDeliveryWorktree(wtPath, deliveryBranch, repoDir);

    // After sync: delivery worktree has the PR-merged file
    expect(existsSync(join(wtPath, 'pr-merged.txt'))).toBe(true);
    expect(readFileSync(join(wtPath, 'pr-merged.txt'), 'utf-8')).toBe('merged via PR\n');
    expect(isDetached(wtPath)).toBe(true);
  });
});

// =============================================================================
// 3. cleanupDeliveryWorktree
// =============================================================================

describe('cleanupDeliveryWorktree (real git)', { timeout: 30_000 }, () => {
  it('removes the worktree directory and prunes', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/cleanup1', 'main');

    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });
    const wtPath = (await createDeliveryWorktree(repo, 'astro/cleanup1', baseRoot, 'cleanup1'))!;
    expect(existsSync(wtPath)).toBe(true);

    await cleanupDeliveryWorktree(repo, wtPath);

    expect(existsSync(wtPath)).toBe(false);

    // git worktree list should not mention the removed path
    const wtList = git(repo, 'worktree', 'list', '--porcelain');
    expect(wtList).not.toContain('cleanup1');
  });

  it('is a no-op when directory does not exist', async () => {
    const repo = createLocalRepo();
    // Should not throw
    await cleanupDeliveryWorktree(repo, '/nonexistent/path');
  });
});

// =============================================================================
// 4. Detached HEAD constraint — core invariant
// =============================================================================

describe('detached HEAD allows concurrent merge worktrees', { timeout: 30_000 }, () => {
  it('localMergeIntoDeliveryBranch succeeds while delivery worktree exists', async () => {
    const repo = createLocalRepo();
    const deliveryBranch = 'astro/detach1';
    git(repo, 'branch', deliveryBranch, 'main');

    // Create the persistent delivery worktree (detached HEAD)
    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });
    const wtPath = await createDeliveryWorktree(repo, deliveryBranch, baseRoot, 'detach1');
    expect(wtPath).not.toBeNull();
    expect(isDetached(wtPath!)).toBe(true);

    // Create a task branch with changes
    git(repo, 'checkout', '-b', 'astro/detach1-task1', deliveryBranch);
    writeFileSync(join(repo, 'task-work.txt'), 'some work\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task work');
    git(repo, 'checkout', 'main');

    // This is the KEY test: localMergeIntoDeliveryBranch() creates a temporary
    // worktree that checks out the delivery branch. If the delivery worktree
    // held a regular branch checkout (not detached), this would fail with
    // "fatal: 'astro/detach1' is already checked out".
    const result = await localMergeIntoDeliveryBranch(
      repo,
      'astro/detach1-task1',
      deliveryBranch,
      'Squash: task work',
    );

    expect(result.merged).toBe(true);
    expect(result.commitSha).toBeDefined();

    // Sync and verify the delivery worktree has the merged file
    await syncDeliveryWorktree(wtPath!, deliveryBranch, repo);
    expect(readFileSync(join(wtPath!, 'task-work.txt'), 'utf-8')).toBe('some work\n');
  });

  it('multiple merges succeed with persistent delivery worktree', async () => {
    const repo = createLocalRepo();
    const deliveryBranch = 'astro/detach2';
    git(repo, 'branch', deliveryBranch, 'main');

    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });
    const wtPath = (await createDeliveryWorktree(repo, deliveryBranch, baseRoot, 'detach2'))!;

    // Merge two sequential tasks
    for (const taskNum of [1, 2]) {
      const taskBranch = `astro/detach2-t${taskNum}`;
      git(repo, 'checkout', '-b', taskBranch, deliveryBranch);
      writeFileSync(join(repo, `task${taskNum}.txt`), `task ${taskNum}\n`);
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', `Task ${taskNum}`);
      git(repo, 'checkout', 'main');

      const result = await localMergeIntoDeliveryBranch(
        repo, taskBranch, deliveryBranch, `Squash: task ${taskNum}`,
      );
      expect(result.merged).toBe(true);
      await syncDeliveryWorktree(wtPath, deliveryBranch, repo);
    }

    // Both files present in delivery worktree
    expect(readFileSync(join(wtPath, 'task1.txt'), 'utf-8')).toBe('task 1\n');
    expect(readFileSync(join(wtPath, 'task2.txt'), 'utf-8')).toBe('task 2\n');
    expect(isDetached(wtPath)).toBe(true);
  });
});

// =============================================================================
// 5. Integration with createWorktree()
// =============================================================================

describe('createWorktree() creates delivery worktree', { timeout: 30_000 }, () => {
  it('returns deliveryWorktreePath when shortProjectId is provided', async () => {
    const repo = createLocalRepo();

    const setup = await createWorktree({
      workingDirectory: repo,
      taskId: 'exec-abc123-n1-123',
      shortProjectId: 'abc123',
      shortNodeId: 'n1',
    });

    expect(setup).not.toBeNull();

    // Should have a delivery worktree path
    expect(setup!.deliveryWorktreePath).toBeDefined();
    expect(existsSync(setup!.deliveryWorktreePath!)).toBe(true);

    // Project worktree should be at .astro/worktrees/abc123
    expect(setup!.deliveryWorktreePath).toContain(join('.astro', 'worktrees', 'abc123'));

    // Project worktree uses detached HEAD
    expect(isDetached(setup!.deliveryWorktreePath!)).toBe(true);

    // Task worktree is separate (at .astro/worktrees/abc123-n1)
    expect(setup!.workingDirectory).toContain(join('.astro', 'worktrees', 'abc123-n1'));
    expect(setup!.workingDirectory).not.toBe(setup!.deliveryWorktreePath);

    // Both exist simultaneously
    expect(existsSync(setup!.workingDirectory)).toBe(true);
    expect(existsSync(setup!.deliveryWorktreePath!)).toBe(true);

    // After task cleanup, delivery worktree persists
    await setup!.cleanup();
    expect(existsSync(setup!.workingDirectory)).toBe(false);
    expect(existsSync(setup!.deliveryWorktreePath!)).toBe(true);
  });

  it('does not create delivery worktree when shortProjectId is missing', async () => {
    const repo = createLocalRepo();

    const setup = await createWorktree({
      workingDirectory: repo,
      taskId: 'plain-task-1',
    });

    expect(setup).not.toBeNull();
    expect(setup!.deliveryWorktreePath).toBeUndefined();

    await setup!.cleanup();
  });

  it('delivery worktree persists across multiple task worktree lifecycles', async () => {
    const repo = createLocalRepo();

    // First task
    const setup1 = await createWorktree({
      workingDirectory: repo,
      taskId: 'exec-xyz789-n1-001',
      shortProjectId: 'xyz789',
      shortNodeId: 'n1',
    });
    expect(setup1).not.toBeNull();
    const projectWtPath = setup1!.deliveryWorktreePath!;
    expect(existsSync(projectWtPath)).toBe(true);

    await setup1!.cleanup();
    expect(existsSync(projectWtPath)).toBe(true); // persists

    // Second task — delivery worktree already exists
    const setup2 = await createWorktree({
      workingDirectory: repo,
      taskId: 'exec-xyz789-n2-002',
      shortProjectId: 'xyz789',
      shortNodeId: 'n2',
    });
    expect(setup2).not.toBeNull();
    expect(setup2!.deliveryWorktreePath).toBe(projectWtPath); // same path

    await setup2!.cleanup();
    expect(existsSync(projectWtPath)).toBe(true); // still persists
  });
});

// =============================================================================
// 6. Full lifecycle: create → task → merge → sync → cleanup
// =============================================================================

describe('full delivery worktree lifecycle', { timeout: 30_000 }, () => {
  it('end-to-end: create worktree, merge task, sync, verify files', async () => {
    const repo = createLocalRepo();

    // Step 1: Create task worktree (also creates delivery worktree)
    const setup = await createWorktree({
      workingDirectory: repo,
      taskId: 'exec-e2e111-n1-001',
      shortProjectId: 'e2e111',
      shortNodeId: 'n1',
    });
    expect(setup).not.toBeNull();
    const projectWtPath = setup!.deliveryWorktreePath!;
    const deliveryBranch = setup!.deliveryBranch!;

    expect(existsSync(projectWtPath)).toBe(true);
    expect(deliveryBranch).toBe('astro/e2e111');

    // Step 2: Simulate agent work in the task worktree
    writeFileSync(join(setup!.workingDirectory, 'agent-output.txt'), 'hello from agent\n');
    git(setup!.workingDirectory, 'add', '.');
    git(setup!.workingDirectory, 'commit', '-m', 'Agent adds output');

    // Step 3: Merge task branch into delivery branch
    const mergeResult = await localMergeIntoDeliveryBranch(
      setup!.gitRoot,
      setup!.branchName,
      deliveryBranch,
      '[e2e111/n1] Agent output',
    );
    expect(mergeResult.merged).toBe(true);

    // Step 4: Sync delivery worktree
    await syncDeliveryWorktree(projectWtPath, deliveryBranch, setup!.gitRoot);

    // Verify: delivery worktree has the merged file
    expect(readFileSync(join(projectWtPath, 'agent-output.txt'), 'utf-8')).toBe('hello from agent\n');

    // Step 5: Cleanup task worktree — delivery worktree survives
    await setup!.cleanup();
    expect(existsSync(setup!.workingDirectory)).toBe(false);
    expect(existsSync(projectWtPath)).toBe(true);
    expect(readFileSync(join(projectWtPath, 'agent-output.txt'), 'utf-8')).toBe('hello from agent\n');

    // Step 6: Eventually cleanup the delivery worktree
    await cleanupDeliveryWorktree(setup!.gitRoot, projectWtPath);
    expect(existsSync(projectWtPath)).toBe(false);
  });
});
