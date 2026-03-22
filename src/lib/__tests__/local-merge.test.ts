/**
 * Tests for local-merge — squash-merge task branches into delivery branches locally.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type GitResponse = { stdout?: string; error?: Error };

// The mock must have [promisify.custom] set BEFORE the module imports it,
// because local-merge.ts does `const execFileAsync = promisify(execFile)` at top level.
const mockExecFile = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _promisify = require('node:util').promisify;
  const fn = (...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
    }
  };
  // This is what promisify(execFile) will call
  (fn as unknown as Record<symbol, unknown>)[_promisify.custom] = (_cmd: string, gitArgs: string[]) => {
    return new Promise((resolve, reject) => {
      const filtered = (gitArgs as string[]).filter((a: string, i: number, arr: string[]) => {
        if (a === '-C') return false;
        if (i > 0 && arr[i - 1] === '-C') return false;
        return true;
      });
      const key = filtered.join(' ');

      // We'll use a global to pass responses since hoisted runs before module scope
      const responses = (globalThis as unknown as Record<string, Record<string, GitResponse>>).__gitResponses ?? {};
      for (const [pattern, response] of Object.entries(responses) as [string, GitResponse][]) {
        if (key.includes(pattern)) {
          if (response.error) {
            reject(response.error);
          } else {
            resolve({ stdout: response.stdout ?? '', stderr: '' });
          }
          return;
        }
      }
      resolve({ stdout: '', stderr: '' });
    });
  };
  return fn;
});

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:fs/promises', () => ({
  rm: vi.fn().mockResolvedValue(undefined),
}));

import { localMergeIntoDeliveryBranch } from '../local-merge.js';

describe('localMergeIntoDeliveryBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as unknown as Record<string, unknown>).__gitResponses = {};
  });

  function setGitResponses(responses: Record<string, GitResponse>) {
    (globalThis as unknown as Record<string, unknown>).__gitResponses = responses;
  }

  it('returns merged=false when there are no changes between branches', async () => {
    setGitResponses({
      'diff --stat': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo',
      'astro/abc123-def456',
      'astro/abc123',
      'test commit',
    );

    expect(result.merged).toBe(false);
    expect(result.conflict).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('performs squash merge and returns commit SHA on success', async () => {
    setGitResponses({
      'diff --stat': { stdout: ' src/index.ts | 5 ++---\n 1 file changed\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { stdout: '' },
      'commit -m': { stdout: '' },
      'rev-parse HEAD': { stdout: 'abc123def456\n' },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo',
      'astro/abc123-def456',
      'astro/abc123',
      '[abc123/def456] Fix the thing',
    );

    expect(result.merged).toBe(true);
    expect(result.commitSha).toBe('abc123def456');
  });

  it('detects merge conflicts and returns conflict files', async () => {
    setGitResponses({
      'diff --stat': { stdout: ' src/index.ts | 5 ++---\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { error: new Error('CONFLICT') },
      'status --porcelain': { stdout: 'UU src/index.ts\nUU src/lib.ts\n' },
      'merge --abort': { stdout: '' },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo',
      'astro/abc123-def456',
      'astro/abc123',
      'test commit',
    );

    expect(result.merged).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.conflictFiles).toEqual(['src/index.ts', 'src/lib.ts']);
  });

  it('returns error when worktree creation fails', async () => {
    setGitResponses({
      'diff --stat': { stdout: ' src/index.ts | 5 ++---\n' },
      'worktree add': { error: new Error('worktree already exists') },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo',
      'astro/abc123-def456',
      'astro/abc123',
      'test commit',
    );

    expect(result.merged).toBe(false);
    expect(result.error).toContain('Failed to create merge worktree');
  });

  it('returns merged=false when commit has nothing (identical trees)', async () => {
    setGitResponses({
      'diff --stat': { stdout: ' src/index.ts | 5 ++---\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { stdout: '' },
      'commit -m': { error: new Error('nothing to commit') },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo',
      'astro/abc123-def456',
      'astro/abc123',
      'test commit',
    );

    expect(result.merged).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('cleans up temp worktree even when merge fails with non-conflict error', async () => {
    setGitResponses({
      'diff --stat': { stdout: ' src/index.ts | 5 ++---\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { error: new Error('merge failed badly') },
      'status --porcelain': { stdout: 'M src/index.ts\n' }, // No conflict markers (UU/AA/etc)
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo',
      'astro/abc123-def456',
      'astro/abc123',
      'test commit',
    );

    expect(result.merged).toBe(false);
    expect(result.error).toContain('Merge failed');
  });

  it('proceeds with merge when diff check fails', async () => {
    // When diff --stat fails (e.g., branch doesn't exist yet), code should proceed
    setGitResponses({
      'diff --stat': { error: new Error('unknown revision') },
      'worktree add': { stdout: '' },
      'merge --squash': { stdout: '' },
      'commit -m': { stdout: '' },
      'rev-parse HEAD': { stdout: 'deadbeef1234\n' },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo',
      'astro/abc123-def456',
      'astro/abc123',
      'test commit',
    );

    expect(result.merged).toBe(true);
    expect(result.commitSha).toBe('deadbeef1234');
  });

  it('uses reset --merge (not merge --abort) for squash conflict cleanup', async () => {
    // git merge --abort does NOT work after merge --squash (no MERGE_HEAD).
    // The code should use `git reset --merge` instead.
    setGitResponses({
      'diff --stat': { stdout: ' file.ts | 3 +-\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { error: new Error('CONFLICT (content)') },
      'status --porcelain': { stdout: 'UU file.ts\n' },
      'reset --merge': { stdout: '' },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo', 'task-branch', 'project-branch', 'msg',
    );

    expect(result.merged).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.conflictFiles).toEqual(['file.ts']);
  });

  it('handles rev-parse HEAD failure after successful commit', async () => {
    // If commit succeeds but rev-parse HEAD fails, return structured error (not throw)
    setGitResponses({
      'diff --stat': { stdout: ' file.ts | 3 +-\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { stdout: '' },
      'commit -m': { stdout: '' },
      'rev-parse HEAD': { error: new Error('ambiguous argument HEAD') },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch('/repo', 'task', 'proj', 'msg');
    expect(result.merged).toBe(false);
    expect(result.error).toContain('failed to capture SHA');
  });

  it('falls back to rm + prune when worktree remove fails in cleanup', async () => {
    const mockRm = (await import('node:fs/promises')).rm as ReturnType<typeof vi.fn>;

    setGitResponses({
      'diff --stat': { stdout: ' file.ts | 3 +-\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { stdout: '' },
      'commit -m': { stdout: '' },
      'rev-parse HEAD': { stdout: 'abc123\n' },
      'worktree remove': { error: new Error('worktree remove failed') },
      'worktree prune': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo', 'task', 'proj', 'msg',
    );

    // Merge should still succeed
    expect(result.merged).toBe(true);
    expect(result.commitSha).toBe('abc123');

    // rm should have been called as fallback cleanup
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('.astro/tmp-merge/merge-'),
      { recursive: true, force: true },
    );
  });

  it('handles merge failure when status --porcelain also fails', async () => {
    // If both merge and status fail, should return a generic error
    setGitResponses({
      'diff --stat': { stdout: ' file.ts | 3 +-\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { error: new Error('merge failed') },
      'status --porcelain': { error: new Error('status also failed') },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo', 'task', 'proj', 'msg',
    );

    expect(result.merged).toBe(false);
    expect(result.error).toContain('Merge failed');
    // Should NOT have conflict info since status check failed
    expect(result.conflict).toBeUndefined();
  });

  it('distinguishes conflict markers from regular modifications in status', async () => {
    // Only UU, AA, DD, AU, UA, DU, UD are conflict markers.
    // M, A, D are normal changes and should NOT be treated as conflicts.
    setGitResponses({
      'diff --stat': { stdout: ' file.ts | 3 +-\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { error: new Error('merge issue') },
      'status --porcelain': {
        stdout: 'M  normal-modified.ts\nA  normal-added.ts\nD  normal-deleted.ts\n',
      },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo', 'task', 'proj', 'msg',
    );

    // No UU/AA/etc markers → should NOT be treated as a conflict
    expect(result.conflict).toBeUndefined();
    expect(result.error).toContain('Merge failed');
  });

  it('correctly parses all conflict marker types', async () => {
    setGitResponses({
      'diff --stat': { stdout: ' file.ts | 3 +-\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { error: new Error('CONFLICT') },
      'status --porcelain': {
        stdout: [
          'UU both-modified.ts',    // Both modified
          'AA both-added.ts',        // Both added
          'DD both-deleted.ts',      // Both deleted
          'AU added-by-us.ts',       // Added by us, modified by them
          'M  cleanly-staged.ts',    // Not a conflict
          '',
        ].join('\n'),
      },
      'reset --merge': { stdout: '' },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo', 'task', 'proj', 'msg',
    );

    expect(result.conflict).toBe(true);
    expect(result.conflictFiles).toHaveLength(4);
    expect(result.conflictFiles).toContain('both-modified.ts');
    expect(result.conflictFiles).toContain('both-added.ts');
    expect(result.conflictFiles).toContain('both-deleted.ts');
    expect(result.conflictFiles).toContain('added-by-us.ts');
    // cleanly-staged.ts should NOT be in conflict list
    expect(result.conflictFiles).not.toContain('cleanly-staged.ts');
  });

  it('trims whitespace from commit SHA', async () => {
    setGitResponses({
      'diff --stat': { stdout: ' file | 1 +\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { stdout: '' },
      'commit -m': { stdout: '' },
      'rev-parse HEAD': { stdout: '  abc123def456789  \n\n' },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo', 'task', 'proj', 'msg',
    );

    expect(result.commitSha).toBe('abc123def456789');
  });

  it('returns error when commit fails for non-empty-tree reason (e.g., pre-commit hook)', async () => {
    setGitResponses({
      'diff --stat': { stdout: ' src/index.ts | 5 ++---\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { stdout: '' },
      'commit -m': { error: new Error('pre-commit hook rejected: lint failed') },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo', 'task', 'proj', 'msg',
    );

    expect(result.merged).toBe(false);
    expect(result.error).toContain('Commit failed');
    expect(result.error).toContain('pre-commit hook');
  });

  it('handles diff --stat with whitespace-only output as no changes', async () => {
    setGitResponses({
      'diff --stat': { stdout: '   \n  \n' },
    });

    const result = await localMergeIntoDeliveryBranch(
      '/repo', 'task', 'proj', 'msg',
    );

    expect(result.merged).toBe(false);
  });

  it('detects "nothing to commit" in stdout of error object (Node execFile behavior)', async () => {
    // Node's promisify(execFile) puts git's actual output in error.stdout,
    // while error.message is just "Command failed: git -C ...".
    // This test verifies we check all three fields.
    const err = new Error('Command failed: git -C /tmp/merge commit -m msg') as Error & { stdout: string; stderr: string };
    err.stdout = 'On branch astro/proj\nnothing to commit, working tree clean\n';
    err.stderr = '';

    setGitResponses({
      'diff --stat': { stdout: ' file.ts | 3 +-\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { stdout: '' },
      'commit -m': { error: err },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch('/repo', 'task', 'proj', 'msg');
    expect(result.merged).toBe(false);
    // Should NOT have an error — this is the "nothing to commit" case
    expect(result.error).toBeUndefined();
  });

  it('detects "nothing added to commit" variant', async () => {
    const err = new Error('Command failed: git commit') as Error & { stdout: string; stderr: string };
    err.stdout = 'nothing added to commit (use "git add" and/or "git commit -a")\n';
    err.stderr = '';

    setGitResponses({
      'diff --stat': { stdout: ' file.ts | 3 +-\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { stdout: '' },
      'commit -m': { error: err },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch('/repo', 'task', 'proj', 'msg');
    expect(result.merged).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('real commit error (not nothing-to-commit) surfaces the error', async () => {
    const err = new Error('Command failed: git commit') as Error & { stdout: string; stderr: string };
    err.stdout = '';
    err.stderr = 'error: gpg failed to sign the data\nfatal: failed to write commit object\n';

    setGitResponses({
      'diff --stat': { stdout: ' file.ts | 3 +-\n' },
      'worktree add': { stdout: '' },
      'merge --squash': { stdout: '' },
      'commit -m': { error: err },
      'worktree remove': { stdout: '' },
    });

    const result = await localMergeIntoDeliveryBranch('/repo', 'task', 'proj', 'msg');
    expect(result.merged).toBe(false);
    expect(result.error).toContain('Commit failed');
  });
});
