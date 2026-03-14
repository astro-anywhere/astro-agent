/**
 * Workspace root management for auto-provisioned project workspaces.
 *
 * When no explicit workingDirectory is configured for a project, the agent-runner
 * auto-creates a plain directory under the workspace root. No git init — the user
 * can opt in later via the safety decision flow.
 *
 * Resolution priority:
 *   1. ASTRO_WORKSPACE_DIR env var      (Slurm .bashrc, HPC job scripts)
 *   2. config.workspaceRoot             (persisted ~/.astro/config.json)
 *   3. Platform default:
 *      - Linux:   $XDG_DATA_HOME/astro/workspaces || ~/.astro/workspaces
 *      - macOS:   ~/.astro/workspaces
 *      - Windows: %LOCALAPPDATA%\astro\workspaces
 */

import { homedir, platform } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';

/**
 * Resolve the workspace root directory using the priority cascade.
 */
export function resolveWorkspaceRoot(): string {
  // 1. Environment variable (highest priority)
  if (process.env.ASTRO_WORKSPACE_DIR) {
    return process.env.ASTRO_WORKSPACE_DIR;
  }

  // 2. Persisted config
  const configRoot = config.getWorkspaceRoot();
  if (configRoot) {
    return configRoot;
  }

  // 3. Platform default
  const os = platform();
  if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      return path.join(localAppData, 'astro', 'workspaces');
    }
    return path.join(homedir(), 'astro', 'workspaces');
  }

  // Linux: prefer XDG_DATA_HOME
  if (os === 'linux' && process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, 'astro', 'workspaces');
  }

  // macOS + Linux fallback
  return path.join(homedir(), '.astro', 'workspaces');
}

/**
 * Ensure a project workspace directory exists and return its path.
 * Creates the directory (and parents) if it doesn't exist.
 * Does NOT initialize git — the workspace is a plain directory.
 */
export function ensureProjectWorkspace(projectId: string): string {
  const dir = path.join(resolveWorkspaceRoot(), projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Remove a project's workspace directory (best-effort).
 * Called when a project is deleted.
 */
export function cleanupProjectWorkspace(projectId: string): void {
  const dir = path.join(resolveWorkspaceRoot(), projectId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[workspace] Cleaned up project workspace: ${dir}`);
  } catch (err) {
    console.warn(`[workspace] Failed to clean up workspace ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Prune workspace directories older than maxAgeDays.
 * Runs on agent startup to clean up orphaned temp workspaces.
 */
export function pruneStaleWorkspaces(maxAgeDays: number = 30): void {
  const root = resolveWorkspaceRoot();
  if (!fs.existsSync(root)) return;

  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let pruned = 0;

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirPath = path.join(root, entry.name);
      try {
        const stat = fs.statSync(dirPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          console.log(`[workspace] Pruned stale workspace: ${dirPath} (age: ${Math.floor((now - stat.mtimeMs) / (24 * 60 * 60 * 1000))} days)`);
          pruned++;
        }
      } catch {
        // Skip entries we can't stat or remove
      }
    }
  } catch {
    // Workspace root doesn't exist or isn't readable — nothing to prune
  }

  if (pruned > 0) {
    console.log(`[workspace] Pruned ${pruned} stale workspace(s) from ${root}`);
  }
}
