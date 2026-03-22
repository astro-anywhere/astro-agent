/**
 * Comprehensive tests for delivery branch logic.
 *
 * Covers:
 * - validateBranchName (via createWorktree)
 * - Singleton worktree creation (deliveryBranchIsSingleton)
 * - Delivery branch naming from shortProjectId/shortNodeId
 * - createDeliveryWorktree (persistent detached HEAD worktree)
 * - syncDeliveryWorktree (post-merge sync)
 * - cleanupDeliveryWorktree
 * - ensureDeliveryBranch (local + remote mode, race condition)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks (must be defined before vi.mock factories)
const mockExecFileAsync = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRm = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCopyFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockReadFile = vi.hoisted(() => vi.fn().mockResolvedValue(''));
const mockAppendFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockExistsSync = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockRepoHasRemote = vi.hoisted(() => vi.fn().mockResolvedValue(false));
const mockPushBranchToRemote = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));

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
  copyFile: mockCopyFile,
  cp: mockCp,
}));
vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  realpathSync: (p: string) => p,
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
vi.mock('../workdir-safety.js', () => ({
  repoHasRemote: mockRepoHasRemote,
}));
vi.mock('../git-pr.js', () => ({
  pushBranchToRemote: mockPushBranchToRemote,
}));

import {
  createWorktree,
  createDeliveryWorktree,
  syncDeliveryWorktree,
  cleanupDeliveryWorktree,
} from '../worktree.js';

beforeEach(() => {
  vi.resetAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockRepoHasRemote.mockResolvedValue(false);
  mockMkdir.mockResolvedValue(undefined);
  mockRm.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue('');
  mockAppendFile.mockResolvedValue(undefined);
  mockCopyFile.mockResolvedValue(undefined);
  mockCp.mockResolvedValue(undefined);
});

/**
 * Helper: set up the minimum mock chain for createWorktree to succeed.
 */
function setupCreateWorktreeBaseMocks(opts?: {
  gitRoot?: string;
  hasRemote?: boolean;
}) {
  const gitRoot = opts?.gitRoot ?? '/project';
  mockRepoHasRemote.mockResolvedValue(opts?.hasRemote ?? false);
  mockExecFileAsync
    .mockResolvedValueOnce({ stdout: `${gitRoot}\n` })  // getGitRoot
    .mockResolvedValueOnce({ stdout: '' });               // hasCommits
  mockMkdir.mockResolvedValue(undefined);
}

// ============================================================================
// validateBranchName (tested via createWorktree)
// ============================================================================

describe('validateBranchName (via createWorktree)', () => {
  it('should reject branch names with ".." (path traversal)', async () => {
    setupCreateWorktreeBaseMocks();
    await expect(
      createWorktree({
        workingDirectory: '/project',
        taskId: 'task-1',
        deliveryBranch: 'astro/../etc/passwd',
      }),
    ).rejects.toThrow('Invalid branch name');
  });

  it('should reject branch names with "//" (double slash)', async () => {
    setupCreateWorktreeBaseMocks();
    await expect(
      createWorktree({
        workingDirectory: '/project',
        taskId: 'task-1',
        deliveryBranch: 'astro//abc',
      }),
    ).rejects.toThrow('Invalid branch name');
  });

  it('should reject branch names starting with "/"', async () => {
    setupCreateWorktreeBaseMocks();
    await expect(
      createWorktree({
        workingDirectory: '/project',
        taskId: 'task-1',
        deliveryBranch: '/astro/abc',
      }),
    ).rejects.toThrow('Invalid branch name');
  });

  it('should reject branch names ending with "/"', async () => {
    setupCreateWorktreeBaseMocks();
    await expect(
      createWorktree({
        workingDirectory: '/project',
        taskId: 'task-1',
        deliveryBranch: 'astro/abc/',
      }),
    ).rejects.toThrow('Invalid branch name');
  });

  it('should reject branch names ending with ".lock"', async () => {
    setupCreateWorktreeBaseMocks();
    await expect(
      createWorktree({
        workingDirectory: '/project',
        taskId: 'task-1',
        deliveryBranch: 'astro/abc.lock',
      }),
    ).rejects.toThrow('Invalid branch name');
  });

  it('should reject branch names with dot-prefixed path components', async () => {
    setupCreateWorktreeBaseMocks();
    await expect(
      createWorktree({
        workingDirectory: '/project',
        taskId: 'task-1',
        deliveryBranch: 'astro/.hidden',
      }),
    ).rejects.toThrow('Invalid branch name');
  });

  it('should reject "." as a branch name', async () => {
    setupCreateWorktreeBaseMocks();
    await expect(
      createWorktree({
        workingDirectory: '/project',
        taskId: 'task-1',
        deliveryBranch: '.',
      }),
    ).rejects.toThrow('Invalid branch name');
  });

  it('should reject branch names with shell metacharacters', async () => {
    setupCreateWorktreeBaseMocks();
    await expect(
      createWorktree({
        workingDirectory: '/project',
        taskId: 'task-1',
        deliveryBranch: 'astro/abc;rm -rf /',
      }),
    ).rejects.toThrow('Invalid branch name');
  });

  it('should reject branch names exceeding 200 chars', async () => {
    setupCreateWorktreeBaseMocks();
    const longName = 'a'.repeat(201);
    await expect(
      createWorktree({
        workingDirectory: '/project',
        taskId: 'task-1',
        deliveryBranch: longName,
      }),
    ).rejects.toThrow('Invalid branch name');
  });

  it('should accept valid delivery branch names', async () => {
    setupCreateWorktreeBaseMocks();
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })   // pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })   // deleteRemoteBranch
      // getDefaultBranch fallback
      .mockRejectedValueOnce(new Error('no'))  // symbolic-ref
      .mockRejectedValueOnce(new Error('no'))  // branch -r
      .mockResolvedValueOnce({ stdout: '  main\n' })  // branch --list
      // ensureDeliveryBranch (local mode): refExists
      .mockResolvedValueOnce({ stdout: 'abc\n' }) // refs/heads/astro/7b19a9-e4f1a2
      // createDeliveryWorktree: refExists local ref
      .mockRejectedValueOnce(new Error('no'))  // no local ref for delivery worktree
      .mockRejectedValueOnce(new Error('no'))  // worktree add --detach fails (non-fatal)
      // refExists for origin/astro/7b19a9-e4f1a2
      .mockRejectedValueOnce(new Error('no'))
      .mockRejectedValueOnce(new Error('no'))  // commitBeforeSha
      .mockResolvedValueOnce({ stdout: '' });  // git worktree add

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'task-1',
      deliveryBranch: 'astro/7b19a9-e4f1a2',
      shortProjectId: '7b19a9',
      shortNodeId: 'a1b2c3',
    });

    expect(result).not.toBeNull();
  });
});

// ============================================================================
// Delivery branch naming from shortProjectId/shortNodeId
// ============================================================================

describe('delivery branch naming', () => {
  it('should construct task branch as astro/{shortProjectId}-{shortNodeId}', async () => {
    setupCreateWorktreeBaseMocks();
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })   // pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })   // deleteRemoteBranch
      // getDefaultBranch
      .mockRejectedValueOnce(new Error('no'))  // symbolic-ref
      .mockRejectedValueOnce(new Error('no'))  // branch -r
      .mockResolvedValueOnce({ stdout: '  main\n' })  // branch --list
      // ensureDeliveryBranch (local mode): refExists for the delivery branch
      .mockRejectedValueOnce(new Error('not found'))  // refs/heads/astro/abc123 does not exist
      .mockResolvedValueOnce({ stdout: '' })           // git branch astro/abc123 main (create)
      // createDeliveryWorktree
      .mockRejectedValueOnce(new Error('no'))  // refExists local
      .mockRejectedValueOnce(new Error('no'))  // worktree add --detach (non-fatal)
      // refExists for origin/astro/abc123
      .mockRejectedValueOnce(new Error('no'))
      .mockRejectedValueOnce(new Error('no'))  // commitBeforeSha
      .mockResolvedValueOnce({ stdout: '' });  // git worktree add

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'task-001',
      shortProjectId: 'abc123',
      shortNodeId: 'def456',
    });

    expect(result).not.toBeNull();
    expect(result!.branchName).toBe('astro/abc123-def456');
  });

  it('should use taskId as branch suffix when shortProjectId/shortNodeId are missing', async () => {
    setupCreateWorktreeBaseMocks();
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })   // pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })   // deleteRemoteBranch
      .mockRejectedValueOnce(new Error('no'))  // symbolic-ref
      .mockRejectedValueOnce(new Error('no'))  // branch -r
      .mockResolvedValueOnce({ stdout: '  main\n' })  // branch --list
      .mockRejectedValueOnce(new Error('no'))  // refExists origin/main
      .mockRejectedValueOnce(new Error('no'))  // commitBeforeSha
      .mockResolvedValueOnce({ stdout: '' });  // worktree add

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'my-task-id',
    });

    expect(result).not.toBeNull();
    expect(result!.branchName).toBe('astro/my-task-id');
  });

  it('should sanitize special characters in shortProjectId', async () => {
    setupCreateWorktreeBaseMocks();
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })   // pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })   // deleteRemoteBranch
      .mockRejectedValueOnce(new Error('no'))  // symbolic-ref
      .mockRejectedValueOnce(new Error('no'))  // branch -r
      .mockResolvedValueOnce({ stdout: '  main\n' })  // branch --list
      // ensureDeliveryBranch
      .mockRejectedValueOnce(new Error('not found'))  // refExists delivery branch
      .mockResolvedValueOnce({ stdout: '' })           // git branch create
      // createDeliveryWorktree
      .mockRejectedValueOnce(new Error('no'))  // refExists local
      .mockRejectedValueOnce(new Error('no'))  // worktree add (non-fatal)
      // rest
      .mockRejectedValueOnce(new Error('no'))  // refExists origin
      .mockRejectedValueOnce(new Error('no'))  // commitBeforeSha
      .mockResolvedValueOnce({ stdout: '' });  // worktree add

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'task-1',
      shortProjectId: 'ab@cd#ef',
      shortNodeId: 'gh!ij',
    });

    expect(result).not.toBeNull();
    // Special chars replaced with '_'
    expect(result!.branchName).toBe('astro/ab_cd_ef-gh_ij');
  });
});

// ============================================================================
// Singleton delivery branch (deliveryBranchIsSingleton)
// ============================================================================

describe('singleton delivery branch', () => {
  it('should work directly on the delivery branch (no task sub-branch)', async () => {
    setupCreateWorktreeBaseMocks();
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })   // pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })   // removeLingeringWorktrees: list
      // NO ensureBranchAvailable (singleton skips it)
      // NO deleteRemoteBranch (singleton skips it)
      // getDefaultBranch
      .mockRejectedValueOnce(new Error('no'))  // symbolic-ref
      .mockRejectedValueOnce(new Error('no'))  // branch -r
      .mockResolvedValueOnce({ stdout: '  main\n' })  // branch --list
      // ensureDeliveryBranch (local mode): refExists
      .mockResolvedValueOnce({ stdout: 'abc\n' })  // refs/heads/astro/singleton01 exists
      // refExists origin/astro/singleton01
      .mockRejectedValueOnce(new Error('no'))
      .mockRejectedValueOnce(new Error('no'))  // commitBeforeSha
      .mockResolvedValueOnce({ stdout: '' });  // git worktree add (singleton checkout)

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'task-1',
      shortProjectId: 'singleton01',
      shortNodeId: 'n1',
      deliveryBranch: 'astro/singleton01',
      deliveryBranchIsSingleton: true,
    });

    expect(result).not.toBeNull();
    // Branch name IS the delivery branch (no task sub-branch)
    expect(result!.branchName).toBe('astro/singleton01');
    // Singleton: deliveryBranch should be undefined (PR targets base directly)
    expect(result!.deliveryBranch).toBeUndefined();
    // Singleton: deliveryWorktreePath should be undefined (task worktree IS the delivery worktree)
    expect(result!.deliveryWorktreePath).toBeUndefined();
    // baseBranch should be the default branch (main), not the delivery branch
    expect(result!.baseBranch).toBe('main');
  });

  it('should throw if deliveryBranchIsSingleton=true but no delivery branch name', async () => {
    setupCreateWorktreeBaseMocks();
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' });  // pruneWorktrees

    await expect(
      createWorktree({
        workingDirectory: '/project',
        taskId: 'task-1',
        deliveryBranchIsSingleton: true,
        // No deliveryBranch, no shortProjectId → no deliveryBranchName
      }),
    ).rejects.toThrow('Singleton delivery branch requires deliveryBranchName');
  });

  it('should retry singleton checkout after pruning stale worktrees', async () => {
    setupCreateWorktreeBaseMocks();
    const alreadyCheckedOutErr = new Error('fatal: astro/singleton01 is already checked out');

    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })   // pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })   // removeLingeringWorktrees: list
      .mockRejectedValueOnce(new Error('no'))  // symbolic-ref
      .mockRejectedValueOnce(new Error('no'))  // branch -r
      .mockResolvedValueOnce({ stdout: '  main\n' })  // branch --list
      .mockResolvedValueOnce({ stdout: 'abc\n' })  // ensureDeliveryBranch: refExists
      .mockRejectedValueOnce(new Error('no'))  // refExists origin
      .mockRejectedValueOnce(new Error('no'))  // commitBeforeSha
      .mockRejectedValueOnce(alreadyCheckedOutErr) // first worktree add: already checked out
      .mockResolvedValueOnce({ stdout: '' })        // worktree prune (retry)
      .mockResolvedValueOnce({ stdout: '' });       // second worktree add: success

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'task-1',
      deliveryBranch: 'astro/singleton01',
      deliveryBranchIsSingleton: true,
      shortProjectId: 'singleton01',
      shortNodeId: 'n1',
    });

    expect(result).not.toBeNull();
    expect(result!.branchName).toBe('astro/singleton01');
  });

  it('should throw clear error if singleton branch still locked after prune', async () => {
    setupCreateWorktreeBaseMocks();
    const alreadyCheckedOutErr = new Error('fatal: astro/singleton01 is already checked out');

    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })   // pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })   // removeLingeringWorktrees: list
      .mockRejectedValueOnce(new Error('no'))  // symbolic-ref
      .mockRejectedValueOnce(new Error('no'))  // branch -r
      .mockResolvedValueOnce({ stdout: '  main\n' })  // branch --list
      .mockResolvedValueOnce({ stdout: 'abc\n' })  // ensureDeliveryBranch: refExists
      .mockRejectedValueOnce(new Error('no'))  // refExists origin
      .mockRejectedValueOnce(new Error('no'))  // commitBeforeSha
      .mockRejectedValueOnce(alreadyCheckedOutErr) // first: already checked out
      .mockResolvedValueOnce({ stdout: '' })        // worktree prune
      .mockRejectedValueOnce(alreadyCheckedOutErr); // second: STILL checked out

    await expect(
      createWorktree({
        workingDirectory: '/project',
        taskId: 'task-1',
        deliveryBranch: 'astro/singleton01',
        deliveryBranchIsSingleton: true,
        shortProjectId: 'singleton01',
        shortNodeId: 'n1',
      }),
    ).rejects.toThrow('still checked out after pruning');
  });
});

// ============================================================================
// createDeliveryWorktree (persistent detached HEAD worktree)
// ============================================================================

describe('createDeliveryWorktree', () => {
  it('should create a detached HEAD worktree at baseRoot/shortProjectId', async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // refExists refs/heads/astro/proj01
      .mockResolvedValueOnce({ stdout: '' });         // git worktree add --detach

    const result = await createDeliveryWorktree(
      '/project',
      'astro/proj01',
      '/project/.astro/worktrees',
      'proj01',
    );

    expect(result).toBe('/project/.astro/worktrees/proj01');
    // Check that worktree add was called with --detach and local ref
    const wtAddCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('worktree') && args.includes('add') && args.includes('--detach');
      },
    );
    expect(wtAddCall).toBeDefined();
    expect((wtAddCall![1] as string[])).toContain('refs/heads/astro/proj01');
  });

  it('should return existing path if worktree already exists (idempotent)', async () => {
    mockExistsSync.mockReturnValue(true);

    const result = await createDeliveryWorktree(
      '/project',
      'astro/proj01',
      '/project/.astro/worktrees',
      'proj01',
    );

    expect(result).toBe('/project/.astro/worktrees/proj01');
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('should handle race condition (another task created it first)', async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'abc123\n' })  // refExists
      .mockRejectedValueOnce(new Error('fatal: already registered')); // race

    const result = await createDeliveryWorktree(
      '/project',
      'astro/proj01',
      '/project/.astro/worktrees',
      'proj01',
    );

    expect(result).toBe('/project/.astro/worktrees/proj01');
  });

  it('should fall back to remote ref when local ref is missing', async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('not a ref'))  // refExists local: fails
      .mockResolvedValueOnce({ stdout: '' });          // git worktree add --detach

    const result = await createDeliveryWorktree(
      '/project',
      'astro/proj01',
      '/project/.astro/worktrees',
      'proj01',
    );

    expect(result).toBe('/project/.astro/worktrees/proj01');
    // Check that it used origin/ prefix
    const wtAddCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('worktree') && args.includes('add') && args.includes('--detach');
      },
    );
    expect(wtAddCall).toBeDefined();
    expect((wtAddCall![1] as string[])).toContain('origin/astro/proj01');
  });

  it('should return null on non-race failure', async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'abc\n' })     // refExists local
      .mockRejectedValueOnce(new Error('some git error'));

    const result = await createDeliveryWorktree(
      '/project',
      'astro/proj01',
      '/project/.astro/worktrees',
      'proj01',
    );

    expect(result).toBeNull();
  });
});

// ============================================================================
// syncDeliveryWorktree
// ============================================================================

describe('syncDeliveryWorktree', () => {
  it('should no-op if worktree path does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    await syncDeliveryWorktree('/nonexistent', 'astro/proj01', '/project');
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('should checkout local ref for local-only repos', async () => {
    mockExistsSync.mockReturnValue(true);
    mockRepoHasRemote.mockResolvedValue(false);
    mockExecFileAsync.mockResolvedValue({ stdout: '' });

    await syncDeliveryWorktree('/project/.astro/worktrees/proj01', 'astro/proj01', '/project');

    // Only one call: checkout (no fetch for local-only repos)
    const checkoutCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('checkout') && args.includes('--detach');
      },
    );
    expect(checkoutCall).toBeDefined();
    expect((checkoutCall![1] as string[])).toContain('refs/heads/astro/proj01');
  });

  it('should fetch and use remote ref for repos with a remote', async () => {
    mockExistsSync.mockReturnValue(true);
    mockRepoHasRemote.mockResolvedValue(true);
    mockExecFileAsync.mockResolvedValue({ stdout: '' });

    await syncDeliveryWorktree('/project/.astro/worktrees/proj01', 'astro/proj01', '/project');

    // Should have fetched
    const fetchCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('fetch') && args.includes('origin');
      },
    );
    expect(fetchCall).toBeDefined();

    // Should checkout remote ref
    const checkoutCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('checkout') && args.includes('--detach');
      },
    );
    expect(checkoutCall).toBeDefined();
    expect((checkoutCall![1] as string[])).toContain('origin/astro/proj01');
  });

  it('should fall back to local ref when fetch fails', async () => {
    mockExistsSync.mockReturnValue(true);
    mockRepoHasRemote.mockResolvedValue(true);
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('fetch failed'))  // fetch
      .mockResolvedValueOnce({ stdout: '' });             // checkout

    await syncDeliveryWorktree('/project/.astro/worktrees/proj01', 'astro/proj01', '/project');

    // Should have attempted fetch
    expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
    // The checkout call (second) should use local ref since fetch failed
    const checkoutArgs = mockExecFileAsync.mock.calls[1][1] as string[];
    expect(checkoutArgs).toContain('refs/heads/astro/proj01');
  });

  it('should not throw on checkout failure (non-fatal)', async () => {
    mockExistsSync.mockReturnValue(true);
    mockRepoHasRemote.mockResolvedValue(false);
    mockExecFileAsync.mockRejectedValue(new Error('checkout failed'));

    await expect(
      syncDeliveryWorktree('/project/.astro/worktrees/proj01', 'astro/proj01', '/project'),
    ).resolves.toBeUndefined();
  });
});

// ============================================================================
// cleanupDeliveryWorktree
// ============================================================================

describe('cleanupDeliveryWorktree', () => {
  it('should no-op if path does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    await cleanupDeliveryWorktree('/project', '/nonexistent');
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('should remove worktree and prune', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })  // worktree remove --force
      .mockResolvedValueOnce({ stdout: '' }); // worktree prune

    await cleanupDeliveryWorktree('/project', '/project/.astro/worktrees/proj01');

    const removeCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('worktree') && args.includes('remove');
      },
    );
    expect(removeCall).toBeDefined();

    const pruneCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('worktree') && args.includes('prune');
      },
    );
    expect(pruneCall).toBeDefined();
  });

  it('should fall back to rm when worktree remove fails', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('worktree remove failed'))  // remove fails
      .mockResolvedValueOnce({ stdout: '' });                       // prune

    await cleanupDeliveryWorktree('/project', '/project/.astro/worktrees/proj01');

    expect(mockRm).toHaveBeenCalledWith(
      '/project/.astro/worktrees/proj01',
      { recursive: true, force: true },
    );
  });
});

// ============================================================================
// ensureDeliveryBranch (tested via createWorktree)
// ============================================================================

describe('ensureDeliveryBranch (via createWorktree)', () => {
  it('should create delivery branch locally when no remote exists', async () => {
    setupCreateWorktreeBaseMocks({ hasRemote: false });
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })   // pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })   // deleteRemoteBranch
      // getDefaultBranch
      .mockRejectedValueOnce(new Error('no'))  // symbolic-ref
      .mockRejectedValueOnce(new Error('no'))  // branch -r
      .mockResolvedValueOnce({ stdout: '  main\n' })  // branch --list
      // ensureDeliveryBranch (local mode):
      .mockRejectedValueOnce(new Error('not a ref'))  // refExists refs/heads — does not exist
      .mockResolvedValueOnce({ stdout: '' })           // git branch create → success
      // createDeliveryWorktree
      .mockRejectedValueOnce(new Error('no'))  // refExists local
      .mockRejectedValueOnce(new Error('no'))  // worktree add --detach
      // rest of createWorktree
      .mockRejectedValueOnce(new Error('no'))  // refExists origin/astro/...
      .mockRejectedValueOnce(new Error('no'))  // commitBeforeSha
      .mockResolvedValueOnce({ stdout: '' });  // worktree add

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'task-1',
      shortProjectId: 'abc123',
      shortNodeId: 'def456',
      deliveryBranch: 'astro/abc123',
    });

    expect(result).not.toBeNull();
    // Verify git branch was called to create the delivery branch
    const createBranchCall = mockExecFileAsync.mock.calls.find(
      (call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('branch') && args.includes('astro/abc123') && args.includes('main');
      },
    );
    expect(createBranchCall).toBeDefined();
  });

  it('should skip creation when delivery branch already exists locally', async () => {
    setupCreateWorktreeBaseMocks({ hasRemote: false });
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })   // pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })   // deleteRemoteBranch
      .mockRejectedValueOnce(new Error('no'))  // symbolic-ref
      .mockRejectedValueOnce(new Error('no'))  // branch -r
      .mockResolvedValueOnce({ stdout: '  main\n' })  // branch --list
      // ensureDeliveryBranch: refExists → branch already exists
      .mockResolvedValueOnce({ stdout: 'abc123\n' })  // refs/heads/astro/abc123 exists
      // createDeliveryWorktree
      .mockRejectedValueOnce(new Error('no'))  // refExists local
      .mockRejectedValueOnce(new Error('no'))  // worktree add --detach
      // rest
      .mockRejectedValueOnce(new Error('no'))  // refExists origin
      .mockRejectedValueOnce(new Error('no'))  // commitBeforeSha
      .mockResolvedValueOnce({ stdout: '' });  // worktree add

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'task-1',
      shortProjectId: 'abc123',
      shortNodeId: 'def456',
      deliveryBranch: 'astro/abc123',
    });

    expect(result).not.toBeNull();
    // Should NOT have created the branch (no call to `git branch astro/abc123 main`)
    const createCalls = mockExecFileAsync.mock.calls.filter(
      (call: unknown[]) => {
        const args = call[1] as string[];
        return args.length >= 4 && args[2] === 'branch' && args[3] === 'astro/abc123' && args[4] === 'main';
      },
    );
    expect(createCalls).toHaveLength(0);
  });

  it('should handle race condition: "already exists" from concurrent task', async () => {
    setupCreateWorktreeBaseMocks({ hasRemote: false });
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })   // pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })   // deleteRemoteBranch
      .mockRejectedValueOnce(new Error('no'))  // symbolic-ref
      .mockRejectedValueOnce(new Error('no'))  // branch -r
      .mockResolvedValueOnce({ stdout: '  main\n' })  // branch --list
      // ensureDeliveryBranch: refExists → does not exist
      .mockRejectedValueOnce(new Error('not found'))
      // git branch create → race: already exists
      .mockRejectedValueOnce(new Error('fatal: a branch named astro/abc123 already exists'))
      // createDeliveryWorktree
      .mockRejectedValueOnce(new Error('no'))  // refExists local
      .mockRejectedValueOnce(new Error('no'))  // worktree add --detach
      // rest
      .mockRejectedValueOnce(new Error('no'))  // refExists origin
      .mockRejectedValueOnce(new Error('no'))  // commitBeforeSha
      .mockResolvedValueOnce({ stdout: '' });  // worktree add

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'task-1',
      shortProjectId: 'abc123',
      shortNodeId: 'def456',
      deliveryBranch: 'astro/abc123',
    });

    expect(result).not.toBeNull();
  });

  it('should create and push delivery branch for repos with remote', async () => {
    setupCreateWorktreeBaseMocks({ hasRemote: true });
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })   // pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })   // deleteRemoteBranch
      .mockResolvedValueOnce({ stdout: '' })   // git fetch origin
      // getDefaultBranch
      .mockRejectedValueOnce(new Error('no'))  // symbolic-ref
      .mockRejectedValueOnce(new Error('no'))  // branch -r
      .mockResolvedValueOnce({ stdout: '  main\n' })  // branch --list
      // ensureDeliveryBranch (remote mode):
      .mockRejectedValueOnce(new Error('no'))  // refExists origin/astro/abc123 → not on remote
      .mockRejectedValueOnce(new Error('no'))  // refExists refs/heads/astro/abc123 → not local either
      // create from defaultBranch: check origin/main
      .mockRejectedValueOnce(new Error('no'))  // refExists origin/main
      // git branch create from main (local fallback)
      .mockResolvedValueOnce({ stdout: '' })
      // pushBranchToRemote handled by mock
      // createDeliveryWorktree
      .mockRejectedValueOnce(new Error('no'))  // refExists local
      .mockRejectedValueOnce(new Error('no'))  // worktree add --detach (non-fatal)
      // rest of createWorktree
      .mockRejectedValueOnce(new Error('no'))  // refExists origin/astro/abc123
      .mockRejectedValueOnce(new Error('no'))  // commitBeforeSha
      .mockResolvedValueOnce({ stdout: '' });  // worktree add

    mockPushBranchToRemote.mockResolvedValue({ ok: true });

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'task-1',
      shortProjectId: 'abc123',
      shortNodeId: 'def456',
      deliveryBranch: 'astro/abc123',
    });

    expect(result).not.toBeNull();
    expect(mockPushBranchToRemote).toHaveBeenCalledWith(
      '/project',
      'astro/abc123',
      expect.objectContaining({ label: 'ensureDeliveryBranch' }),
    );
  });
});

// ============================================================================
// Multi-task: deliveryBranch and deliveryWorktreePath are set
// ============================================================================

describe('multi-task delivery branch mode', () => {
  it('should set deliveryBranch and baseBranch in returned WorktreeSetup', async () => {
    setupCreateWorktreeBaseMocks();
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })   // pruneWorktrees
      .mockResolvedValueOnce({ stdout: '' })   // removeLingeringWorktrees: list
      .mockResolvedValueOnce({ stdout: '' })   // ensureBranchAvailable
      .mockResolvedValueOnce({ stdout: '' })   // deleteRemoteBranch
      .mockRejectedValueOnce(new Error('no'))  // symbolic-ref
      .mockRejectedValueOnce(new Error('no'))  // branch -r
      .mockResolvedValueOnce({ stdout: '  main\n' })  // branch --list
      // ensureDeliveryBranch: already exists
      .mockResolvedValueOnce({ stdout: 'abc\n' })
      // createDeliveryWorktree: local ref exists, worktree created
      .mockResolvedValueOnce({ stdout: 'abc\n' })
      .mockResolvedValueOnce({ stdout: '' })   // worktree add --detach
      // rest
      .mockRejectedValueOnce(new Error('no'))  // refExists origin/delivery
      .mockRejectedValueOnce(new Error('no'))  // commitBeforeSha
      .mockResolvedValueOnce({ stdout: '' });  // worktree add

    const result = await createWorktree({
      workingDirectory: '/project',
      taskId: 'task-1',
      shortProjectId: 'proj01',
      shortNodeId: 'node01',
      deliveryBranch: 'astro/proj01',
    });

    expect(result).not.toBeNull();
    // Multi-task: deliveryBranch is set
    expect(result!.deliveryBranch).toBe('astro/proj01');
    // baseBranch is the delivery branch (effectiveBase) in multi-task mode
    expect(result!.baseBranch).toBe('astro/proj01');
    // Task branch is distinct from delivery branch
    expect(result!.branchName).toBe('astro/proj01-node01');
    expect(result!.branchName).not.toBe(result!.deliveryBranch);
  });
});

// ============================================================================
// Abort signal handling
// ============================================================================

describe('abort signal during worktree creation', () => {
  it('should throw on pre-aborted signal', async () => {
    setupCreateWorktreeBaseMocks();
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '' });  // pruneWorktrees

    const controller = new AbortController();
    controller.abort();

    await expect(
      createWorktree({
        workingDirectory: '/project',
        taskId: 'task-1',
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled during workspace preparation');
  });
});
