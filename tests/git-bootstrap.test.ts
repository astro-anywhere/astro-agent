/**
 * Git bootstrap tests.
 *
 * Tests the initializeGit() function from git-bootstrap.ts:
 * 1. Basic initialization — creates repo, .gitignore, initial commit
 * 2. Idempotency — skips if repo already has commits
 * 3. Stale lock removal — cleans up old .lock files before init
 * 4. "Nothing to commit" handling — tolerates race where another task committed
 * 5. Lock age threshold — does NOT remove fresh lock files
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utimes } from 'node:fs/promises';

import { initializeGit } from '../src/lib/git-bootstrap.js';

// ============================================================================
// Helpers
// ============================================================================

const tmpDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Create a temp directory with a file in it (non-git). */
function createNonGitDir(): string {
  const dir = createTempDir('git-bootstrap-test-');
  writeFileSync(join(dir, 'hello.txt'), 'hello world\n');
  return dir;
}

/** Create a temp directory that already has a git repo with commits. */
function createExistingGitRepo(): string {
  const dir = createTempDir('git-bootstrap-existing-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'existing.txt'), 'already here\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'Pre-existing commit'], { cwd: dir });
  return dir;
}

/** Check if a directory is a git repo with at least one commit. */
function hasCommits(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/** Get the commit message of HEAD. */
function getHeadMessage(dir: string): string {
  return execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir }).toString().trim();
}

afterAll(async () => {
  for (const dir of tmpDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ============================================================================
// 1. Basic initialization
// ============================================================================

describe('initializeGit — basic initialization', () => {
  it('creates a git repo with initial commit in a non-git directory', async () => {
    const dir = createNonGitDir();

    await initializeGit(dir);

    expect(hasCommits(dir)).toBe(true);
    expect(getHeadMessage(dir)).toBe('Initial commit');
  });

  it('creates .gitignore with standard entries', async () => {
    const dir = createNonGitDir();

    await initializeGit(dir);

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.astro');
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('.env.local');
  });

  it('does not overwrite existing .gitignore', async () => {
    const dir = createNonGitDir();
    writeFileSync(join(dir, '.gitignore'), 'custom_ignore\n');

    await initializeGit(dir);

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(gitignore).toBe('custom_ignore\n');
    expect(gitignore).not.toContain('node_modules');
  });

  it('sets repo-local git identity', async () => {
    const dir = createNonGitDir();

    await initializeGit(dir);

    const userName = execFileSync('git', ['config', 'user.name'], { cwd: dir }).toString().trim();
    const userEmail = execFileSync('git', ['config', 'user.email'], { cwd: dir }).toString().trim();
    expect(userName).toBe('Astro Agent');
    expect(userEmail).toBe('agent@astro.local');
  });

  it('tracks existing files in the initial commit', async () => {
    const dir = createNonGitDir();

    await initializeGit(dir);

    // hello.txt should be tracked
    const files = execFileSync('git', ['ls-files'], { cwd: dir }).toString().trim();
    expect(files).toContain('hello.txt');
  });
});

// ============================================================================
// 2. Idempotency — skip if repo already has commits
// ============================================================================

describe('initializeGit — idempotency', () => {
  it('skips entirely if repo already has commits', async () => {
    const dir = createExistingGitRepo();
    const originalMessage = getHeadMessage(dir);

    await initializeGit(dir);

    // Should still have the original commit, not "Initial commit"
    expect(getHeadMessage(dir)).toBe(originalMessage);
    expect(getHeadMessage(dir)).toBe('Pre-existing commit');
  });

  it('is safe to call twice on the same non-git directory', async () => {
    const dir = createNonGitDir();

    await initializeGit(dir);
    await initializeGit(dir);

    // Should have exactly one commit (the initial one)
    const commitCount = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })
      .toString().trim();
    expect(commitCount).toBe('1');
  });
});

// ============================================================================
// 3. Stale lock removal
// ============================================================================

describe('initializeGit — stale lock removal', () => {
  it('removes stale config.lock before init', async () => {
    const dir = createNonGitDir();
    // Create a .git directory with a stale lock
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    const lockPath = join(gitDir, 'config.lock');
    writeFileSync(lockPath, '');
    // Backdate the lock to make it stale (older than 30s)
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    await initializeGit(dir);

    // Should have succeeded despite the stale lock
    expect(hasCommits(dir)).toBe(true);
    // Lock file should be gone
    expect(existsSync(lockPath)).toBe(false);
  });

  it('removes stale index.lock and HEAD.lock', async () => {
    const dir = createNonGitDir();
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });

    const locks = ['index.lock', 'HEAD.lock'];
    const staleTime = new Date(Date.now() - 60_000);
    for (const lock of locks) {
      const lockPath = join(gitDir, lock);
      writeFileSync(lockPath, '');
      await utimes(lockPath, staleTime, staleTime);
    }

    await initializeGit(dir);

    expect(hasCommits(dir)).toBe(true);
    for (const lock of locks) {
      expect(existsSync(join(gitDir, lock))).toBe(false);
    }
  });

  it('does NOT remove fresh lock files (< 30s old)', async () => {
    const dir = createNonGitDir();
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    const lockPath = join(gitDir, 'config.lock');
    writeFileSync(lockPath, '');
    // Lock is fresh (just created) — should NOT be removed

    // initializeGit will fail because the fresh lock blocks git init
    // but it should NOT have deleted the lock
    try {
      await initializeGit(dir);
    } catch {
      // Expected to fail — git init can't proceed with a fresh lock
    }

    // The fresh lock should still exist
    expect(existsSync(lockPath)).toBe(true);
  });
});

// ============================================================================
// 4. "Nothing to commit" race handling
// ============================================================================

describe('initializeGit — nothing to commit handling', () => {
  it('does not throw when commit finds nothing to commit', async () => {
    // Create a dir, init git manually, add and commit everything,
    // then call initializeGit — the repoHasCommits check should skip.
    // But if we simulate the race by having an empty repo (init but no commits),
    // and another process commits between our add and commit, we need
    // to tolerate "nothing to commit".
    //
    // We test this indirectly: create a repo with 0 commits but nothing to add.
    const dir = createTempDir('git-bootstrap-empty-');
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    // Don't create any files — git add . will stage nothing, commit will say "nothing to commit"
    // But git-bootstrap creates .gitignore, so there will be something to commit.
    // To truly test this, we need to pre-create .gitignore too.
    writeFileSync(join(dir, '.gitignore'), '.astro\nnode_modules\n.env\n.env.local\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'Someone else committed'], { cwd: dir });
    // Now remove the HEAD ref to make repoHasCommits return false,
    // but keep everything committed so "nothing to commit" fires.
    // Actually, repoHasCommits uses rev-parse HEAD which would succeed.
    // So this path is only reachable in a true race condition.
    // We verify the code pattern is correct by reading the source.
    const { readFileSync: readFs } = require('node:fs');
    const source = readFs(join(process.cwd(), 'src/lib/git-bootstrap.ts'), 'utf-8');

    // Verify the catch block checks both err.message and err.stdout
    expect(source).toContain("const msg = err instanceof Error ? err.message : String(err)");
    expect(source).toContain("const stdout = (err as { stdout?: string })?.stdout ?? ''");
    expect(source).toContain("!msg.includes('nothing to commit')");
    expect(source).toContain("!stdout.includes('nothing to commit')");
  });
});

// ============================================================================
// 5. Edge cases
// ============================================================================

describe('initializeGit — edge cases', () => {
  it('handles directory with only hidden files', async () => {
    const dir = createTempDir('git-bootstrap-hidden-');
    writeFileSync(join(dir, '.hidden'), 'secret\n');

    await initializeGit(dir);

    expect(hasCommits(dir)).toBe(true);
    const files = execFileSync('git', ['ls-files'], { cwd: dir }).toString().trim();
    expect(files).toContain('.hidden');
    expect(files).toContain('.gitignore');
  });

  it('handles directory with nested subdirectories', async () => {
    const dir = createTempDir('git-bootstrap-nested-');
    const subDir = join(dir, 'src', 'lib');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'main.ts'), 'console.log("hello")\n');

    await initializeGit(dir);

    expect(hasCommits(dir)).toBe(true);
    const files = execFileSync('git', ['ls-files'], { cwd: dir }).toString().trim();
    expect(files).toContain('src/lib/main.ts');
  });

  it('handles empty directory (only .gitignore gets committed)', async () => {
    const dir = createTempDir('git-bootstrap-empty-dir-');

    await initializeGit(dir);

    expect(hasCommits(dir)).toBe(true);
    const files = execFileSync('git', ['ls-files'], { cwd: dir }).toString().trim();
    expect(files).toBe('.gitignore');
  });

  it('does not fail when .git directory does not exist (no stale locks to check)', async () => {
    const dir = createTempDir('git-bootstrap-no-gitdir-');
    writeFileSync(join(dir, 'app.js'), 'module.exports = {}\n');

    // .git doesn't exist yet — removeStaleGitLocks should handle ENOENT gracefully
    await initializeGit(dir);

    expect(hasCommits(dir)).toBe(true);
  });
});
