/**
 * Working directory safety checks for agent runner.
 *
 * Prevents data loss by:
 * - Detecting git repos vs non-git directories
 * - Blocking parallel execution in non-git directories
 * - Warning about uncommitted changes
 * - Providing sandbox mode for risky operations
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, cp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

export enum WorkdirSafetyTier {
  SAFE = 'safe',           // Git repo with clean state
  GUARDED = 'guarded',     // Git repo with uncommitted changes (warn)
  RISKY = 'risky',         // Non-git directory (warn + require confirmation)
  UNSAFE = 'unsafe',       // Non-git + parallel execution (block)
}

export interface SafetyCheckResult {
  tier: WorkdirSafetyTier;
  warning?: string;
  blockReason?: string;
  isGitRepo: boolean;
  hasUncommittedChanges: boolean;
  parallelTaskCount: number;
}

export interface SandboxOptions {
  workdir: string;
  taskId: string;
  maxSize?: number; // Max size in bytes (default 100MB)
}

export interface SandboxSetup {
  sandboxPath: string;
  originalPath: string;
  cleanup: () => Promise<void>;
  copyBack: () => Promise<void>;
}

const DEFAULT_MAX_SANDBOX_SIZE = 100 * 1024 * 1024; // 100MB

/**
 * Check if a directory is a git repository
 */
export async function isGitRepo(workdir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workdir,
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a working directory is an untracked subdirectory of a parent git repo.
 *
 * Returns true when:
 * - The workdir is inside a git repo (git root found by walking up)
 * - The git root is a DIFFERENT directory than the workdir
 * - The workdir has ZERO tracked files in that repo
 *
 * This detects the case where a user places their project folder inside a
 * directory that happens to have a .git (e.g., ~/tmp has a .git and the
 * project is at ~/tmp/my-project/). The worktree logic would latch onto the
 * parent repo, but the project's files aren't tracked there, so the worktree
 * would be empty.
 */
export async function isUntrackedInParentRepo(workdir: string): Promise<boolean> {
  try {
    const { resolve, relative } = await import('node:path');
    const { stdout: gitRootRaw } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workdir,
      timeout: 5_000,
    });
    const gitRoot = resolve(gitRootRaw.trim());
    const resolvedWorkdir = resolve(workdir);

    // If workdir IS the git root, it's not a "parent repo" situation
    if (gitRoot === resolvedWorkdir) return false;

    // Check if any files in the workdir are tracked by the parent repo
    const rel = relative(gitRoot, resolvedWorkdir);
    const { stdout: trackedFiles } = await execFileAsync(
      'git', ['-C', gitRoot, 'ls-files', rel],
      { timeout: 5_000 },
    );
    return trackedFiles.trim().length === 0;
  } catch {
    return false;
  }
}

/**
 * Check if a git repository has any configured remotes.
 * Returns false for repos created with `git init` that never had a remote added.
 */
export async function repoHasRemote(workdir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['remote'], {
      cwd: workdir,
      timeout: 5_000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a git repository has uncommitted changes
 */
export async function hasUncommittedChanges(workdir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: workdir,
      timeout: 5_000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false; // If git command fails, assume no changes
  }
}

/**
 * Check if git is installed on the system
 */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the size of a directory in bytes
 */
export async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  async function traverse(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);

      if (entry.isDirectory()) {
        // Skip common large directories and hidden folders
        if (entry.name === 'node_modules' ||
            entry.name === '.git' ||
            entry.name === 'venv' ||
            entry.name === '__pycache__' ||
            entry.name === 'build' ||
            entry.name === 'dist' ||
            entry.name === '.next') {
          continue;
        }
        await traverse(fullPath);
      } else if (entry.isFile()) {
        const stats = await stat(fullPath);
        totalSize += stats.size;
      }
    }
  }

  await traverse(dirPath);
  return totalSize;
}

/**
 * Check working directory safety for task execution.
 *
 * Safety tiers:
 * - SAFE:    git + worktree (isolation), or git + clean + no worktree
 * - RISKY:   non-git single task, or git + uncommitted + no worktree single task
 * - UNSAFE:  non-git + parallel, or git + uncommitted + no worktree + parallel
 * - GUARDED: (reserved, currently unused)
 */
export async function checkWorkdirSafety(
  workdir: string,
  activeTasksInDir: number,
  gitAvailable: boolean,
  willUseWorktree?: boolean,
): Promise<SafetyCheckResult> {
  const isGit = gitAvailable && await isGitRepo(workdir);
  const hasUncommitted = isGit && await hasUncommittedChanges(workdir);

  // UNSAFE: Non-git directory with parallel execution
  if (!isGit && activeTasksInDir > 0) {
    return {
      tier: WorkdirSafetyTier.UNSAFE,
      blockReason: [
        'PARALLEL EXECUTION BLOCKED',
        '',
        'Multiple agents cannot run in the same non-git directory.',
        'This would cause file conflicts and potential data loss.',
        '',
        `Active tasks in this directory: ${activeTasksInDir}`,
        '',
        'Solutions:',
        '1. Wait for other tasks to complete',
        '2. Initialize git in this directory',
        '3. Use a different working directory',
        '4. Enable --sandbox-mode to execute in isolation',
      ].join('\n'),
      isGitRepo: false,
      hasUncommittedChanges: false,
      parallelTaskCount: activeTasksInDir,
    };
  }

  // RISKY: Non-git directory (warn but allow with confirmation)
  if (!isGit) {
    return {
      tier: WorkdirSafetyTier.RISKY,
      warning: [
        'NO GIT REPOSITORY DETECTED',
        '',
        'AI agents may modify or delete files without version control.',
        'You will NOT be able to revert changes if something goes wrong.',
        '',
        'Recommendations:',
        '1. Initialize git: cd ' + workdir + ' && git init',
        '2. Use --sandbox-mode to work on a copy',
        '3. Ensure you have backups of important files',
        '',
        'Continue at your own risk.',
      ].join('\n'),
      isGitRepo: false,
      hasUncommittedChanges: false,
      parallelTaskCount: activeTasksInDir,
    };
  }

  // SAFE: Git repo with worktree isolation (uncommitted changes are safe)
  if (willUseWorktree) {
    return {
      tier: WorkdirSafetyTier.SAFE,
      isGitRepo: true,
      hasUncommittedChanges: hasUncommitted,
      parallelTaskCount: activeTasksInDir,
    };
  }

  // UNSAFE: Git repo with uncommitted changes, no worktree, parallel tasks
  if (hasUncommitted && activeTasksInDir > 0) {
    return {
      tier: WorkdirSafetyTier.UNSAFE,
      blockReason: [
        'PARALLEL EXECUTION WITH UNCOMMITTED CHANGES',
        '',
        'The working directory has uncommitted changes, worktree isolation',
        'is disabled, and other tasks are already running here.',
        'This would risk destroying your uncommitted work.',
        '',
        `Active tasks in this directory: ${activeTasksInDir}`,
        '',
        'Solutions:',
        '1. Wait for other tasks to complete',
        '2. Commit or stash your changes first',
        '3. Enable worktree isolation (default)',
        '4. Use --sandbox-mode to execute in isolation',
      ].join('\n'),
      isGitRepo: true,
      hasUncommittedChanges: true,
      parallelTaskCount: activeTasksInDir,
    };
  }

  // RISKY: Git repo with uncommitted changes, no worktree, single task
  if (hasUncommitted) {
    return {
      tier: WorkdirSafetyTier.RISKY,
      warning: [
        'UNCOMMITTED CHANGES WITHOUT WORKTREE ISOLATION',
        '',
        'The working directory has uncommitted changes and worktree',
        'isolation is disabled. The agent may overwrite or destroy',
        'your uncommitted work.',
        '',
        'Recommendations:',
        '1. Commit or stash your changes first',
        '2. Enable worktree isolation (default)',
        '3. Use --sandbox-mode to work on a copy',
        '',
        'Continue at your own risk.',
      ].join('\n'),
      isGitRepo: true,
      hasUncommittedChanges: true,
      parallelTaskCount: activeTasksInDir,
    };
  }

  // SAFE: Git repo with clean state
  return {
    tier: WorkdirSafetyTier.SAFE,
    isGitRepo: true,
    hasUncommittedChanges: false,
    parallelTaskCount: activeTasksInDir,
  };
}

/**
 * Create a sandbox copy of the working directory for isolated execution
 */
export async function createSandbox(options: SandboxOptions): Promise<SandboxSetup> {
  const { workdir, taskId, maxSize = DEFAULT_MAX_SANDBOX_SIZE } = options;

  // Check directory size
  const dirSize = await getDirectorySize(workdir);
  if (dirSize > maxSize) {
    const sizeMB = (dirSize / 1024 / 1024).toFixed(1);
    const maxMB = (maxSize / 1024 / 1024).toFixed(1);
    throw new Error(
      `Directory size (${sizeMB}MB) exceeds sandbox limit (${maxMB}MB). ` +
      `Use --max-sandbox-size to increase or exclude large directories.`
    );
  }

  const sandboxRoot = join(homedir(), '.astro', 'sandbox');
  const sandboxPath = join(sandboxRoot, taskId);

  // Remove existing sandbox if present
  await rm(sandboxPath, { recursive: true, force: true });

  // Copy directory to sandbox
  await cp(workdir, sandboxPath, {
    recursive: true,
    filter: (src) => {
      const name = src.split('/').pop() || '';
      // Skip large/unnecessary directories
      return !(
        name === 'node_modules' ||
        name === '.git' ||
        name === 'venv' ||
        name === '__pycache__' ||
        name === 'build' ||
        name === 'dist' ||
        name === '.next' ||
        name === '.venv'
      );
    },
  });

  return {
    sandboxPath,
    originalPath: workdir,
    cleanup: async () => {
      await rm(sandboxPath, { recursive: true, force: true });
    },
    copyBack: async () => {
      // WARNING: Copy modified files back to original location
      // This operation can overwrite existing work. Consider requiring explicit approval.
      // Skip .git directory to avoid corrupting git state
      console.warn('[sandbox] Copying back from sandbox to original directory. This may overwrite files.');

      // Verify sandbox still exists before copying
      try {
        await stat(sandboxPath);
      } catch {
        throw new Error(`Sandbox path no longer exists: ${sandboxPath}`);
      }

      await cp(sandboxPath, workdir, {
        recursive: true,
        force: true,
        filter: (src) => {
          const name = src.split('/').pop() || '';
          return name !== '.git';
        },
      });
    },
  };
}

/**
 * Format directory size for human reading
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}
