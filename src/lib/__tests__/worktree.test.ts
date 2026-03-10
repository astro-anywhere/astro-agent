/**
 * Tests for worktree management utilities
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted() so mock is available inside vi.mock factories (which are hoisted)
const mockExecFileAsync = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRm = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockReadFile = vi.hoisted(() => vi.fn().mockResolvedValue(''));
const mockAppendFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:util', () => ({
  promisify: () => mockExecFileAsync,
}));
vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  rm: mockRm,
  readFile: mockReadFile,
  appendFile: mockAppendFile,
}));
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));
vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
}));
vi.mock('../worktree-include.js', () => ({
  applyWorktreeInclude: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../worktree-setup.js', () => ({
  runSetupScript: vi.fn().mockResolvedValue(undefined),
}));

import { createWorktree, removeLingeringWorktrees } from '../worktree.js';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

describe('removeLingeringWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should remove worktree matching the target branch', async () => {
    const porcelainOutput = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/testuser/.astro/worktrees/repo/old-task',
      'HEAD def456',
      'branch refs/heads/astro/my-task',
      '',
    ].join('\n');

    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: porcelainOutput }) // list --porcelain
      .mockResolvedValueOnce({ stdout: '' }); // worktree remove

    await removeLingeringWorktrees('/repo', 'astro/my-task');

    // Should have called list --porcelain
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'worktree', 'list', '--porcelain'],
      expect.any(Object),
    );

    // Should have attempted to remove the conflicting worktree
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'worktree', 'remove', '--force', '/home/testuser/.astro/worktrees/repo/old-task'],
      expect.any(Object),
    );
  });

  it('should not remove worktrees on different branches', async () => {
    const porcelainOutput = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/testuser/.astro/worktrees/repo/other-task',
      'HEAD def456',
      'branch refs/heads/astro/other-task',
      '',
    ].join('\n');

    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: porcelainOutput }); // list --porcelain

    await removeLingeringWorktrees('/repo', 'astro/my-task');

    // Should only have called list, no remove
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
  });

  it('should fall back to rm + prune when worktree remove fails', async () => {
    const porcelainOutput = [
      'worktree /home/testuser/.astro/worktrees/repo/task1',
      'HEAD abc123',
      'branch refs/heads/astro/task1',
      '',
    ].join('\n');

    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: porcelainOutput }) // list --porcelain
      .mockRejectedValueOnce(new Error('worktree remove failed')) // worktree remove fails
      .mockResolvedValueOnce({ stdout: '' }); // worktree prune

    await removeLingeringWorktrees('/repo', 'astro/task1');

    // Should have called rm (from fs/promises mock)
    expect(rm).toHaveBeenCalledWith(
      '/home/testuser/.astro/worktrees/repo/task1',
      { recursive: true, force: true },
    );

    // Should have called prune as fallback
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'worktree', 'prune'],
      expect.any(Object),
    );
  });

  it('should handle empty porcelain output gracefully', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '' });

    await removeLingeringWorktrees('/repo', 'astro/task1');

    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
  });

  it('should handle porcelain list failure gracefully', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('git not found'));

    // Should not throw
    await removeLingeringWorktrees('/repo', 'astro/task1');
  });

  it('should force-remove directory if it still exists after worktree remove', async () => {
    const porcelainOutput = [
      'worktree /stale/path',
      'HEAD abc123',
      'branch refs/heads/astro/task1',
      '',
    ].join('\n');

    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: porcelainOutput }) // list --porcelain
      .mockResolvedValueOnce({ stdout: '' }); // worktree remove succeeds

    (existsSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(true); // directory still exists

    await removeLingeringWorktrees('/repo', 'astro/task1');

    // Should rm the stale directory
    expect(rm).toHaveBeenCalledWith('/stale/path', { recursive: true, force: true });
  });
});

describe('createWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset existsSync default
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('should create worktree at {gitRoot}/.astro/worktrees/', async () => {
    // Setup mocks for the full createWorktree flow
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '/project\n' })        // getGitRoot (rev-parse)
      .mockResolvedValueOnce({ stdout: '' })                   // hasCommits (rev-parse HEAD)
      .mockResolvedValueOnce({ stdout: '' })                   // removeLingeringWorktrees: list --porcelain (empty)
      .mockResolvedValueOnce({ stdout: '' })                   // ensureBranchAvailable: branch -D
      .mockResolvedValueOnce({ stdout: '' })                   // deleteRemoteBranch
      .mockResolvedValueOnce({ stdout: '' })                   // git fetch origin
      .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/HEAD\nrefs/remotes/origin/main' }) // getDefaultBranch
      .mockResolvedValueOnce({ stdout: '' });                  // git worktree add

    // mkdir should succeed (.astro/worktrees inside project)
    mockMkdir.mockResolvedValue(undefined);

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'test-task-123',
    });

    expect(result).not.toBeNull();
    // Verify mkdir was called with the inside-project path
    expect(mockMkdir).toHaveBeenCalledWith('/project/.astro/worktrees', { recursive: true });
    // Verify worktree path is under .astro/worktrees inside project
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'worktree', 'add', '-b', 'astro/test-task-123',
        '/project/.astro/worktrees/test-task-123',
      ]),
      expect.any(Object),
    );
  });

  it('should use custom agentDir when provided', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '/project\n' })        // getGitRoot
      .mockResolvedValueOnce({ stdout: '' })                   // hasCommits
      .mockResolvedValueOnce({ stdout: '' })                   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })                   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })                   // deleteRemoteBranch
      .mockResolvedValueOnce({ stdout: '' })                   // git fetch
      .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/HEAD\nrefs/remotes/origin/main' }) // getDefaultBranch
      .mockResolvedValueOnce({ stdout: '' });                  // git worktree add

    mockMkdir.mockResolvedValue(undefined);

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'test-task-custom',
      agentDir: '.myagent',
    });

    expect(result).not.toBeNull();
    expect(mockMkdir).toHaveBeenCalledWith('/project/.myagent/worktrees', { recursive: true });
  });

  it('should read branch prefix from config.json', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '/project\n' })        // getGitRoot
      .mockResolvedValueOnce({ stdout: '' })                   // hasCommits
      .mockResolvedValueOnce({ stdout: '' })                   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })                   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })                   // deleteRemoteBranch
      .mockResolvedValueOnce({ stdout: '' })                   // git fetch
      .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/HEAD\nrefs/remotes/origin/main' }) // getDefaultBranch
      .mockResolvedValueOnce({ stdout: '' });                  // git worktree add

    mockMkdir.mockResolvedValue(undefined);
    // readFile returns config with custom branchPrefix
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ branchPrefix: 'custom/' }));

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'test-task-prefix',
    });

    expect(result).not.toBeNull();
    // Branch name should use the custom prefix
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'worktree', 'add', '-b', 'custom/test-task-prefix',
      ]),
      expect.any(Object),
    );
  });

  it('should fall back to ~/.astro/worktrees/ when git root is read-only', async () => {
    // Setup mocks
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '/readonly-project\n' }) // getGitRoot
      .mockResolvedValueOnce({ stdout: '' })                    // hasCommits
      .mockResolvedValueOnce({ stdout: '' })                    // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })                    // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })                    // deleteRemoteBranch
      .mockResolvedValueOnce({ stdout: '' })                    // git fetch
      .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/HEAD\nrefs/remotes/origin/main' }) // getDefaultBranch
      .mockResolvedValueOnce({ stdout: '' });                   // git worktree add

    // First mkdir call fails (read-only git root), second succeeds (fallback)
    mockMkdir
      .mockRejectedValueOnce(new Error('EACCES: permission denied'))
      .mockResolvedValue(undefined);

    const result = await createWorktree({
      workingDirectory: '/readonly-project',
      taskId: 'test-task-456',
    });

    expect(result).not.toBeNull();
    // Verify fallback mkdir was called with ~/.astro/worktrees/
    expect(mockMkdir).toHaveBeenCalledWith(
      '/home/testuser/.astro/worktrees/readonly-project',
      { recursive: true },
    );
  });

  it('should use baseBranch from .astro/config.json when available', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '/project\n' })        // getGitRoot
      .mockResolvedValueOnce({ stdout: '' })                   // hasCommits
      .mockResolvedValueOnce({ stdout: '' })                   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })                   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })                   // deleteRemoteBranch
      .mockResolvedValueOnce({ stdout: '' })                   // git fetch
      .mockResolvedValueOnce({ stdout: '' })                   // getDefaultBranch: rev-parse --verify (validates origin/develop exists)
      .mockResolvedValueOnce({ stdout: '' });                  // git worktree add

    mockMkdir.mockResolvedValue(undefined);
    // readFile: first call from getDefaultBranch reads baseBranch,
    // second call from readBranchPrefix reads branchPrefix
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ baseBranch: 'develop', branchPrefix: 'astro/' }))
      .mockResolvedValueOnce(JSON.stringify({ baseBranch: 'develop', branchPrefix: 'astro/' }));

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'test-task-basebranch',
    });

    expect(result).not.toBeNull();
    // Verify worktree was created from origin/develop instead of origin/main
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'worktree', 'add', '-b', 'astro/test-task-basebranch',
      ]),
      expect.any(Object),
    );
    // The worktree add call should reference origin/develop as the start point
    const worktreeAddCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes('worktree')
        && (call[1] as string[]).includes('add')
    );
    expect(worktreeAddCall).toBeDefined();
    expect((worktreeAddCall![1] as string[]).includes('origin/develop')).toBe(true);
  });

  it('should handle gitRoot with trailing slash correctly', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '/project/\n' })       // getGitRoot returns trailing slash
      .mockResolvedValueOnce({ stdout: '' })                   // hasCommits
      .mockResolvedValueOnce({ stdout: '' })                   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })                   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })                   // deleteRemoteBranch
      .mockResolvedValueOnce({ stdout: '' })                   // git fetch
      .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/HEAD\nrefs/remotes/origin/main' }) // getDefaultBranch
      .mockResolvedValueOnce({ stdout: '' });                  // git worktree add

    mockMkdir.mockResolvedValue(undefined);

    const result = await createWorktree({
      workingDirectory: '/project/',
      taskId: 'test-task-slash',
    });

    expect(result).not.toBeNull();
    // Trailing slash is resolved by path.resolve(), .astro/worktrees goes inside git root
    expect(mockMkdir).toHaveBeenCalledWith('/project/.astro/worktrees', { recursive: true });
  });

  it('should fall back to auto-detection when dispatchBaseBranch does not exist as a ref', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '/project\n' })         // 0: getGitRoot
      .mockResolvedValueOnce({ stdout: '' })                    // 1: hasCommits
      .mockResolvedValueOnce({ stdout: '' })                    // 2: pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })                    // 3: removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })                    // 4: ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })                    // 5: deleteRemoteBranch
      .mockResolvedValueOnce({ stdout: '' })                    // 6: repoHasRemote (no remote → skip fetch)
      .mockRejectedValueOnce(new Error('not a ref'))            // 7: refExists refs/heads/main → does not exist
      .mockRejectedValueOnce(new Error('not a ref'))            // 8: refExists refs/remotes/origin/main → does not exist
      // readBaseBranch: mockReadFile returns '' → JSON.parse fails → null
      // getDefaultBranch fallback chain:
      .mockRejectedValueOnce(new Error('no symbolic-ref'))      // 9: step 2: symbolic-ref
      .mockRejectedValueOnce(new Error('no remote branches'))   // 10: step 3: branch -r
      .mockRejectedValueOnce(new Error('no local branches'))    // 11: step 4: branch --list
      .mockResolvedValueOnce({ stdout: 'astro/c6fdf6\n' })     // 12: step 5: rev-parse --abbrev-ref HEAD → returns 'astro/c6fdf6'
      .mockRejectedValueOnce(new Error('no remote ref'))        // 13: refExists origin/astro/c6fdf6 (line 156)
      .mockRejectedValueOnce(new Error('no sha'))               // 14: commitBeforeSha (caught)
      .mockResolvedValueOnce({ stdout: '' });                   // 15: git worktree add

    mockMkdir.mockResolvedValue(undefined);

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'test-task-fallback',
      baseBranch: 'main', // server sends 'main' but it doesn't exist
    });

    expect(result).not.toBeNull();
    // The worktree add should use 'astro/c6fdf6' (auto-detected), NOT 'main'
    const worktreeAddCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes('worktree')
        && (call[1] as string[]).includes('add')
    );
    expect(worktreeAddCall).toBeDefined();
    // startPoint should be 'astro/c6fdf6' (not 'main'), since refExists for origin/ also failed
    expect((worktreeAddCall![1] as string[])).toContain('astro/c6fdf6');
    expect((worktreeAddCall![1] as string[])).not.toContain('main');
    expect((worktreeAddCall![1] as string[])).not.toContain('origin/main');
  });

  it('should use dispatchBaseBranch when it exists as a valid local ref', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '/project\n' })         // 0: getGitRoot
      .mockResolvedValueOnce({ stdout: '' })                    // 1: hasCommits
      .mockResolvedValueOnce({ stdout: '' })                    // 2: pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })                    // 3: removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })                    // 4: ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })                    // 5: deleteRemoteBranch
      .mockResolvedValueOnce({ stdout: '' })                    // 6: repoHasRemote (no remote → skip fetch)
      .mockResolvedValueOnce({ stdout: 'abc123\n' })            // 7: refExists refs/heads/main → exists!
      // dispatchBranchValid = true → uses 'main' directly
      .mockRejectedValueOnce(new Error('no remote ref'))        // 8: refExists origin/main (line 156)
      .mockRejectedValueOnce(new Error('no sha'))               // 9: commitBeforeSha (caught)
      .mockResolvedValueOnce({ stdout: '' });                   // 10: git worktree add

    mockMkdir.mockResolvedValue(undefined);

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'test-task-valid-dispatch',
      baseBranch: 'main', // 'main' exists locally
    });

    expect(result).not.toBeNull();
    // The worktree add should use 'main' as the start point
    const worktreeAddCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes('worktree')
        && (call[1] as string[]).includes('add')
    );
    expect(worktreeAddCall).toBeDefined();
    expect((worktreeAddCall![1] as string[])).toContain('main');
  });

  it('should use dispatchBaseBranch when it exists only as a remote ref', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '/project\n' })         // 0: getGitRoot
      .mockResolvedValueOnce({ stdout: '' })                    // 1: hasCommits
      .mockResolvedValueOnce({ stdout: '' })                    // 2: pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })                    // 3: removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })                    // 4: ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })                    // 5: deleteRemoteBranch
      .mockResolvedValueOnce({ stdout: '' })                    // 6: repoHasRemote (no remote → skip fetch)
      .mockRejectedValueOnce(new Error('not a ref'))            // 7: refExists refs/heads/main → does not exist locally
      .mockResolvedValueOnce({ stdout: 'abc123\n' })            // 8: refExists refs/remotes/origin/main → exists on remote!
      // dispatchBranchValid = true → uses 'main' directly
      .mockResolvedValueOnce({ stdout: 'abc123\n' })            // 9: refExists origin/main (line 156 — has remote ref)
      .mockResolvedValueOnce({ stdout: 'abc123\n' })            // 10: commitBeforeSha
      .mockResolvedValueOnce({ stdout: '' });                   // 11: git worktree add

    mockMkdir.mockResolvedValue(undefined);

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'test-task-remote-dispatch',
      baseBranch: 'main', // 'main' exists on remote only
    });

    expect(result).not.toBeNull();
    // The worktree add should use 'origin/main' as start point (since remote ref exists)
    const worktreeAddCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes('worktree')
        && (call[1] as string[]).includes('add')
    );
    expect(worktreeAddCall).toBeDefined();
    expect((worktreeAddCall![1] as string[])).toContain('origin/main');
  });

  it('should return non-standard branch from getDefaultBranch when no standard branches exist', async () => {
    // This tests Fix 2: getDefaultBranch step 6 — enumerate any local branch
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '/project\n' })         // 0: getGitRoot
      .mockResolvedValueOnce({ stdout: '' })                    // 1: hasCommits
      .mockResolvedValueOnce({ stdout: '' })                    // 2: pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })                    // 3: removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })                    // 4: ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })                    // 5: deleteRemoteBranch
      .mockResolvedValueOnce({ stdout: '' })                    // 6: repoHasRemote (no remote)
      // No baseBranch passed → dispatchBaseBranch is undefined → skip refExists
      // readBaseBranch: mockReadFile returns '' → fails → null
      // getDefaultBranch fallback chain:
      .mockRejectedValueOnce(new Error('no symbolic-ref'))      // 7: step 2: symbolic-ref
      .mockRejectedValueOnce(new Error('no remote'))            // 8: step 3: branch -r
      .mockRejectedValueOnce(new Error('no match'))             // 9: step 4: branch --list main/master
      .mockResolvedValueOnce({ stdout: 'HEAD\n' })              // 10: step 5: rev-parse --abbrev-ref HEAD → detached HEAD
      .mockResolvedValueOnce({ stdout: 'astro/c6fdf6-063f39\n' }) // 11: step 6: branch --format (new!) → non-standard branch
      .mockRejectedValueOnce(new Error('no remote'))            // 12: refExists origin/astro/c6fdf6-063f39 (line 156)
      .mockRejectedValueOnce(new Error('no sha'))               // 13: commitBeforeSha (caught)
      .mockResolvedValueOnce({ stdout: '' });                   // 14: git worktree add

    mockMkdir.mockResolvedValue(undefined);

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'test-task-nonstandard',
      // No baseBranch — force auto-detection via getDefaultBranch
    });

    expect(result).not.toBeNull();
    // The worktree add should use 'astro/c6fdf6-063f39' (the only local branch)
    const worktreeAddCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes('worktree')
        && (call[1] as string[]).includes('add')
    );
    expect(worktreeAddCall).toBeDefined();
    expect((worktreeAddCall![1] as string[])).toContain('astro/c6fdf6-063f39');
  });
});
