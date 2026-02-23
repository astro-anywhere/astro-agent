/**
 * Stop command - stops the running agent
 */

import chalk from 'chalk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

export async function stopCommand(): Promise<void> {
  console.log(chalk.bold('\n🛑 Stopping Astro Agent Runner...\n'));

  try {
    let pids: string[] = [];

    // Try PID file first
    const pidFile = join(homedir(), '.astro', 'agent-runner.pid');
    try {
      const pidContent = readFileSync(pidFile, 'utf-8').trim();
      if (/^\d+$/.test(pidContent)) {
        pids.push(pidContent);
      }
      // Remove PID file regardless
      try { unlinkSync(pidFile); } catch { /* ignore */ }
    } catch {
      // No PID file — fall back to process search
    }

    // Fall back to pgrep if no PID file
    if (pids.length === 0) {
      const platform = process.platform;

      if (platform === 'win32') {
        try {
          const { stdout } = await execFileAsync(
            'wmic',
            ['process', 'where', "commandline like '%astro-agent%start%'", 'get', 'processid'],
            { timeout: 5000 },
          );
          pids = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => /^\d+$/.test(line));
        } catch {
          // No processes found
        }
      } else {
        try {
          const { stdout } = await execFileAsync('pgrep', ['-f', 'astro-agent.*start'], {
            timeout: 5000,
          });
          pids = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => /^\d+$/.test(line));
        } catch {
          // No processes found (pgrep exits 1 when no match)
        }
      }
    }

    if (pids.length === 0) {
      console.log(chalk.yellow('No running agent processes found.'));
      return;
    }

    // Kill each process
    for (const pid of pids) {
      try {
        process.kill(parseInt(pid, 10), 'SIGTERM');
        console.log(chalk.green(`✓ Stopped process ${pid}`));
      } catch (error) {
        console.log(chalk.red(`✗ Failed to stop process ${pid}`));
        console.log(chalk.dim(`  ${error instanceof Error ? error.message : String(error)}`));
      }
    }

    console.log();
    console.log(chalk.green('Agent runner stopped.'));
  } catch (error) {
    console.error(chalk.red('Failed to stop agent:'));
    console.error(chalk.dim(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}
