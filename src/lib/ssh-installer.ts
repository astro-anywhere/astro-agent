/**
 * Remote SSH installation utilities for local dev.
 *
 * Packs the agent-runner locally, SCPs it to the target host,
 * installs via npm, and pushes pre-provisioned tokens so the
 * remote host skips its own device auth entirely.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiscoveredHost } from '../types.js';

const execFile = promisify(execFileCb);

// ============================================================================
// Network helpers
// ============================================================================

/**
 * Detect the LAN IP of this machine so remote hosts can reach the dev server.
 * Returns the first non-internal IPv4 address found.
 */
export function detectLocalIP(): string {
  const nets = networkInterfaces();

  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }

  return '127.0.0.1';
}

// ============================================================================
// Remote checks
// ============================================================================

/**
 * SSH to a host and check whether Node.js ≥ 18 is available.
 * Returns { available, version } or throws on SSH failure.
 */
export async function checkRemoteNode(
  host: DiscoveredHost,
): Promise<{ available: boolean; version: string | null }> {
  try {
    const { stdout } = await sshExec(host, 'node --version');
    const ver = stdout.trim(); // e.g. "v20.11.0"
    const major = parseInt(ver.replace(/^v/, ''), 10);
    return { available: major >= 18, version: ver };
  } catch {
    return { available: false, version: null };
  }
}

// ============================================================================
// Pack & Install
// ============================================================================

export interface InstallOptions {
  host: DiscoveredHost;
  apiUrl: string;
  relayUrl: string;
  accessToken: string;
  refreshToken: string;
  wsToken: string;
  machineId: string;
}

/**
 * Pack the local agent-runner, SCP it to the remote host, install, and configure.
 *
 * Steps:
 *   1. `npm pack` in the agent-runner directory → tarball
 *   2. `scp` tarball to remote ~/
 *   3. `ssh npm install -g <tarball>` on remote
 *   4. `ssh astro-agent setup --non-interactive --skip-auth` on remote
 *   5. Push tokens via `ssh astro-agent config --set` commands
 */
export async function packAndInstall(
  opts: InstallOptions,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const { host, apiUrl, relayUrl, accessToken, refreshToken, wsToken, machineId } = opts;
  const log = onProgress ?? (() => {});

  // 1. npm pack
  const agentRunnerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  log('Packing agent-runner...');
  const { stdout: packOut } = await execFile('npm', ['pack', '--pack-destination', '/tmp'], {
    cwd: agentRunnerDir,
  });
  const tarball = `/tmp/${packOut.trim().split('\n').pop()}`;

  // 2. SCP tarball to remote
  log(`Copying to ${host.name}...`);
  const scpArgs = buildScpArgs(host, tarball, '~/astro-agent.tgz');
  await execFile('scp', scpArgs);

  // 3. Install to user-local prefix to avoid EACCES on system dirs
  // Use $HOME instead of ~ because ~ is not expanded inside double quotes in zsh/bash
  // Remove old binary first to avoid EEXIST errors on reinstall
  log(`Installing on ${host.name}...`);
  const npmPrefix = '$HOME/.local';
  await sshExec(host, `mkdir -p ${npmPrefix} && rm -f ${npmPrefix}/bin/astro-agent && npm install -g --force --prefix ${npmPrefix} $HOME/astro-agent.tgz`);

  // 4. Ensure $HOME/.local/bin is on PATH for this session and future logins
  const binDir = `${npmPrefix}/bin`;
  const pathExport = `export PATH="${binDir}:$PATH"`;
  // Use ~ in grep/echo for .bashrc since those are unquoted word-initial positions where ~ expands
  const persistExport = 'export PATH="$HOME/.local/bin:$PATH"';
  const pathSetup = [
    `grep -qxF '${persistExport}' $HOME/.bashrc 2>/dev/null || echo '${persistExport}' >> $HOME/.bashrc`,
    `grep -qxF '${persistExport}' $HOME/.profile 2>/dev/null || echo '${persistExport}' >> $HOME/.profile`,
  ].join(' && ');
  await sshExec(host, pathSetup);

  // 5. Run setup --non-interactive --skip-auth (with binDir on PATH)
  log(`Running setup on ${host.name}...`);
  await sshExec(
    host,
    `${pathExport} && astro-agent setup --non-interactive --skip-auth --api ${apiUrl} --relay ${relayUrl}`,
  );

  // 6. Push tokens via stdin to avoid exposing them in ps output
  log(`Configuring tokens on ${host.name}...`);
  const configJson = JSON.stringify({
    apiUrl,
    relayUrl,
    accessToken,
    refreshToken,
    wsToken,
    machineId,
  });
  // Pipe config as JSON via stdin to avoid shell argument exposure on shared machines
  const configCmd = `${pathExport} && cat > /tmp/.astro-config-$$.json && ` +
    `astro-agent config --import /tmp/.astro-config-$$.json && ` +
    `rm -f /tmp/.astro-config-$$.json`;
  const sshArgs = buildSshArgs(host, configCmd);
  const { execFile: execFileCbInner } = await import('node:child_process');
  const child = execFileCbInner('ssh', sshArgs);
  child.stdin?.write(configJson);
  child.stdin?.end();
  await new Promise<void>((resolve, reject) => {
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ssh config push exited with code ${code}`)));
    child.on('error', reject);
  });

  // Clean up remote tarball
  await sshExec(host, 'rm -f $HOME/astro-agent.tgz').catch(() => {});

  log(`Done — ${host.name} is configured`);
}

// ============================================================================
// SSH / SCP helpers
// ============================================================================

export function buildSshArgs(host: DiscoveredHost, command: string): string[] {
  const args: string[] = [];

  if (host.port && host.port !== 22) {
    args.push('-p', String(host.port));
  }
  if (host.identityFile) {
    args.push('-i', host.identityFile);
  }
  if (host.proxyJump) {
    args.push('-J', host.proxyJump);
  }

  // Batch mode to avoid password prompts hanging
  args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10');

  const target = host.user ? `${host.user}@${host.hostname}` : host.hostname;
  args.push(target, command);

  return args;
}

function buildScpArgs(host: DiscoveredHost, localPath: string, remotePath: string): string[] {
  const args: string[] = [];

  if (host.port && host.port !== 22) {
    args.push('-P', String(host.port));
  }
  if (host.identityFile) {
    args.push('-i', host.identityFile);
  }
  if (host.proxyJump) {
    args.push('-o', `ProxyJump=${host.proxyJump}`);
  }

  args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10');

  const target = host.user ? `${host.user}@${host.hostname}` : host.hostname;
  args.push(localPath, `${target}:${remotePath}`);

  return args;
}

export async function sshExec(
  host: DiscoveredHost,
  command: string,
): Promise<{ stdout: string; stderr: string }> {
  const args = buildSshArgs(host, command);
  return execFile('ssh', args, { timeout: 60_000 });
}

// ============================================================================
// Remote agent start
// ============================================================================

export interface StartRemoteOptions {
  maxTasks?: number;
  logLevel?: string;
  preserveWorktrees?: boolean;
}

export interface RemoteStartResult {
  host: DiscoveredHost;
  success: boolean;
  message: string;
  alreadyRunning?: boolean;
}

/**
 * Start agent runners on remote hosts.
 *
 * For each host:
 *   1. Check if an agent is already running (pgrep)
 *   2. Start via nohup + disown
 *   3. Verify after 2s with pgrep
 *
 * One failure does not block others.
 */
export async function startRemoteAgents(
  hosts: DiscoveredHost[],
  options: StartRemoteOptions = {},
  onProgress?: (host: string, msg: string) => void,
): Promise<RemoteStartResult[]> {
  const results: RemoteStartResult[] = [];
  const log = (host: string, msg: string) => onProgress?.(host, msg);

  for (const host of hosts) {
    log(host.name, 'Checking for running agent...');

    // 1. Check if already running (pgrep with ps aux fallback) and stop stale process
    try {
      const { stdout } = await sshExec(
        host,
        'pgrep -f "astro-agent start" 2>/dev/null || ps aux 2>/dev/null | grep "astro-agent start" | grep -v grep',
      );
      if (stdout.trim()) {
        log(host.name, 'Stopping existing agent...');
        await sshExec(host, 'pkill -f "astro-agent start" 2>/dev/null || true').catch(() => {});
        // Wait for process to exit
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch {
      // pgrep returns exit code 1 when no match — that's fine
    }

    // 2. Build start command with forwarded options
    // Use full path to avoid PATH resolution issues across different shells (zsh, bash)
    const agentBin = '$HOME/.local/bin/astro-agent';
    const flags: string[] = ['--foreground'];
    if (options.maxTasks) flags.push(`--max-tasks ${options.maxTasks}`);
    if (options.logLevel) flags.push(`--log-level ${options.logLevel}`);
    if (options.preserveWorktrees) flags.push('--preserve-worktrees');
    const startCmd = `${agentBin} start ${flags.join(' ')}`;

    log(host.name, 'Starting agent...');
    try {
      await sshExec(
        host,
        `export PATH="$HOME/.local/bin:$PATH" && mkdir -p $HOME/.astro/logs && nohup ${startCmd} > $HOME/.astro/logs/agent-runner.log 2>&1 & disown`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ host, success: false, message: `Failed to start: ${msg}` });
      continue;
    }

    // 3. Verify after 2s — use ps aux fallback if pgrep is unavailable
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const { stdout } = await sshExec(
        host,
        'pgrep -f "astro-agent start" 2>/dev/null || ps aux 2>/dev/null | grep "astro-agent start" | grep -v grep',
      );
      if (stdout.trim()) {
        log(host.name, 'Agent started successfully');
        results.push({ host, success: true, message: 'Started' });
      } else {
        // Fallback: check log tail
        try {
          const { stdout: logTail } = await sshExec(host, 'tail -5 $HOME/.astro/logs/agent-runner.log 2>/dev/null');
          results.push({ host, success: false, message: `Process not found after start. Log tail:\n${logTail}` });
        } catch {
          results.push({ host, success: false, message: 'Process not found after start (no logs available)' });
        }
      }
    } catch {
      results.push({ host, success: false, message: 'Could not verify agent start (pgrep failed)' });
    }
  }

  return results;
}
