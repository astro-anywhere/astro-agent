/**
 * Tests for copy-worktree utilities (non-git workspace strategies)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRm = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockReaddir = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockStat = vi.hoisted(() => vi.fn().mockResolvedValue({ size: 100 }));
const mockReadFile = vi.hoisted(() => vi.fn().mockRejectedValue(new Error('not found')));
const mockCopyFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockExistsSync = vi.hoisted(() => vi.fn().mockReturnValue(false));

// execFile mock: properly invokes callback with error so Promises resolve
const mockExecFile = vi.hoisted(() =>
  vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (...a: unknown[]) => void) => {
    const callback = typeof _opts === 'function' ? _opts : cb;
    if (callback) callback(new Error('mock: not available'), '', '');
  }),
);

vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  cp: mockCp,
  rm: mockRm,
  readdir: mockReaddir,
  stat: mockStat,
  readFile: mockReadFile,
  copyFile: mockCopyFile,
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import {
  createCopyWorktree,
  createReferenceWorktree,
  generateFileMap,
} from '../copy-worktree.js';

describe('createCopyWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    // Restore default implementations after clearAllMocks
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({ size: 100 });
    mockReadFile.mockRejectedValue(new Error('not found'));
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb?: (...a: unknown[]) => void) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (callback) callback(new Error('mock: not available'), '', '');
    });
  });

  it('should create worktree at {sourceDir}/{agentDir}/worktrees/{taskId}/', async () => {
    // readdir returns some files/dirs to copy
    mockReaddir
      .mockResolvedValueOnce([ // root
        { name: 'src', isDirectory: () => true, isFile: () => false },
        { name: 'package.json', isDirectory: () => false, isFile: () => true },
      ])
      .mockResolvedValueOnce([]); // src/ subdirectory (empty)

    const result = await createCopyWorktree('/project', '.astro', 'task-1');

    expect(result.worktreePath).toBe('/project/.astro/worktrees/task-1');
    expect(mockMkdir).toHaveBeenCalledWith('/project/.astro/worktrees/task-1', { recursive: true });
  });

  it('should exclude agent dir from copy', async () => {
    mockReaddir
      .mockResolvedValueOnce([ // root dir
        { name: '.astro', isDirectory: () => true, isFile: () => false },
        { name: '.git', isDirectory: () => true, isFile: () => false },
        { name: 'node_modules', isDirectory: () => true, isFile: () => false },
        { name: 'src', isDirectory: () => true, isFile: () => false },
        { name: 'README.md', isDirectory: () => false, isFile: () => true },
      ])
      .mockResolvedValueOnce([ // src/ subdirectory
        { name: 'main.ts', isDirectory: () => false, isFile: () => true },
      ]);

    await createCopyWorktree('/project', '.astro', 'task-2');

    // Should only process src/ (mkdir + recurse) and README.md (cp), not .astro, .git, or node_modules
    // src/ is handled by mkdir + recursive walk; cp is called for individual files only
    expect(mockCp).toHaveBeenCalledTimes(2);
    expect(mockCp).toHaveBeenCalledWith('/project/src/main.ts', '/project/.astro/worktrees/task-2/src/main.ts');
    expect(mockCp).toHaveBeenCalledWith('/project/README.md', '/project/.astro/worktrees/task-2/README.md');
    // src/ directory is created via mkdir, not cp
    expect(mockMkdir).toHaveBeenCalledWith('/project/.astro/worktrees/task-2/src', { recursive: true });
  });

  it('should clean up existing worktree before creating', async () => {
    // Only return true for the worktree path check, not for .git
    mockExistsSync.mockImplementation((path: string) => {
      return String(path).includes('.astro/worktrees/');
    });
    mockReaddir.mockResolvedValueOnce([]);

    await createCopyWorktree('/project', '.astro', 'task-3');

    // Should rm existing worktree first
    expect(mockRm).toHaveBeenCalledWith('/project/.astro/worktrees/task-3', { recursive: true, force: true });
  });

  it('should return cleanup function that removes worktree', async () => {
    mockReaddir.mockResolvedValueOnce([]);

    const result = await createCopyWorktree('/project', '.astro', 'task-4');
    vi.clearAllMocks();

    await result.cleanup();
    expect(mockRm).toHaveBeenCalledWith('/project/.astro/worktrees/task-4', { recursive: true, force: true });
  });

  it('should sanitize taskId in path', async () => {
    mockReaddir.mockResolvedValueOnce([]);

    const result = await createCopyWorktree('/project', '.astro', 'task/with spaces!');

    expect(result.worktreePath).toBe('/project/.astro/worktrees/task_with_spaces_');
  });
});

describe('createReferenceWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({ size: 100 });
  });

  it('should create empty directory at correct path', async () => {
    mockReaddir.mockResolvedValueOnce([]); // for generateFileMap walk

    const result = await createReferenceWorktree('/project', '.astro', 'ref-task-1');

    expect(result.worktreePath).toBe('/project/.astro/worktrees/ref-task-1');
    expect(mockMkdir).toHaveBeenCalledWith('/project/.astro/worktrees/ref-task-1', { recursive: true });
    // Should NOT call cp (reference mode doesn't copy files)
    expect(mockCp).not.toHaveBeenCalled();
  });

  it('should return file map with entries', async () => {
    mockReaddir
      .mockResolvedValueOnce([ // root dir
        { name: 'main.py', isDirectory: () => false, isFile: () => true },
      ]);
    mockStat.mockResolvedValueOnce({ size: 500 });

    const result = await createReferenceWorktree('/project', '.astro', 'ref-task-2');

    expect(result.fileMap).toHaveLength(1);
    expect(result.fileMap[0]).toEqual({
      relativePath: 'main.py',
      sizeBytes: 500,
      classification: 'code',
    });
  });

  it('should return cleanup function', async () => {
    mockReaddir.mockResolvedValueOnce([]);

    const result = await createReferenceWorktree('/project', '.astro', 'ref-task-3');
    vi.clearAllMocks();

    await result.cleanup();
    expect(mockRm).toHaveBeenCalledWith('/project/.astro/worktrees/ref-task-3', { recursive: true, force: true });
  });
});

describe('generateFileMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({ size: 100 });
  });

  it('should classify small files as code', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'index.ts', isDirectory: () => false, isFile: () => true },
    ]);
    mockStat.mockResolvedValueOnce({ size: 1000 }); // 1KB

    const entries = await generateFileMap('/project', '.astro');

    expect(entries).toHaveLength(1);
    expect(entries[0].classification).toBe('code');
    expect(entries[0].sizeBytes).toBe(1000);
  });

  it('should classify large files as data', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'model.bin', isDirectory: () => false, isFile: () => true },
    ]);
    mockStat.mockResolvedValueOnce({ size: 5_000_000 }); // 5MB

    const entries = await generateFileMap('/project', '.astro');

    expect(entries).toHaveLength(1);
    expect(entries[0].classification).toBe('data');
  });

  it('should skip agent dir, .git, and node_modules', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: '.astro', isDirectory: () => true, isFile: () => false },
      { name: '.git', isDirectory: () => true, isFile: () => false },
      { name: 'node_modules', isDirectory: () => true, isFile: () => false },
      { name: 'app.js', isDirectory: () => false, isFile: () => true },
    ]);
    mockStat.mockResolvedValueOnce({ size: 200 });

    const entries = await generateFileMap('/project', '.astro');

    // Only app.js should be included
    expect(entries).toHaveLength(1);
    expect(entries[0].relativePath).toBe('app.js');
  });

  it('should walk subdirectories recursively', async () => {
    mockReaddir
      .mockResolvedValueOnce([ // root
        { name: 'src', isDirectory: () => true, isFile: () => false },
        { name: 'README.md', isDirectory: () => false, isFile: () => true },
      ])
      .mockResolvedValueOnce([ // src/
        { name: 'main.ts', isDirectory: () => false, isFile: () => true },
      ]);
    mockStat
      .mockResolvedValueOnce({ size: 100 })  // README.md
      .mockResolvedValueOnce({ size: 500 }); // src/main.ts

    const entries = await generateFileMap('/project', '.astro');

    expect(entries).toHaveLength(2);
    const paths = entries.map(e => e.relativePath);
    expect(paths).toContain('README.md');
    expect(paths).toContain('src/main.ts');
  });

  it('should handle empty directory', async () => {
    mockReaddir.mockResolvedValueOnce([]);

    const entries = await generateFileMap('/project', '.astro');

    expect(entries).toHaveLength(0);
  });
});
