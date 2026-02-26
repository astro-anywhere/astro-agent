/**
 * Worktree setup script execution
 *
 * Runs `astro-setup.sh` (if present) inside the worktree to perform
 * environment-specific setup like `npm install`, venv creation, etc.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

export interface SetupScriptOptions {
  gitRoot: string;
  worktreePath: string;
  taskId: string;
  projectId?: string;
  nodeId?: string;
  stdout?: (data: string) => void;
  stderr?: (data: string) => void;
  timeout?: number;
}

const SETUP_SCRIPT = 'astro-setup.sh';
const DEFAULT_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const KILL_GRACE = 5_000; // 5s after SIGTERM before SIGKILL

export async function runSetupScript(options: SetupScriptOptions): Promise<void> {
  const {
    gitRoot,
    worktreePath,
    taskId,
    projectId,
    nodeId,
    stdout,
    stderr,
    timeout = DEFAULT_TIMEOUT,
  } = options;

  const scriptPath = join(gitRoot, SETUP_SCRIPT);

  try {
    await access(scriptPath);
  } catch {
    return; // No setup script — nothing to do
  }

  return new Promise<void>((resolve) => {
    const child = spawn('bash', [scriptPath], {
      cwd: worktreePath,
      env: {
        ...process.env,
        ASTRO_TASK_ID: taskId,
        ASTRO_PROJECT_ID: projectId ?? '',
        ASTRO_NODE_ID: nodeId ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout?.(chunk.toString());
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr?.(chunk.toString());
    });

    child.on('close', settle);
    child.on('error', settle);

    // Timeout: SIGTERM then SIGKILL
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, KILL_GRACE);
    }, timeout);

    child.on('close', () => clearTimeout(timer));
  });
}
