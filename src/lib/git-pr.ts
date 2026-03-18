/**
 * Git PR utilities for creating pull requests after task execution.
 *
 * GitHub workflow: task branch → PR → project branch (auto-merge).
 * Task branches NEVER create PRs directly to the base branch (main).
 * The only PR to main comes from the "Push to GitHub" task node.
 *
 * When the worktree is gone (agent cleaned it up during execution),
 * git operations fall back to gitRoot (branch refs live in shared store),
 * and gh commands use explicit --repo OWNER/REPO (no local context needed).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

function withGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
}

export interface PRResult {
  branchName: string;
  pushed?: boolean;
  prUrl?: string;
  prNumber?: number;
  /** Git SHA of the base branch before this PR was merged */
  commitBeforeSha?: string;
  /** Git SHA of the base branch after this PR was merged */
  commitAfterSha?: string;
  /** Error message if any step of the delivery pipeline failed */
  error?: string;
  /** Whether auto-merge was attempted and failed (PR created but not merged) */
  autoMergeFailed?: boolean;
}

/**
 * Detect the default branch (main/master) for the repo
 */
export async function getDefaultBranch(repoDir: string): Promise<string> {
  // Try symbolic-ref first (most reliable)
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'symbolic-ref', 'refs/remotes/origin/HEAD'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    const ref = stdout.trim();
    // refs/remotes/origin/main -> main
    const parts = ref.split('/');
    return parts[parts.length - 1];
  } catch {
    // Fallback: look for common branch names in remote refs
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'branch', '-r', '--list', 'origin/main', 'origin/master'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    const branches = stdout.trim().split('\n').map((b) => b.trim());
    if (branches.includes('origin/main')) return 'main';
    if (branches.includes('origin/master')) return 'master';
  } catch {
    // Fallback to 'main'
  }

  return 'main';
}

/**
 * Check if a branch has commits ahead of the base branch.
 *
 * When called from a worktree, HEAD resolves to the task branch.
 * When called from the git root (worktree cleaned up), pass branchName
 * explicitly so we compare the right ref instead of HEAD.
 */
export async function hasBranchCommits(
  repoDir: string,
  baseBranch: string,
  branchName?: string,
): Promise<boolean> {
  try {
    const headRef = branchName ?? 'HEAD';
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'rev-list', '--count', `origin/${baseBranch}..${headRef}`],
      { env: withGitEnv(), timeout: 10_000 }
    );
    return parseInt(stdout.trim(), 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Push the branch to origin
 */
export async function pushBranch(
  repoDir: string,
  branchName: string,
): Promise<{ ok: boolean; error?: string }> {
  // Log remote URL for debugging push target
  try {
    const { stdout: remoteUrl } = await execFileAsync(
      'git',
      ['-C', repoDir, 'remote', 'get-url', 'origin'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    console.log(`[git-pr] Pushing branch ${branchName} to origin (${remoteUrl.trim()})`);
  } catch {
    console.warn(`[git-pr] Could not resolve origin URL for ${repoDir}`);
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['-C', repoDir, 'push', '-u', 'origin', branchName],
      { env: withGitEnv(), timeout: 60_000 }
    );
    if (stderr) console.log(`[git-pr] Push stderr: ${stderr.trim()}`);
    if (stdout) console.log(`[git-pr] Push stdout: ${stdout.trim()}`);
    return { ok: true };
  } catch (err) {
    const execErr = err as { stderr?: string; stdout?: string; message?: string };
    const errorDetail = execErr.stderr?.trim() || execErr.message || String(err);
    console.error(`[git-pr] Failed to push branch ${branchName}: ${errorDetail}`);
    return { ok: false, error: `Failed to push branch: ${errorDetail}` };
  }
}

/**
 * Extract the GitHub repo slug (OWNER/REPO) from a git remote URL.
 * Supports both SSH and HTTPS formats:
 *   git@github.com:owner/repo.git → owner/repo
 *   https://github.com/owner/repo.git → owner/repo
 */
export function parseRepoSlug(remoteUrl: string): string | null {
  // Handles both SSH (git@github.com:owner/repo.git)
  // and HTTPS (https://github.com/owner/repo.git) formats.
  const match = remoteUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (match) return match[1];
  return null;
}

/**
 * Get the GitHub repo slug (OWNER/REPO) from a git directory's origin remote.
 */
export async function getRepoSlug(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'remote', 'get-url', 'origin'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    return parseRepoSlug(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Create a pull request using the `gh` CLI.
 *
 * Uses --repo OWNER/REPO when provided so the command doesn't depend on
 * the local git directory being valid (worktree may have been cleaned up).
 */
export async function createPullRequest(
  cwd: string,
  options: {
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
    /** Explicit GitHub repo slug (OWNER/REPO) — avoids local git context resolution */
    repoSlug?: string;
  },
): Promise<{ prUrl: string; prNumber: number } | null> {
  try {
    const args = [
      'pr', 'create',
      '--base', options.baseBranch,
      '--head', options.branchName,
      '--title', options.title,
      '--body', options.body,
    ];
    if (options.repoSlug) {
      args.push('--repo', options.repoSlug);
    }

    const { stdout } = await execFileAsync(
      'gh',
      args,
      { cwd, env: withGitEnv(), timeout: 30_000 }
    );

    const prUrl = stdout.trim();
    // Extract PR number from URL: https://github.com/user/repo/pull/123
    const match = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = match ? parseInt(match[1], 10) : 0;

    return { prUrl, prNumber };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[git-pr] Failed to create PR: ${msg}`);
    return null;
  }
}

/**
 * Merge a pull request using the `gh` CLI.
 * Used to auto-merge per-task PRs into the project branch.
 *
 * Uses --repo OWNER/REPO when provided so the command doesn't depend on
 * the local git directory being valid.
 */
export async function mergePullRequest(
  cwd: string,
  prNumber: number,
  options?: {
    method?: 'squash' | 'merge' | 'rebase';
    deleteBranch?: boolean;
    /** Explicit GitHub repo slug (OWNER/REPO) */
    repoSlug?: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const method = options?.method ?? 'squash';
  const args = [
    'pr', 'merge', String(prNumber),
    `--${method}`,
  ];
  if (options?.deleteBranch !== false) {
    args.push('--delete-branch');
  }
  if (options?.repoSlug) {
    args.push('--repo', options.repoSlug);
  }

  try {
    await execFileAsync('gh', args, {
      cwd,
      env: withGitEnv(),
      timeout: 60_000,
    });
    console.log(`[git-pr] Merged PR #${prNumber} via ${method}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[git-pr] Failed to merge PR #${prNumber}: ${msg}`);
    return { ok: false, error: `Failed to merge PR: ${msg}` };
  }
}

/**
 * Get the current SHA of a remote branch.
 * Fetches first to ensure we have the latest.
 */
export async function getRemoteBranchSha(
  repoDir: string,
  branchName: string,
): Promise<string | undefined> {
  try {
    await execFileAsync(
      'git',
      ['-C', repoDir, 'fetch', 'origin', branchName],
      { env: withGitEnv(), timeout: 30_000 }
    );
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'rev-parse', `origin/${branchName}`],
      { env: withGitEnv(), timeout: 5_000 }
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if `gh` CLI is available and authenticated
 */
export async function isGhAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status'], {
      env: withGitEnv(),
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a directory is a git repo with a remote origin
 */
export async function hasRemoteOrigin(repoDir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'remote', 'get-url', 'origin'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the git root directory from any subdirectory
 */
export async function getGitRoot(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', dir, 'rev-parse', '--show-toplevel'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Auto-commit any uncommitted changes in the worktree.
 * Fallback for when the agent doesn't commit its own changes.
 */
export async function autoCommitChanges(
  worktreePath: string,
  taskTitle: string,
): Promise<boolean> {
  try {
    const { stdout: statusOutput } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'status', '--porcelain'],
      { env: withGitEnv(), timeout: 10_000 }
    );

    if (!statusOutput.trim()) {
      return false;
    }

    await execFileAsync(
      'git',
      ['-C', worktreePath, 'add', '-A'],
      { env: withGitEnv(), timeout: 30_000 }
    );

    await execFileAsync(
      'git',
      ['-C', worktreePath, 'commit', '-m', `${taskTitle}\n\nAuto-committed by Astro agent-runner`],
      { env: withGitEnv(), timeout: 30_000 }
    );

    console.log(`[git-pr] Auto-committed uncommitted changes for: ${taskTitle}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[git-pr] Auto-commit failed: ${msg}`);
    return false;
  }
}

/**
 * Read baseBranch from .astro/config.json (set during repo setup).
 * Returns null if config doesn't exist or baseBranch is not set.
 */
async function readBaseBranchFromConfig(gitRoot: string): Promise<string | null> {
  try {
    const configPath = join(gitRoot, '.astro', 'config.json');
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
 * Full PR delivery following the accumulative project branch workflow:
 *
 *   task branch → push → PR → auto-merge → project branch
 *
 * When the worktree has been cleaned up (agent removed it during execution):
 * - git operations (push, rev-list) use gitRoot — the task branch lives in
 *   the shared git object store, not the worktree directory
 * - gh operations (pr create, pr merge) use --repo OWNER/REPO — explicitly
 *   targets the GitHub repo without depending on local filesystem state
 * - auto-commit is skipped (nothing to stage if the worktree is gone)
 *
 * baseBranch MUST be provided by the caller. It is the project branch
 * (e.g., astro/7b19a9), never auto-detected. Task branches must never
 * create PRs directly to the base branch (main) — that's exclusively
 * the "Push to GitHub" node's responsibility.
 */
export async function pushAndCreatePR(
  worktreePath: string,
  options: {
    branchName: string;
    taskTitle: string;
    taskDescription?: string;
    /** If true, push the branch but skip PR creation */
    skipPR?: boolean;
    /** If true, auto-commit uncommitted changes before pushing (default: true) */
    autoCommit?: boolean;
    /** Override the default PR body */
    body?: string;
    /** Target branch for PR base (project branch). Required for PR creation. */
    baseBranch?: string;
    /** If true, auto-merge the PR after creation (squash merge into project branch) */
    autoMerge?: boolean;
    /** Merge method for auto-merge (default: 'squash') */
    mergeMethod?: 'squash' | 'merge' | 'rebase';
    /** Git SHA of the base branch before this task — passed through to PRResult */
    commitBeforeSha?: string;
    /** Git root directory — used when the worktree has been cleaned up */
    gitRoot?: string;
  },
): Promise<PRResult> {
  const result: PRResult = { branchName: options.branchName };

  // Resolve git context: worktree if it still exists, gitRoot otherwise.
  // The task branch lives in the shared git object store (all worktrees
  // share one .git), so push/rev-list work from gitRoot even when the
  // worktree directory is gone.
  const worktreeGitRoot = await getGitRoot(worktreePath);
  const gitRoot = worktreeGitRoot ?? options.gitRoot ?? null;
  if (!gitRoot) {
    console.warn(`[git-pr] No git root found for ${worktreePath} and no gitRoot provided`);
    result.error = 'Not a git repository';
    return result;
  }

  const worktreeAlive = !!worktreeGitRoot;
  // For git commands: use worktree when available (HEAD = task branch),
  // fall back to gitRoot (need explicit branch name for rev-list).
  const gitDir = worktreeAlive ? worktreePath : gitRoot;

  if (!worktreeAlive) {
    console.log(`[git-pr] Worktree at ${worktreePath} is gone, using gitRoot: ${gitRoot}`);
  }

  // Check if repo has a remote
  if (!(await hasRemoteOrigin(gitRoot))) {
    console.warn(`[git-pr] No remote origin for ${gitRoot}, skipping PR`);
    result.error = 'No remote origin configured — cannot push';
    return result;
  }

  // Resolve the repo slug for gh commands (OWNER/REPO from remote URL).
  // This makes gh pr create/merge independent of the local filesystem.
  // Only required when we'll actually run gh commands (not skipPR mode).
  const repoSlug = await getRepoSlug(gitRoot);
  if (!repoSlug && !worktreeAlive && !options.skipPR) {
    console.warn(`[git-pr] Cannot resolve repo slug from ${gitRoot} and worktree is gone`);
    result.error = 'Cannot resolve GitHub repo — worktree gone and no repo slug';
    return result;
  }

  // baseBranch: caller-provided (project branch) > config > auto-detect.
  // For the accumulative workflow, the caller should always provide the
  // project branch. Auto-detection is only a fallback for edge cases
  // (e.g., "Push to GitHub" node targeting the default branch).
  const baseBranch = options.baseBranch ?? await readBaseBranchFromConfig(gitRoot) ?? await getDefaultBranch(gitRoot);

  // Auto-commit uncommitted changes — only when the worktree still exists.
  // When the worktree is gone, there's nothing to stage (agent cleaned it up).
  if (options.autoCommit !== false && worktreeAlive) {
    await autoCommitChanges(worktreePath, options.taskTitle);
  } else if (options.autoCommit !== false && !worktreeAlive) {
    console.log(`[git-pr] Skipping auto-commit — worktree at ${worktreePath} no longer exists`);
  }

  // Check if there are commits to push.
  // From gitRoot, HEAD is the main checkout (not the task branch), so we
  // must compare by explicit branch name.
  const hasCommits = await hasBranchCommits(
    gitDir,
    baseBranch,
    worktreeAlive ? undefined : options.branchName,
  );
  if (!hasCommits) {
    console.log(`[git-pr] No commits ahead of ${baseBranch} for ${options.branchName}`);
    return result;
  }
  console.log(`[git-pr] Branch ${options.branchName} has commits ahead of ${baseBranch}`);

  // Push the task branch to origin.
  // Works from gitRoot because the branch ref lives in the shared store.
  const pushResult = await pushBranch(gitDir, options.branchName);
  if (!pushResult.ok) {
    result.error = pushResult.error || 'Failed to push branch';
    return result;
  }
  result.pushed = true;

  // Skip PR creation if requested (push-only mode, e.g., "Push to GitHub" node)
  if (options.skipPR) {
    console.log(`[git-pr] skipPR=true, branch pushed (${options.branchName})`);
    return result;
  }

  // Create PR if gh is available
  if (!(await isGhAvailable())) {
    console.log('[git-pr] gh CLI not available, skipping PR creation (branch pushed)');
    result.error = 'GitHub CLI (gh) not installed or not authenticated';
    return result;
  }

  const body = options.body
    ?? (options.taskDescription
      ? `## Task\n\n${options.taskDescription}\n\n---\n*Created by Astro task automation*`
      : '*Created by Astro task automation*');

  // Create PR: task branch → project branch.
  // Uses --repo when available so gh doesn't depend on local git context.
  // Guard: if repoSlug is null (non-standard remote URL) and the worktree
  // was deleted between the initial check and now, gh will fail with a
  // misleading "not a git repository" error. Re-check and fail clearly.
  if (!repoSlug && !(await getGitRoot(worktreePath))) {
    console.warn(`[git-pr] Worktree gone after push and no repo slug — cannot create PR`);
    result.error = 'Cannot resolve GitHub repo — worktree gone and no repo slug';
    return result;
  }
  console.log(`[git-pr] Creating PR: ${options.branchName} → ${baseBranch}${repoSlug ? ` (repo: ${repoSlug})` : ''}`);
  const pr = await createPullRequest(gitDir, {
    branchName: options.branchName,
    baseBranch,
    title: options.taskTitle,
    body,
    repoSlug: repoSlug ?? undefined,
  });

  if (pr) {
    result.prUrl = pr.prUrl;
    result.prNumber = pr.prNumber;
    result.commitBeforeSha = options.commitBeforeSha;

    // Auto-merge: squash-merge the per-task PR into the project branch
    if (options.autoMerge && pr.prNumber) {
      const mergeResult = await mergePullRequest(gitDir, pr.prNumber, {
        method: options.mergeMethod ?? 'squash',
        deleteBranch: true,
        repoSlug: repoSlug ?? undefined,
      });
      if (mergeResult.ok) {
        // Capture the project branch SHA after merge
        result.commitAfterSha = await getRemoteBranchSha(gitRoot, baseBranch);
        if (!result.commitAfterSha) {
          console.warn(`[git-pr] Failed to capture commitAfterSha after merge of PR #${pr.prNumber}`);
        }
        console.log(`[git-pr] Auto-merged PR #${pr.prNumber}, commitAfterSha=${result.commitAfterSha}`);
      } else {
        console.warn(`[git-pr] Auto-merge failed for PR #${pr.prNumber}: ${mergeResult.error}`);
        result.autoMergeFailed = true;
      }
    }
  } else {
    result.error = 'PR creation failed (gh pr create returned an error)';
  }

  return result;
}
