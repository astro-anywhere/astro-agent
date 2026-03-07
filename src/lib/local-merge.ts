/**
 * Local Merge — squash-merge a task branch into a project branch locally.
 *
 * Used for git repos with no remote (remoteType='none'). Provides the same
 * accumulative branch model as the GitHub PR flow, but using local git
 * merge operations instead of GitHub API calls.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

function withGitEnv(): NodeJS.ProcessEnv {
  // LC_ALL=C ensures git outputs English messages regardless of user locale,
  // which is required for reliable string matching (e.g., "nothing to commit").
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

export interface LocalMergeResult {
  merged: boolean;
  commitSha?: string;
  conflict?: boolean;
  conflictFiles?: string[];
  error?: string;
}

/**
 * Squash-merge a task branch into a project branch using a temporary worktree.
 *
 * This never disturbs the user's main checkout or any existing worktrees.
 * A temporary worktree is created for the merge, used, then cleaned up.
 */
export async function localMergeIntoProjectBranch(
  gitRoot: string,
  taskBranch: string,
  projectBranch: string,
  commitMessage: string,
): Promise<LocalMergeResult> {
  // 1. Check if there are actual changes between the branches
  try {
    const { stdout: diff } = await execFileAsync(
      'git',
      ['-C', gitRoot, 'diff', '--stat', `${projectBranch}...${taskBranch}`],
      { env: withGitEnv(), timeout: 10_000 },
    );
    if (!diff.trim()) {
      return { merged: false };
    }
  } catch {
    // If diff fails (e.g., branch doesn't exist), try the merge anyway
  }

  // 2. Create a temporary worktree for the merge operation
  const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const tmpMergeDir = join(gitRoot, '.astro', 'tmp-merge', `merge-${suffix}`);
  try {
    await execFileAsync(
      'git',
      ['-C', gitRoot, 'worktree', 'add', tmpMergeDir, projectBranch],
      { env: withGitEnv(), timeout: 15_000 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { merged: false, error: `Failed to create merge worktree: ${msg}` };
  }

  try {
    // 3. Squash-merge the task branch
    try {
      await execFileAsync(
        'git',
        ['-C', tmpMergeDir, 'merge', '--squash', taskBranch],
        { env: withGitEnv(), timeout: 30_000 },
      );
    } catch (mergeErr) {
      // Check for merge conflicts
      try {
        const { stdout: status } = await execFileAsync(
          'git',
          ['-C', tmpMergeDir, 'status', '--porcelain'],
          { env: withGitEnv(), timeout: 5_000 },
        );
        const conflictFiles = status
          .split('\n')
          .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(l))
          .map((l) => l.slice(3).trim());

        if (conflictFiles.length > 0) {
          // Reset the failed squash merge to leave worktree clean before removal.
          // Note: `merge --abort` does NOT work after `merge --squash` because
          // squash merges don't set MERGE_HEAD. `reset --merge` is the correct way.
          try {
            await execFileAsync(
              'git',
              ['-C', tmpMergeDir, 'reset', '--merge'],
              { env: withGitEnv(), timeout: 5_000 },
            );
          } catch { /* best effort — worktree cleanup handles it anyway */ }
          return { merged: false, conflict: true, conflictFiles };
        }
      } catch { /* fall through to generic error */ }

      const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      return { merged: false, error: `Merge failed: ${msg}` };
    }

    // 4. Commit the squash merge
    try {
      await execFileAsync(
        'git',
        ['-C', tmpMergeDir, 'commit', '-m', commitMessage],
        { env: withGitEnv(), timeout: 10_000 },
      );
    } catch (commitErr: unknown) {
      // Node's execFile error has .message='Command failed: ...' but the actual
      // git output is in .stdout/.stderr on the error object.
      const errObj = commitErr as { message?: string; stdout?: string; stderr?: string };
      const allOutput = [errObj.message, errObj.stdout, errObj.stderr]
        .filter(Boolean).join('\n');
      if (allOutput.includes('nothing to commit') || allOutput.includes('nothing added to commit')) {
        // Identical trees — not an error
        return { merged: false };
      }
      // Real commit failure (pre-commit hook, disk full, etc.)
      const msg = commitErr instanceof Error ? commitErr.message : String(commitErr);
      return { merged: false, error: `Commit failed: ${msg}` };
    }

    // 5. Get the resulting commit SHA
    try {
      const { stdout: sha } = await execFileAsync(
        'git',
        ['-C', tmpMergeDir, 'rev-parse', 'HEAD'],
        { env: withGitEnv(), timeout: 5_000 },
      );
      return { merged: true, commitSha: sha.trim() };
    } catch (shaErr) {
      const msg = shaErr instanceof Error ? shaErr.message : String(shaErr);
      return { merged: false, error: `Merge committed but failed to capture SHA: ${msg}` };
    }
  } finally {
    // 6. Always clean up the temporary merge worktree
    try {
      await execFileAsync(
        'git',
        ['-C', gitRoot, 'worktree', 'remove', '--force', tmpMergeDir],
        { env: withGitEnv(), timeout: 10_000 },
      );
    } catch {
      // Force-remove if git worktree remove fails
      try { await rm(tmpMergeDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try {
        await execFileAsync(
          'git', ['-C', gitRoot, 'worktree', 'prune'],
          { env: withGitEnv(), timeout: 5_000 },
        );
      } catch { /* best effort */ }
    }
  }
}
