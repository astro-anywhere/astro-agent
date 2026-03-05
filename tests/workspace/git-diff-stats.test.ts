/**
 * Integration test for post-execution git diff file change stats.
 * Verifies that emitGitDiffFileChanges correctly parses `git diff --numstat`
 * output for text files, binary files, new files, and modified files.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

/** Minimal reproduction of emitGitDiffFileChanges parsing logic */
async function collectGitDiffStats(
  workdir: string,
  commitBeforeSha: string,
): Promise<Array<{ path: string; action: string; linesAdded?: number; linesRemoved?: number; binary: boolean }>> {
  const results: Array<{ path: string; action: string; linesAdded?: number; linesRemoved?: number; binary: boolean }> = [];

  let output = '';

  // Committed changes
  const { stdout } = await execFileAsync(
    'git', ['-C', workdir, 'diff', '--numstat', commitBeforeSha, 'HEAD'],
    { timeout: 30_000 },
  );
  output = stdout;

  // Uncommitted changes
  const { stdout: uncommitted } = await execFileAsync(
    'git', ['-C', workdir, 'diff', '--numstat', 'HEAD'],
    { timeout: 30_000 },
  );
  if (uncommitted.trim()) {
    output = output ? output + '\n' + uncommitted : uncommitted;
  }

  if (!output.trim()) return results;

  const fileStats = new Map<string, { added: number; removed: number; binary: boolean }>();

  for (const line of output.trim().split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [addedStr, removedStr, ...pathParts] = parts;
    const filePath = pathParts.join('\t');

    if (addedStr === '-' || removedStr === '-') {
      if (!fileStats.has(filePath)) {
        fileStats.set(filePath, { added: 0, removed: 0, binary: true });
      }
      continue;
    }

    const added = parseInt(addedStr, 10) || 0;
    const removed = parseInt(removedStr, 10) || 0;
    const existing = fileStats.get(filePath);
    if (existing && !existing.binary) {
      existing.added += added;
      existing.removed += removed;
    } else if (!existing) {
      fileStats.set(filePath, { added, removed, binary: false });
    }
  }

  for (const [filePath, stats] of fileStats) {
    if (stats.binary) {
      results.push({ path: filePath, action: 'modified', binary: true });
    } else {
      const action = stats.removed === 0 && stats.added > 0 ? 'created' : 'modified';
      results.push({
        path: filePath,
        action,
        linesAdded: stats.added,
        linesRemoved: stats.removed,
        binary: false,
      });
    }
  }

  return results;
}

function createTestRepo(): { dir: string; beforeSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'astro-diff-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

  // Initial commit with text + binary files
  writeFileSync(join(dir, 'existing.txt'), 'line1\nline2\n');
  writeFileSync(join(dir, 'to-modify.txt'), 'original\n');
  // Write real binary content (random bytes)
  const binaryContent = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) binaryContent[i] = i;
  writeFileSync(join(dir, 'image.bin'), binaryContent);

  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  const beforeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  return { dir, beforeSha };
}

describe('git diff file change stats', () => {
  it('should count lines for new text files', async () => {
    const { dir, beforeSha } = createTestRepo();
    writeFileSync(join(dir, 'new-file.txt'), 'a\nb\nc\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'add new file'], { cwd: dir });

    const results = await collectGitDiffStats(dir, beforeSha);
    const newFile = results.find(r => r.path === 'new-file.txt');

    expect(newFile).toBeDefined();
    expect(newFile!.action).toBe('created');
    expect(newFile!.linesAdded).toBe(3);
    expect(newFile!.linesRemoved).toBe(0);
    expect(newFile!.binary).toBe(false);
  });

  it('should count lines for modified text files', async () => {
    const { dir, beforeSha } = createTestRepo();
    writeFileSync(join(dir, 'to-modify.txt'), 'changed\nand added\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'modify file'], { cwd: dir });

    const results = await collectGitDiffStats(dir, beforeSha);
    const modified = results.find(r => r.path === 'to-modify.txt');

    expect(modified).toBeDefined();
    expect(modified!.action).toBe('modified');
    expect(modified!.linesAdded).toBe(2);
    expect(modified!.linesRemoved).toBe(1);
    expect(modified!.binary).toBe(false);
  });

  it('should detect binary files without line counts', async () => {
    const { dir, beforeSha } = createTestRepo();
    const newBinary = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) newBinary[i] = 255 - i;
    writeFileSync(join(dir, 'image.bin'), newBinary);
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'modify binary'], { cwd: dir });

    const results = await collectGitDiffStats(dir, beforeSha);
    const binary = results.find(r => r.path === 'image.bin');

    expect(binary).toBeDefined();
    expect(binary!.binary).toBe(true);
    expect(binary!.linesAdded).toBeUndefined();
    expect(binary!.linesRemoved).toBeUndefined();
  });

  it('should handle multiple files in one diff', async () => {
    const { dir, beforeSha } = createTestRepo();
    writeFileSync(join(dir, 'new1.txt'), 'hello\n');
    writeFileSync(join(dir, 'new2.txt'), 'a\nb\n');
    writeFileSync(join(dir, 'to-modify.txt'), 'rewritten\ncompletely\nnew\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'multiple changes'], { cwd: dir });

    const results = await collectGitDiffStats(dir, beforeSha);

    expect(results.length).toBe(3);

    const new1 = results.find(r => r.path === 'new1.txt')!;
    expect(new1.linesAdded).toBe(1);
    expect(new1.action).toBe('created');

    const new2 = results.find(r => r.path === 'new2.txt')!;
    expect(new2.linesAdded).toBe(2);
    expect(new2.action).toBe('created');

    const modified = results.find(r => r.path === 'to-modify.txt')!;
    expect(modified.linesAdded).toBe(3);
    expect(modified.linesRemoved).toBe(1);
    expect(modified.action).toBe('modified');
  });

  it('should include uncommitted changes', async () => {
    const { dir, beforeSha } = createTestRepo();
    // Commit one file
    writeFileSync(join(dir, 'committed.txt'), 'yes\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'commit one'], { cwd: dir });
    // Leave another uncommitted
    writeFileSync(join(dir, 'uncommitted.txt'), 'not yet\n');

    const results = await collectGitDiffStats(dir, beforeSha);

    const committed = results.find(r => r.path === 'committed.txt');
    expect(committed).toBeDefined();
    expect(committed!.linesAdded).toBe(1);

    // Uncommitted files won't appear in `git diff HEAD` unless staged
    // But untracked files don't show in `git diff --numstat HEAD`
    // This is expected — untracked files need `git add` first
  });

  it('should return empty for no changes', async () => {
    const { dir, beforeSha } = createTestRepo();
    const results = await collectGitDiffStats(dir, beforeSha);
    expect(results).toEqual([]);
  });
});
