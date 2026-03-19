import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, appendFile, rm, copyFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { applyWorktreeInclude } from './worktree-include.js';
import { runSetupScript } from './worktree-setup.js';
import { repoHasRemote } from './workdir-safety.js';

const execFileAsync = promisify(execFile);

export interface WorktreeOptions {
  workingDirectory: string;
  taskId: string;
  rootOverride?: string;
  projectId?: string;
  nodeId?: string;
  /** Short hex ID from projectId (6 chars) — used for readable branch/worktree names */
  shortProjectId?: string;
  /** Short hex ID from nodeId (6 chars) — used for readable branch/worktree names */
  shortNodeId?: string;
  agentDir?: string;
  /** Target branch from dispatch — takes priority over .astro/config.json and auto-detection */
  baseBranch?: string;
  /** Project-level accumulation branch (e.g., 'astro/7b19a9'). Task branches from this instead of main. */
  projectBranch?: string;
  stdout?: (data: string) => void;
  stderr?: (data: string) => void;
  /** Emit visible activity text to the Astro UI (shows in the task activity stream) */
  text?: (data: string) => void;
  /** Abort signal — checked between git operations so cancellation stops workspace prep */
  signal?: AbortSignal;
}

export interface WorktreeSetup {
  workingDirectory: string;
  branchName: string;
  /** The base branch the worktree was created from (project branch or default branch) */
  baseBranch: string;
  /** Git SHA of the start point before this task's work */
  commitBeforeSha?: string;
  /** Absolute path to the git root directory (for local merge operations) */
  gitRoot: string;
  /** Project accumulation branch name, if applicable (e.g., 'astro/7b19a9') */
  projectBranch?: string;
  /** Absolute path to the persistent project worktree (detached HEAD), if created */
  projectWorktreePath?: string;
  cleanup: (options?: { keepBranch?: boolean }) => Promise<void>;
}

export async function createWorktree(
  options: WorktreeOptions,
): Promise<WorktreeSetup | null> {
  const {
    workingDirectory,
    taskId,
    rootOverride,
    projectId,
    nodeId,
    shortProjectId,
    shortNodeId,
    agentDir,
    baseBranch: dispatchBaseBranch,
    text,
    projectBranch: dispatchProjectBranch,
    stdout,
    stderr,
    signal,
  } = options;

  // Validate taskId format to prevent command injection
  validateTaskId(taskId);

  const resolvedWorkingDirectory = resolve(workingDirectory);
  const gitRoot = await getGitRoot(resolvedWorkingDirectory);

  // Require git repository to exist
  // Safety checks in task-executor.ts ensure git is initialized before reaching here
  if (!gitRoot) {
    throw new Error(`Not a git repository: ${resolvedWorkingDirectory}. Initialize git first.`);
  }

  const hasHead = await hasCommits(gitRoot);
  if (!hasHead) {
    throw new Error(`Git repository has no commits: ${gitRoot}. Create an initial commit first.`);
  }

  const agentDirName = agentDir ?? '.astro';
  const baseRoot = rootOverride ?? await resolveWorktreeRoot(gitRoot, agentDirName);

  const branchPrefix = await readBranchPrefix(gitRoot, agentDirName);

  // Separate project branch (accumulative) from task branch (per-task).
  // Project branch: `astro/{shortProjectId}` — accumulates all task work via auto-merged PRs
  // Task branch: `astro/{shortProjectId}-{shortNodeId}` — per-task worktree branch
  const projectBranchName = dispatchProjectBranch
    ?? (shortProjectId ? `${branchPrefix}${sanitize(shortProjectId)}` : undefined);
  const branchSuffix = shortProjectId && shortNodeId
    ? `${sanitize(shortProjectId)}-${sanitize(shortNodeId)}`
    : sanitize(taskId);
  const taskBranchName = `${branchPrefix}${branchSuffix}`;
  const worktreePath = join(baseRoot, branchSuffix);
  // Abort-signal gate: check between every long git operation so cancellation
  // actually halts workspace prep instead of letting it run to completion.
  const checkAborted = () => {
    if (signal?.aborted) throw new Error(`Task ${taskId} cancelled during workspace preparation`);
  };

  text?.(`\n── [Astro] Preparing worktree: branch ${taskBranchName}\n`);
  checkAborted();
  await rm(worktreePath, { recursive: true, force: true });
  await pruneWorktrees(gitRoot);

  // Clean up lingering worktrees and branches for the TASK branch only.
  // Never delete the project branch — it accumulates work across tasks.
  checkAborted();
  await removeLingeringWorktrees(gitRoot, taskBranchName);
  await ensureBranchAvailable(gitRoot, taskBranchName);

  // Delete remote task branch if it exists — prevents non-fast-forward push
  // failures when re-executing a task whose previous branch was already pushed
  checkAborted();
  await deleteRemoteBranch(gitRoot, taskBranchName);

  // Fetch latest so we branch from up-to-date origin (skip for local-only repos)
  checkAborted();
  const hasRemote = await repoHasRemote(gitRoot);
  if (hasRemote) {
    text?.(`── [Git] Fetching latest from origin...\n`);
    try {
      await execFileAsync(
        'git',
        ['-C', gitRoot, '-c', 'core.hooksPath=/dev/null', 'fetch', 'origin'],
        { env: withGitEnv(), timeout: 30_000, signal: signal ?? undefined }
      );
      text?.(`── [Git] Fetch complete\n`);
    } catch (fetchErr) {
      const fetchMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      text?.(`── [Git] Fetch failed (proceeding with local refs): ${fetchMsg}\n`);
      console.warn(`[worktree] git fetch origin failed: ${fetchMsg}`);
    }
  }

  // Detect the repo's default branch (main/master/develop) for fallback.
  // Validate dispatch-provided baseBranch exists before using it.
  // The server may send 'main' as a default even for repos where 'main' doesn't exist
  // (e.g., non-git directories that later gained a git repo via agent init).
  const dispatchBranchValid = dispatchBaseBranch
    && (await refExists(gitRoot, `refs/heads/${dispatchBaseBranch}`)
      || await refExists(gitRoot, `refs/remotes/origin/${dispatchBaseBranch}`));
  const defaultBranch = (dispatchBranchValid ? dispatchBaseBranch : null)
    ?? await readBaseBranch(gitRoot, agentDirName)
    ?? await getDefaultBranch(gitRoot);

  // Ensure the project branch exists on origin. If this is the first task,
  // create it from origin/{defaultBranch}. Idempotent.
  checkAborted();
  if (projectBranchName) {
    await ensureProjectBranch(gitRoot, projectBranchName, defaultBranch, text);
  }

  // Create persistent project worktree (detached HEAD) — idempotent.
  // This enables file browsing at .astro/worktrees/{shortProjectId}/ after
  // task worktrees are cleaned up.
  let projectWorktreePath: string | undefined;
  if (projectBranchName && shortProjectId) {
    projectWorktreePath = await createProjectWorktree(
      gitRoot, projectBranchName, baseRoot, sanitize(shortProjectId),
    ) ?? undefined;
  }

  // Start point: prefer project branch tip (accumulates prior task work),
  // fall back to default branch for non-project worktrees.
  // Using origin/<branch> avoids stale local refs.
  const effectiveBase = projectBranchName ?? defaultBranch;
  const remoteRef = `origin/${effectiveBase}`;
  const hasRemoteRef = await refExists(gitRoot, remoteRef);
  const startPoint = hasRemoteRef ? remoteRef : effectiveBase;
  if (hasRemoteRef) {
    text?.(`── [Git] Branching from ${remoteRef}\n`);
  } else {
    text?.(`── [Git] Remote ref ${remoteRef} not found, using local ref ${effectiveBase}\n`);
    console.warn(`[worktree] Remote ref ${remoteRef} not found — falling back to local ${effectiveBase}`);
  }

  // Capture the commit SHA before this task's work begins
  let commitBeforeSha: string | undefined;
  try {
    const { stdout: sha } = await execFileAsync(
      'git',
      ['-C', gitRoot, 'rev-parse', startPoint],
      { env: withGitEnv(), timeout: 5_000 }
    );
    commitBeforeSha = sha.trim();
  } catch {
    console.warn('[worktree] Failed to capture commitBeforeSha for audit trail');
  }

  checkAborted();
  text?.(`── [Astro] Creating worktree from ${startPoint}...\n`);
  try {
    await execFileAsync(
      'git',
      ['-C', gitRoot, 'worktree', 'add', '-b', taskBranchName, worktreePath, startPoint],
      { env: withGitEnv(), timeout: 30_000, signal: signal ?? undefined }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) {
      // Branch exists from a previous failed/retried execution — delete it and retry.
      console.log(`[worktree] Branch ${taskBranchName} already exists, deleting stale branch and retrying`);
      try {
        await execFileAsync(
          'git', ['-C', gitRoot, 'branch', '-D', taskBranchName],
          { env: withGitEnv(), timeout: 5_000 }
        );
      } catch { /* branch might be checked out in a stale worktree — prune first */ }
      try {
        await execFileAsync(
          'git', ['-C', gitRoot, 'worktree', 'prune'],
          { env: withGitEnv(), timeout: 5_000 }
        );
        await execFileAsync(
          'git', ['-C', gitRoot, 'branch', '-D', taskBranchName],
          { env: withGitEnv(), timeout: 5_000 }
        );
      } catch { /* best effort — may already be deleted */ }
      await execFileAsync(
        'git',
        ['-C', gitRoot, 'worktree', 'add', '-b', taskBranchName, worktreePath, startPoint],
        { env: withGitEnv(), timeout: 30_000, signal: signal ?? undefined }
      );
    } else {
      throw err;
    }
  }

  // Initialize submodules if the repo uses them (non-fatal)
  checkAborted();
  try {
    await initSubmodules(worktreePath, stderr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr?.(`submodule init failed: ${msg}`);
  }

  // Orchestration: include files + setup script (both non-fatal)
  checkAborted();
  const log = stdout;
  try {
    await applyWorktreeInclude({ gitRoot, worktreePath, log });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr?.(`worktree-include failed: ${msg}`);
  }

  checkAborted();
  try {
    await runSetupScript({
      gitRoot,
      worktreePath,
      taskId,
      projectId,
      nodeId,
      stdout,
      stderr,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr?.(`setup script failed: ${msg}`);
  }

  // Copy CLAUDE.md if it exists in the git root but isn't tracked (non-fatal)
  try {
    await ensureClaudeMdInWorktree(gitRoot, worktreePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr?.(`CLAUDE.md copy failed: ${msg}`);
  }

  const relativePath = relative(gitRoot, resolvedWorkingDirectory);
  const useRelativePath =
    relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath) && relativePath !== '.';
  const worktreeWorkingDirectory = useRelativePath
    ? join(worktreePath, relativePath)
    : worktreePath;

  // If the working subdirectory doesn't exist in the worktree (e.g., it contains
  // only untracked or gitignored files), copy the source content so the agent
  // has files to work with. Without this, spawn() fails with ENOENT on the cwd.
  // This happens when the workdir is a deeply nested untracked folder inside a
  // parent git repo (git worktree only checks out tracked content).
  if (useRelativePath && !existsSync(worktreeWorkingDirectory)) {
    console.log(`[worktree] Working directory "${relativePath}" not in worktree (untracked?), copying from source`);
    try {
      await cp(resolvedWorkingDirectory, worktreeWorkingDirectory, { recursive: true });
      console.log(`[worktree] Copied "${relativePath}" into worktree successfully`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to copy untracked working directory "${relativePath}" into worktree: ${msg}`);
    }
  }

  text?.(`── [Astro] Worktree ready: ${worktreeWorkingDirectory}\n`);

  return {
    workingDirectory: worktreeWorkingDirectory,
    branchName: taskBranchName,
    baseBranch: effectiveBase,
    commitBeforeSha,
    gitRoot,
    projectBranch: projectBranchName,
    projectWorktreePath,
    cleanup: async (options?: { keepBranch?: boolean }) => {
      await cleanupWorktree(gitRoot, worktreePath, taskBranchName, options?.keepBranch);
    },
  };
}

/**
 * Parse `git worktree list --porcelain` and remove any worktree
 * that has the target branch checked out. This prevents
 * "branch already checked out" errors on re-execution.
 */
export async function removeLingeringWorktrees(gitRoot: string, branchName: string): Promise<void> {
  let wtList: string;
  try {
    const result = await execFileAsync(
      'git',
      ['-C', gitRoot, 'worktree', 'list', '--porcelain'],
      { env: withGitEnv(), timeout: 10_000 }
    );
    wtList = result.stdout;
  } catch {
    return; // Can't list — nothing to clean
  }

  // Parse porcelain output: blocks separated by blank lines,
  // each block has "worktree <path>" and "branch refs/heads/<name>"
  let currentWorktreePath: string | null = null;
  for (const line of wtList.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentWorktreePath = line.slice('worktree '.length);
    } else if (line.startsWith('branch ') && currentWorktreePath) {
      const ref = line.slice('branch '.length);
      if (ref === `refs/heads/${branchName}`) {
        console.log(`[worktree] Removing lingering worktree at ${currentWorktreePath} (branch: ${branchName})`);
        // Try git worktree remove first, fall back to force-removing the directory + prune
        try {
          await execFileAsync(
            'git',
            ['-C', gitRoot, 'worktree', 'remove', '--force', currentWorktreePath],
            { env: withGitEnv(), timeout: 30_000 }
          );
        } catch {
          // Fallback: force-remove the directory and prune to deregister
          await rm(currentWorktreePath, { recursive: true, force: true });
          await execFileAsync('git', ['-C', gitRoot, 'worktree', 'prune'], {
            env: withGitEnv(),
            timeout: 30_000,
          });
        }
        // Clean up directory if it still exists after either path
        if (existsSync(currentWorktreePath)) {
          await rm(currentWorktreePath, { recursive: true, force: true });
        }
      }
    } else if (line.trim() === '') {
      currentWorktreePath = null;
    }
  }
}

/**
 * Ensure the project-level accumulation branch exists.
 *
 * For repos WITH a remote: create on origin and push.
 * For repos WITHOUT a remote: create locally only (no push).
 *
 * Idempotent — safe to call on every task dispatch.
 *
 * Note: This function may be called concurrently by parallel tasks in the
 * same project (there is no external lock around workspace preparation).
 * It is internally idempotent: if a parallel task already created the branch,
 * the "already exists" error is caught and handled gracefully.
 */
async function ensureProjectBranch(
  gitRoot: string,
  projectBranch: string,
  defaultBranch: string,
  text?: (data: string) => void,
): Promise<void> {
  const hasRemote = await repoHasRemote(gitRoot);

  if (hasRemote) {
    // --- Remote mode: check origin, push if needed ---
    const remoteRef = `origin/${projectBranch}`;
    if (await refExists(gitRoot, remoteRef)) {
      text?.(`── [Git] Project branch ${projectBranch} exists on origin\n`);
      console.log(`[worktree] Project branch ${projectBranch} exists on origin`);
      return;
    }

    // Branch not on origin — either create it or push an existing local branch.
    const localExists = await refExists(gitRoot, `refs/heads/${projectBranch}`);

    if (!localExists) {
      // First-ever task for this project — create the branch locally.
      const defaultRemoteRef = `origin/${defaultBranch}`;
      const hasDefaultRemote = await refExists(gitRoot, defaultRemoteRef);
      const startPoint = hasDefaultRemote ? defaultRemoteRef : defaultBranch;

      text?.(`── [Git] Creating project branch ${projectBranch} from ${startPoint}...\n`);
      console.log(`[worktree] Creating project branch ${projectBranch} from ${startPoint}`);
      try {
        await execFileAsync(
          'git',
          ['-C', gitRoot, 'branch', projectBranch, startPoint],
          { env: withGitEnv(), timeout: 10_000 }
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Handle race condition: parallel task already created the branch locally.
        if (msg.includes('already exists')) {
          text?.(`── [Git] Project branch ${projectBranch} already created (race OK)\n`);
          console.log(`[worktree] Project branch ${projectBranch} created by another task (race OK)`);
        } else {
          throw new Error(`Failed to create project branch ${projectBranch}: ${msg}`);
        }
      }
    } else {
      text?.(`── [Git] Project branch ${projectBranch} exists locally but not on origin\n`);
      console.log(`[worktree] Project branch ${projectBranch} exists locally, not on origin — pushing`);
    }

    // Push the project branch to origin — required for PR mode to work.
    // Retry once on transient failures.
    const MAX_PUSH_ATTEMPTS = 2;
    let pushError: string | undefined;

    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      try {
        text?.(`── [Git] Pushing project branch ${projectBranch} to origin (attempt ${attempt}/${MAX_PUSH_ATTEMPTS})...\n`);
        await execFileAsync(
          'git',
          ['-C', gitRoot, 'push', '-u', 'origin', projectBranch],
          { env: withGitEnv(), timeout: 30_000 }
        );
        pushError = undefined;
        text?.(`── [Git] Project branch ${projectBranch} pushed to origin\n`);
        console.log(`[worktree] Pushed project branch ${projectBranch} to origin (attempt ${attempt})`);
        break;
      } catch (err) {
        pushError = err instanceof Error ? err.message : String(err);
        // "everything up-to-date" is not an error — branch already exists on origin
        if (pushError.includes('Everything up-to-date') || pushError.includes('up to date')) {
          text?.(`── [Git] Project branch ${projectBranch} already up-to-date on origin\n`);
          console.log(`[worktree] Project branch ${projectBranch} already up-to-date on origin`);
          pushError = undefined;
          break;
        }
        console.error(`[worktree] Push project branch attempt ${attempt} failed: ${pushError}`);
        if (attempt < MAX_PUSH_ATTEMPTS) {
          text?.(`── [Git] Push failed (attempt ${attempt}): ${pushError}\n── [Git] Retrying...\n`);
        }
      }
    }

    if (pushError) {
      text?.(`── [Git] ERROR: Failed to push project branch ${projectBranch} to origin: ${pushError}\n`);
      text?.(`── [Git] PR delivery will fail — the base branch must exist on GitHub for PRs.\n`);
      throw new Error(
        `Failed to push project branch ${projectBranch} to origin after ${MAX_PUSH_ATTEMPTS} attempts: ${pushError}. `
        + `PR delivery requires the project branch to exist on the remote. `
        + `Check: git remote permissions, SSH keys, network connectivity.`
      );
    }

    // Verify the branch is actually on origin after push.
    // git push can succeed but the branch may not appear if there's a ref mismatch.
    try {
      const { stdout: lsRemoteOut } = await execFileAsync(
        'git',
        ['-C', gitRoot, 'ls-remote', '--heads', 'origin', projectBranch],
        { env: withGitEnv(), timeout: 15_000 }
      );
      if (lsRemoteOut.trim()) {
        text?.(`── [Git] Verified: ${projectBranch} exists on origin\n`);
        console.log(`[worktree] Verified project branch ${projectBranch} on origin via ls-remote`);
      } else {
        text?.(`── [Git] WARNING: push succeeded but ls-remote does not show ${projectBranch} on origin\n`);
        console.warn(`[worktree] Push succeeded but ls-remote shows no ${projectBranch} on origin — PR delivery may fail`);
      }
    } catch (lsErr) {
      const lsMsg = lsErr instanceof Error ? lsErr.message : String(lsErr);
      text?.(`── [Git] WARNING: Could not verify branch on origin: ${lsMsg}\n`);
      console.warn(`[worktree] ls-remote verification failed: ${lsMsg}`);
    }
  } else {
    // --- Local mode (no remote): create branch locally only ---
    if (await refExists(gitRoot, `refs/heads/${projectBranch}`)) {
      text?.(`── [Git] Project branch ${projectBranch} exists locally (no remote)\n`);
      console.log(`[worktree] Project branch ${projectBranch} exists locally (no remote)`);
      return;
    }

    text?.(`── [Git] Creating local project branch ${projectBranch} from ${defaultBranch}...\n`);
    console.log(`[worktree] Creating local project branch ${projectBranch} from ${defaultBranch}`);
    try {
      await execFileAsync(
        'git',
        ['-C', gitRoot, 'branch', projectBranch, defaultBranch],
        { env: withGitEnv(), timeout: 10_000 }
      );
      text?.(`── [Git] Created local project branch ${projectBranch}\n`);
      console.log(`[worktree] Created local project branch ${projectBranch}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) {
        text?.(`── [Git] Project branch ${projectBranch} already created (race OK)\n`);
        console.log(`[worktree] Project branch ${projectBranch} created by another task (race OK)`);
        return;
      }
      throw new Error(`Failed to create local project branch ${projectBranch}: ${msg}`);
    }
  }
}

/**
 * Create a persistent project-level worktree using detached HEAD.
 *
 * The project worktree lives at {baseRoot}/{shortProjectId}/ and mirrors
 * the project branch on disk. It uses `--detach` so the project branch
 * ref remains free for temporary merge worktrees (localMergeIntoProjectBranch
 * checks out the project branch — git prevents the same branch in two worktrees).
 *
 * Idempotent — safe to call on every task dispatch. If the worktree
 * already exists, returns the existing path.
 */
export async function createProjectWorktree(
  gitRoot: string,
  projectBranch: string,
  baseRoot: string,
  shortProjectId: string,
): Promise<string | null> {
  const projectWorktreePath = join(baseRoot, shortProjectId);

  // Already exists — no-op
  if (existsSync(projectWorktreePath)) {
    console.log(`[worktree] Project worktree already exists at ${projectWorktreePath}`);
    return projectWorktreePath;
  }

  // Determine start point: prefer local ref, fall back to remote
  const localRef = `refs/heads/${projectBranch}`;
  const remoteRef = `origin/${projectBranch}`;
  const hasLocal = await refExists(gitRoot, localRef);
  const startPoint = hasLocal ? localRef : remoteRef;

  try {
    await execFileAsync(
      'git',
      ['-C', gitRoot, 'worktree', 'add', '--detach', projectWorktreePath, startPoint],
      { env: withGitEnv(), timeout: 30_000 }
    );
    console.log(`[worktree] Created persistent project worktree at ${projectWorktreePath} (detached HEAD at ${projectBranch})`);
    return projectWorktreePath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Handle race: another parallel task created it between our check and git worktree add
    if (msg.includes('already registered') || msg.includes('already exists')) {
      console.log(`[worktree] Project worktree created by another task (race OK): ${projectWorktreePath}`);
      return projectWorktreePath;
    }
    console.warn(`[worktree] Failed to create project worktree: ${msg}`);
    return null;
  }
}

/**
 * Sync the persistent project worktree to the latest project branch tip.
 *
 * After each successful merge (branch or PR mode), the project branch moves
 * forward. This updates the detached HEAD in the project worktree so the
 * files on disk reflect the latest state.
 *
 * Ref selection:
 * - Branch mode (no remote): localMergeIntoProjectBranch() advances
 *   refs/heads/{projectBranch} directly → use the local ref.
 * - PR mode (has remote): GitHub merge advances origin/{projectBranch},
 *   but refs/heads/ is stale (no local commit) → fetch then use remote ref.
 *
 * Non-fatal — sync failure doesn't affect task completion.
 */
export async function syncProjectWorktree(
  projectWorktreePath: string,
  projectBranch: string,
  gitRoot: string,
): Promise<void> {
  if (!existsSync(projectWorktreePath)) {
    return;
  }

  // Determine the correct ref to checkout:
  // - Remote repos (PR mode): fetch, then use origin/ (remote has the merged state)
  // - Local repos (branch mode): use refs/heads/ (local merge updated it directly)
  const hasRemote = await repoHasRemote(gitRoot);
  let checkoutRef = `refs/heads/${projectBranch}`;

  if (hasRemote) {
    try {
      await execFileAsync(
        'git',
        ['-C', gitRoot, 'fetch', 'origin', projectBranch],
        { env: withGitEnv(), timeout: 15_000 }
      );
      checkoutRef = `origin/${projectBranch}`;
    } catch {
      // Fetch failed — fall back to local ref (best effort)
    }
  }

  try {
    await execFileAsync(
      'git',
      ['-C', projectWorktreePath, 'checkout', '--detach', checkoutRef],
      { env: withGitEnv(), timeout: 10_000 }
    );
    console.log(`[worktree] Synced project worktree at ${projectWorktreePath} to ${checkoutRef}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[worktree] Failed to sync project worktree: ${msg}`);
  }
}

/**
 * Remove the persistent project worktree.
 *
 * This is an exported utility for the astro platform to call when a project
 * is deleted. The agent-runner does not manage project lifecycles — it only
 * provides the building blocks. The integration point (calling this on
 * project deletion) lives in the astro server, not here.
 */
export async function cleanupProjectWorktree(
  gitRoot: string,
  projectWorktreePath: string,
): Promise<void> {
  if (!existsSync(projectWorktreePath)) {
    return;
  }

  try {
    await execFileAsync(
      'git',
      ['-C', gitRoot, 'worktree', 'remove', '--force', projectWorktreePath],
      { env: withGitEnv(), timeout: 30_000 }
    );
  } catch {
    await rm(projectWorktreePath, { recursive: true, force: true });
  }

  await pruneWorktrees(gitRoot);
  console.log(`[worktree] Cleaned up project worktree at ${projectWorktreePath}`);
}

/**
 * Delete remote branch if it exists.
 * Prevents non-fast-forward push failures when re-executing a task
 * whose previous branch was already pushed.
 */
async function deleteRemoteBranch(gitRoot: string, branchName: string): Promise<void> {
  try {
    await execFileAsync(
      'git',
      ['-C', gitRoot, 'push', 'origin', '--delete', branchName],
      { env: withGitEnv(), timeout: 15_000 }
    );
    console.log(`[worktree] Deleted remote branch ${branchName}`);
  } catch {
    // Remote branch didn't exist — that's fine
  }
}

/**
 * Detect the default branch for the repo.
 * Priority: .astro/config.json baseBranch → origin/HEAD → origin/main or master → local HEAD → 'main'.
 */
async function getDefaultBranch(gitRoot: string): Promise<string> {
  // 1. Check .astro/config.json for user-configured baseBranch
  try {
    const configPath = join(gitRoot, '.astro', 'config.json');
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content);
    if (config.baseBranch && typeof config.baseBranch === 'string') {
      // Validate it exists (remote or local)
      const remoteRef = `refs/remotes/origin/${config.baseBranch}`;
      const localRef = `refs/heads/${config.baseBranch}`;
      try {
        await execFileAsync(
          'git',
          ['-C', gitRoot, 'rev-parse', '--verify', remoteRef],
          { env: withGitEnv(), timeout: 5_000 }
        );
        return config.baseBranch;
      } catch {
        // No remote ref — check local
        try {
          await execFileAsync(
            'git',
            ['-C', gitRoot, 'rev-parse', '--verify', localRef],
            { env: withGitEnv(), timeout: 5_000 }
          );
          return config.baseBranch;
        } catch {
          // Branch doesn't exist anywhere, fall through to auto-detection
        }
      }
    }
  } catch {
    // Config doesn't exist or is invalid — fall through
  }

  // 2. Try origin/HEAD symbolic ref
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', gitRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    const parts = stdout.trim().split('/');
    return parts[parts.length - 1];
  } catch {
    // Fallback
  }

  // 3. Check if origin/main or origin/master exist
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', gitRoot, 'branch', '-r', '--list', 'origin/main', 'origin/master'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    const branches = stdout.trim().split('\n').map((b) => b.trim());
    if (branches.includes('origin/main')) return 'main';
    if (branches.includes('origin/master')) return 'master';
  } catch {
    // Fallback
  }

  // 4. No remote — check local branches for main/master
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', gitRoot, 'branch', '--list', 'main', 'master'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    const branches = stdout.trim().split('\n').map((b) => b.replace(/^\*?\s*/, '').trim());
    if (branches.includes('main')) return 'main';
    if (branches.includes('master')) return 'master';
  } catch {
    // Fallback
  }

  // 5. Last resort: use HEAD's current branch name
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', gitRoot, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    const branch = stdout.trim();
    if (branch && branch !== 'HEAD') return branch;
  } catch {
    // Fallback
  }

  // 6. Any local branch (last resort before hardcoded 'main')
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', gitRoot, 'branch', '--format=%(refname:short)'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    const branches = stdout.trim().split('\n').filter(b => b.trim());
    if (branches.length > 0) return branches[0];
  } catch {
    // Fallback
  }

  return 'main';
}

/**
 * Read the base branch from the agent directory config.
 * This is set during repo setup (e.g., 'main', 'develop', 'release').
 * Returns null if config doesn't exist or baseBranch is not set.
 */
async function readBaseBranch(gitRoot: string, agentDirName: string): Promise<string | null> {
  try {
    const configPath = join(gitRoot, agentDirName, 'config.json');
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content);
    if (config.baseBranch && typeof config.baseBranch === 'string') {
      return config.baseBranch;
    }
  } catch {
    // Config doesn't exist or is invalid
  }
  return null;
}

/**
 * Read the branch prefix from the agent directory config.
 * Falls back to 'astro/' if config doesn't exist or is invalid.
 */
async function readBranchPrefix(gitRoot: string, agentDirName: string): Promise<string> {
  try {
    const configPath = join(gitRoot, agentDirName, 'config.json');
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content);
    if (config.branchPrefix && typeof config.branchPrefix === 'string') {
      return config.branchPrefix;
    }
  } catch {
    // Config doesn't exist or is invalid — use default
  }
  return 'astro/';
}

/**
 * Resolve the worktree root directory.
 *
 * Creates `{agentDirName}/worktrees/` inside the git root so worktrees live
 * alongside the project (easy access to untracked data files, no bloat in ~/.astro/).
 *
 * Automatically adds `{agentDirName}/` to the repo's `.gitignore` if missing.
 *
 * Falls back to `~/.astro/worktrees/{repoName}/` if the git root is read-only.
 */
async function resolveWorktreeRoot(gitRoot: string, agentDirName: string): Promise<string> {
  const worktreesDir = join(gitRoot, agentDirName, 'worktrees');
  try {
    await mkdir(worktreesDir, { recursive: true });
    await ensureGitignoreEntry(gitRoot, `${agentDirName}/`);
    return worktreesDir;
  } catch {
    // Git root is read-only — fall back to home dir
    const repoName = sanitize(basename(gitRoot));
    const fallback = join(homedir(), '.astro', 'worktrees', repoName);
    await mkdir(fallback, { recursive: true });
    console.log(`[worktree] Git root read-only, using fallback: ${fallback}`);
    return fallback;
  }
}

/**
 * Ensure a pattern is present in the repo's .gitignore.
 * Appends if missing; creates the file if it doesn't exist.
 */
async function ensureGitignoreEntry(gitRoot: string, pattern: string): Promise<void> {
  const gitignorePath = join(gitRoot, '.gitignore');
  try {
    if (existsSync(gitignorePath)) {
      const content = await readFile(gitignorePath, 'utf-8');
      // Check if already present (exact line match)
      const lines = content.split('\n').map((l) => l.trim());
      if (lines.includes(pattern)) return;
      // Append with a preceding newline if the file doesn't end with one
      // Only add comment header if not already present in the file
      const prefix = content.endsWith('\n') ? '' : '\n';
      const hasComment = lines.includes('# Astro agent directory');
      const entry = hasComment ? `${prefix}${pattern}\n` : `${prefix}\n# Astro agent directory\n${pattern}\n`;
      await appendFile(gitignorePath, entry);
    } else {
      await appendFile(gitignorePath, `# Astro agent directory\n${pattern}\n`);
    }
  } catch {
    // Non-fatal: .gitignore update failed (e.g., permissions)
    console.log(`[worktree] Could not update .gitignore at ${gitignorePath}`);
  }
}

/**
 * Ensure CLAUDE.md is available in the worktree.
 *
 * If CLAUDE.md is tracked by git it will already appear in the worktree
 * automatically. But if it is untracked or gitignored in the source repo
 * we need to copy it explicitly so the agent has access to project
 * instructions inside the isolated worktree.
 *
 * This is intentionally non-fatal: a missing CLAUDE.md should never block
 * task execution.
 */
export async function ensureClaudeMdInWorktree(
  gitRoot: string,
  worktreePath: string,
): Promise<void> {
  try {
    const sourcePath = join(gitRoot, 'CLAUDE.md');
    const destPath = join(worktreePath, 'CLAUDE.md');

    // Nothing to copy if the source repo doesn't have a CLAUDE.md
    if (!existsSync(sourcePath)) {
      return;
    }

    // If it already exists in the worktree (i.e. it's tracked by git),
    // there's nothing to do
    if (existsSync(destPath)) {
      return;
    }

    await copyFile(sourcePath, destPath);
    console.log(`[worktree] Copied CLAUDE.md from ${gitRoot} to ${worktreePath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[worktree] Failed to copy CLAUDE.md: ${msg}`);
  }
}

/**
 * Initialize and update git submodules in a worktree.
 *
 * Git worktrees don't automatically init submodules — the directories
 * exist but are empty. We run `git submodule update --init --recursive`
 * to populate them. This is skipped if no .gitmodules file exists.
 */
async function initSubmodules(
  worktreePath: string,
  stderr?: (data: string) => void,
): Promise<void> {
  if (!existsSync(join(worktreePath, '.gitmodules'))) {
    return;
  }

  console.log(`[worktree] Initializing submodules in ${worktreePath}`);
  try {
    await execFileAsync(
      'git',
      ['-C', worktreePath, 'submodule', 'update', '--init', '--recursive'],
      { env: withGitEnv(), timeout: 120_000 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr?.(`[worktree] Submodule init failed: ${msg}`);
  }
}

async function getGitRoot(workingDirectory: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workingDirectory, 'rev-parse', '--show-toplevel'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    const root = stdout.trim();
    return root ? resolve(root) : null;
  } catch {
    return null;
  }
}

async function ensureBranchAvailable(gitRoot: string, branchName: string): Promise<void> {
  try {
    await execFileAsync(
      'git',
      ['-C', gitRoot, 'branch', '-D', branchName],
      { env: withGitEnv(), timeout: 10_000 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) return; // Branch didn't exist — fine

    // Branch exists but can't be deleted (e.g., checked out in a stale worktree).
    // Prune stale worktree references and retry.
    console.warn(`[worktree] branch -D ${branchName} failed: ${msg.split('\n')[0]}. Pruning and retrying...`);
    try {
      await execFileAsync('git', ['-C', gitRoot, 'worktree', 'prune'], {
        env: withGitEnv(), timeout: 10_000,
      });
      await execFileAsync(
        'git',
        ['-C', gitRoot, 'branch', '-D', branchName],
        { env: withGitEnv(), timeout: 10_000 }
      );
    } catch {
      // Still can't delete — warn but don't crash (caller will fail with descriptive error)
      console.warn(`[worktree] Failed to delete branch ${branchName} after prune`);
    }
  }
}

async function cleanupWorktree(
  gitRoot: string,
  worktreePath: string,
  branchName: string,
  keepBranch?: boolean,
): Promise<void> {
  try {
    await execFileAsync(
      'git',
      ['-C', gitRoot, 'worktree', 'remove', '--force', worktreePath],
      { env: withGitEnv(), timeout: 30_000 }
    );
    await execFileAsync('git', ['-C', gitRoot, 'worktree', 'prune'], {
      env: withGitEnv(),
      timeout: 30_000,
    });
  } catch {
    // Ignore - worktree may already be removed
  }

  try {
    await rm(worktreePath, { recursive: true, force: true });
  } catch {
    // Ignore - directory may not exist
  }

  // Skip branch deletion when keepBranch is true (e.g., PR was created)
  if (!keepBranch) {
    try {
      await execFileAsync(
        'git',
        ['-C', gitRoot, 'branch', '-D', branchName],
        { env: withGitEnv(), timeout: 10_000 }
      );
    } catch {
      // Ignore - branch may not exist or already deleted
    }
  }
}

async function pruneWorktrees(gitRoot: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', gitRoot, 'worktree', 'prune'], {
      env: withGitEnv(),
      timeout: 30_000,
    });
  } catch {
    // Ignore prune errors
  }
}

async function refExists(gitRoot: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', gitRoot, 'rev-parse', '--verify', ref], {
      env: withGitEnv(),
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function hasCommits(gitRoot: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', gitRoot, 'rev-parse', '--verify', 'HEAD'], {
      env: withGitEnv(),
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that taskId is safe for use in paths.
 * Accepts both UUID format and execution ID format (exec-{uuid-prefix}-{nodeId}-{timestamp}).
 * Command injection is not a risk because we use execFileAsync (not shell),
 * and the sanitize() function handles path safety.
 */
function validateTaskId(taskId: string): void {
  // Allow: alphanumeric, hyphens, underscores, dots (same chars as sanitize keeps)
  const safePattern = /^[a-zA-Z0-9._-]+$/;
  if (!safePattern.test(taskId) || taskId.length > 200) {
    throw new Error(`Invalid taskId format: ${taskId}. Must be alphanumeric with hyphens/underscores/dots, max 200 chars.`);
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function withGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
}
