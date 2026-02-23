/**
 * Tests for repo context reader utilities
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted() so mocks are available inside vi.mock factories (which are hoisted)
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

import { readRepoContext } from '../repo-context.js';

describe('readRepoContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should read CLAUDE.md and README.md from a directory', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === '/project') return true;
      if (path === '/project/CLAUDE.md') return true;
      if (path === '/project/README.md') return true;
      return false;
    });

    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/project/CLAUDE.md') return '# Project Instructions';
      if (path === '/project/README.md') return '# My Project';
      return '';
    });

    const result = readRepoContext('/project');

    expect(result.claudeMd).toBe('# Project Instructions');
    expect(result.readmeMd).toBe('# My Project');
  });

  it('should return undefined for missing CLAUDE.md', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === '/project') return true;
      if (path === '/project/CLAUDE.md') return false;
      if (path === '/project/README.md') return false;
      if (path === '/project/readme.md') return false;
      return false;
    });

    const result = readRepoContext('/project');

    expect(result.claudeMd).toBeUndefined();
    expect(result.readmeMd).toBeUndefined();
  });

  it('should try lowercase readme.md as fallback', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === '/project') return true;
      if (path === '/project/README.md') return false;
      if (path === '/project/readme.md') return true;
      return false;
    });

    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/project/readme.md') return 'lowercase readme content';
      return '';
    });

    const result = readRepoContext('/project');

    expect(result.readmeMd).toBe('lowercase readme content');
  });

  it('should read package.json when available', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === '/project') return true;
      if (path === '/project/package.json') return true;
      return false;
    });

    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/project/package.json') return '{"name": "my-pkg", "version": "1.0.0"}';
      return '';
    });

    const result = readRepoContext('/project');

    expect(result.packageInfo).toContain('# package.json');
    expect(result.packageInfo).toContain('"my-pkg"');
  });

  it('should prefer package.json over other package files', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === '/project') return true;
      if (path === '/project/package.json') return true;
      if (path === '/project/pyproject.toml') return true;
      return false;
    });

    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/project/package.json') return '{"name": "npm-pkg"}';
      if (path === '/project/pyproject.toml') return '[project]\nname = "py-pkg"';
      return '';
    });

    const result = readRepoContext('/project');

    expect(result.packageInfo).toContain('package.json');
    expect(result.packageInfo).not.toContain('pyproject.toml');
  });

  it('should fall back to pyproject.toml when no package.json exists', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === '/project') return true;
      if (path === '/project/package.json') return false;
      if (path === '/project/pyproject.toml') return true;
      return false;
    });

    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/project/pyproject.toml') return '[project]\nname = "py-pkg"';
      return '';
    });

    const result = readRepoContext('/project');

    expect(result.packageInfo).toContain('# pyproject.toml');
    expect(result.packageInfo).toContain('py-pkg');
  });

  it('should truncate large files', () => {
    const largeContent = 'x'.repeat(20_000);

    mockExistsSync.mockImplementation((path: string) => {
      if (path === '/project') return true;
      if (path === '/project/CLAUDE.md') return true;
      return false;
    });

    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/project/CLAUDE.md') return largeContent;
      return '';
    });

    const result = readRepoContext('/project');

    expect(result.claudeMd).toBeDefined();
    // FILE_CAP is 15_000, so content should be truncated
    expect(result.claudeMd!.length).toBeLessThan(largeContent.length);
    expect(result.claudeMd).toContain('[... truncated ...]');
  });

  it('should not read files when working directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = readRepoContext('/nonexistent');

    expect(result.claudeMd).toBeUndefined();
    expect(result.readmeMd).toBeUndefined();
    expect(result.packageInfo).toBeUndefined();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('should not read files when working directory is empty string', () => {
    const result = readRepoContext('');

    expect(result.claudeMd).toBeUndefined();
    expect(result.readmeMd).toBeUndefined();
    expect(result.packageInfo).toBeUndefined();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('should format file tree summary from provided file list', () => {
    mockExistsSync.mockReturnValue(false);

    const fileTree = ['src/index.ts', 'src/utils.ts', 'package.json'];
    const result = readRepoContext('', fileTree);

    expect(result.fileTreeSummary).toBe('src/index.ts\nsrc/utils.ts\npackage.json');
  });

  it('should truncate file tree when exceeding 200 files', () => {
    mockExistsSync.mockReturnValue(false);

    const fileTree = Array.from({ length: 250 }, (_, i) => `file-${i}.ts`);
    const result = readRepoContext('', fileTree);

    expect(result.fileTreeSummary).toContain('file-0.ts');
    expect(result.fileTreeSummary).toContain('file-199.ts');
    expect(result.fileTreeSummary).not.toContain('file-200.ts');
    expect(result.fileTreeSummary).toContain('and 50 more files (250 total)');
  });

  it('should return undefined fileTreeSummary when no file tree provided', () => {
    mockExistsSync.mockReturnValue(false);

    const result = readRepoContext('');

    expect(result.fileTreeSummary).toBeUndefined();
  });

  it('should return undefined fileTreeSummary for empty file tree', () => {
    mockExistsSync.mockReturnValue(false);

    const result = readRepoContext('', []);

    expect(result.fileTreeSummary).toBeUndefined();
  });

  it('should handle readFileSync throwing errors gracefully', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === '/project') return true;
      if (path === '/project/CLAUDE.md') return true;
      return false;
    });

    mockReadFileSync.mockImplementation(() => {
      throw new Error('permission denied');
    });

    const result = readRepoContext('/project');

    // readFileCapped catches errors and returns undefined
    expect(result.claudeMd).toBeUndefined();
  });
});
