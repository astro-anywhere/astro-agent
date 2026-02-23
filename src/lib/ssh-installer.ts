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
  log(`Installing on ${host.name}...`);
  const npmPrefix = '~/.local';
  await sshExec(host, `mkdir -p ${npmPrefix} && npm install -g --prefix ${npmPrefix} ~/astro-agent.tgz`);

  // 4. Ensure ~/.local/bin is on PATH for this session and future logins
  const binDir = `${npmPrefix}/bin`;
  const pathExport = `export PATH="${binDir}:$PATH"`;
  const pathSetup = [
    `grep -qxF '${pathExport}' ~/.bashrc 2>/dev/null || echo '${pathExport}' >> ~/.bashrc`,
    `grep -qxF '${pathExport}' ~/.profile 2>/dev/null || echo '${pathExport}' >> ~/.profile`,
  ].join(' && ');
  await sshExec(host, pathSetup);

  // 5. Run setup --non-interactive --skip-auth (with binDir on PATH)
  log(`Running setup on ${host.name}...`);
  await sshExec(
    host,
    `${pathExport} && astro-agent setup --non-interactive --skip-auth --api ${apiUrl} --relay ${relayUrl}`,
  );

  // 6. Push tokens
  log(`Configuring tokens on ${host.name}...`);
  const setCommands = [
    `astro-agent config --set apiUrl=${apiUrl}`,
    `astro-agent config --set relayUrl=${relayUrl}`,
    `astro-agent config --set accessToken=${accessToken}`,
    `astro-agent config --set refreshToken=${refreshToken}`,
    `astro-agent config --set wsToken=${wsToken}`,
    `astro-agent config --set machineId=${machineId}`,
  ];
  await sshExec(host, `${pathExport} && ${setCommands.join(' && ')}`);

  // Clean up remote tarball
  await sshExec(host, 'rm -f ~/astro-agent.tgz').catch(() => {});

  log(`Done — ${host.name} is configured`);
}

// ============================================================================
// SSH / SCP helpers
// ============================================================================

function buildSshArgs(host: DiscoveredHost, command: string): string[] {
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

async function sshExec(
  host: DiscoveredHost,
  command: string,
): Promise<{ stdout: string; stderr: string }> {
  const args = buildSshArgs(host, command);
  return execFile('ssh', args, { timeout: 60_000 });
}
