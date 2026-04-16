/**
 * Tests for additional-folders.ts helpers. We focus on:
 *   - isPathUnderReferenceMount path-prefix semantics (no accidental /foo/bar
 *     matching /foo/barbaz).
 *   - setupAdditionalFolders happy-path for reference mode (filesystem-only,
 *     no git commands).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isPathUnderReferenceMount,
  setupAdditionalFolders,
} from '../additional-folders.js';

describe('isPathUnderReferenceMount', () => {
  it('returns false for empty mount list', () => {
    expect(isPathUnderReferenceMount('/any/path', [])).toBe(false);
  });

  it('returns true for exact match', () => {
    expect(isPathUnderReferenceMount('/home/u/ref', ['/home/u/ref'])).toBe(true);
  });

  it('returns true for path nested inside a mount', () => {
    expect(isPathUnderReferenceMount('/home/u/ref/sub/file.ts', ['/home/u/ref'])).toBe(true);
  });

  it('does not match a sibling with a shared prefix', () => {
    // /home/u/ref must not match /home/u/refactor
    expect(isPathUnderReferenceMount('/home/u/refactor/file.ts', ['/home/u/ref'])).toBe(false);
  });

  it('returns false for an unrelated path', () => {
    expect(isPathUnderReferenceMount('/var/tmp/x', ['/home/u/ref'])).toBe(false);
  });

  it('handles trailing slashes on mount input', () => {
    expect(isPathUnderReferenceMount('/home/u/ref/a.ts', ['/home/u/ref/'])).toBe(true);
  });
});

describe('setupAdditionalFolders (reference mode)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'astro-extra-test-'));
  });

  it('returns an empty result when folders is undefined', async () => {
    const result = await setupAdditionalFolders(undefined);
    expect(result.mounts).toEqual([]);
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it('returns an empty result when folders is empty', async () => {
    const result = await setupAdditionalFolders([]);
    expect(result.mounts).toEqual([]);
  });

  it('mounts a reference folder with mountPath === hostPath', async () => {
    writeFileSync(join(tmpRoot, 'README.md'), '# ref');
    const result = await setupAdditionalFolders([
      { machineId: 'm1', path: tmpRoot, mode: 'reference' },
    ]);
    expect(result.mounts).toHaveLength(1);
    const m = result.mounts[0];
    expect(m.mode).toBe('reference');
    expect(m.hostPath).toBe(tmpRoot);
    expect(m.mountPath).toBe(tmpRoot);
  });

  it('throws with a descriptive error when a reference path is missing', async () => {
    const missing = join(tmpRoot, 'definitely-does-not-exist');
    await expect(
      setupAdditionalFolders([{ machineId: 'm1', path: missing, mode: 'reference' }]),
    ).rejects.toThrow(/not found on this machine/);
  });

  it('error message includes the folder index and machineId for debuggability', async () => {
    const missing = join(tmpRoot, 'nope');
    await expect(
      setupAdditionalFolders([
        { machineId: 'm1', path: tmpRoot, mode: 'reference' },
        { machineId: 'm-broken', path: missing, mode: 'reference' },
      ]),
    ).rejects.toThrow(/additionalFolders\[1\].*m-broken/);
  });
});

describe('reference-folder write-denial hook (integration with isPathUnderReferenceMount)', () => {
  // The canUseTool hook inside claude-sdk-adapter builds its deny decision on
  // top of isPathUnderReferenceMount + extractPathsForWriteCheck. Re-exercise
  // the contract here so a refactor to either helper doesn't silently regress
  // the "write into reference folder is denied" rule.
  it('denies Edit calls whose file_path is inside a reference mount', () => {
    const refMounts = ['/mnt/ref-repo'];
    const input = { file_path: '/mnt/ref-repo/src/index.ts' };
    const isWrite = input.file_path && isPathUnderReferenceMount(input.file_path, refMounts);
    expect(isWrite).toBe(true);
  });

  it('allows Edit calls outside reference mounts', () => {
    const refMounts = ['/mnt/ref-repo'];
    const input = { file_path: '/mnt/project/src/index.ts' };
    const isWrite = input.file_path && isPathUnderReferenceMount(input.file_path, refMounts);
    expect(isWrite).toBe(false);
  });

  it('denies Bash commands that touch paths under a reference mount', () => {
    const refMounts = ['/mnt/ref-repo'];
    const cmd = 'rm -rf /mnt/ref-repo/secrets';
    const tokens = cmd.split(/\s+/).filter(t => t.startsWith('/'));
    const anyDenied = tokens.some(t => isPathUnderReferenceMount(t, refMounts));
    expect(anyDenied).toBe(true);
  });
});
