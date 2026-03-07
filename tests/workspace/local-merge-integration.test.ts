/**
 * Integration tests for local-merge with REAL git repos.
 *
 * Tests the full squash-merge flow: create repos, make changes on branches,
 * merge them locally, and verify the results — no mocking of git or filesystem.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  mkdirSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock worktree-include and worktree-setup (they depend on astro config files)
vi.mock('../src/lib/worktree-include.js', () => ({
  applyWorktreeInclude: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/lib/worktree-setup.js', () => ({
  runSetupScript: vi.fn().mockResolvedValue(undefined),
}));

import { localMergeIntoProjectBranch } from '../../src/lib/local-merge.js';
import { createWorktree } from '../../src/lib/worktree.js';

const tmpDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/**
 * Create a local-only git repo (NO remote) with an initial commit on `main`.
 */
function createLocalRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'astro-lm-test-'));
  tmpDirs.push(dir);
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'test@test.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'readme.txt'), 'initial content\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial commit');
  return dir;
}

/**
 * Create a repo with a remote (bare).
 */
function createRepoWithRemote(): { repoDir: string; bareDir: string } {
  const bareDir = mkdtempSync(join(tmpdir(), 'astro-lm-test-bare-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'astro-lm-test-repo-'));
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

afterAll(async () => {
  for (const dir of tmpDirs) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});

describe('localMergeIntoProjectBranch (real git)', { timeout: 30_000 }, () => {
  it('squash-merges a task branch into a project branch', async () => {
    const repo = createLocalRepo();

    // Create project branch from main
    git(repo, 'branch', 'astro/proj1', 'main');

    // Create task branch with changes
    git(repo, 'checkout', '-b', 'astro/proj1-task1', 'main');
    writeFileSync(join(repo, 'feature.txt'), 'new feature\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add feature');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo,
      'astro/proj1-task1',
      'astro/proj1',
      '[proj1/task1] Add feature',
    );

    expect(result.merged).toBe(true);
    expect(result.commitSha).toBeDefined();
    expect(result.commitSha!.length).toBeGreaterThanOrEqual(7);

    // Verify the project branch has the file
    const projectFiles = git(repo, 'ls-tree', '--name-only', 'astro/proj1');
    expect(projectFiles).toContain('feature.txt');

    // Verify it's a squash (single commit on top of initial)
    const logCount = git(repo, 'rev-list', '--count', 'astro/proj1');
    expect(parseInt(logCount)).toBe(2); // initial + squash

    // Verify the commit message
    const commitMsg = git(repo, 'log', '-1', '--format=%s', 'astro/proj1');
    expect(commitMsg).toBe('[proj1/task1] Add feature');

    // Verify main branch is NOT affected
    const mainFiles = git(repo, 'ls-tree', '--name-only', 'main');
    expect(mainFiles).not.toContain('feature.txt');
  });

  it('accumulates multiple task merges into the same project branch', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/proj2', 'main');

    // Task 1: add file-a
    git(repo, 'checkout', '-b', 'astro/proj2-task1', 'astro/proj2');
    writeFileSync(join(repo, 'file-a.txt'), 'content a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add file-a');
    git(repo, 'checkout', 'main');

    const r1 = await localMergeIntoProjectBranch(
      repo, 'astro/proj2-task1', 'astro/proj2', 'Task 1',
    );
    expect(r1.merged).toBe(true);

    // Task 2: branch FROM project branch (accumulative) and add file-b
    git(repo, 'checkout', '-b', 'astro/proj2-task2', 'astro/proj2');
    writeFileSync(join(repo, 'file-b.txt'), 'content b\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add file-b');
    git(repo, 'checkout', 'main');

    const r2 = await localMergeIntoProjectBranch(
      repo, 'astro/proj2-task2', 'astro/proj2', 'Task 2',
    );
    expect(r2.merged).toBe(true);

    // Project branch should have BOTH files
    const projectFiles = git(repo, 'ls-tree', '--name-only', 'astro/proj2');
    expect(projectFiles).toContain('file-a.txt');
    expect(projectFiles).toContain('file-b.txt');

    // 3 commits: initial + task1 squash + task2 squash
    const logCount = git(repo, 'rev-list', '--count', 'astro/proj2');
    expect(parseInt(logCount)).toBe(3);
  });

  it('detects merge conflicts between overlapping task changes', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/proj3', 'main');

    // Task 1: modify readme
    git(repo, 'checkout', '-b', 'astro/proj3-task1', 'astro/proj3');
    writeFileSync(join(repo, 'readme.txt'), 'task 1 version\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 1 changes');
    git(repo, 'checkout', 'main');

    // Merge task 1 first
    const r1 = await localMergeIntoProjectBranch(
      repo, 'astro/proj3-task1', 'astro/proj3', 'Task 1',
    );
    expect(r1.merged).toBe(true);

    // Task 2: started from ORIGINAL main (before task 1), modifies same file
    git(repo, 'checkout', '-b', 'astro/proj3-task2', 'main');
    writeFileSync(join(repo, 'readme.txt'), 'task 2 conflicting version\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 2 changes');
    git(repo, 'checkout', 'main');

    // This should conflict because project branch has task 1's version
    const r2 = await localMergeIntoProjectBranch(
      repo, 'astro/proj3-task2', 'astro/proj3', 'Task 2',
    );

    expect(r2.merged).toBe(false);
    expect(r2.conflict).toBe(true);
    expect(r2.conflictFiles).toContain('readme.txt');

    // Verify project branch is clean (not left in conflict state)
    const status = git(repo, 'status', '--porcelain');
    expect(status).toBe('');

    // Verify project branch still has task 1's content (not corrupted)
    const content = git(repo, 'show', 'astro/proj3:readme.txt');
    expect(content).toBe('task 1 version');
  });

  it('returns merged=false when there are no changes between branches', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/proj4', 'main');

    // Create a task branch from project branch with NO changes
    git(repo, 'branch', 'astro/proj4-task1', 'astro/proj4');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/proj4-task1', 'astro/proj4', 'Empty task',
    );

    expect(result.merged).toBe(false);
    expect(result.conflict).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('cleans up temp worktree even after conflict', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/proj5', 'main');

    // Create conflicting branches
    git(repo, 'checkout', '-b', 'astro/proj5-task1', 'astro/proj5');
    writeFileSync(join(repo, 'readme.txt'), 'version A\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'A');
    git(repo, 'checkout', 'main');

    const r1 = await localMergeIntoProjectBranch(
      repo, 'astro/proj5-task1', 'astro/proj5', 'Task 1',
    );
    expect(r1.merged).toBe(true);

    // Conflicting task
    git(repo, 'checkout', '-b', 'astro/proj5-task2', 'main');
    writeFileSync(join(repo, 'readme.txt'), 'version B\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'B');
    git(repo, 'checkout', 'main');

    await localMergeIntoProjectBranch(
      repo, 'astro/proj5-task2', 'astro/proj5', 'Task 2',
    );

    // No tmp-merge directories should remain
    const astroDir = join(repo, '.astro', 'tmp-merge');
    if (existsSync(astroDir)) {
      const { readdirSync } = await import('node:fs');
      const entries = readdirSync(astroDir);
      expect(entries.length).toBe(0);
    }

    // No stale worktrees should exist
    const worktreeList = git(repo, 'worktree', 'list', '--porcelain');
    const worktreeCount = worktreeList.split('\n').filter(l => l.startsWith('worktree ')).length;
    expect(worktreeCount).toBe(1); // Only the main worktree
  });

  it('handles merging when task branch has multiple commits', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/proj6', 'main');

    // Task with multiple commits
    git(repo, 'checkout', '-b', 'astro/proj6-task1', 'astro/proj6');
    writeFileSync(join(repo, 'file1.txt'), 'commit 1\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'First commit');
    writeFileSync(join(repo, 'file2.txt'), 'commit 2\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Second commit');
    writeFileSync(join(repo, 'file3.txt'), 'commit 3\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Third commit');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/proj6-task1', 'astro/proj6', 'Squashed 3 commits',
    );

    expect(result.merged).toBe(true);

    // All 3 files should be present
    const files = git(repo, 'ls-tree', '--name-only', 'astro/proj6');
    expect(files).toContain('file1.txt');
    expect(files).toContain('file2.txt');
    expect(files).toContain('file3.txt');

    // But squashed into a single commit (initial + 1 squash)
    const logCount = git(repo, 'rev-list', '--count', 'astro/proj6');
    expect(parseInt(logCount)).toBe(2);
  });

  it('handles task branch that modifies AND deletes files', async () => {
    const repo = createLocalRepo();

    // Add extra files to main
    writeFileSync(join(repo, 'to-delete.txt'), 'delete me\n');
    writeFileSync(join(repo, 'to-modify.txt'), 'original\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add extra files');
    git(repo, 'branch', 'astro/proj7', 'main');

    // Task: delete one file, modify another, add a new one
    git(repo, 'checkout', '-b', 'astro/proj7-task1', 'astro/proj7');
    git(repo, 'rm', 'to-delete.txt');
    writeFileSync(join(repo, 'to-modify.txt'), 'modified\n');
    writeFileSync(join(repo, 'new-file.txt'), 'brand new\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Mixed changes');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/proj7-task1', 'astro/proj7', 'Mixed changes',
    );

    expect(result.merged).toBe(true);

    const files = git(repo, 'ls-tree', '--name-only', 'astro/proj7');
    expect(files).toContain('new-file.txt');
    expect(files).toContain('to-modify.txt');
    expect(files).not.toContain('to-delete.txt');

    // Verify modified content
    const content = git(repo, 'show', 'astro/proj7:to-modify.txt');
    expect(content).toBe('modified');
  });
});

describe('createWorktree for local-only repos (real git)', { timeout: 30_000 }, () => {
  it('creates worktree with project branch in a no-remote repo', async () => {
    const repo = createLocalRepo();

    const result = await createWorktree({
      workingDirectory: repo,
      taskId: 'local-task-1',
      shortProjectId: 'abc123',
      shortNodeId: 'def456',
      projectBranch: 'astro/abc123',
    });

    expect(result).not.toBeNull();
    const setup = result!;

    expect(setup.branchName).toBe('astro/abc123-def456');
    expect(setup.gitRoot).toBeDefined();
    expect(setup.projectBranch).toBe('astro/abc123');
    expect(existsSync(setup.workingDirectory)).toBe(true);

    // Project branch should have been created locally
    const branches = git(repo, 'branch', '--list', 'astro/abc123');
    expect(branches).toContain('astro/abc123');

    // No remote branches should exist
    const remoteBranches = git(repo, 'branch', '-r');
    expect(remoteBranches).toBe('');

    // Clean up
    await setup.cleanup();
    expect(existsSync(setup.workingDirectory)).toBe(false);
  });

  it('creates worktree and accumulates via local merge (full E2E)', async () => {
    const repo = createLocalRepo();

    // --- Task 1 ---
    const wt1 = await createWorktree({
      workingDirectory: repo,
      taskId: 'e2e-task-1',
      shortProjectId: 'e2epro',
      shortNodeId: 'node01',
      projectBranch: 'astro/e2epro',
    });
    expect(wt1).not.toBeNull();

    // Simulate agent work in the worktree
    writeFileSync(join(wt1!.workingDirectory, 'task1-output.txt'), 'task 1 result\n');
    git(wt1!.workingDirectory, 'add', '.');
    git(wt1!.workingDirectory, 'commit', '-m', 'Task 1 work');

    // Merge into project branch
    const merge1 = await localMergeIntoProjectBranch(
      wt1!.gitRoot,
      wt1!.branchName,
      wt1!.projectBranch!,
      '[e2epro/node01] Task 1',
    );
    expect(merge1.merged).toBe(true);

    // Cleanup task 1 worktree
    await wt1!.cleanup({ keepBranch: true });

    // --- Task 2 (branches from updated project branch) ---
    const wt2 = await createWorktree({
      workingDirectory: repo,
      taskId: 'e2e-task-2',
      shortProjectId: 'e2epro',
      shortNodeId: 'node02',
      projectBranch: 'astro/e2epro',
    });
    expect(wt2).not.toBeNull();

    // Task 2 should see task 1's file (branched from project branch)
    expect(existsSync(join(wt2!.workingDirectory, 'task1-output.txt'))).toBe(true);

    // Add task 2's work
    writeFileSync(join(wt2!.workingDirectory, 'task2-output.txt'), 'task 2 result\n');
    git(wt2!.workingDirectory, 'add', '.');
    git(wt2!.workingDirectory, 'commit', '-m', 'Task 2 work');

    // Merge task 2
    const merge2 = await localMergeIntoProjectBranch(
      wt2!.gitRoot,
      wt2!.branchName,
      wt2!.projectBranch!,
      '[e2epro/node02] Task 2',
    );
    expect(merge2.merged).toBe(true);

    await wt2!.cleanup({ keepBranch: true });

    // Verify project branch has BOTH task outputs
    const projectFiles = git(repo, 'ls-tree', '--name-only', 'astro/e2epro');
    expect(projectFiles).toContain('task1-output.txt');
    expect(projectFiles).toContain('task2-output.txt');

    // main is untouched
    const mainFiles = git(repo, 'ls-tree', '--name-only', 'main');
    expect(mainFiles).not.toContain('task1-output.txt');
    expect(mainFiles).not.toContain('task2-output.txt');
  });

  it('getDefaultBranch works for repos with master instead of main', async () => {
    // Create repo with 'master' as the default branch
    const dir = mkdtempSync(join(tmpdir(), 'astro-lm-test-master-'));
    tmpDirs.push(dir);
    git(dir, 'init', '--initial-branch=master');
    git(dir, 'config', 'user.email', 'test@test.com');
    git(dir, 'config', 'user.name', 'Test');
    writeFileSync(join(dir, 'readme.txt'), 'hello\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'init');

    // createWorktree should detect 'master' as the default branch
    const result = await createWorktree({
      workingDirectory: dir,
      taskId: 'master-test',
      shortProjectId: 'mst123',
      shortNodeId: 'nd1234',
      projectBranch: 'astro/mst123',
    });

    expect(result).not.toBeNull();
    expect(result!.baseBranch).toBe('astro/mst123');

    // Project branch should exist
    const branches = git(dir, 'branch', '--list', 'astro/mst123');
    expect(branches).toContain('astro/mst123');

    // Verify the project branch was created from master (has the same file)
    const content = git(dir, 'show', 'astro/mst123:readme.txt');
    expect(content).toBe('hello');

    await result!.cleanup();
  });

  it('handles re-merge after previous merge (idempotent project branch)', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/remerge', 'main');

    // Task: add a file
    git(repo, 'checkout', '-b', 'astro/remerge-t1', 'astro/remerge');
    writeFileSync(join(repo, 'output.txt'), 'result\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Work done');
    git(repo, 'checkout', 'main');

    // Merge once
    const r1 = await localMergeIntoProjectBranch(
      repo, 'astro/remerge-t1', 'astro/remerge', 'First merge',
    );
    expect(r1.merged).toBe(true);

    // Try to merge the same branch again — should return merged=false (no new changes)
    const r2 = await localMergeIntoProjectBranch(
      repo, 'astro/remerge-t1', 'astro/remerge', 'Duplicate merge',
    );
    expect(r2.merged).toBe(false);
    expect(r2.error).toBeUndefined();
    expect(r2.conflict).toBeUndefined();
  });

  it('handles binary file changes in merge', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/binary', 'main');

    git(repo, 'checkout', '-b', 'astro/binary-t1', 'astro/binary');
    // Write a binary-like file
    const binaryContent = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    writeFileSync(join(repo, 'image.png'), binaryContent);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add binary');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/binary-t1', 'astro/binary', 'Add image',
    );

    expect(result.merged).toBe(true);

    // Verify the binary file exists on the project branch
    const files = git(repo, 'ls-tree', '--name-only', 'astro/binary');
    expect(files).toContain('image.png');
  });

  it('conflict detection lists ALL conflicting files, not just the first', async () => {
    const repo = createLocalRepo();

    // Add multiple files to main
    writeFileSync(join(repo, 'config.json'), '{"a": 1}\n');
    writeFileSync(join(repo, 'settings.yaml'), 'key: original\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add config files');
    git(repo, 'branch', 'astro/multi', 'main');

    // Task 1 modifies both files
    git(repo, 'checkout', '-b', 'astro/multi-t1', 'astro/multi');
    writeFileSync(join(repo, 'config.json'), '{"a": "task1"}\n');
    writeFileSync(join(repo, 'settings.yaml'), 'key: task1\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 1');
    git(repo, 'checkout', 'main');

    const r1 = await localMergeIntoProjectBranch(
      repo, 'astro/multi-t1', 'astro/multi', 'Task 1',
    );
    expect(r1.merged).toBe(true);

    // Task 2 also modifies both files (from main, not from project branch)
    git(repo, 'checkout', '-b', 'astro/multi-t2', 'main');
    writeFileSync(join(repo, 'config.json'), '{"a": "task2"}\n');
    writeFileSync(join(repo, 'settings.yaml'), 'key: task2\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task 2');
    git(repo, 'checkout', 'main');

    const r2 = await localMergeIntoProjectBranch(
      repo, 'astro/multi-t2', 'astro/multi', 'Task 2',
    );

    expect(r2.merged).toBe(false);
    expect(r2.conflict).toBe(true);
    expect(r2.conflictFiles).toBeDefined();
    expect(r2.conflictFiles!.length).toBe(2);
    expect(r2.conflictFiles).toContain('config.json');
    expect(r2.conflictFiles).toContain('settings.yaml');
  });

  it('parallel tasks on different files merge cleanly in sequence', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/parallel', 'main');

    // Task A: add file-a (from project branch)
    git(repo, 'checkout', '-b', 'astro/parallel-a', 'astro/parallel');
    writeFileSync(join(repo, 'file-a.txt'), 'A content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task A');
    git(repo, 'checkout', 'main');

    // Task B: add file-b (also from project branch, simulating parallel start)
    git(repo, 'checkout', '-b', 'astro/parallel-b', 'astro/parallel');
    writeFileSync(join(repo, 'file-b.txt'), 'B content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task B');
    git(repo, 'checkout', 'main');

    // Merge A first
    const rA = await localMergeIntoProjectBranch(
      repo, 'astro/parallel-a', 'astro/parallel', 'Task A',
    );
    expect(rA.merged).toBe(true);

    // Merge B — even though B branched before A merged, there's no conflict
    // because they touch different files
    const rB = await localMergeIntoProjectBranch(
      repo, 'astro/parallel-b', 'astro/parallel', 'Task B',
    );
    expect(rB.merged).toBe(true);

    // Both files should be on the project branch
    const files = git(repo, 'ls-tree', '--name-only', 'astro/parallel');
    expect(files).toContain('file-a.txt');
    expect(files).toContain('file-b.txt');
  });
});

describe('edge cases: directory structures (real git)', { timeout: 30_000 }, () => {
  it('workingDirectory is a subdirectory of the git root', async () => {
    // Git root is /repo, but workingDirectory is /repo/packages/my-app
    const repo = createLocalRepo();
    // Use realpathSync to resolve macOS /var -> /private/var symlink
    const realRepo = realpathSync(repo);
    const subDir = join(realRepo, 'packages', 'my-app');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'app.ts'), 'export default {};\n');
    git(realRepo, 'add', '.');
    git(realRepo, 'commit', '-m', 'Add subdir package');

    const wt = await createWorktree({
      workingDirectory: subDir,
      taskId: 'subdir-test-1',
      shortProjectId: 'subdir',
      shortNodeId: 'node01',
      projectBranch: 'astro/subdir',
    });

    expect(wt).not.toBeNull();
    // gitRoot should be the parent repo (resolved real path)
    expect(wt!.gitRoot).toBe(realRepo);
    // workingDirectory should point to the subdirectory WITHIN the worktree
    expect(wt!.workingDirectory).toContain(join('packages', 'my-app'));
    // The app.ts file should exist in the worktree subdirectory
    expect(existsSync(join(wt!.workingDirectory, 'app.ts'))).toBe(true);

    // Make a change in the subdirectory
    writeFileSync(join(wt!.workingDirectory, 'new-feature.ts'), 'new stuff\n');
    git(wt!.workingDirectory, 'add', '.');
    git(wt!.workingDirectory, 'commit', '-m', 'Add feature');

    // Merge should work — gitRoot is correctly set
    const mergeResult = await localMergeIntoProjectBranch(
      wt!.gitRoot,
      wt!.branchName,
      wt!.projectBranch!,
      'Subdir feature',
    );
    expect(mergeResult.merged).toBe(true);

    // Verify the file is on the project branch (in the correct subdirectory)
    const files = git(realRepo, 'ls-tree', '-r', '--name-only', 'astro/subdir');
    expect(files).toContain('packages/my-app/new-feature.ts');

    await wt!.cleanup({ keepBranch: true });
  });

  it('workingDirectory is deeply nested (3+ levels)', async () => {
    const repo = createLocalRepo();
    const realRepo = realpathSync(repo);
    const deepDir = join(realRepo, 'src', 'modules', 'core', 'lib');
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(join(deepDir, 'utils.ts'), 'export const x = 1;\n');
    git(realRepo, 'add', '.');
    git(realRepo, 'commit', '-m', 'Add deep structure');

    const wt = await createWorktree({
      workingDirectory: deepDir,
      taskId: 'deep-test-1',
      shortProjectId: 'deep01',
      shortNodeId: 'nd0001',
      projectBranch: 'astro/deep01',
    });

    expect(wt).not.toBeNull();
    expect(wt!.workingDirectory).toContain(join('src', 'modules', 'core', 'lib'));
    expect(existsSync(join(wt!.workingDirectory, 'utils.ts'))).toBe(true);

    await wt!.cleanup();
  });

  it('workingDirectory IS the git root (most common case)', async () => {
    const repo = createLocalRepo();
    const realRepo = realpathSync(repo);

    const wt = await createWorktree({
      workingDirectory: realRepo,
      taskId: 'root-test',
      shortProjectId: 'root01',
      shortNodeId: 'nd0001',
      projectBranch: 'astro/root01',
    });

    expect(wt).not.toBeNull();
    expect(wt!.gitRoot).toBe(realRepo);
    // Working directory should be the worktree (inside .astro/worktrees), not the original repo itself
    expect(wt!.workingDirectory).toContain('.astro/worktrees/');
    expect(wt!.workingDirectory).not.toBe(realRepo);
    expect(existsSync(join(wt!.workingDirectory, 'readme.txt'))).toBe(true);

    await wt!.cleanup();
  });

  it('repo with only .git and no other files still works', async () => {
    // Bare-minimum repo: just .git and one committed file
    const dir = mkdtempSync(join(tmpdir(), 'astro-lm-test-minimal-'));
    tmpDirs.push(dir);
    const realDir = realpathSync(dir);
    git(realDir, 'init', '--initial-branch=main');
    git(realDir, 'config', 'user.email', 'test@test.com');
    git(realDir, 'config', 'user.name', 'Test');
    writeFileSync(join(realDir, '.gitkeep'), '');
    git(realDir, 'add', '.');
    git(realDir, 'commit', '-m', 'init');

    const wt = await createWorktree({
      workingDirectory: realDir,
      taskId: 'minimal-test',
      shortProjectId: 'min001',
      shortNodeId: 'nd0001',
      projectBranch: 'astro/min001',
    });

    expect(wt).not.toBeNull();

    // Create a file and merge
    writeFileSync(join(wt!.workingDirectory, 'output.txt'), 'hello\n');
    git(wt!.workingDirectory, 'add', '.');
    git(wt!.workingDirectory, 'commit', '-m', 'Add output');

    const result = await localMergeIntoProjectBranch(
      wt!.gitRoot,
      wt!.branchName,
      wt!.projectBranch!,
      'First work',
    );
    expect(result.merged).toBe(true);

    await wt!.cleanup({ keepBranch: true });
  });

  it('workingDirectory with gitignored subdirectory (tracked parent)', async () => {
    // Test that worktrees work when the working directory is a gitignored
    // subdirectory. The subdirectory exists in git (parent committed) but
    // the content is gitignored. Worktree won't have it automatically.
    const repo = createLocalRepo();
    const realRepo = realpathSync(repo);

    // Add a tracked subdirectory with content
    const trackedDir = join(realRepo, 'src', 'app');
    mkdirSync(trackedDir, { recursive: true });
    writeFileSync(join(trackedDir, 'index.ts'), 'export {};\n');
    git(realRepo, 'add', '.');
    git(realRepo, 'commit', '-m', 'Add tracked subdir');

    // Working directory is the tracked subdirectory
    const wt = await createWorktree({
      workingDirectory: trackedDir,
      taskId: 'tracked-subdir-test',
      shortProjectId: 'trckd1',
      shortNodeId: 'nd0001',
      projectBranch: 'astro/trckd1',
    });

    expect(wt).not.toBeNull();
    // The tracked file should be available in the worktree subdirectory
    expect(existsSync(join(wt!.workingDirectory, 'index.ts'))).toBe(true);

    await wt!.cleanup();
  });

  it('local merge with worktree in subdirectory uses gitRoot correctly', async () => {
    // Ensure that localMergeIntoProjectBranch uses gitRoot (not workingDirectory)
    // for all git operations, even when the task worked in a subdirectory
    const repo = createLocalRepo();
    const realRepo = realpathSync(repo);
    const subDir = join(realRepo, 'services', 'api');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'server.ts'), 'import express from "express";\n');
    git(realRepo, 'add', '.');
    git(realRepo, 'commit', '-m', 'Add api service');

    const wt = await createWorktree({
      workingDirectory: subDir,
      taskId: 'merge-subdir-test',
      shortProjectId: 'msub01',
      shortNodeId: 'nd0001',
      projectBranch: 'astro/msub01',
    });
    expect(wt).not.toBeNull();

    // Simulate work in the subdirectory worktree
    writeFileSync(join(wt!.workingDirectory, 'routes.ts'), 'export const routes = [];\n');
    // Use the worktree root (not subdirectory) for git operations that span the repo
    const worktreeRoot = git(wt!.workingDirectory, 'rev-parse', '--show-toplevel');
    writeFileSync(join(worktreeRoot, 'root-change.txt'), 'root\n');
    git(worktreeRoot, 'add', '--all');
    git(worktreeRoot, 'commit', '-m', 'Add routes and root change');

    // Merge using gitRoot — this should capture ALL changes (subdir + root)
    const result = await localMergeIntoProjectBranch(
      wt!.gitRoot,
      wt!.branchName,
      wt!.projectBranch!,
      'API service work',
    );

    expect(result.merged).toBe(true);

    // Both the subdirectory and root-level changes should be on the project branch
    const files = git(realRepo, 'ls-tree', '-r', '--name-only', 'astro/msub01');
    expect(files).toContain('services/api/routes.ts');
    expect(files).toContain('root-change.txt');

    await wt!.cleanup({ keepBranch: true });
  });
});

describe('ensureProjectBranch local mode (real git)', { timeout: 15_000 }, () => {
  it('does not attempt to push for a no-remote repo', async () => {
    const repo = createLocalRepo();

    // createWorktree should NOT fail even though there's no remote
    const result = await createWorktree({
      workingDirectory: repo,
      taskId: 'nopush-test',
      shortProjectId: 'nopush',
      shortNodeId: 'node01',
      projectBranch: 'astro/nopush',
    });

    expect(result).not.toBeNull();
    // Verify local branch exists
    const branches = git(repo, 'branch', '--list', 'astro/nopush');
    expect(branches).toContain('astro/nopush');

    await result!.cleanup();
  });

  it('reuses existing local project branch on second task', async () => {
    const repo = createLocalRepo();

    // First task creates the project branch
    const wt1 = await createWorktree({
      workingDirectory: repo,
      taskId: 'reuse-test-1',
      shortProjectId: 'reuse1',
      shortNodeId: 'node01',
      projectBranch: 'astro/reuse1',
    });
    expect(wt1).not.toBeNull();

    // Make a change and merge
    writeFileSync(join(wt1!.workingDirectory, 'first.txt'), 'first\n');
    git(wt1!.workingDirectory, 'add', '.');
    git(wt1!.workingDirectory, 'commit', '-m', 'First task');
    await localMergeIntoProjectBranch(
      wt1!.gitRoot, wt1!.branchName, wt1!.projectBranch!, 'First',
    );
    await wt1!.cleanup({ keepBranch: true });

    // Get the project branch SHA after first merge
    const sha1 = git(repo, 'rev-parse', 'astro/reuse1');

    // Second task — should reuse the same project branch
    const wt2 = await createWorktree({
      workingDirectory: repo,
      taskId: 'reuse-test-2',
      shortProjectId: 'reuse1',
      shortNodeId: 'node02',
      projectBranch: 'astro/reuse1',
    });
    expect(wt2).not.toBeNull();

    // The second task's worktree should be branched from the project branch
    // which now has the first task's changes
    expect(existsSync(join(wt2!.workingDirectory, 'first.txt'))).toBe(true);

    await wt2!.cleanup();
  });
});
