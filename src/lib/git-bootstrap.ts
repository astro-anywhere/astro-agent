/**
 * Unified git initialization for non-git directories.
 *
 * Single source of truth used by:
 *  - task-executor.ts (safety dialog init-git, skipSafetyCheck, untracked subdir, zero-commit repo)
 *  - start.ts onGitInit (relay-based plan page button)
 *
 * Produces:
 *  - `git init -b main`
 *  - `.gitignore` (if missing): .astro, node_modules, .env, .env.local
 *  - `git add .` + `git commit -m "Initial commit"`
 *  - No CLAUDE.md — project context is injected via prompt at dispatch time
 *
 * Race-safe: if two tasks dispatch to the same directory simultaneously,
 * the first to commit wins and the second is a no-op.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, access, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const GITIGNORE_CONTENTS = '.astro\nnode_modules\n.env\n.env.local\n';

/**
 * Initialize a git repository in the given directory.
 * Idempotent: skips entirely if the repo already has commits.
 * Race-safe: handles concurrent calls from parallel tasks.
 */
export async function initializeGit(workdir: string): Promise<void> {
  // If the repo already has commits, skip initialization entirely.
  // This handles re-execution and the common race where another task won.
  if (await repoHasCommits(workdir)) {
    return;
  }

  // Remove stale lock files from interrupted git operations.
  // Prevents "could not lock config file: File exists" when a prior
  // git process was killed mid-operation.
  await removeStaleGitLocks(workdir);

  await execFileAsync('git', ['init', '-b', 'main'], { cwd: workdir, timeout: 10_000 });

  // Set repo-local git identity so commit works on machines without global git config.
  // This writes to .git/config (local only), not the user's ~/.gitconfig.
  await execFileAsync('git', ['config', 'user.name', 'Astro Agent'], { cwd: workdir, timeout: 5_000 });
  await execFileAsync('git', ['config', 'user.email', 'agent@astro.local'], { cwd: workdir, timeout: 5_000 });

  // Create .gitignore if it doesn't exist
  const gitignorePath = join(workdir, '.gitignore');
  try {
    await access(gitignorePath);
  } catch {
    await writeFile(gitignorePath, GITIGNORE_CONTENTS);
  }

  await execFileAsync('git', ['add', '.'], { cwd: workdir, timeout: 10_000 });

  // Commit may race with another task that initialized the same directory.
  // "nothing to commit" means the other task already committed — that's fine.
  try {
    await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: workdir, timeout: 10_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('nothing to commit')) {
      throw err;
    }
  }
}

/** Check if the git repo at workdir has at least one commit. */
async function repoHasCommits(workdir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workdir, timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Remove stale .git/*.lock files left by interrupted git operations. */
async function removeStaleGitLocks(workdir: string): Promise<void> {
  const lockFiles = [
    join(workdir, '.git', 'config.lock'),
    join(workdir, '.git', 'index.lock'),
  ];
  for (const lockFile of lockFiles) {
    try {
      await access(lockFile);
      await unlink(lockFile);
      console.log(`[git-bootstrap] Removed stale lock file: ${lockFile}`);
    } catch {
      // No lock file — normal case
    }
  }
}
