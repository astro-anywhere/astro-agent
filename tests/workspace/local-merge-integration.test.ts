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

describe('boundary: stress & edge cases (real git)', { timeout: 60_000 }, () => {
  it('concurrent merges to the same project branch serialize correctly', async () => {
    // Two tasks merging simultaneously — both should succeed since they touch different files
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/concurrent', 'main');

    // Create two task branches with non-overlapping files
    git(repo, 'checkout', '-b', 'astro/concurrent-a', 'astro/concurrent');
    writeFileSync(join(repo, 'alpha.txt'), 'alpha\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Alpha');
    git(repo, 'checkout', 'main');

    git(repo, 'checkout', '-b', 'astro/concurrent-b', 'astro/concurrent');
    writeFileSync(join(repo, 'beta.txt'), 'beta\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Beta');
    git(repo, 'checkout', 'main');

    // Fire both merges concurrently
    const [rA, rB] = await Promise.all([
      localMergeIntoProjectBranch(repo, 'astro/concurrent-a', 'astro/concurrent', 'Alpha'),
      localMergeIntoProjectBranch(repo, 'astro/concurrent-b', 'astro/concurrent', 'Beta'),
    ]);

    // At least one should succeed. The other may also succeed (if worktree locking works)
    // or may fail with a worktree error (since both try to checkout the same branch).
    // The critical thing: no crash, no corruption, no stale worktrees.
    const mergedCount = [rA, rB].filter(r => r.merged).length;
    expect(mergedCount).toBeGreaterThanOrEqual(1);

    // If one failed, it should have a structured error (not throw)
    for (const r of [rA, rB]) {
      if (!r.merged && r.error) {
        expect(typeof r.error).toBe('string');
      }
    }

    // No stale worktrees
    const worktreeList = git(repo, 'worktree', 'list', '--porcelain');
    const worktreeCount = worktreeList.split('\n').filter(l => l.startsWith('worktree ')).length;
    expect(worktreeCount).toBe(1);
  });

  it('unicode filenames and content merge correctly', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/unicode', 'main');

    git(repo, 'checkout', '-b', 'astro/unicode-t1', 'astro/unicode');
    writeFileSync(join(repo, 'résumé.txt'), '日本語テスト\nemoji: 🎉\naccent: à la carte\n');
    writeFileSync(join(repo, 'data.txt'), 'Ñoño — ñ, ü, ö, ä\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add unicode files — résumé + data');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/unicode-t1', 'astro/unicode', 'Unicode content — 日本語',
    );

    expect(result.merged).toBe(true);

    // Verify content roundtrips correctly
    const content = git(repo, 'show', 'astro/unicode:data.txt');
    expect(content).toContain('Ñoño');

    // Verify commit message with unicode
    const commitMsg = git(repo, 'log', '-1', '--format=%s', 'astro/unicode');
    expect(commitMsg).toContain('日本語');
  });

  it('commit message with special characters (quotes, newlines, backticks)', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/msg', 'main');

    git(repo, 'checkout', '-b', 'astro/msg-t1', 'astro/msg');
    writeFileSync(join(repo, 'file.txt'), 'content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Work');
    git(repo, 'checkout', 'main');

    // Commit message with characters that could break shell escaping
    const trickMessage = `Fix "the bug" in O'Reilly's \`code\` — yes/no $HOME`;
    const result = await localMergeIntoProjectBranch(
      repo, 'astro/msg-t1', 'astro/msg', trickMessage,
    );

    expect(result.merged).toBe(true);

    // Verify the commit message was stored correctly (execFile is shell-safe)
    const storedMsg = git(repo, 'log', '-1', '--format=%s', 'astro/msg');
    expect(storedMsg).toBe(trickMessage);
  });

  it('symlinks in the repo merge correctly', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/symlink', 'main');

    git(repo, 'checkout', '-b', 'astro/symlink-t1', 'astro/symlink');
    writeFileSync(join(repo, 'target.txt'), 'I am the target\n');
    const { symlinkSync } = await import('node:fs');
    symlinkSync('target.txt', join(repo, 'link.txt'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add symlink');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/symlink-t1', 'astro/symlink', 'Symlink merge',
    );

    expect(result.merged).toBe(true);
    const files = git(repo, 'ls-tree', '--name-only', 'astro/symlink');
    expect(files).toContain('link.txt');
    expect(files).toContain('target.txt');
  });

  it('file rename detection works across branches', async () => {
    const repo = createLocalRepo();

    // Add a file to main
    writeFileSync(join(repo, 'old-name.ts'), 'export function hello() { return "world"; }\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add file');
    git(repo, 'branch', 'astro/rename', 'main');

    // Task: rename the file
    git(repo, 'checkout', '-b', 'astro/rename-t1', 'astro/rename');
    git(repo, 'mv', 'old-name.ts', 'new-name.ts');
    git(repo, 'commit', '-m', 'Rename file');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/rename-t1', 'astro/rename', 'Renamed file',
    );

    expect(result.merged).toBe(true);
    const files = git(repo, 'ls-tree', '--name-only', 'astro/rename');
    expect(files).toContain('new-name.ts');
    expect(files).not.toContain('old-name.ts');
  });

  it('handles stale tmp-merge directory from a previous crash', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/stale', 'main');

    // Simulate a crash by leaving a stale directory in .astro/tmp-merge/
    const staleDir = join(repo, '.astro', 'tmp-merge', 'merge-stale-crash');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'leftover.txt'), 'crash artifact\n');

    // Now do a real merge — should succeed despite the stale directory
    git(repo, 'checkout', '-b', 'astro/stale-t1', 'astro/stale');
    writeFileSync(join(repo, 'fresh.txt'), 'new content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Fresh work');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/stale-t1', 'astro/stale', 'Fresh merge',
    );

    expect(result.merged).toBe(true);

    // The stale directory should still be there (we don't clean others' mess),
    // but the merge operation shouldn't be affected
    const files = git(repo, 'ls-tree', '--name-only', 'astro/stale');
    expect(files).toContain('fresh.txt');
  });

  it('task branch far behind project branch still merges cleanly (no conflict, different files)', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/farback', 'main');

    // Merge 5 tasks into project branch to advance it far ahead
    for (let i = 1; i <= 5; i++) {
      git(repo, 'checkout', '-b', `astro/farback-t${i}`, 'astro/farback');
      writeFileSync(join(repo, `file-${i}.txt`), `content ${i}\n`);
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', `Task ${i}`);
      git(repo, 'checkout', 'main');

      const r = await localMergeIntoProjectBranch(
        repo, `astro/farback-t${i}`, 'astro/farback', `Task ${i}`,
      );
      expect(r.merged).toBe(true);
    }

    // Now create a task from the ORIGINAL main (5 merges behind)
    git(repo, 'checkout', '-b', 'astro/farback-late', 'main');
    writeFileSync(join(repo, 'late-addition.txt'), 'I am late\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Late task');
    git(repo, 'checkout', 'main');

    // This should merge cleanly since it touches a different file
    const result = await localMergeIntoProjectBranch(
      repo, 'astro/farback-late', 'astro/farback', 'Late merge',
    );

    expect(result.merged).toBe(true);

    // All 6 files should be on the project branch
    const files = git(repo, 'ls-tree', '--name-only', 'astro/farback');
    for (let i = 1; i <= 5; i++) {
      expect(files).toContain(`file-${i}.txt`);
    }
    expect(files).toContain('late-addition.txt');
  });

  it('large file (1MB+) merges without timeout', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/large', 'main');

    git(repo, 'checkout', '-b', 'astro/large-t1', 'astro/large');
    // Generate a ~1MB file
    const largeContent = 'x'.repeat(1024 * 1024) + '\n';
    writeFileSync(join(repo, 'big-file.txt'), largeContent);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add large file');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/large-t1', 'astro/large', 'Large file merge',
    );

    expect(result.merged).toBe(true);
  });

  it('many files in a single merge (100+ files)', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/many', 'main');

    git(repo, 'checkout', '-b', 'astro/many-t1', 'astro/many');
    const fileCount = 150;
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(repo, `generated-${i.toString().padStart(3, '0')}.txt`), `content ${i}\n`);
    }
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', `Add ${fileCount} files`);
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/many-t1', 'astro/many', 'Bulk file merge',
    );

    expect(result.merged).toBe(true);

    const files = git(repo, 'ls-tree', '--name-only', 'astro/many');
    const generatedFiles = files.split('\n').filter(f => f.startsWith('generated-'));
    expect(generatedFiles.length).toBe(fileCount);
  });

  it('merge after project branch was manually advanced (simulating external changes)', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/ext', 'main');

    // Externally advance the project branch (e.g., user manually committed)
    git(repo, 'checkout', 'astro/ext');
    writeFileSync(join(repo, 'manual.txt'), 'manually added\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Manual external change');
    git(repo, 'checkout', 'main');

    // Task branched from main (before external change)
    git(repo, 'checkout', '-b', 'astro/ext-t1', 'main');
    writeFileSync(join(repo, 'task.txt'), 'task output\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Task work');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/ext-t1', 'astro/ext', 'Task merge after external change',
    );

    expect(result.merged).toBe(true);

    // Project branch should have BOTH the manual change and the task change
    const files = git(repo, 'ls-tree', '--name-only', 'astro/ext');
    expect(files).toContain('manual.txt');
    expect(files).toContain('task.txt');
  });

  it('task that only deletes files produces a valid merge', async () => {
    const repo = createLocalRepo();

    // Add files to main
    writeFileSync(join(repo, 'delete-me-1.txt'), 'goodbye 1\n');
    writeFileSync(join(repo, 'delete-me-2.txt'), 'goodbye 2\n');
    writeFileSync(join(repo, 'keep-me.txt'), 'stay\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add files to delete');
    git(repo, 'branch', 'astro/delonly', 'main');

    // Task: only delete files, no additions
    git(repo, 'checkout', '-b', 'astro/delonly-t1', 'astro/delonly');
    git(repo, 'rm', 'delete-me-1.txt', 'delete-me-2.txt');
    git(repo, 'commit', '-m', 'Delete files');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/delonly-t1', 'astro/delonly', 'Delete-only merge',
    );

    expect(result.merged).toBe(true);
    const files = git(repo, 'ls-tree', '--name-only', 'astro/delonly');
    expect(files).toContain('keep-me.txt');
    expect(files).not.toContain('delete-me-1.txt');
    expect(files).not.toContain('delete-me-2.txt');
  });

  it('three-way conflict: task A merged, task B conflicts, then task C merges cleanly', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/threeway', 'main');

    // Task A: modify readme
    git(repo, 'checkout', '-b', 'astro/threeway-a', 'main');
    writeFileSync(join(repo, 'readme.txt'), 'version A\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'A');
    git(repo, 'checkout', 'main');

    const rA = await localMergeIntoProjectBranch(
      repo, 'astro/threeway-a', 'astro/threeway', 'Task A',
    );
    expect(rA.merged).toBe(true);

    // Task B: conflicts with A on the same file
    git(repo, 'checkout', '-b', 'astro/threeway-b', 'main');
    writeFileSync(join(repo, 'readme.txt'), 'version B\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'B');
    git(repo, 'checkout', 'main');

    const rB = await localMergeIntoProjectBranch(
      repo, 'astro/threeway-b', 'astro/threeway', 'Task B',
    );
    expect(rB.merged).toBe(false);
    expect(rB.conflict).toBe(true);

    // Task C: different file, should merge cleanly despite B's conflict
    git(repo, 'checkout', '-b', 'astro/threeway-c', 'main');
    writeFileSync(join(repo, 'other.txt'), 'no conflict\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'C');
    git(repo, 'checkout', 'main');

    const rC = await localMergeIntoProjectBranch(
      repo, 'astro/threeway-c', 'astro/threeway', 'Task C',
    );
    expect(rC.merged).toBe(true);

    // Project branch should be clean: A's readme + C's other.txt
    const files = git(repo, 'ls-tree', '--name-only', 'astro/threeway');
    expect(files).toContain('other.txt');

    // Verify readme has A's version (B was conflicted and rejected)
    const content = git(repo, 'show', 'astro/threeway:readme.txt');
    expect(content).toBe('version A');
  });

  it('deeply nested directory creation in merge', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/deep', 'main');

    git(repo, 'checkout', '-b', 'astro/deep-t1', 'astro/deep');
    const deepPath = join(repo, 'a', 'b', 'c', 'd', 'e', 'f');
    mkdirSync(deepPath, { recursive: true });
    writeFileSync(join(deepPath, 'deep.txt'), 'deep content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Deep dir');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/deep-t1', 'astro/deep', 'Deep directory merge',
    );

    expect(result.merged).toBe(true);
    const files = git(repo, 'ls-tree', '-r', '--name-only', 'astro/deep');
    expect(files).toContain('a/b/c/d/e/f/deep.txt');
  });

  it('whitespace-only changes produce a valid merge', async () => {
    const repo = createLocalRepo();

    // Add a file with no trailing newline
    writeFileSync(join(repo, 'code.ts'), 'const x = 1;');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add code');
    git(repo, 'branch', 'astro/ws', 'main');

    // Task: only whitespace changes
    git(repo, 'checkout', '-b', 'astro/ws-t1', 'astro/ws');
    writeFileSync(join(repo, 'code.ts'), 'const x = 1;\n');  // add trailing newline
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Fix trailing newline');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/ws-t1', 'astro/ws', 'Whitespace fix',
    );

    expect(result.merged).toBe(true);
    const content = git(repo, 'show', 'astro/ws:code.ts');
    expect(content).toBe('const x = 1;');  // git show trims trailing newline
  });

  it('executable file mode changes merge correctly', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/chmod', 'main');

    git(repo, 'checkout', '-b', 'astro/chmod-t1', 'astro/chmod');
    writeFileSync(join(repo, 'script.sh'), '#!/bin/bash\necho hello\n');
    const { chmodSync } = await import('node:fs');
    chmodSync(join(repo, 'script.sh'), 0o755);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Add executable script');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/chmod-t1', 'astro/chmod', 'Executable script merge',
    );

    expect(result.merged).toBe(true);

    // Verify the file mode is preserved (100755 for executable)
    const lsTree = git(repo, 'ls-tree', 'astro/chmod', 'script.sh');
    expect(lsTree).toContain('100755');
  });

  it('merge returns different SHAs for different commits', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/sha', 'main');

    // Task 1
    git(repo, 'checkout', '-b', 'astro/sha-t1', 'astro/sha');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'A');
    git(repo, 'checkout', 'main');

    const r1 = await localMergeIntoProjectBranch(
      repo, 'astro/sha-t1', 'astro/sha', 'Task 1',
    );

    // Task 2
    git(repo, 'checkout', '-b', 'astro/sha-t2', 'astro/sha');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'B');
    git(repo, 'checkout', 'main');

    const r2 = await localMergeIntoProjectBranch(
      repo, 'astro/sha-t2', 'astro/sha', 'Task 2',
    );

    expect(r1.merged).toBe(true);
    expect(r2.merged).toBe(true);
    expect(r1.commitSha).toBeDefined();
    expect(r2.commitSha).toBeDefined();
    // Each merge should produce a different SHA
    expect(r1.commitSha).not.toBe(r2.commitSha);
    // SHAs should be valid hex
    expect(r1.commitSha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(r2.commitSha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('nonexistent task branch returns structured error', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/noref', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/nonexistent-branch', 'astro/noref', 'Should fail',
    );

    // Should not throw — should return a structured error
    expect(result.merged).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('nonexistent project branch returns structured error', async () => {
    const repo = createLocalRepo();

    // Create a valid task branch but no project branch
    git(repo, 'checkout', '-b', 'astro/orphan-task', 'main');
    writeFileSync(join(repo, 'orphan.txt'), 'orphan\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Orphan');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/orphan-task', 'astro/nonexistent-project', 'Should fail',
    );

    expect(result.merged).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('pre-commit hook failure returns Commit failed error (real hook)', async () => {
    const repo = createLocalRepo();
    git(repo, 'branch', 'astro/hook', 'main');

    // Install a pre-commit hook that always fails
    const hookDir = join(repo, '.git', 'hooks');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'pre-commit'), '#!/bin/bash\necho "hook blocked"\nexit 1\n');
    const { chmodSync } = await import('node:fs');
    chmodSync(join(hookDir, 'pre-commit'), 0o755);

    // Create task with changes
    git(repo, 'checkout', '-b', 'astro/hook-t1', 'astro/hook');
    writeFileSync(join(repo, 'hooked.txt'), 'will fail\n');
    git(repo, 'add', '.');
    // Commit on task branch bypasses the hook (--no-verify) so we can create the branch
    git(repo, 'commit', '--no-verify', '-m', 'Add file');
    git(repo, 'checkout', 'main');

    const result = await localMergeIntoProjectBranch(
      repo, 'astro/hook-t1', 'astro/hook', 'Should fail at commit',
    );

    // The merge --squash succeeds, but the commit should fail due to the hook
    expect(result.merged).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Commit failed');
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
