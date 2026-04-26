/**
 * Remote SSH installation utilities for local dev.
 *
 * Packs the agent-runner locally, SCPs it to the target host,
 * installs via npm, and pushes pre-provisioned tokens so the
 * remote host skips its own device auth entirely.
 */

import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { networkInterfaces, homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
// SSH ControlMaster — persistent multiplexed connections for 2FA hosts
// ============================================================================

/**
 * Directory for SSH control sockets managed by astro-agent.
 */
const CONTROL_SOCKET_DIR = join(homedir(), '.ssh', 'astro-sockets');

/**
 * Return the ControlPath for a given host.
 *
 * Uses a truncated SHA-256 hash of user@hostname:port to keep the path
 * well under the Unix domain socket limit (104 bytes on macOS, 108 on Linux).
 * Result: ~/.ssh/astro-sockets/<16-char hex hash>  (total ~50 bytes)
 */
export function controlSocketPath(host: DiscoveredHost): string {
  const user = host.user ?? 'default';
  const port = host.port ?? 22;
  const key = `${user}@${host.hostname}:${port}`;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return join(CONTROL_SOCKET_DIR, hash);
}

/**
 * Check whether a ControlMaster session already exists for this host.
 */
export async function hasControlMaster(host: DiscoveredHost): Promise<boolean> {
  const socketPath = controlSocketPath(host);
  try {
    const target = host.user ? `${host.user}@${host.hostname}` : host.hostname;
    const args = ['-o', `ControlPath=${socketPath}`, '-O', 'check', target];
    if (host.port && host.port !== 22) args.unshift('-p', String(host.port));
    await execFile('ssh', args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Establish an interactive SSH ControlMaster session.
 *
 * Spawns an SSH process with stdio inherited so the user can
 * complete interactive authentication (password, 2FA/Duo push, etc.).
 * The session persists in the background for 10 minutes via ControlPersist.
 *
 * Returns true if the master session was established successfully.
 */
export async function establishControlMaster(host: DiscoveredHost): Promise<boolean> {
  // Ensure the socket directory exists with restricted permissions
  await mkdir(CONTROL_SOCKET_DIR, { recursive: true, mode: 0o700 });

  const socketPath = controlSocketPath(host);
  const target = host.user ? `${host.user}@${host.hostname}` : host.hostname;

  const args: string[] = [];
  if (host.port && host.port !== 22) args.push('-p', String(host.port));
  if (host.identityFile) args.push('-i', host.identityFile);
  if (host.proxyJump) args.push('-J', host.proxyJump);

  args.push(
    '-o', `ControlMaster=yes`,
    '-o', `ControlPath=${socketPath}`,
    '-o', `ControlPersist=600`,  // 10 minutes
    '-o', 'ConnectTimeout=30',
    '-N',  // no remote command — just hold the session
    target,
  );

  const AUTH_TIMEOUT_MS = 120_000; // 2 minutes for user to complete 2FA

  return new Promise<boolean>((resolve) => {
    const child = spawn('ssh', args, {
      stdio: 'inherit',  // user sees 2FA prompts, enters password, etc.
    });

    let settled = false;
    const finish = (result: boolean) => {
      if (!settled) { settled = true; resolve(result); }
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(false);
    }, AUTH_TIMEOUT_MS);

    child.on('close', async (code) => {
      clearTimeout(timer);
      // -N + ControlPersist means SSH exits 0 after backgrounding the master
      if (code === 0) {
        finish(true);
      } else {
        // Check if master established despite non-zero exit (can happen with -N)
        const running = await hasControlMaster(host);
        finish(running);
      }
    });

    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Tear down a ControlMaster session for a host.
 */
export async function teardownControlMaster(host: DiscoveredHost): Promise<void> {
  const socketPath = controlSocketPath(host);
  const target = host.user ? `${host.user}@${host.hostname}` : host.hostname;
  try {
    const args = ['-o', `ControlPath=${socketPath}`, '-O', 'exit', target];
    if (host.port && host.port !== 22) args.unshift('-p', String(host.port));
    await execFile('ssh', args, { timeout: 5000 });
  } catch {
    // Socket may already be gone
  }
}

// ============================================================================
// Remote checks
// ============================================================================

/**
 * Common HPC module system initialization commands.
 * These source the module system so `module load` works in non-interactive SSH.
 */
const HPC_MODULE_INIT_COMMANDS = [
  // Lmod (most common on modern HPC clusters)
  'source /etc/profile.d/lmod.sh 2>/dev/null',
  'source /etc/profile.d/z00_lmod.sh 2>/dev/null',
  'source /usr/share/lmod/lmod/init/bash 2>/dev/null',
  // Environment Modules (TCL-based)
  'source /etc/profile.d/modules.sh 2>/dev/null',
  'source /usr/share/Modules/init/bash 2>/dev/null',
  // General profile (may include module init)
  'source /etc/profile 2>/dev/null',
];

/**
 * Common module names for Node.js across different HPC systems.
 */
const HPC_NODE_MODULE_NAMES = [
  'nodejs',
  'node',
  'nodejs/22',
  'nodejs/20',
  'nodejs/18',
  'node/22',
  'node/20',
  'node/18',
  'Node.js',
  'nodejs/latest',
];

/**
 * Common paths where Node.js might be installed on HPC/Linux systems.
 */
const COMMON_NODE_PATHS = [
  '$HOME/.local/bin/node',
  '$HOME/.nvm/versions/node/*/bin/node',
  '/usr/local/bin/node',
  '/opt/node/bin/node',
  '/opt/nodejs/bin/node',
];

/**
 * SSH to a host and check whether Node.js ≥ 18 is available.
 * Handles HPC module systems (Lmod, Environment Modules), NVM, and common paths.
 * Returns { available, version, method } or throws on SSH failure.
 */
export async function checkRemoteNode(
  host: DiscoveredHost,
): Promise<{ available: boolean; version: string | null; method?: string }> {
  // Track the best version found across all strategies so the caller can
  // distinguish "node_too_old" (found but < 18) from "node_not_found".
  let bestVersion: string | null = null;

  function parseVersion(stdout: string): { ver: string; major: number } | null {
    // Extract the version line (e.g. "v20.11.0") — first line matching vN.N.N
    const match = stdout.match(/v\d+\.\d+\.\d+/);
    if (!match) return null;
    const ver = match[0];
    const major = parseInt(ver.replace(/^v/, ''), 10);
    if (isNaN(major)) return null;
    if (!bestVersion) bestVersion = ver;
    return { ver, major };
  }

  // Strategy 1: Direct check (works on standard Linux/macOS)
  for (const bin of ['node', 'nodejs']) {
    try {
      const { stdout } = await sshExec(host, `${bin} --version`);
      const parsed = parseVersion(stdout);
      if (parsed && parsed.major >= 18) return { available: true, version: parsed.ver, method: 'direct' };
    } catch {
      // binary not found, try next
    }
  }

  // Strategy 2: HPC module system — batch all module-load attempts into a single
  // SSH call to minimize round-trips on high-latency HPC login nodes.
  const moduleInit = HPC_MODULE_INIT_COMMANDS.join('; ');
  const moduleAttempts = HPC_NODE_MODULE_NAMES.map(
    (m) => `module load ${m} 2>/dev/null && node --version && echo "MODULE:${m}" && exit 0`,
  ).join('; ');
  try {
    const cmd = `${moduleInit}; ${moduleAttempts}`;
    const { stdout } = await sshExec(host, cmd);
    const parsed = parseVersion(stdout);
    if (parsed && parsed.major >= 18) {
      // Extract which module succeeded from the output
      const moduleMatch = stdout.match(/MODULE:(.+)/);
      const moduleName = moduleMatch ? moduleMatch[1].trim() : 'unknown';
      return { available: true, version: parsed.ver, method: `module:${moduleName}` };
    }
  } catch {
    // no module available
  }

  // Strategy 3: Check common installation paths
  for (const nodePath of COMMON_NODE_PATHS) {
    try {
      // Use bash -c to expand globs like ~/.nvm/versions/node/*/bin/node
      const cmd = `bash -c 'for p in ${nodePath}; do [ -x "$p" ] && "$p" --version && exit 0; done; exit 1'`;
      const { stdout } = await sshExec(host, cmd);
      const parsed = parseVersion(stdout);
      if (parsed && parsed.major >= 18) {
        return { available: true, version: parsed.ver, method: `path:${nodePath}` };
      }
    } catch {
      // path not found, try next
    }
  }

  // Strategy 4: Try sourcing user's shell profile (may have NVM/module setup)
  // Note: only sources bash profiles; most HPC systems use bash as default shell.
  try {
    const cmd = 'source ~/.bashrc 2>/dev/null; source ~/.bash_profile 2>/dev/null; node --version';
    const { stdout } = await sshExec(host, cmd);
    const parsed = parseVersion(stdout);
    if (parsed && parsed.major >= 18) {
      return { available: true, version: parsed.ver, method: 'profile' };
    }
  } catch {
    // profile sourcing failed
  }

  return { available: false, version: bestVersion };
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
// Direct install — SCP bundles + wrapper, no remote npm
// ============================================================================

/**
 * Discover the absolute path to `node` on the remote, sourcing the user's
 * login shell so PATH includes nvm/asdf/Homebrew/~/.local etc. Returns null
 * if Node isn't available at all.
 *
 * The remote BatchMode SSH session uses a non-interactive non-login shell by
 * default, so `which node` from within `sshExec` would miss anything not in
 * /usr/bin or /usr/local/bin. `bash -lc` runs a login shell that sources the
 * profile files, exposing the user's full PATH.
 */
async function findRemoteNodePath(host: DiscoveredHost): Promise<string | null> {
  // Try bash first (most macOS/Linux). Fall back to sh for minimal systems
  // (e.g. Alpine without bash). `command -v` is portable.
  const cmd = `bash -lc 'command -v node' 2>/dev/null || sh -lc 'command -v node' 2>/dev/null || true`;
  try {
    const { stdout } = await sshExec(host, cmd);
    const path = stdout.trim().split('\n').pop()?.trim() ?? '';
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the local paths to the bundled astro-agent.mjs and astro-cli.mjs
 * files. Two install contexts:
 *
 *   1. Bundled inside an Electron app: both files are siblings in
 *      ~/.astro/bin/ (or wherever the user installed them). The currently-
 *      running file IS astro-agent (with or without .mjs extension).
 *   2. npx @astroanywhere/agent: the agent is installed as an npm package;
 *      the CLI is a separate npm package. Resolve via require.resolve.
 *
 * Throws with an actionable error if neither path resolves.
 */
function resolveLocalBundlePaths(): { agentMjs: string; cliMjs: string } {
  const agentMjs = fileURLToPath(import.meta.url);
  const dir = dirname(agentMjs);

  // Sibling-bundle case: try common names with and without extension.
  for (const name of ['astro-cli.mjs', 'astro-cli', 'astro-cli.cmd']) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return { agentMjs, cliMjs: candidate };
    }
  }

  // npm-package case: resolve @astroanywhere/cli via the agent-runner's
  // module resolution.
  try {
    const req = createRequire(import.meta.url);
    const cliMjs = req.resolve('@astroanywhere/cli/dist/cli.js');
    return { agentMjs, cliMjs };
  } catch {
    throw new Error(
      'Could not locate astro-cli bundle. Expected a sibling file in the same directory as astro-agent, or @astroanywhere/cli installed as a dependency.',
    );
  }
}

/** SCP a local file to a remote path, using ControlMaster if available. */
async function scpFile(
  host: DiscoveredHost,
  localPath: string,
  remotePath: string,
): Promise<void> {
  const args = buildScpArgs(host, localPath, remotePath);
  await execFile('scp', args, { timeout: 120_000 });
}

/**
 * Pipe a string to a file on the remote via stdin (avoids exposing tokens
 * in process arguments). The remote shell uses `cat > <path>` to write.
 */
async function pipeToRemoteFile(
  host: DiscoveredHost,
  remotePath: string,
  contents: string,
  opts: { mode?: string } = {},
): Promise<void> {
  const chmod = opts.mode ? `chmod ${opts.mode} ${remotePath} && ` : '';
  const cmd = `cat > ${remotePath} && ${chmod}true`;
  const args = buildSshArgs(host, cmd);
  return new Promise<void>((resolve, reject) => {
    const child = execFileCb('ssh', args, (err) => {
      if (err) reject(err);
      else resolve();
    });
    child.stdin?.write(contents);
    child.stdin?.end();
  });
}

/**
 * Direct-install path: SCP bundled .mjs files + write wrapper scripts that
 * hardcode the discovered remote Node path. No `npm install`, no remote
 * `astro-agent setup --skip-auth`, no shell-PATH dependence at runtime.
 *
 * Steps:
 *   1. Discover remote node via login shell
 *   2. mkdir -p ~/.astro/bin ~/.astro/logs on remote
 *   3. pkill any existing agent (always, per the always-stop-and-restart rule)
 *   4. SCP astro-agent.mjs + astro-cli.mjs
 *   5. Write wrapper scripts that exec the discovered node path
 *   6. chmod +x on all four files
 *   7. Pipe config.json (with all tokens) directly via stdin
 *
 * Compatible with InstallOptions for drop-in replacement of packAndInstall.
 */
export async function directInstall(
  opts: InstallOptions,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const { host, apiUrl, relayUrl, accessToken, refreshToken, wsToken, machineId } = opts;
  const log = onProgress ?? (() => {});

  // 1. Find Node on the remote.
  log(`Locating node on ${host.name}...`);
  const nodePath = await findRemoteNodePath(host);
  if (!nodePath) {
    throw new Error(
      `Node.js not found on ${host.name}. Install Node 18+ on the remote (e.g. via nvm, Homebrew, or your package manager) and retry.`,
    );
  }

  // 2. Resolve local bundles.
  const { agentMjs, cliMjs } = resolveLocalBundlePaths();

  // 3. Prepare remote layout + always-stop-and-restart.
  log(`Preparing ~/.astro on ${host.name}...`);
  await sshExec(host, 'mkdir -p $HOME/.astro/bin $HOME/.astro/logs');
  await sshExec(host, 'pkill -f "[a]stro-agent start" 2>/dev/null || true').catch(() => {});
  await new Promise((r) => setTimeout(r, 500));

  // 4. SCP the bundles.
  log(`Uploading bundles to ${host.name}...`);
  await scpFile(host, agentMjs, '$HOME/.astro/bin/astro-agent.mjs');
  await scpFile(host, cliMjs, '$HOME/.astro/bin/astro-cli.mjs');

  // 5. Wrapper scripts that pin the discovered node path.
  log(`Installing wrappers on ${host.name}...`);
  const agentWrapper = `#!/bin/sh\nexec ${nodePath} "$HOME/.astro/bin/astro-agent.mjs" "$@"\n`;
  const cliWrapper = `#!/bin/sh\nexec ${nodePath} "$HOME/.astro/bin/astro-cli.mjs" "$@"\n`;
  await pipeToRemoteFile(host, '$HOME/.astro/bin/astro-agent', agentWrapper, { mode: '755' });
  await pipeToRemoteFile(host, '$HOME/.astro/bin/astro-cli', cliWrapper, { mode: '755' });

  // 6. Pipe config.json with all tokens.
  log(`Configuring ${host.name}...`);
  const config = JSON.stringify({
    apiUrl,
    relayUrl,
    accessToken,
    refreshToken,
    wsToken,
    machineId,
    setupCompleted: true,
  });
  await pipeToRemoteFile(host, '$HOME/.astro/config.json', config, { mode: '600' });

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

  // ControlPath enables multiplexing: if a master session exists, SSH routes
  // through it without re-authenticating, so BatchMode=yes is fine — the auth
  // already happened on the master. If no master exists, BatchMode=yes ensures
  // SSH fails fast instead of hanging on a password/2FA prompt.
  const socketPath = controlSocketPath(host);
  args.push('-o', `ControlPath=${socketPath}`);
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

  // Route through ControlMaster socket if available (supports 2FA hosts)
  const socketPath = controlSocketPath(host);
  args.push('-o', `ControlPath=${socketPath}`);
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

export interface RemoteAgentStatus {
  hostname?: string;
  platform?: string;
  arch?: string;
  cpuCores?: number;
  memoryGB?: number;
  gpu?: Array<{ name: string; vendor: string; memoryGB: number }>;
  providers?: Array<{ name: string; type: string; version?: string | null; model?: string }>;
}

export interface RemoteStartResult {
  host: DiscoveredHost;
  success: boolean;
  message: string;
  alreadyRunning?: boolean;
  agentStatus?: RemoteAgentStatus;
}

export async function startRemoteAgents(
  hosts: DiscoveredHost[],
  options: StartRemoteOptions = {},
  onProgress?: (host: string, msg: string) => void,
): Promise<RemoteStartResult[]> {
  const results: RemoteStartResult[] = [];
  const log = (host: string, msg: string) => onProgress?.(host, msg);

  for (const host of hosts) {
    // 1. Always kill existing agent so we start fresh with latest binary/config.
    log(host.name, 'Stopping existing agent (if any)...');
    await sshExec(host, 'pkill -f "[a]stro-agent start" 2>/dev/null || true').catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));

    // 2. Build start command with forwarded options
    // Use the wrapper script written by directInstall — it hardcodes the
    // discovered node path so it works regardless of the SSH session's PATH.
    const agentBin = '$HOME/.astro/bin/astro-agent';
    const flags: string[] = ['--foreground'];
    if (options.maxTasks) flags.push(`--max-tasks ${options.maxTasks}`);
    if (options.logLevel) flags.push(`--log-level ${options.logLevel}`);
    if (options.preserveWorktrees) flags.push('--preserve-worktrees');
    const startCmd = `${agentBin} start ${flags.join(' ')}`;

    log(host.name, 'Starting agent...');
    try {
      await sshExec(
        host,
        `mkdir -p $HOME/.astro/logs && nohup ${startCmd} > $HOME/.astro/logs/agent-runner.log 2>&1 & disown`,
      );
    } catch {
      // nohup + & disown may cause SSH to exit with non-zero even when the
      // remote process started successfully. We verify via pgrep below.
    }

    // 3. Verify after 2s
    // Use a command that always exits 0 so sshExec never throws.
    // pgrep may not exist on minimal Linux (HPC clusters). The ps+awk fallback
    // also exits non-zero when there's no match, which sshExec treats as an error.
    // Appending `|| true` ensures exit 0; we check stdout instead.
    log(host.name, 'Verifying process started...');
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const { stdout } = await sshExec(
        host,
        '(pgrep -f "[a]stro-agent start" 2>/dev/null || ps aux | awk \'/[a]stro-agent start/{print $2}\') || true',
      );
      if (stdout.trim()) {
        log(host.name, 'Agent started — reading status...');
        // Poll for status file with retries (remote agent may take time to detect environment)
        let agentStatus: RemoteAgentStatus | undefined;
        for (let attempt = 0; attempt < 8; attempt++) {
          const delay = Math.min(100 * Math.pow(2, attempt), 3200); // 100, 200, 400, 800, 1600, 3200, 3200, 3200 (~9.5s total)
          await new Promise((r) => setTimeout(r, delay));
          try {
            const { stdout: statusJson } = await sshExec(host, 'cat $HOME/.astro/agent-status.json 2>/dev/null || true');
            if (statusJson.trim()) {
              agentStatus = JSON.parse(statusJson.trim()) as RemoteAgentStatus;
              break;
            }
          } catch {
            // Status file not ready yet, retry
          }
        }
        results.push({ host, success: true, message: 'Started', agentStatus });
      } else {
        // Fallback: check log tail for error details
        try {
          const { stdout: logTail } = await sshExec(host, 'tail -20 $HOME/.astro/logs/agent-runner.log 2>/dev/null || true');
          const tail = logTail.trim();
          if (tail) {
            log(host.name, `Process not found. Log tail:\n${tail}`);
            results.push({ host, success: false, message: `Agent process not found after start. Check remote logs:\n${tail}` });
          } else {
            log(host.name, 'Process not found (no logs available)');
            results.push({ host, success: false, message: 'Agent process not found after start (no logs available)' });
          }
        } catch {
          log(host.name, 'Process not found (no logs available)');
          results.push({ host, success: false, message: 'Agent process not found after start (no logs available)' });
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(host.name, `Verification failed: ${errMsg}`);
      results.push({ host, success: false, message: `Could not verify agent start: ${errMsg}` });
    }
  }

  return results;
}
