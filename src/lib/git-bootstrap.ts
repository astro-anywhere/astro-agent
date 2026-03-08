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
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const GITIGNORE_CONTENTS = '.astro\nnode_modules\n.env\n.env.local\n';

/**
 * Initialize a git repository in the given directory.
 * Idempotent: skips .gitignore creation if the file already exists.
 */
export async function initializeGit(workdir: string): Promise<void> {
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
  await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: workdir, timeout: 10_000 });
}
