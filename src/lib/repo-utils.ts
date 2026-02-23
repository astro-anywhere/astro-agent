/**
 * Repo utilities for agent runner.
 *
 * Lightweight versions of the core repo setup logic (isGitRepo, getFileTree,
 * getGitRemoteUrl) that run on remote machines. Skips .gitignore/CLAUDE.md
 * generation since the repo already exists on the remote machine.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export function getFileTree(dir: string): string[] {
  if (!existsSync(dir)) return [];

  try {
    const output = execFileSync('git', ['ls-files'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function getGitRemoteUrl(dir: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: 'pipe',
    }).trim();
    return url || undefined;
  } catch {
    return undefined;
  }
}

/** Key file contents read from the repo for context injection */
export interface RepoKeyFiles {
  claudeMd?: string;
  readmeMd?: string;
  packageInfo?: string;
}

export interface LocalRepoSetupResult {
  success: boolean;
  workingDirectory?: string;
  fileTree?: string[];
  repository?: string;
  needsGitInit?: boolean;
  keyFiles?: RepoKeyFiles;
  error?: string;
}

const KEY_FILE_CAP = 15_000;
const PKG_FILE_CAP = 5_000;

/**
 * Read key files from a directory for plan generation context.
 * Returns capped contents of CLAUDE.md, README.md, and package metadata.
 */
function readKeyFiles(dir: string): RepoKeyFiles {
  const result: RepoKeyFiles = {};

  function readCapped(path: string, cap: number): string | undefined {
    if (!existsSync(path)) return undefined;
    try {
      const content = readFileSync(path, 'utf-8');
      return content.length > cap ? content.slice(0, cap) + '\n\n[... truncated ...]' : content;
    } catch { return undefined; }
  }

  result.claudeMd = readCapped(join(dir, 'CLAUDE.md'), KEY_FILE_CAP);
  result.readmeMd = readCapped(join(dir, 'README.md'), KEY_FILE_CAP) ?? readCapped(join(dir, 'readme.md'), KEY_FILE_CAP);

  const packageFiles = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
  for (const pkg of packageFiles) {
    const content = readCapped(join(dir, pkg), PKG_FILE_CAP);
    if (content) {
      result.packageInfo = `# ${pkg}\n${content}`;
      break;
    }
  }

  return result;
}

/**
 * Extract repository name from a git URL.
 * e.g., "git@github.com:user/repo.git" → "repo"
 */
function extractRepoName(url: string): string {
  const parts = url.split('/');
  const last = parts[parts.length - 1];
  return last.replace(/\.git$/, '') || 'repo';
}

/**
 * Clone a git repository to the specified target directory.
 * If already cloned, fetch latest. Returns the local path.
 *
 * SECURITY: Uses execFileSync with git arguments to prevent command injection
 */
function cloneRepository(repoUrl: string, targetDir: string): string {
  if (existsSync(join(targetDir, '.git'))) {
    // Already cloned — fetch latest
    try {
      execFileSync('git', ['fetch', '--all'], {
        cwd: targetDir,
        stdio: 'ignore',
        timeout: 30_000,
      });
    } catch {
      // Non-fatal: proceed with stale clone
    }
  } else {
    // Ensure parent directory exists
    mkdirSync(join(targetDir, '..'), { recursive: true });
    // Clone the repo using execFileSync to prevent command injection
    execFileSync('git', ['clone', repoUrl, targetDir], {
      stdio: 'ignore',
      timeout: 120_000,
    });
  }
  return targetDir;
}

/**
 * Run repo setup locally on the agent runner's machine.
 * Handles existing directories and cloning repos from URL.
 */
export function localRepoSetup(options: {
  workingDirectory?: string;
  repository?: string;
  projectId?: string;
}): LocalRepoSetupResult {
  const { workingDirectory, repository, projectId } = options;

  // Case 1: No directory and no repository — create a fresh project dir
  if (!workingDirectory && !repository) {
    if (!projectId) {
      return { success: false, error: 'Project ID is required when creating a new directory' };
    }
    try {
      const dir = join(homedir(), '.astro', 'projects', projectId);
      mkdirSync(dir, { recursive: true });
      execSync('git init', { cwd: dir, stdio: 'ignore' });
      execSync('git config user.name "Astro Agent" || true', { cwd: dir, stdio: 'ignore' });
      execSync('git config user.email "agent@astro.local" || true', { cwd: dir, stdio: 'ignore' });
      const fileTree = getFileTree(dir);
      return {
        success: true,
        workingDirectory: dir,
        fileTree,
      };
    } catch (error) {
      return { success: false, error: `Failed to create project directory: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // If repo URL + working directory, clone into the working directory
  if (repository && workingDirectory) {
    try {
      const repoName = extractRepoName(repository);
      const cloneTarget = join(workingDirectory, repoName);
      const clonedDir = cloneRepository(repository, cloneTarget);
      const fileTree = getFileTree(clonedDir);
      const keyFiles = readKeyFiles(clonedDir);
      return {
        success: true,
        workingDirectory: clonedDir,
        fileTree,
        repository,
        keyFiles,
      };
    } catch (error) {
      return { success: false, error: `Failed to clone repository: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // If only a repo URL is provided (no working directory) — error
  if (repository && !workingDirectory) {
    return {
      success: false,
      error: 'Working directory required for git URL projects. Specify a local folder where the repository will be cloned.',
    };
  }

  if (workingDirectory) {
    if (!existsSync(workingDirectory)) {
      // Directory doesn't exist — create it (non-git, direct mode)
      try {
        mkdirSync(workingDirectory, { recursive: true });
      } catch (mkdirError) {
        return { success: false, error: `Failed to create directory: ${mkdirError instanceof Error ? mkdirError.message : String(mkdirError)}` };
      }
      return {
        success: true,
        workingDirectory,
        fileTree: [],
        needsGitInit: true,
      };
    }

    if (isGitRepo(workingDirectory)) {
      const fileTree = getFileTree(workingDirectory);
      const detectedRepo = getGitRemoteUrl(workingDirectory);
      const keyFiles = readKeyFiles(workingDirectory);
      return {
        success: true,
        workingDirectory,
        fileTree,
        repository: detectedRepo,
        keyFiles,
      };
    }

    // Not a git repo — direct mode (per WORKSPACE_V2)
    const keyFiles = readKeyFiles(workingDirectory);
    return {
      success: true,
      workingDirectory,
      fileTree: [],
      needsGitInit: true,
      keyFiles,
    };
  }

  return { success: false, error: 'Unexpected state' };
}
