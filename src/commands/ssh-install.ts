/**
 * Non-interactive remote-host install command.
 *
 * Designed to be driven by the Astro desktop app (or any other orchestrator)
 * that has already issued device-auth tokens for the remote machine and just
 * needs the SSH-side install + start performed.
 *
 * Reads tokens from stdin as a JSON object (preferred — keeps secrets off
 * `ps` listings) and writes structured NDJSON progress to stdout. Each line
 * is a self-contained JSON value:
 *
 *   {"event":"step","name":"pack","message":"..."}
 *   {"event":"step","name":"upload","message":"..."}
 *   {"event":"step","name":"install","message":"..."}
 *   {"event":"step","name":"configure","message":"..."}
 *   {"event":"step","name":"start","message":"..."}
 *   {"event":"done","machineId":"...","agentStatus":{...}}
 *   // or on failure:
 *   {"event":"error","code":"...","message":"..."}
 *
 * Exit code: 0 on success, 1 on any failure (after emitting the error event).
 *
 * Stdin payload shape:
 *   { accessToken, refreshToken, wsToken, machineId, apiUrl, relayUrl }
 *
 * The host is resolved from `~/.ssh/config` by alias; everything else is
 * derived from the discovered host record.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverRemoteHosts } from '../lib/ssh-discovery.js';
import {
  packAndInstall,
  startRemoteAgents,
  buildSshArgs,
  type InstallOptions,
} from '../lib/ssh-installer.js';
import type { DiscoveredHost } from '../types.js';

const execFile = promisify(execFileCb);

export interface SshInstallOptions {
  host: string;
  /** Token bundle passed in-process (used by tests / library callers). When
   * omitted, the bundle is read from stdin as JSON. */
  tokens?: TokenBundle;
}

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  wsToken: string;
  machineId: string;
  apiUrl: string;
  relayUrl: string;
}

type NdjsonEvent =
  | { event: 'step'; name: string; message: string }
  | { event: 'done'; machineId: string; agentStatus?: unknown }
  | { event: 'error'; code: string; message: string };

function emit(ev: NdjsonEvent): void {
  process.stdout.write(JSON.stringify(ev) + '\n');
}

/** Cap stdin reads so a buggy or hostile producer can't OOM us. The token
 * bundle is six short strings (~600 bytes); 16KB is generous. */
const STDIN_MAX_BYTES = 16 * 1024;

async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > STDIN_MAX_BYTES) {
      throw new Error(`stdin exceeded ${STDIN_MAX_BYTES} bytes — expected a small JSON token bundle`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) throw new Error('empty stdin — expected JSON token bundle');
  return JSON.parse(raw);
}

function validateTokens(value: unknown): TokenBundle {
  if (!value || typeof value !== 'object') {
    throw new Error('token bundle must be a JSON object');
  }
  const o = value as Record<string, unknown>;
  const required = ['accessToken', 'refreshToken', 'wsToken', 'machineId', 'apiUrl', 'relayUrl'] as const;
  for (const k of required) {
    if (typeof o[k] !== 'string' || (o[k] as string).length === 0) {
      throw new Error(`token bundle missing field: ${k}`);
    }
  }
  return {
    accessToken: o.accessToken as string,
    refreshToken: o.refreshToken as string,
    wsToken: o.wsToken as string,
    machineId: o.machineId as string,
    apiUrl: o.apiUrl as string,
    relayUrl: o.relayUrl as string,
  };
}

async function resolveHost(alias: string): Promise<DiscoveredHost> {
  const hosts = await discoverRemoteHosts();
  const match = hosts.find((h) => h.name === alias);
  if (!match) {
    throw Object.assign(new Error(`host '${alias}' not found in ~/.ssh/config`), {
      code: 'host-not-found',
    });
  }
  return match;
}

/**
 * Verify the host accepts non-interactive SSH (key-based / agent / existing
 * ControlMaster). We deliberately do NOT call `establishControlMaster` here:
 * it uses `stdio: 'inherit'` to surface 2FA prompts, which silently hangs
 * for ~2 minutes when this command is spawned by a non-TTY orchestrator
 * (e.g., Electron). For 2FA hosts the orchestrator must establish the
 * authenticated session first (via `ssh <alias>` or `astro-agent setup`),
 * then call this command.
 */
async function preflightAuth(host: DiscoveredHost): Promise<void> {
  const args = buildSshArgs(host, 'echo astro-preflight-ok');
  try {
    const { stdout } = await execFile('ssh', args, { timeout: 15_000 });
    if (!stdout.includes('astro-preflight-ok')) {
      throw Object.assign(new Error('preflight echo did not return expected token'), {
        code: 'auth-required',
      });
    }
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const msg = (err as Error).message ?? String(err);
    const looksLikeAuth =
      /Permission denied|publickey|keyboard-interactive|password/i.test(stderr) ||
      /Permission denied|publickey|keyboard-interactive|password/i.test(msg);
    throw Object.assign(
      new Error(
        looksLikeAuth
          ? `host '${host.name}' rejected non-interactive auth — open an authenticated session first (e.g. \`ssh ${host.name}\` to complete 2FA, or set up key-based login)`
          : `preflight failed for '${host.name}': ${stderr || msg}`,
      ),
      { code: looksLikeAuth ? 'auth-required' : 'preflight-failed' },
    );
  }
}

export async function sshInstallCommand(opts: SshInstallOptions): Promise<void> {
  const alias = opts.host.trim();
  if (!alias) {
    emit({ event: 'error', code: 'bad-args', message: '--host alias must be non-empty' });
    process.exit(1);
  }

  // Resolve host first so we fail fast on bad alias.
  let host: DiscoveredHost;
  try {
    host = await resolveHost(alias);
  } catch (err) {
    const e = err as Error & { code?: string };
    emit({ event: 'error', code: e.code ?? 'host-not-found', message: e.message });
    process.exit(1);
  }

  // Read tokens from stdin (default) or use the in-process bundle.
  let tokens: TokenBundle;
  try {
    if (opts.tokens) {
      tokens = validateTokens(opts.tokens);
    } else {
      const raw = await readStdinJson();
      tokens = validateTokens(raw);
    }
  } catch (err) {
    emit({
      event: 'error',
      code: 'bad-tokens',
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Preflight: verify non-interactive SSH works. Fails fast with a clear
  // code if the host needs interactive auth, instead of hanging deep inside
  // packAndInstall when it tries to scp/ssh and waits forever for a 2FA
  // prompt that has nowhere to render.
  emit({ event: 'step', name: 'preflight', message: `Checking SSH access to ${host.name}` });
  try {
    await preflightAuth(host);
  } catch (err) {
    const e = err as Error & { code?: string };
    emit({ event: 'error', code: e.code ?? 'preflight-failed', message: e.message });
    process.exit(1);
  }

  // Step: pack + scp + npm install + token push.
  const installOptions: InstallOptions = {
    host,
    apiUrl: tokens.apiUrl,
    relayUrl: tokens.relayUrl,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    wsToken: tokens.wsToken,
    machineId: tokens.machineId,
  };

  try {
    await packAndInstall(installOptions, (msg) => {
      // packAndInstall's progress messages are already human-readable.
      // We classify them into stable step names so consumers can render
      // a fixed progress bar without parsing free text.
      emit({ event: 'step', name: classifyInstallStep(msg), message: msg });
    });
  } catch (err) {
    emit({
      event: 'error',
      code: 'install-failed',
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Step: start the remote agent + verify it's running. Wrap in try/catch
  // because startRemoteAgents may throw if its underlying SSH calls reject
  // (e.g., network drop after install completes). Without this, the NDJSON
  // stream would truncate without an error event.
  let agentStatus: unknown;
  try {
    const [result] = await startRemoteAgents([host], {}, (_hostName, msg) => {
      emit({ event: 'step', name: classifyStartStep(msg), message: msg });
    });
    if (!result || !result.success) {
      emit({
        event: 'error',
        code: 'start-failed',
        message: result?.message ?? 'unknown start failure',
      });
      process.exit(1);
    }
    agentStatus = result.agentStatus;
  } catch (err) {
    emit({
      event: 'error',
      code: 'start-failed',
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  emit({
    event: 'done',
    machineId: tokens.machineId,
    agentStatus,
  });
}

function classifyInstallStep(msg: string): string {
  const m = msg.toLowerCase();
  if (m.startsWith('packing')) return 'pack';
  if (m.startsWith('copying')) return 'upload';
  if (m.startsWith('installing')) return 'install';
  if (m.startsWith('running setup')) return 'configure';
  if (m.startsWith('configuring tokens')) return 'configure';
  if (m.startsWith('done')) return 'install-done';
  return 'install';
}

function classifyStartStep(msg: string): string {
  const m = msg.toLowerCase();
  if (m.startsWith('stopping')) return 'stop-existing';
  if (m.startsWith('starting')) return 'start';
  if (m.startsWith('verifying')) return 'verify';
  if (m.startsWith('agent started')) return 'verify';
  return 'start';
}
