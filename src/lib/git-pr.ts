/**
 * Git PR utilities for creating pull requests after task execution
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
  /** Error message if any step of the delivery pipeline failed */
  error?: string;
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
 * Check if the current branch has commits ahead of the base branch
 */
export async function hasBranchCommits(
  worktreePath: string,
  baseBranch: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'rev-list', '--count', `origin/${baseBranch}..HEAD`],
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
  worktreePath: string,
  branchName: string,
): Promise<{ ok: boolean; error?: string }> {
  // Log remote URL for debugging push target
  try {
    const { stdout: remoteUrl } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'remote', 'get-url', 'origin'],
      { env: withGitEnv(), timeout: 5_000 }
    );
    console.log(`[git-pr] Pushing branch ${branchName} to origin (${remoteUrl.trim()})`);
  } catch {
    console.warn(`[git-pr] Could not resolve origin URL for ${worktreePath}`);
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'push', '-u', 'origin', branchName],
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
 * Create a pull request using the `gh` CLI
 */
export async function createPullRequest(
  worktreePath: string,
  options: {
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
  },
): Promise<{ prUrl: string; prNumber: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr', 'create',
        '--base', options.baseBranch,
        '--head', options.branchName,
        '--title', options.title,
        '--body', options.body,
      ],
      { cwd: worktreePath, env: withGitEnv(), timeout: 30_000 }
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
 * Full PR creation flow: auto-commit + push + create PR, with graceful fallbacks
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
    /** Target branch for PR base — avoids re-detecting (should match what worktree was created from) */
    baseBranch?: string;
  },
): Promise<PRResult> {
  const result: PRResult = { branchName: options.branchName };

  // Get git root from worktree to find default branch
  const gitRoot = await getGitRoot(worktreePath);
  if (!gitRoot) {
    console.warn(`[git-pr] No git root found for ${worktreePath}, skipping PR`);
    result.error = 'Not a git repository';
    return result;
  }

  // Check if repo has a remote
  if (!(await hasRemoteOrigin(gitRoot))) {
    console.warn(`[git-pr] No remote origin for ${gitRoot}, skipping PR`);
    result.error = 'No remote origin configured — cannot push';
    return result;
  }

  // Priority: caller-provided baseBranch > config file > auto-detection
  const baseBranch = options.baseBranch ?? await readBaseBranchFromConfig(gitRoot) ?? await getDefaultBranch(gitRoot);

  // Auto-commit any uncommitted changes the agent left behind (opt-in, default true)
  if (options.autoCommit !== false) {
    await autoCommitChanges(worktreePath, options.taskTitle);
  }

  // Check if there are commits to push
  const hasCommits = await hasBranchCommits(worktreePath, baseBranch);
  if (!hasCommits) {
    console.log(`[git-pr] No commits ahead of ${baseBranch} in ${worktreePath}, skipping PR`);
    // Not an error — agent made no changes
    return result;
  }
  console.log(`[git-pr] Branch ${options.branchName} has commits ahead of ${baseBranch}`);

  // Push the branch
  const pushResult = await pushBranch(worktreePath, options.branchName);
  if (!pushResult.ok) {
    result.error = pushResult.error || 'Failed to push branch';
    return result;
  }
  result.pushed = true;

  // Skip PR creation if requested (push-only mode)
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

  const pr = await createPullRequest(worktreePath, {
    branchName: options.branchName,
    baseBranch,
    title: options.taskTitle,
    body,
  });

  if (pr) {
    result.prUrl = pr.prUrl;
    result.prNumber = pr.prNumber;
  } else {
    result.error = 'PR creation failed (gh pr create returned an error)';
  }

  return result;
}
