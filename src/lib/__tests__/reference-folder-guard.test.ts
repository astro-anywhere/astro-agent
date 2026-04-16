/**
 * Tests for reference-folder-guard.ts — the read-only enforcement helpers.
 *
 * These are the rules the Claude Agent SDK `canUseTool` hook relies on, so
 * the contract here is security-adjacent: quoted paths must not sneak past
 * the denial check, read tools must pass through, and the decision function
 * must return `{ denied: true, message }` for in-mount writes.
 */

import { describe, it, expect } from 'vitest';
import {
  tokenizeShellArgs,
  extractPathsForWriteCheck,
  buildReferenceFolderDenyHook,
  WRITE_TOOLS,
} from '../reference-folder-guard.js';

describe('tokenizeShellArgs', () => {
  it('splits unquoted args on whitespace', () => {
    expect(tokenizeShellArgs('rm -rf /tmp/foo')).toEqual(['rm', '-rf', '/tmp/foo']);
  });

  it('keeps double-quoted paths containing spaces intact', () => {
    expect(tokenizeShellArgs('rm "/mnt/ref folder/file"')).toEqual([
      'rm',
      '/mnt/ref folder/file',
    ]);
  });

  it('keeps single-quoted paths intact', () => {
    expect(tokenizeShellArgs("cat '/mnt/ref folder/a.txt'")).toEqual([
      'cat',
      '/mnt/ref folder/a.txt',
    ]);
  });

  it('honors backslash-escaped spaces', () => {
    expect(tokenizeShellArgs('rm /mnt/ref\\ folder/f')).toEqual([
      'rm',
      '/mnt/ref folder/f',
    ]);
  });

  it('collapses runs of whitespace', () => {
    expect(tokenizeShellArgs('ls   -la\t/tmp')).toEqual(['ls', '-la', '/tmp']);
  });

  it('returns empty array for an empty string', () => {
    expect(tokenizeShellArgs('')).toEqual([]);
  });
});

describe('extractPathsForWriteCheck', () => {
  it('returns file_path for Edit', () => {
    expect(extractPathsForWriteCheck('Edit', { file_path: '/a/b.ts' })).toEqual(['/a/b.ts']);
  });

  it('returns every edits[].file_path for MultiEdit', () => {
    const input = {
      file_path: '/a/main.ts',
      edits: [{ file_path: '/a/main.ts' }, { file_path: '/a/other.ts' }],
    };
    const paths = extractPathsForWriteCheck('MultiEdit', input);
    expect(paths).toContain('/a/main.ts');
    expect(paths).toContain('/a/other.ts');
  });

  it('returns notebook_path for NotebookEdit', () => {
    expect(extractPathsForWriteCheck('NotebookEdit', { notebook_path: '/a/x.ipynb' })).toEqual([
      '/a/x.ipynb',
    ]);
  });

  it('returns Bash args that look like paths, including quoted ones', () => {
    const paths = extractPathsForWriteCheck('Bash', {
      command: 'rm -rf "/mnt/ref folder/secret" /tmp/other',
    });
    expect(paths).toContain('/mnt/ref folder/secret');
    expect(paths).toContain('/tmp/other');
  });

  it('ignores non-path Bash args', () => {
    expect(extractPathsForWriteCheck('Bash', { command: 'echo hello' })).toEqual([]);
  });

  it('returns an empty list for unknown tool names', () => {
    expect(extractPathsForWriteCheck('Read', { file_path: '/a/b.ts' })).toEqual([]);
  });
});

describe('buildReferenceFolderDenyHook', () => {
  it('returns undefined when there are no reference mounts', () => {
    expect(buildReferenceFolderDenyHook([])).toBeUndefined();
  });

  it('denies Edit into a reference mount with a human-readable message', () => {
    const hook = buildReferenceFolderDenyHook(['/mnt/ref'])!;
    const result = hook('Edit', { file_path: '/mnt/ref/src/index.ts' });
    expect(result.denied).toBe(true);
    expect(result.message).toMatch(/reference folder/);
    expect(result.message).toMatch(/\/mnt\/ref\/src\/index\.ts/);
  });

  it('allows Edit outside reference mounts', () => {
    const hook = buildReferenceFolderDenyHook(['/mnt/ref'])!;
    expect(hook('Edit', { file_path: '/project/src/index.ts' }).denied).toBe(false);
  });

  it('denies Bash commands that touch a quoted path inside a reference mount', () => {
    const hook = buildReferenceFolderDenyHook(['/mnt/ref folder'])!;
    const result = hook('Bash', { command: 'rm "/mnt/ref folder/secret"' });
    expect(result.denied).toBe(true);
    expect(result.message).toMatch(/\/mnt\/ref folder\/secret/);
  });

  it('allows Bash commands whose paths are outside reference mounts', () => {
    const hook = buildReferenceFolderDenyHook(['/mnt/ref'])!;
    expect(hook('Bash', { command: 'ls /project' }).denied).toBe(false);
  });

  it('allows read tools (Read, Grep, Glob) even when targeting a reference mount', () => {
    const hook = buildReferenceFolderDenyHook(['/mnt/ref'])!;
    expect(hook('Read', { file_path: '/mnt/ref/a.ts' }).denied).toBe(false);
    expect(hook('Grep', { path: '/mnt/ref' }).denied).toBe(false);
    expect(hook('Glob', { path: '/mnt/ref' }).denied).toBe(false);
  });

  it('denies MultiEdit if any of the edits touches a reference mount', () => {
    const hook = buildReferenceFolderDenyHook(['/mnt/ref'])!;
    const result = hook('MultiEdit', {
      edits: [{ file_path: '/project/ok.ts' }, { file_path: '/mnt/ref/blocked.ts' }],
    });
    expect(result.denied).toBe(true);
  });
});

describe('WRITE_TOOLS set sanity', () => {
  it('contains the four filesystem-mutating SDK tools', () => {
    expect(WRITE_TOOLS.has('Edit')).toBe(true);
    expect(WRITE_TOOLS.has('Write')).toBe(true);
    expect(WRITE_TOOLS.has('NotebookEdit')).toBe(true);
    expect(WRITE_TOOLS.has('MultiEdit')).toBe(true);
    expect(WRITE_TOOLS.has('Read')).toBe(false);
  });
});
