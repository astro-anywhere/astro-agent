/**
 * Local Merge — squash-merge a task branch into a delivery branch locally.
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
 * Squash-merge a task branch into a delivery branch using a temporary worktree.
 *
 * This never disturbs the user's main checkout or any existing worktrees.
 * A temporary worktree is created for the merge, used, then cleaned up.
 */
export async function localMergeIntoDeliveryBranch(
  gitRoot: string,
  taskBranch: string,
  deliveryBranch: string,
  commitMessage: string,
  /** Optional logging callback for user-visible messages */
  log?: (msg: string) => void,
): Promise<LocalMergeResult> {
  const emit = log ?? (() => {});

  // 1. Check if there are actual changes between the branches
  console.log(`[local-merge] diff --stat ${deliveryBranch}...${taskBranch} (gitRoot: ${gitRoot})`);
  try {
    const { stdout: diff } = await execFileAsync(
      'git',
      ['-C', gitRoot, 'diff', '--stat', `${deliveryBranch}...${taskBranch}`],
      { env: withGitEnv(), timeout: 10_000 },
    );
    if (!diff.trim()) {
      console.log(`[local-merge] No changes between ${deliveryBranch} and ${taskBranch}`);
      emit('No changes to merge');
      return { merged: false };
    }
    console.log(`[local-merge] Changes detected:\n${diff.trim()}`);
  } catch {
    console.warn(`[local-merge] diff failed (branch may not exist yet), proceeding with merge`);
  }

  // 2. Create a temporary worktree for the merge operation
  const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const tmpMergeDir = join(gitRoot, '.astro', 'tmp-merge', `merge-${suffix}`);
  console.log(`[local-merge] worktree add ${tmpMergeDir} ${deliveryBranch}`);
  try {
    await execFileAsync(
      'git',
      ['-C', gitRoot, 'worktree', 'add', tmpMergeDir, deliveryBranch],
      { env: withGitEnv(), timeout: 15_000 },
    );
    console.log(`[local-merge] Merge worktree created at ${tmpMergeDir}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[local-merge] Failed to create merge worktree: ${msg}`);
    return { merged: false, error: `Failed to create merge worktree: ${msg}` };
  }

  try {
    // 3. Squash-merge the task branch
    console.log(`[local-merge] merge --squash ${taskBranch} (cwd: ${tmpMergeDir})`);
    emit(`Squash-merging ${taskBranch} into ${deliveryBranch}`);
    try {
      await execFileAsync(
        'git',
        ['-C', tmpMergeDir, 'merge', '--squash', taskBranch],
        { env: withGitEnv(), timeout: 30_000 },
      );
      console.log(`[local-merge] Squash-merge succeeded`);
    } catch (mergeErr) {
      console.warn(`[local-merge] Squash-merge failed, checking for conflicts`);
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
          console.log(`[local-merge] Conflict in: ${conflictFiles.join(', ')}`);
          emit(`Merge conflict: ${conflictFiles.join(', ')}`);
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
      console.error(`[local-merge] Merge failed: ${msg}`);
      return { merged: false, error: `Merge failed: ${msg}` };
    }

    // 4. Commit the squash merge
    console.log(`[local-merge] commit (cwd: ${tmpMergeDir})`);
    try {
      await execFileAsync(
        'git',
        ['-C', tmpMergeDir, 'commit', '-m', commitMessage],
        { env: withGitEnv(), timeout: 10_000 },
      );
      console.log(`[local-merge] Commit succeeded`);
    } catch (commitErr: unknown) {
      const errObj = commitErr as { message?: string; stdout?: string; stderr?: string };
      const allOutput = [errObj.message, errObj.stdout, errObj.stderr]
        .filter(Boolean).join('\n');
      if (allOutput.includes('nothing to commit') || allOutput.includes('nothing added to commit')) {
        console.log(`[local-merge] Nothing to commit (identical trees)`);
        emit('No changes to merge (identical trees)');
        return { merged: false };
      }
      const msg = commitErr instanceof Error ? commitErr.message : String(commitErr);
      console.error(`[local-merge] Commit failed: ${msg}`);
      return { merged: false, error: `Commit failed: ${msg}` };
    }

    // 5. Get the resulting commit SHA
    try {
      const { stdout: sha } = await execFileAsync(
        'git',
        ['-C', tmpMergeDir, 'rev-parse', 'HEAD'],
        { env: withGitEnv(), timeout: 5_000 },
      );
      console.log(`[local-merge] Merge committed: ${sha.trim()}`);
      return { merged: true, commitSha: sha.trim() };
    } catch (shaErr) {
      const msg = shaErr instanceof Error ? shaErr.message : String(shaErr);
      console.error(`[local-merge] Failed to capture SHA: ${msg}`);
      return { merged: false, error: `Merge committed but failed to capture SHA: ${msg}` };
    }
  } finally {
    // 6. Always clean up the temporary merge worktree
    console.log(`[local-merge] worktree remove ${tmpMergeDir}`);
    try {
      await execFileAsync(
        'git',
        ['-C', gitRoot, 'worktree', 'remove', '--force', tmpMergeDir],
        { env: withGitEnv(), timeout: 10_000 },
      );
      console.log(`[local-merge] Merge worktree removed`);
    } catch {
      console.warn(`[local-merge] worktree remove failed, force-removing`);
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
