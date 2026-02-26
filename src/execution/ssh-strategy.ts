/**
 * SSH Execution Strategy
 *
 * Detects SSH hosts from ~/.ssh/config and provides remote execution via ssh.
 * Each host becomes a separate ExecutionStrategyInfo entry (via additionalEntries).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import type {
  ExecutionStrategy,
  ExecutionSpec,
  ExecutionCallbacks,
  ExecutionResult,
  ExecutionStrategyDetection,
  ExecutionStrategyInfo,
  ExecutionJobStatus,
} from './types.js';

// Hosts that are git forges / services, not compute targets
const NON_COMPUTE_HOSTS = new Set([
  'github.com', 'gitlab.com', 'bitbucket.org', 'ssh.dev.azure.com',
  'vs-ssh.visualstudio.com', 'git-codecommit', 'source.developers.google.com',
  'aur.archlinux.org', 'git.sr.ht', 'codeberg.org', 'gitea.com',
]);

interface SSHHostEntry {
  name: string;
  hostname: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
  source: 'ssh-config';
}

function isNonComputeHost(entry: SSHHostEntry): boolean {
  const name = entry.name.toLowerCase();
  const hostname = entry.hostname.toLowerCase();
  // Exact match
  if (NON_COMPUTE_HOSTS.has(name) || NON_COMPUTE_HOSTS.has(hostname)) return true;
  // Prefix match for services like git-codecommit.*.amazonaws.com
  for (const svc of NON_COMPUTE_HOSTS) {
    if (hostname.startsWith(svc) || name.startsWith(svc)) return true;
  }
  return false;
}

/**
 * Quick TCP port check to determine if a host is reachable.
 */
function checkTCPReachable(hostname: string, port: number = 22, timeoutMs: number = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: hostname, port, timeout: timeoutMs }, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Parse ~/.ssh/config and return compute host entries.
 */
export async function parseSSHConfig(): Promise<SSHHostEntry[]> {
  const entries: SSHHostEntry[] = [];

  try {
    const sshConfigPath = join(homedir(), '.ssh', 'config');
    const content = await readFile(sshConfigPath, 'utf-8');
    let current: Partial<SSHHostEntry> | null = null;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^(\S+)\s+(.+)$/);
      if (!match) continue;

      const [, key, value] = match;
      const keyLower = key?.toLowerCase();

      if (keyLower === 'host') {
        if (current?.name) {
          entries.push({
            name: current.name,
            hostname: current.hostname ?? current.name,
            user: current.user,
            port: current.port,
            identityFile: current.identityFile,
            proxyJump: current.proxyJump,
            source: 'ssh-config',
          });
        }

        const hostPattern = value?.trim() ?? '';
        if (hostPattern.includes('*') || hostPattern === 'localhost' || hostPattern === '127.0.0.1') {
          current = null;
          continue;
        }
        current = { name: hostPattern, hostname: hostPattern };
      } else if (current && value) {
        switch (keyLower) {
          case 'hostname': current.hostname = value.trim(); break;
          case 'user': current.user = value.trim(); break;
          case 'port': current.port = parseInt(value.trim(), 10); break;
          case 'identityfile': current.identityFile = value.trim(); break;
          case 'proxyjump': current.proxyJump = value.trim(); break;
        }
      }
    }
    // Last entry
    if (current?.name) {
      entries.push({
        name: current.name,
        hostname: current.hostname ?? current.name,
        user: current.user,
        port: current.port,
        identityFile: current.identityFile,
        proxyJump: current.proxyJump,
        source: 'ssh-config',
      });
    }
  } catch {
    // No SSH config
  }

  // Filter out non-compute hosts
  return entries.filter((e) => !isNonComputeHost(e));
}

export class SSHStrategy implements ExecutionStrategy {
  readonly id = 'ssh' as const;
  readonly name = 'SSH Remote';
  readonly isAsync = false;

  private processes = new Map<string, ChildProcess>();

  async detect(): Promise<ExecutionStrategyDetection> {
    const hosts = await parseSSHConfig();
    if (hosts.length === 0) {
      return { available: false };
    }

    // Check reachability in parallel
    const results = await Promise.all(
      hosts.map(async (entry) => {
        // Skip reachability for hosts behind ProxyJump (TCP check won't work)
        const reachable = entry.proxyJump
          ? null
          : await checkTCPReachable(entry.hostname, entry.port ?? 22, 3000);
        return { entry, reachable };
      }),
    );

    // Build additional entries — one per SSH host
    const additionalEntries: ExecutionStrategyInfo[] = results.map(({ entry, reachable }) => ({
      id: `ssh:${entry.name}`,
      name: entry.name,
      available: reachable !== false, // true or null (unknown via proxy) counts as available
      version: undefined,
      metadata: {
        alias: entry.name,
        hostname: entry.hostname,
        user: entry.user,
        port: entry.port,
        identityFile: entry.identityFile,
        proxyJump: entry.proxyJump,
        source: entry.source,
        reachable,
      },
    }));

    const availableCount = additionalEntries.filter((e) => e.available).length;

    return {
      // The "ssh" strategy itself is available if we found any hosts
      available: availableCount > 0,
      metadata: {
        hostCount: hosts.length,
        availableCount,
      },
      additionalEntries,
    };
  }

  async execute(
    spec: ExecutionSpec,
    callbacks: ExecutionCallbacks,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    if (signal.aborted) {
      return { status: 'cancelled' };
    }

    const opts = spec.options ?? {};
    const alias = opts.sshAlias as string | undefined;

    if (!alias) {
      return {
        status: 'failed',
        error: 'SSH execution requires options.sshAlias to be specified',
      };
    }

    // Validate alias (prevent command injection)
    if (!/^[a-zA-Z0-9._-]+$/.test(alias)) {
      return {
        status: 'failed',
        error: `Invalid SSH alias: ${alias}`,
      };
    }

    const command = typeof spec.command === 'string' ? spec.command : spec.command.join(' ');

    // Build ssh command: cd to cwd and run the command.
    // The entire remote command is quoted to prevent shell interpretation on the local side.
    // The remote shell will interpret the command string.
    const remoteCommand = spec.cwd
      ? `cd ${shellQuote(spec.cwd)} && ${command}`
      : command;

    // Note: We deliberately do NOT quote `command` here — the user/dispatch system
    // sends shell commands that are meant to be interpreted by the remote shell.
    // The alias is validated above to prevent local command injection.

    const args: string[] = [alias, remoteCommand];

    return new Promise<ExecutionResult>((resolve) => {
      const child = spawn('ssh', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.processes.set(spec.jobId, child);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: ExecutionResult) => {
        if (settled) return;
        settled = true;
        this.processes.delete(spec.jobId);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        resolve(result);
      };

      // Handle abort signal
      const onAbort = () => {
        if (!settled) {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!settled) child.kill('SIGKILL');
          }, 5000).unref();
          finish({ status: 'cancelled', output: stdout, error: stderr });
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Handle timeout
      let timeoutHandle: NodeJS.Timeout | undefined;
      if (spec.timeout && spec.timeout > 0) {
        timeoutHandle = setTimeout(() => {
          if (!settled) {
            child.kill('SIGTERM');
            setTimeout(() => {
              if (!settled) child.kill('SIGKILL');
            }, 5000).unref();
            finish({ status: 'timeout', output: stdout, error: stderr });
          }
        }, spec.timeout);
        timeoutHandle.unref();
      }

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        callbacks.onStdout(text);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        callbacks.onStderr(text);
      });

      child.on('error', (err) => {
        finish({
          status: 'failed',
          error: err.message,
          output: stdout,
        });
      });

      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        const exitCode = code ?? 1;
        finish({
          status: exitCode === 0 ? 'completed' : 'failed',
          exitCode,
          output: stdout,
          error: stderr || undefined,
        });
      });

      callbacks.onStatus('running', 0, `SSH session to ${alias}`);
    });
  }

  async cancel(jobId: string): Promise<void> {
    const child = this.processes.get(jobId);
    if (!child) return;

    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, 5000).unref();

    this.processes.delete(jobId);
  }

  async getStatus(jobId: string): Promise<ExecutionJobStatus | null> {
    const child = this.processes.get(jobId);
    if (!child) return null;

    return {
      jobId,
      externalJobId: String(child.pid ?? ''),
      state: child.exitCode !== null ? 'exited' : 'running',
      exitCode: child.exitCode ?? undefined,
    };
  }
}

/** Safely quote a string for use in a shell command */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
