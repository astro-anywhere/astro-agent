/**
 * Real filesystem tests for copy-worktree.ts
 *
 * These tests use actual tmp directories and real file I/O.
 * No mocking — every assertion verifies on-disk state.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  createCopyWorktree,
  createReferenceWorktree,
  generateFileMap,
} from '../../src/lib/copy-worktree.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary project directory populated with the given files.
 * Keys are relative paths; values are file contents (string or Buffer).
 */
function createTestProject(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'astro-copy-test-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return dir;
}

/**
 * Recursively list all file paths relative to `root`.
 */
function listFilesRecursive(root: string, prefix = ''): string[] {
  const results: string[] = [];
  if (!existsSync(root)) return results;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(join(root, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Track directories to clean up after each test
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }
  tmpDirs.length = 0;
});

function tracked(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

// ===========================================================================
// createCopyWorktree
// ===========================================================================

describe('createCopyWorktree', () => {
  it('creates copy at correct path with all files', async () => {
    const projectDir = tracked(
      createTestProject({
        'src/main.ts': 'console.log("hello");',
        'README.md': '# Project',
        'data/model.bin': Buffer.alloc(1_200_000, 0xab), // >1MB placeholder
      }),
    );

    const result = await createCopyWorktree(projectDir, '.astro', 'copy-task-1');

    // Correct path
    expect(result.worktreePath).toBe(join(projectDir, '.astro', 'worktrees', 'copy-task-1'));
    // Directory exists
    expect(existsSync(result.worktreePath)).toBe(true);
    // Files copied
    expect(existsSync(join(result.worktreePath, 'src/main.ts'))).toBe(true);
    expect(existsSync(join(result.worktreePath, 'README.md'))).toBe(true);
    expect(existsSync(join(result.worktreePath, 'data/model.bin'))).toBe(true);
    // Content matches
    expect(readFileSync(join(result.worktreePath, 'src/main.ts'), 'utf-8')).toBe(
      'console.log("hello");',
    );
    expect(readFileSync(join(result.worktreePath, 'README.md'), 'utf-8')).toBe('# Project');

    // Clean up
    await result.cleanup();
  });

  it('excludes agent dir, .git, and node_modules', async () => {
    const projectDir = tracked(
      createTestProject({
        '.astro/config.json': '{}',
        '.git/HEAD': 'ref: refs/heads/main',
        '.git/objects/pack/dummy': 'pack data',
        'node_modules/lodash/index.js': 'module.exports = {};',
        'src/index.ts': 'export {};',
        'lib/utils.ts': 'export const x = 1;',
      }),
    );

    const result = await createCopyWorktree(projectDir, '.astro', 'copy-task-2');

    // Excluded directories must NOT exist in the worktree
    expect(existsSync(join(result.worktreePath, '.astro'))).toBe(false);
    expect(existsSync(join(result.worktreePath, '.git'))).toBe(false);
    expect(existsSync(join(result.worktreePath, 'node_modules'))).toBe(false);

    // Included directories DO exist
    expect(existsSync(join(result.worktreePath, 'src/index.ts'))).toBe(true);
    expect(existsSync(join(result.worktreePath, 'lib/utils.ts'))).toBe(true);

    await result.cleanup();
  });

  it('cleans up existing worktree before re-creating', async () => {
    const projectDir = tracked(
      createTestProject({
        'src/app.ts': 'run();',
      }),
    );

    // First creation
    const result1 = await createCopyWorktree(projectDir, '.astro', 'copy-task-3');
    // Plant a marker file in the worktree
    writeFileSync(join(result1.worktreePath, 'marker.txt'), 'old');
    expect(existsSync(join(result1.worktreePath, 'marker.txt'))).toBe(true);

    // Second creation with same taskId — should wipe the old worktree
    const result2 = await createCopyWorktree(projectDir, '.astro', 'copy-task-3');

    expect(result2.worktreePath).toBe(result1.worktreePath);
    // Marker from old worktree must be gone
    expect(existsSync(join(result2.worktreePath, 'marker.txt'))).toBe(false);
    // Source file still present
    expect(existsSync(join(result2.worktreePath, 'src/app.ts'))).toBe(true);

    await result2.cleanup();
  });

  it('cleanup() removes the worktree directory', async () => {
    const projectDir = tracked(
      createTestProject({
        'file.txt': 'content',
      }),
    );

    const result = await createCopyWorktree(projectDir, '.astro', 'copy-task-4');
    expect(existsSync(result.worktreePath)).toBe(true);

    await result.cleanup();
    expect(existsSync(result.worktreePath)).toBe(false);
  });

  it('works with a custom agent directory name', async () => {
    const projectDir = tracked(
      createTestProject({
        '.myagent/settings.json': '{}',
        'src/main.py': 'print("hi")',
      }),
    );

    const result = await createCopyWorktree(projectDir, '.myagent', 'custom-agent-task');

    expect(result.worktreePath).toBe(
      join(projectDir, '.myagent', 'worktrees', 'custom-agent-task'),
    );
    expect(existsSync(result.worktreePath)).toBe(true);
    // Agent dir excluded
    expect(existsSync(join(result.worktreePath, '.myagent'))).toBe(false);
    // Source file copied
    expect(existsSync(join(result.worktreePath, 'src/main.py'))).toBe(true);

    await result.cleanup();
  });

  it('sanitizes taskId with special characters', async () => {
    const projectDir = tracked(
      createTestProject({
        'index.ts': 'ok',
      }),
    );

    const result = await createCopyWorktree(projectDir, '.astro', 'task/with spaces!@#');

    // Special characters replaced with underscores
    // 'task/with spaces!@#' → 'task_with_spaces___'
    //   / → _   space → _   ! → _   @ → _   # → _
    // but 'with' and 'spaces' are separated by a single space → single _
    expect(result.worktreePath).toBe(
      join(projectDir, '.astro', 'worktrees', 'task_with_spaces___'),
    );
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(existsSync(join(result.worktreePath, 'index.ts'))).toBe(true);

    await result.cleanup();
  });
});

// ===========================================================================
// createReferenceWorktree
// ===========================================================================

describe('createReferenceWorktree', () => {
  it('creates empty directory with file map', async () => {
    const projectDir = tracked(
      createTestProject({
        'src/index.ts': 'export default 42;',
        'src/lib/utils.ts': 'export const add = (a: number, b: number) => a + b;',
        'README.md': '# Hello',
        'data/large.bin': Buffer.alloc(2_000_000, 0xff),
      }),
    );

    const result = await createReferenceWorktree(projectDir, '.astro', 'ref-task-1');

    // Worktree directory exists
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(result.worktreePath).toBe(join(projectDir, '.astro', 'worktrees', 'ref-task-1'));

    // Worktree is empty (no files copied into it)
    const worktreeContents = listFilesRecursive(result.worktreePath);
    expect(worktreeContents).toEqual([]);

    // File map has entries for all source files
    expect(result.fileMap.length).toBe(4);

    const paths = result.fileMap.map((e) => e.relativePath).sort();
    expect(paths).toEqual([
      'README.md',
      'data/large.bin',
      'src/index.ts',
      'src/lib/utils.ts',
    ]);

    // Check individual entries
    const readmeEntry = result.fileMap.find((e) => e.relativePath === 'README.md')!;
    expect(readmeEntry.sizeBytes).toBe(Buffer.byteLength('# Hello'));
    expect(readmeEntry.classification).toBe('code');

    const largeEntry = result.fileMap.find((e) => e.relativePath === 'data/large.bin')!;
    expect(largeEntry.sizeBytes).toBe(2_000_000);
    expect(largeEntry.classification).toBe('data');

    await result.cleanup();
  });

  it('cleanup() removes the worktree directory', async () => {
    const projectDir = tracked(
      createTestProject({
        'a.txt': 'content',
      }),
    );

    const result = await createReferenceWorktree(projectDir, '.astro', 'ref-task-2');
    expect(existsSync(result.worktreePath)).toBe(true);

    await result.cleanup();
    expect(existsSync(result.worktreePath)).toBe(false);
  });
});

// ===========================================================================
// generateFileMap
// ===========================================================================

describe('generateFileMap', () => {
  it('classifies small files as code and large files as data', async () => {
    const projectDir = tracked(
      createTestProject({
        'small.ts': 'x',                               // well under 1MB
        'large.bin': Buffer.alloc(2_000_000, 0x00),     // 2MB, above threshold
        'exactly-at-threshold.dat': Buffer.alloc(1_000_000, 0x01), // exactly 1MB
      }),
    );

    const fileMap = await generateFileMap(projectDir, '.astro');
    expect(fileMap.length).toBe(3);

    const small = fileMap.find((e) => e.relativePath === 'small.ts')!;
    expect(small.classification).toBe('code');
    expect(small.sizeBytes).toBe(1);

    const large = fileMap.find((e) => e.relativePath === 'large.bin')!;
    expect(large.classification).toBe('data');
    expect(large.sizeBytes).toBe(2_000_000);

    // Exactly at threshold (1MB) — classified as 'data' because >= 1MB
    const atThreshold = fileMap.find((e) => e.relativePath === 'exactly-at-threshold.dat')!;
    expect(atThreshold.classification).toBe('data');
    expect(atThreshold.sizeBytes).toBe(1_000_000);
  });

  it('skips excluded directories (.astro, .git, node_modules)', async () => {
    const projectDir = tracked(
      createTestProject({
        '.astro/config.json': '{}',
        '.git/HEAD': 'ref: refs/heads/main',
        'node_modules/pkg/index.js': 'exports = {};',
        'app.py': 'print("hello")',
      }),
    );

    const fileMap = await generateFileMap(projectDir, '.astro');

    expect(fileMap.length).toBe(1);
    expect(fileMap[0].relativePath).toBe('app.py');
  });

  it('walks subdirectories and reports correct relative paths', async () => {
    const projectDir = tracked(
      createTestProject({
        'src/lib/utils.ts': 'export const y = 2;',
        'src/index.ts': 'import { y } from "./lib/utils";',
        'README.md': '# Docs',
      }),
    );

    const fileMap = await generateFileMap(projectDir, '.astro');
    const paths = fileMap.map((e) => e.relativePath).sort();

    expect(paths).toEqual(['README.md', 'src/index.ts', 'src/lib/utils.ts']);

    // All should be small => 'code'
    for (const entry of fileMap) {
      expect(entry.classification).toBe('code');
      expect(entry.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('returns empty array for a project with only excluded dirs', async () => {
    const projectDir = tracked(
      createTestProject({
        '.astro/state.json': '{}',
        '.git/config': '[core]',
        'node_modules/foo/bar.js': 'module.exports = 1;',
      }),
    );

    const fileMap = await generateFileMap(projectDir, '.astro');
    expect(fileMap).toEqual([]);
  });

  it('handles deeply nested directory structures', async () => {
    const projectDir = tracked(
      createTestProject({
        'a/b/c/d/e/deep.txt': 'deep content',
        'a/b/c/mid.txt': 'mid content',
        'top.txt': 'top content',
      }),
    );

    const fileMap = await generateFileMap(projectDir, '.astro');
    const paths = fileMap.map((e) => e.relativePath).sort();

    expect(paths).toEqual(['a/b/c/d/e/deep.txt', 'a/b/c/mid.txt', 'top.txt']);
  });
});
