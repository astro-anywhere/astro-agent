/**
 * Tests for git PR utilities
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted() so mock is available inside vi.mock factories (which are hoisted)
const mockExecFileAsync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:util', () => ({
  promisify: () => mockExecFileAsync,
}));

import {
  hasBranchCommits,
  getDefaultBranch,
  pushBranch,
  createPullRequest,
  mergePullRequest,
  isGhAvailable,
  hasRemoteOrigin,
  getGitRoot,
  autoCommitChanges,
  parseRepoSlug,
  getRepoSlug,
} from '../git-pr.js';

describe('hasBranchCommits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when there are commits ahead of the base branch', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '3\n' });

    const result = await hasBranchCommits('/repo/worktree', 'main');

    expect(result).toBe(true);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo/worktree', 'rev-list', '--count', 'origin/main..HEAD'],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it('should return false when there are zero commits ahead', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '0\n' });

    const result = await hasBranchCommits('/repo/worktree', 'main');

    expect(result).toBe(false);
  });

  it('should return false when the git command fails', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('fatal: not a git repository'));

    const result = await hasBranchCommits('/repo/worktree', 'main');

    expect(result).toBe(false);
  });

  it('should work with different base branches', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '1\n' });

    const result = await hasBranchCommits('/repo/worktree', 'master');

    expect(result).toBe(true);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo/worktree', 'rev-list', '--count', 'origin/master..HEAD'],
      expect.any(Object),
    );
  });

  it('should handle stdout with extra whitespace', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  5  \n' });

    const result = await hasBranchCommits('/repo/worktree', 'main');

    expect(result).toBe(true);
  });
});

describe('getDefaultBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should detect branch from symbolic-ref', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: 'refs/remotes/origin/main\n',
    });

    const branch = await getDefaultBranch('/repo');

    expect(branch).toBe('main');
  });

  it('should detect master from symbolic-ref', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: 'refs/remotes/origin/master\n',
    });

    const branch = await getDefaultBranch('/repo');

    expect(branch).toBe('master');
  });

  it('should fall back to branch -r when symbolic-ref fails', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('symbolic-ref not set'))
      .mockResolvedValueOnce({ stdout: '  origin/main\n  origin/master\n' });

    const branch = await getDefaultBranch('/repo');

    expect(branch).toBe('main');
  });

  it('should prefer main over master in fallback', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('no symbolic-ref'))
      .mockResolvedValueOnce({ stdout: '  origin/main\n  origin/master\n' });

    const branch = await getDefaultBranch('/repo');

    expect(branch).toBe('main');
  });

  it('should return master when only master exists in fallback', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('no symbolic-ref'))
      .mockResolvedValueOnce({ stdout: '  origin/master\n' });

    const branch = await getDefaultBranch('/repo');

    expect(branch).toBe('master');
  });

  it('should default to main when all methods fail', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('no symbolic-ref'))
      .mockRejectedValueOnce(new Error('no remotes'));

    const branch = await getDefaultBranch('/repo');

    expect(branch).toBe('main');
  });
});

describe('pushBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true on successful push', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'git@github.com:user/repo.git\n' }) // remote get-url
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // push

    const result = await pushBranch('/repo/worktree', 'feature-branch');

    expect(result).toEqual({ ok: true });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo/worktree', 'push', '-u', 'origin', 'feature-branch'],
      expect.any(Object),
    );
  });

  it('should return false when push fails', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'git@github.com:user/repo.git\n' }) // remote get-url
      .mockRejectedValueOnce({ message: 'push rejected', stderr: 'rejected' }); // push fails

    const result = await pushBranch('/repo/worktree', 'feature-branch');

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('createPullRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a PR and return URL and number', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: 'https://github.com/user/repo/pull/42\n',
    });

    const result = await createPullRequest('/repo/worktree', {
      branchName: 'feature-branch',
      baseBranch: 'main',
      title: 'My PR',
      body: 'PR body',
    });

    expect(result).toEqual({
      prUrl: 'https://github.com/user/repo/pull/42',
      prNumber: 42,
    });
  });

  it('should return null when gh pr create fails', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('gh not authenticated'));

    const result = await createPullRequest('/repo/worktree', {
      branchName: 'feature-branch',
      baseBranch: 'main',
      title: 'My PR',
      body: 'PR body',
    });

    expect(result).toBeNull();
  });

  it('should return prNumber 0 when URL does not match expected pattern', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: 'https://some-enterprise.com/unexpected-format\n',
    });

    const result = await createPullRequest('/repo/worktree', {
      branchName: 'feature-branch',
      baseBranch: 'main',
      title: 'My PR',
      body: 'PR body',
    });

    expect(result).toEqual({
      prUrl: 'https://some-enterprise.com/unexpected-format',
      prNumber: 0,
    });
  });
});

describe('isGhAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when gh auth status succeeds', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '' });

    const result = await isGhAvailable();

    expect(result).toBe(true);
  });

  it('should return false when gh is not installed or not authenticated', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('command not found: gh'));

    const result = await isGhAvailable();

    expect(result).toBe(false);
  });
});

describe('hasRemoteOrigin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when remote origin exists', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: 'git@github.com:user/repo.git\n',
    });

    const result = await hasRemoteOrigin('/repo');

    expect(result).toBe(true);
  });

  it('should return false when no remote origin', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('fatal: no such remote'));

    const result = await hasRemoteOrigin('/repo');

    expect(result).toBe(false);
  });

  it('should return false for empty remote URL', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '\n' });

    const result = await hasRemoteOrigin('/repo');

    expect(result).toBe(false);
  });
});

describe('getGitRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return the git root directory', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '/home/user/repo\n' });

    const result = await getGitRoot('/home/user/repo/subdir');

    expect(result).toBe('/home/user/repo');
  });

  it('should return null when not in a git repo', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('fatal: not a git repository'));

    const result = await getGitRoot('/tmp/random');

    expect(result).toBeNull();
  });

  it('should return null for empty stdout', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '' });

    const result = await getGitRoot('/some/dir');

    expect(result).toBeNull();
  });
});

describe('autoCommitChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should auto-commit when there are uncommitted changes', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: ' M file.ts\n?? new-file.ts\n' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // git add -A
      .mockResolvedValueOnce({ stdout: '' }); // git commit

    const result = await autoCommitChanges('/repo/worktree', 'Fix something');

    expect(result).toBe(true);
    expect(mockExecFileAsync).toHaveBeenCalledTimes(3);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo/worktree', 'add', '-A'],
      expect.any(Object),
    );
  });

  it('should return false when there are no changes', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '\n' });

    const result = await autoCommitChanges('/repo/worktree', 'Fix something');

    expect(result).toBe(false);
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
  });

  it('should return false when git status fails', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repo'));

    const result = await autoCommitChanges('/repo/worktree', 'Fix something');

    expect(result).toBe(false);
  });
});

describe('parseRepoSlug', () => {
  it('should parse SSH remote URLs', () => {
    expect(parseRepoSlug('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  it('should parse SSH URLs without .git suffix', () => {
    expect(parseRepoSlug('git@github.com:owner/repo')).toBe('owner/repo');
  });

  it('should parse HTTPS remote URLs', () => {
    expect(parseRepoSlug('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('should parse HTTPS URLs without .git suffix', () => {
    expect(parseRepoSlug('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('should handle enterprise GitHub URLs', () => {
    expect(parseRepoSlug('git@github.corp.com:team/project.git')).toBe('team/project');
    expect(parseRepoSlug('https://github.corp.com/team/project.git')).toBe('team/project');
  });

  it('should return null for malformed URLs', () => {
    expect(parseRepoSlug('')).toBeNull();
    expect(parseRepoSlug('not-a-url')).toBeNull();
    expect(parseRepoSlug('git@github.com')).toBeNull();
  });
});

describe('getRepoSlug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return slug from SSH remote', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'git@github.com:owner/repo.git\n' });

    const result = await getRepoSlug('/repo');

    expect(result).toBe('owner/repo');
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'remote', 'get-url', 'origin'],
      expect.any(Object),
    );
  });

  it('should return slug from HTTPS remote', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'https://github.com/org/project.git\n' });

    const result = await getRepoSlug('/repo');

    expect(result).toBe('org/project');
  });

  it('should return null when git command fails', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repo'));

    const result = await getRepoSlug('/not-a-repo');

    expect(result).toBeNull();
  });

  it('should return null for unparseable remote URL', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'not-a-valid-remote\n' });

    const result = await getRepoSlug('/repo');

    expect(result).toBeNull();
  });
});

describe('hasBranchCommits with explicit branchName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use explicit branchName instead of HEAD when provided', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '2\n' });

    const result = await hasBranchCommits('/repo', 'main', 'astro/proj-task');

    expect(result).toBe(true);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'rev-list', '--count', 'origin/main..astro/proj-task'],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it('should use HEAD when branchName is undefined', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '1\n' });

    const result = await hasBranchCommits('/repo', 'main', undefined);

    expect(result).toBe(true);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'rev-list', '--count', 'origin/main..HEAD'],
      expect.any(Object),
    );
  });

  it('should return false when explicit branch has no commits ahead', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '0\n' });

    const result = await hasBranchCommits('/repo', 'main', 'astro/proj-task');

    expect(result).toBe(false);
  });
});

describe('createPullRequest with repoSlug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass --repo when repoSlug is provided', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: 'https://github.com/owner/repo/pull/99\n',
    });

    await createPullRequest('/repo', {
      branchName: 'task-branch',
      baseBranch: 'project-branch',
      title: 'Task PR',
      body: 'body',
      repoSlug: 'owner/repo',
    });

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--repo', 'owner/repo']),
      expect.any(Object),
    );
  });

  it('should not pass --repo when repoSlug is undefined', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: 'https://github.com/owner/repo/pull/99\n',
    });

    await createPullRequest('/repo', {
      branchName: 'task-branch',
      baseBranch: 'project-branch',
      title: 'Task PR',
      body: 'body',
    });

    const args = mockExecFileAsync.mock.calls[0][1] as string[];
    expect(args).not.toContain('--repo');
  });
});

describe('mergePullRequest with repoSlug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass --repo when repoSlug is provided', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '' });

    const result = await mergePullRequest('/repo', 42, {
      method: 'squash',
      repoSlug: 'owner/repo',
    });

    expect(result).toEqual({ ok: true });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--repo', 'owner/repo']),
      expect.any(Object),
    );
  });

  it('should not pass --repo when repoSlug is undefined', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '' });

    await mergePullRequest('/repo', 42, { method: 'squash' });

    const args = mockExecFileAsync.mock.calls[0][1] as string[];
    expect(args).not.toContain('--repo');
  });

  it('should return error when merge fails', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('merge conflict'));

    const result = await mergePullRequest('/repo', 42, {
      method: 'squash',
      repoSlug: 'owner/repo',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('merge conflict');
  });
});
