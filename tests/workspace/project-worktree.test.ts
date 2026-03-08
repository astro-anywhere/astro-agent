/**
 * Integration tests for persistent project-level worktree.
 *
 * These tests use REAL git repos in temporary directories — no mocking of
 * git or filesystem operations. Only worktree-include and worktree-setup
 * are mocked (they depend on astro config files that won't exist in test repos).
 *
 * Key invariant: the project worktree uses detached HEAD so that
 * localMergeIntoProjectBranch() can check out the project branch in a
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
  createProjectWorktree,
  syncProjectWorktree,
  cleanupProjectWorktree,
} from '../../src/lib/worktree.js';
import { localMergeIntoProjectBranch } from '../../src/lib/local-merge.js';

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

/** Get the HEAD commit message of a worktree/branch. */
function headSha(cwd: string): string {
  return git(cwd, 'rev-parse', 'HEAD');
}

/** Check if HEAD is detached in a worktree. */
function isDetachedHead(cwd: string): boolean {
  const result = git(cwd, 'symbolic-ref', '--short', 'HEAD').trim();
  return false; // If this succeeds, HEAD is NOT detached
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
// 1. createProjectWorktree — basic functionality
// =============================================================================

describe('createProjectWorktree (real git)', { timeout: 30_000 }, () => {
  it('creates a worktree at the expected path with detached HEAD', async () => {
    const repo = createLocalRepo();
    const projectBranch = 'astro/abc123';
    git(repo, 'branch', projectBranch, 'main');

    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });

    const result = await createProjectWorktree(repo, projectBranch, baseRoot, 'abc123');

    expect(result).not.toBeNull();
    expect(result).toBe(join(baseRoot, 'abc123'));
    expect(existsSync(result!)).toBe(true);

    // Files from the project branch should be present
    expect(readFileSync(join(result!, 'readme.txt'), 'utf-8')).toBe('initial content\n');

    // HEAD must be detached
    expect(isDetached(result!)).toBe(true);
  });

  it('is idempotent — second call returns existing path', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/def456', 'main');

    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });

    const first = await createProjectWorktree(repo, 'astro/def456', baseRoot, 'def456');
    const second = await createProjectWorktree(repo, 'astro/def456', baseRoot, 'def456');

    expect(first).toBe(second);
    expect(existsSync(first!)).toBe(true);
  });

  it('returns null when the start point does not exist', async () => {
    const repo = createLocalRepo();
    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });

    // No branch created — refs/heads/astro/ghost and origin/astro/ghost both missing
    const result = await createProjectWorktree(repo, 'astro/ghost', baseRoot, 'ghost');

    expect(result).toBeNull();
  });

  it('uses remote ref when local ref does not exist', async () => {
    const { repoDir } = createRepoWithRemote();
    const projectBranch = 'astro/remote1';

    // Create branch only on remote (push then delete local)
    git(repoDir, 'branch', projectBranch, 'main');
    git(repoDir, 'push', 'origin', projectBranch);
    git(repoDir, 'branch', '-D', projectBranch);

    const baseRoot = join(repoDir, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });

    const result = await createProjectWorktree(repoDir, projectBranch, baseRoot, 'remote1');

    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
    expect(isDetached(result!)).toBe(true);
  });
});

// =============================================================================
// 2. syncProjectWorktree — update after merge
// =============================================================================

describe('syncProjectWorktree (real git)', { timeout: 30_000 }, () => {
  it('updates the project worktree files after a branch merge', async () => {
    const repo = createLocalRepo();
    const projectBranch = 'astro/sync1';
    git(repo, 'branch', projectBranch, 'main');

    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });

    const wtPath = await createProjectWorktree(repo, projectBranch, baseRoot, 'sync1');
    expect(wtPath).not.toBeNull();

    // The project worktree should have the initial file
    expect(readFileSync(join(wtPath!, 'readme.txt'), 'utf-8')).toBe('initial content\n');

    // Create a task branch, add a file, and merge into the project branch
    git(repo, 'checkout', '-b', 'astro/sync1-task1', projectBranch);
    writeFileSync(join(repo, 'feature.txt'), 'new feature\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add feature');
    git(repo, 'checkout', 'main');

    const mergeResult = await localMergeIntoProjectBranch(
      repo,
      'astro/sync1-task1',
      projectBranch,
      'Squash: add feature',
    );
    expect(mergeResult.merged).toBe(true);

    // Before sync: project worktree still has old state
    expect(existsSync(join(wtPath!, 'feature.txt'))).toBe(false);

    // After sync: project worktree should reflect the merged changes
    await syncProjectWorktree(wtPath!, projectBranch, repo);

    expect(existsSync(join(wtPath!, 'feature.txt'))).toBe(true);
    expect(readFileSync(join(wtPath!, 'feature.txt'), 'utf-8')).toBe('new feature\n');

    // HEAD should still be detached after sync
    expect(isDetached(wtPath!)).toBe(true);
  });

  it('is a no-op when the worktree path does not exist', async () => {
    const repo = createLocalRepo();
    // Should not throw
    await syncProjectWorktree('/nonexistent/path', 'astro/nope', repo);
  });

  it('handles multiple sequential merges', async () => {
    const repo = createLocalRepo();
    const projectBranch = 'astro/multi';
    git(repo, 'branch', projectBranch, 'main');

    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });
    const wtPath = (await createProjectWorktree(repo, projectBranch, baseRoot, 'multi'))!;

    // Merge task 1
    git(repo, 'checkout', '-b', 'astro/multi-t1', projectBranch);
    writeFileSync(join(repo, 'file1.txt'), 'task1\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 1');
    git(repo, 'checkout', 'main');

    await localMergeIntoProjectBranch(repo, 'astro/multi-t1', projectBranch, 'Squash: task 1');
    await syncProjectWorktree(wtPath, projectBranch, repo);
    expect(readFileSync(join(wtPath, 'file1.txt'), 'utf-8')).toBe('task1\n');

    // Merge task 2 (branches from updated project branch)
    git(repo, 'checkout', '-b', 'astro/multi-t2', projectBranch);
    writeFileSync(join(repo, 'file2.txt'), 'task2\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 2');
    git(repo, 'checkout', 'main');

    await localMergeIntoProjectBranch(repo, 'astro/multi-t2', projectBranch, 'Squash: task 2');
    await syncProjectWorktree(wtPath, projectBranch, repo);

    // Both files should be present
    expect(readFileSync(join(wtPath, 'file1.txt'), 'utf-8')).toBe('task1\n');
    expect(readFileSync(join(wtPath, 'file2.txt'), 'utf-8')).toBe('task2\n');
    expect(isDetached(wtPath)).toBe(true);
  });
});

// =============================================================================
// 2b. syncProjectWorktree — remote mode (simulates PR merge on GitHub)
// =============================================================================

describe('syncProjectWorktree remote mode (real git)', { timeout: 30_000 }, () => {
  it('uses origin/ ref after fetch when remote is ahead (PR mode)', async () => {
    const { repoDir, bareDir } = createRepoWithRemote();
    const projectBranch = 'astro/prsync';

    // Create project branch and push to origin
    git(repoDir, 'branch', projectBranch, 'main');
    git(repoDir, 'push', 'origin', projectBranch);

    const baseRoot = join(repoDir, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });
    const wtPath = (await createProjectWorktree(repoDir, projectBranch, baseRoot, 'prsync'))!;

    // Simulate a PR merge on "GitHub" (the bare remote):
    // Clone the bare repo, make a commit on the project branch, push back.
    // This advances origin/{projectBranch} without touching refs/heads/ in repoDir.
    const cloneDir = realpathSync(mkdtempSync(join(tmpdir(), 'astro-pwt-clone-')));
    tmpDirs.push(cloneDir);
    git(cloneDir, 'clone', bareDir, '.');
    git(cloneDir, 'config', 'user.email', 'test@test.com');
    git(cloneDir, 'config', 'user.name', 'Test');
    git(cloneDir, 'checkout', projectBranch);
    writeFileSync(join(cloneDir, 'pr-merged.txt'), 'merged via PR\n');
    git(cloneDir, 'add', '.');
    git(cloneDir, 'commit', '-m', 'PR merge commit');
    git(cloneDir, 'push', 'origin', projectBranch);

    // At this point: origin/{projectBranch} is ahead, local refs/heads/ is stale
    // Verify the local ref is indeed stale
    const localSha = git(repoDir, 'rev-parse', `refs/heads/${projectBranch}`);
    git(repoDir, 'fetch', 'origin', projectBranch);
    const remoteSha = git(repoDir, 'rev-parse', `origin/${projectBranch}`);
    expect(localSha).not.toBe(remoteSha); // local is stale

    // Before sync: project worktree doesn't have the PR file
    expect(existsSync(join(wtPath, 'pr-merged.txt'))).toBe(false);

    // Sync — should fetch and checkout from origin/ (not stale refs/heads/)
    await syncProjectWorktree(wtPath, projectBranch, repoDir);

    // After sync: project worktree has the PR-merged file
    expect(existsSync(join(wtPath, 'pr-merged.txt'))).toBe(true);
    expect(readFileSync(join(wtPath, 'pr-merged.txt'), 'utf-8')).toBe('merged via PR\n');
    expect(isDetached(wtPath)).toBe(true);
  });
});

// =============================================================================
// 3. cleanupProjectWorktree
// =============================================================================

describe('cleanupProjectWorktree (real git)', { timeout: 30_000 }, () => {
  it('removes the worktree directory and prunes', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/cleanup1', 'main');

    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });
    const wtPath = (await createProjectWorktree(repo, 'astro/cleanup1', baseRoot, 'cleanup1'))!;
    expect(existsSync(wtPath)).toBe(true);

    await cleanupProjectWorktree(repo, wtPath);

    expect(existsSync(wtPath)).toBe(false);

    // git worktree list should not mention the removed path
    const wtList = git(repo, 'worktree', 'list', '--porcelain');
    expect(wtList).not.toContain('cleanup1');
  });

  it('is a no-op when directory does not exist', async () => {
    const repo = createLocalRepo();
    // Should not throw
    await cleanupProjectWorktree(repo, '/nonexistent/path');
  });
});

// =============================================================================
// 4. Detached HEAD constraint — core invariant
// =============================================================================

describe('detached HEAD allows concurrent merge worktrees', { timeout: 30_000 }, () => {
  it('localMergeIntoProjectBranch succeeds while project worktree exists', async () => {
    const repo = createLocalRepo();
    const projectBranch = 'astro/detach1';
    git(repo, 'branch', projectBranch, 'main');

    // Create the persistent project worktree (detached HEAD)
    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });
    const wtPath = await createProjectWorktree(repo, projectBranch, baseRoot, 'detach1');
    expect(wtPath).not.toBeNull();
    expect(isDetached(wtPath!)).toBe(true);

    // Create a task branch with changes
    git(repo, 'checkout', '-b', 'astro/detach1-task1', projectBranch);
    writeFileSync(join(repo, 'task-work.txt'), 'some work\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task work');
    git(repo, 'checkout', 'main');

    // This is the KEY test: localMergeIntoProjectBranch() creates a temporary
    // worktree that checks out the project branch. If the project worktree
    // held a regular branch checkout (not detached), this would fail with
    // "fatal: 'astro/detach1' is already checked out".
    const result = await localMergeIntoProjectBranch(
      repo,
      'astro/detach1-task1',
      projectBranch,
      'Squash: task work',
    );

    expect(result.merged).toBe(true);
    expect(result.commitSha).toBeDefined();

    // Sync and verify the project worktree has the merged file
    await syncProjectWorktree(wtPath!, projectBranch, repo);
    expect(readFileSync(join(wtPath!, 'task-work.txt'), 'utf-8')).toBe('some work\n');
  });

  it('multiple merges succeed with persistent project worktree', async () => {
    const repo = createLocalRepo();
    const projectBranch = 'astro/detach2';
    git(repo, 'branch', projectBranch, 'main');

    const baseRoot = join(repo, '.astro', 'worktrees');
    mkdirSync(baseRoot, { recursive: true });
    const wtPath = (await createProjectWorktree(repo, projectBranch, baseRoot, 'detach2'))!;

    // Merge two sequential tasks
    for (const taskNum of [1, 2]) {
      const taskBranch = `astro/detach2-t${taskNum}`;
      git(repo, 'checkout', '-b', taskBranch, projectBranch);
      writeFileSync(join(repo, `task${taskNum}.txt`), `task ${taskNum}\n`);
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', `Task ${taskNum}`);
      git(repo, 'checkout', 'main');

      const result = await localMergeIntoProjectBranch(
        repo, taskBranch, projectBranch, `Squash: task ${taskNum}`,
      );
      expect(result.merged).toBe(true);
      await syncProjectWorktree(wtPath, projectBranch, repo);
    }

    // Both files present in project worktree
    expect(readFileSync(join(wtPath, 'task1.txt'), 'utf-8')).toBe('task 1\n');
    expect(readFileSync(join(wtPath, 'task2.txt'), 'utf-8')).toBe('task 2\n');
    expect(isDetached(wtPath)).toBe(true);
  });
});

// =============================================================================
// 5. Integration with createWorktree()
// =============================================================================

describe('createWorktree() creates project worktree', { timeout: 30_000 }, () => {
  it('returns projectWorktreePath when shortProjectId is provided', async () => {
    const repo = createLocalRepo();

    const setup = await createWorktree({
      workingDirectory: repo,
      taskId: 'exec-abc123-n1-123',
      shortProjectId: 'abc123',
      shortNodeId: 'n1',
    });

    expect(setup).not.toBeNull();

    // Should have a project worktree path
    expect(setup!.projectWorktreePath).toBeDefined();
    expect(existsSync(setup!.projectWorktreePath!)).toBe(true);

    // Project worktree should be at .astro/worktrees/abc123
    expect(setup!.projectWorktreePath).toContain(join('.astro', 'worktrees', 'abc123'));

    // Project worktree uses detached HEAD
    expect(isDetached(setup!.projectWorktreePath!)).toBe(true);

    // Task worktree is separate (at .astro/worktrees/abc123-n1)
    expect(setup!.workingDirectory).toContain(join('.astro', 'worktrees', 'abc123-n1'));
    expect(setup!.workingDirectory).not.toBe(setup!.projectWorktreePath);

    // Both exist simultaneously
    expect(existsSync(setup!.workingDirectory)).toBe(true);
    expect(existsSync(setup!.projectWorktreePath!)).toBe(true);

    // After task cleanup, project worktree persists
    await setup!.cleanup();
    expect(existsSync(setup!.workingDirectory)).toBe(false);
    expect(existsSync(setup!.projectWorktreePath!)).toBe(true);
  });

  it('does not create project worktree when shortProjectId is missing', async () => {
    const repo = createLocalRepo();

    const setup = await createWorktree({
      workingDirectory: repo,
      taskId: 'plain-task-1',
    });

    expect(setup).not.toBeNull();
    expect(setup!.projectWorktreePath).toBeUndefined();

    await setup!.cleanup();
  });

  it('project worktree persists across multiple task worktree lifecycles', async () => {
    const repo = createLocalRepo();

    // First task
    const setup1 = await createWorktree({
      workingDirectory: repo,
      taskId: 'exec-xyz789-n1-001',
      shortProjectId: 'xyz789',
      shortNodeId: 'n1',
    });
    expect(setup1).not.toBeNull();
    const projectWtPath = setup1!.projectWorktreePath!;
    expect(existsSync(projectWtPath)).toBe(true);

    await setup1!.cleanup();
    expect(existsSync(projectWtPath)).toBe(true); // persists

    // Second task — project worktree already exists
    const setup2 = await createWorktree({
      workingDirectory: repo,
      taskId: 'exec-xyz789-n2-002',
      shortProjectId: 'xyz789',
      shortNodeId: 'n2',
    });
    expect(setup2).not.toBeNull();
    expect(setup2!.projectWorktreePath).toBe(projectWtPath); // same path

    await setup2!.cleanup();
    expect(existsSync(projectWtPath)).toBe(true); // still persists
  });
});

// =============================================================================
// 6. Full lifecycle: create → task → merge → sync → cleanup
// =============================================================================

describe('full project worktree lifecycle', { timeout: 30_000 }, () => {
  it('end-to-end: create worktree, merge task, sync, verify files', async () => {
    const repo = createLocalRepo();

    // Step 1: Create task worktree (also creates project worktree)
    const setup = await createWorktree({
      workingDirectory: repo,
      taskId: 'exec-e2e111-n1-001',
      shortProjectId: 'e2e111',
      shortNodeId: 'n1',
    });
    expect(setup).not.toBeNull();
    const projectWtPath = setup!.projectWorktreePath!;
    const projectBranch = setup!.projectBranch!;

    expect(existsSync(projectWtPath)).toBe(true);
    expect(projectBranch).toBe('astro/e2e111');

    // Step 2: Simulate agent work in the task worktree
    writeFileSync(join(setup!.workingDirectory, 'agent-output.txt'), 'hello from agent\n');
    git(setup!.workingDirectory, 'add', '.');
    git(setup!.workingDirectory, 'commit', '-m', 'Agent adds output');

    // Step 3: Merge task branch into project branch
    const mergeResult = await localMergeIntoProjectBranch(
      setup!.gitRoot,
      setup!.branchName,
      projectBranch,
      '[e2e111/n1] Agent output',
    );
    expect(mergeResult.merged).toBe(true);

    // Step 4: Sync project worktree
    await syncProjectWorktree(projectWtPath, projectBranch, setup!.gitRoot);

    // Verify: project worktree has the merged file
    expect(readFileSync(join(projectWtPath, 'agent-output.txt'), 'utf-8')).toBe('hello from agent\n');

    // Step 5: Cleanup task worktree — project worktree survives
    await setup!.cleanup();
    expect(existsSync(setup!.workingDirectory)).toBe(false);
    expect(existsSync(projectWtPath)).toBe(true);
    expect(readFileSync(join(projectWtPath, 'agent-output.txt'), 'utf-8')).toBe('hello from agent\n');

    // Step 6: Eventually cleanup the project worktree
    await cleanupProjectWorktree(setup!.gitRoot, projectWtPath);
    expect(existsSync(projectWtPath)).toBe(false);
  });
});
