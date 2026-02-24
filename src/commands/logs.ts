/**
 * Logs command - view agent runner logs
 */

import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { buildSshArgs } from '../lib/ssh-installer.js';
import { config } from '../lib/config.js';
import type { DiscoveredHost } from '../types.js';

export interface LogsOptions {
  follow?: boolean;
  lines?: number;
  host?: string;
}

const DEFAULT_LINES = 50;
const LOG_FILE_PATH = join(homedir(), '.astro', 'logs', 'agent-runner.log');

export async function logsCommand(options: LogsOptions): Promise<void> {
  const lines = options.lines ?? DEFAULT_LINES;

  // Remote host logs
  if (options.host) {
    await viewRemoteLogs(options.host, lines, options.follow);
    return;
  }

  // Local logs
  if (!existsSync(LOG_FILE_PATH)) {
    console.log(chalk.yellow('No log file found at:'));
    console.log(chalk.dim(`  ${LOG_FILE_PATH}`));
    console.log();
    console.log('Is the agent running? Start with:');
    console.log(chalk.cyan('  npx @astroanywhere/agent start'));
    return;
  }

  if (options.follow) {
    const child = spawn('tail', ['-f', '-n', String(lines), LOG_FILE_PATH], {
      stdio: 'inherit',
    });

    process.on('SIGINT', () => {
      child.kill();
      process.exit(0);
    });

    // Wait for the child to exit
    await new Promise<void>((resolve) => {
      child.on('close', () => resolve());
    });
  } else {
    try {
      const output = execFileSync('tail', ['-n', String(lines), LOG_FILE_PATH], {
        encoding: 'utf-8',
      });
      process.stdout.write(output);
    } catch (error) {
      console.error(chalk.red(`Failed to read logs: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  }
}

async function viewRemoteLogs(hostName: string, lines: number, follow?: boolean): Promise<void> {
  const remoteHosts: DiscoveredHost[] = config.getRemoteHosts();
  const host = remoteHosts.find((h) => h.name === hostName);

  if (!host) {
    console.error(chalk.red(`Unknown remote host: ${hostName}`));
    const names = remoteHosts.map((h) => h.name);
    if (names.length > 0) {
      console.log(chalk.dim(`Available hosts: ${names.join(', ')}`));
    } else {
      console.log(chalk.dim('No remote hosts configured. Run setup --with-ssh-config first.'));
    }
    process.exit(1);
  }

  const remoteLogPath = '$HOME/.astro/logs/agent-runner.log';
  const tailFlag = follow ? '-f' : '';
  const cmd = `tail ${tailFlag} -n ${lines} ${remoteLogPath}`;

  const sshArgs = buildSshArgs(host, cmd);
  const child = spawn('ssh', sshArgs, { stdio: 'inherit' });

  process.on('SIGINT', () => {
    child.kill();
    process.exit(0);
  });

  await new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`SSH exited with code ${code}`));
      } else {
        resolve();
      }
    });
    child.on('error', reject);
  });
}
