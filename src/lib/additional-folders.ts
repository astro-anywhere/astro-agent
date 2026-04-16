/**
 * Additional folder mounting for multi-folder sessions.
 *
 * When a dispatch payload carries `additionalFolders`, the agent-runner
 * mounts each one into the agent session:
 *
 * - `working` folders: a git worktree is created at a sibling path on the
 *   folder's current HEAD (no new branch, no branch checkout on the host
 *   folder). The worktree path is what the agent operates on so the host
 *   folder is never mutated.
 *
 * - `reference` folders: the host path is mounted directly. Write-access
 *   is enforced by the provider adapter's permission hook — this module
 *   just verifies the path exists and passes it through.
 */

import { execFile as execFileCb } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

export type AdditionalFolderMode = 'working' | 'reference';

export interface AdditionalFolderInput {
  machineId: string;
  path: string;
  mode: AdditionalFolderMode;
}

export interface AdditionalFolderMount {
  hostPath: string;
  mountPath: string;
  mode: AdditionalFolderMode;
}

export interface SetupAdditionalFoldersResult {
  mounts: AdditionalFolderMount[];
  cleanup: () => Promise<void>;
}

const WORKTREE_PREFIX = '.astro-extra-';

/** Short stable hash of an absolute path — used to keep sibling worktree names unique. */
function pathHash(absPath: string): string {
  return createHash('sha1').update(absPath).digest('hex').slice(0, 8);
}

function siblingWorktreePath(hostPath: string): string {
  const parent = dirname(hostPath) || '.';
  const base = basename(hostPath) || 'repo';
  return join(parent, `${WORKTREE_PREFIX}${base}-${pathHash(hostPath)}`);
}

/**
 * Verify that a path exists and is a directory. Throws with a clear,
 * emoji-free error (per agent-runner CLAUDE.md safety-warning rules) if not.
 */
function assertDirectoryExists(label: string, p: string): void {
  if (!existsSync(p)) {
    throw new Error(
      `Additional ${label} folder not found on this machine: ${p}. ` +
      `The path was included in the dispatch payload but does not exist here.`,
    );
  }
  const s = statSync(p);
  if (!s.isDirectory()) {
    throw new Error(
      `Additional ${label} folder is not a directory: ${p}.`,
    );
  }
}

/**
 * Returns true if the directory is inside a git work tree.
 * Used to decide whether a working-mode folder can get a secondary worktree.
 */
async function isGitWorkTree(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', dir, 'rev-parse', '--is-inside-work-tree'],
      { timeout: 5_000 },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Create a git worktree at `worktreePath` pointing at the current HEAD of
 * `sourceRepo` (no new branch — `--detach` keeps the worktree on HEAD without
 * fighting with the source folder's checked-out branch).
 */
async function addDetachedWorktree(sourceRepo: string, worktreePath: string): Promise<void> {
  // `git worktree add --detach <path> HEAD` creates a worktree at HEAD
  // without requiring a new branch and without moving the source folder's
  // branch, which is exactly what we want: leave the user's folder alone.
  await execFileAsync(
    'git',
    ['-C', sourceRepo, 'worktree', 'add', '--detach', worktreePath, 'HEAD'],
    { timeout: 60_000 },
  );
}

/** Best-effort worktree removal. Logs on failure; never throws. */
async function removeWorktree(sourceRepo: string, worktreePath: string): Promise<void> {
  try {
    await execFileAsync(
      'git',
      ['-C', sourceRepo, 'worktree', 'remove', '--force', worktreePath],
      { timeout: 30_000 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[additional-folders] worktree remove failed for ${worktreePath}: ${msg}. ` +
      `Proceeding (best-effort cleanup).`,
    );
    // Fallback: prune stale worktree metadata so the repo isn't left confused.
    try {
      await execFileAsync(
        'git',
        ['-C', sourceRepo, 'worktree', 'prune'],
        { timeout: 15_000 },
      );
    } catch {
      // ignore
    }
  }
}

/**
 * Set up all additional folders for a task.
 *
 * For each folder:
 *   - reference: verify the path exists; mountPath = hostPath.
 *   - working: verify it's a git repo; create a detached sibling worktree
 *     at `<parent>/.astro-extra-<basename>-<sha8>`; mountPath = worktree path.
 *
 * Returns the resolved mounts plus a cleanup function that best-effort removes
 * any worktrees that were created. The cleanup is safe to call multiple times.
 */
export async function setupAdditionalFolders(
  folders: AdditionalFolderInput[] | undefined,
  logger?: { operational?: (message: string, source: 'astro' | 'git' | 'delivery') => void },
): Promise<SetupAdditionalFoldersResult> {
  if (!folders || folders.length === 0) {
    return { mounts: [], cleanup: async () => {} };
  }

  const mounts: AdditionalFolderMount[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    const entryLabel = `additionalFolders[${i}] (machineId=${folder?.machineId ?? '<unknown>'})`;
    try {
      await setupOneFolder(folder, mounts, cleanups, logger);
    } catch (err) {
      // Wrap every per-entry error with the label so callers can pinpoint
      // which entry in a multi-folder payload failed without losing the
      // original message.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${entryLabel}: ${msg}`);
    }
  }

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const fn of cleanups) {
      try {
        await fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[additional-folders] cleanup step failed: ${msg}`);
      }
    }
  };

  return { mounts, cleanup };
}

async function setupOneFolder(
  folder: AdditionalFolderInput,
  mounts: AdditionalFolderMount[],
  cleanups: Array<() => Promise<void>>,
  logger?: { operational?: (message: string, source: 'astro' | 'git' | 'delivery') => void },
): Promise<void> {
    if (!folder?.path) {
      throw new Error('missing path.');
    }
    const hostPath = isAbsolute(folder.path) ? folder.path : resolve(folder.path);

    if (folder.mode === 'reference') {
      assertDirectoryExists('reference', hostPath);
      mounts.push({ hostPath, mountPath: hostPath, mode: 'reference' });
      logger?.operational?.(
        `Mounted reference folder (read-only): ${hostPath}`,
        'astro',
      );
      return;
    }

    if (folder.mode === 'working') {
      assertDirectoryExists('working', hostPath);
      const isRepo = await isGitWorkTree(hostPath);
      if (!isRepo) {
        throw new Error(
          `working folder is not inside a git repository: ${hostPath}. ` +
          `Working folders require git so a secondary worktree can be created.`,
        );
      }

      const worktreePath = siblingWorktreePath(hostPath);
      // If a stale worktree from a prior run remains, prune it out first so
      // `git worktree add` doesn't refuse. Tight timeouts: don't let a slow
      // or hung filesystem stall the whole task queue — if quick cleanup
      // fails, addDetachedWorktree below will surface a clear error.
      if (existsSync(worktreePath)) {
        logger?.operational?.(
          `Removing stale worktree for additional folder: ${worktreePath}`,
          'git',
        );
        try {
          await execFileAsync(
            'git',
            ['-C', hostPath, 'worktree', 'remove', '--force', worktreePath],
            { timeout: 5_000 },
          );
        } catch {
          try {
            await execFileAsync('git', ['-C', hostPath, 'worktree', 'prune'], { timeout: 2_000 });
          } catch {
            // ignore — `git worktree add` below will error if state is still bad.
          }
        }
      }

      logger?.operational?.(
        `Creating worktree for additional folder: ${hostPath} -> ${worktreePath}`,
        'git',
      );
      try {
        await addDetachedWorktree(hostPath, worktreePath);
      } catch (addErr) {
        // Leave the repo in a consistent state: prune any half-created
        // worktree metadata so the next attempt isn't blocked by stale refs.
        try {
          await execFileAsync('git', ['-C', hostPath, 'worktree', 'prune'], { timeout: 2_000 });
        } catch {
          // ignore — the original add error is more useful to surface.
        }
        const msg = addErr instanceof Error ? addErr.message : String(addErr);
        throw new Error(
          `failed to create worktree at ${worktreePath}: ${msg}`,
        );
      }
      mounts.push({ hostPath, mountPath: worktreePath, mode: 'working' });
      cleanups.push(() => removeWorktree(hostPath, worktreePath));
      return;
    }

    throw new Error(
      `unknown mode ${String((folder as { mode?: unknown }).mode)} ` +
      `for path ${hostPath}. Expected 'working' or 'reference'.`,
    );
}

/**
 * Returns true if `targetPath` resolves under any `referenceMount.mountPath`.
 * Uses string-prefix matching on resolved absolute paths with a trailing
 * separator guard so /foo/bar does not match /foo/barbaz.
 */
export function isPathUnderReferenceMount(
  targetPath: string,
  referenceMountPaths: readonly string[],
): boolean {
  if (!targetPath || referenceMountPaths.length === 0) return false;
  let abs: string;
  try {
    abs = isAbsolute(targetPath) ? resolve(targetPath) : resolve(targetPath);
  } catch {
    return false;
  }
  for (const raw of referenceMountPaths) {
    if (!raw) continue;
    const root = resolve(raw);
    if (abs === root) return true;
    const rootWithSep = root.endsWith('/') ? root : root + '/';
    if (abs.startsWith(rootWithSep)) return true;
  }
  return false;
}
