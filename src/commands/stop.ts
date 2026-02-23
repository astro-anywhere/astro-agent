/**
 * Stop command - stops the running agent
 */

import chalk from 'chalk';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export async function stopCommand(): Promise<void> {
  console.log(chalk.bold('\n🛑 Stopping Astro Agent Runner...\n'));

  try {
    // Find running agent processes
    const platform = process.platform;
    let findCommand: string;
    let killCommand: (pid: string) => string;

    if (platform === 'win32') {
      findCommand = 'wmic process where "commandline like \'%astro-agent%start%\'" get processid';
      killCommand = (pid) => `taskkill /PID ${pid} /F`;
    } else {
      findCommand = "pgrep -f 'astro-agent.*start'";
      killCommand = (pid) => `kill -TERM ${pid}`;
    }

    let pids: string[] = [];

    try {
      const { stdout } = await execAsync(findCommand, { timeout: 5000 });
      pids = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line));
    } catch {
      // No processes found
    }

    if (pids.length === 0) {
      console.log(chalk.yellow('No running agent processes found.'));
      return;
    }

    // Kill each process
    for (const pid of pids) {
      try {
        await execAsync(killCommand(pid), { timeout: 5000 });
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
