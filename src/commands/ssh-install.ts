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

import { discoverRemoteHosts } from '../lib/ssh-discovery.js';
import {
  packAndInstall,
  startRemoteAgents,
  establishControlMaster,
  hasControlMaster,
  type InstallOptions,
} from '../lib/ssh-installer.js';
import type { DiscoveredHost } from '../types.js';

export interface SshInstallOptions {
  host: string;
  /** Read JSON token bundle from stdin. Default true. */
  stdin?: boolean;
  /** Token bundle passed in-process (used by tests / library callers). */
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

async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

export async function sshInstallCommand(opts: SshInstallOptions): Promise<void> {
  // Resolve host first so we fail fast on bad alias.
  let host: DiscoveredHost;
  try {
    host = await resolveHost(opts.host);
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

  // Establish ControlMaster up-front for 2FA hosts. This is a no-op if the
  // host doesn't need 2FA — packAndInstall and sshExec both route through
  // the socket if it exists.
  try {
    if (!(await hasControlMaster(host))) {
      emit({ event: 'step', name: 'control-master', message: `Opening multiplexed SSH session to ${host.name}` });
      await establishControlMaster(host);
    }
  } catch (err) {
    // Non-fatal: many hosts work fine without ControlMaster. Surface as a
    // step note so the orchestrator can show it, but keep going.
    emit({
      event: 'step',
      name: 'control-master',
      message: `Skipped multiplexing: ${err instanceof Error ? err.message : String(err)}`,
    });
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

  // Step: start the remote agent + verify it's running.
  const [result] = await startRemoteAgents(
    [host],
    {},
    (_hostName, msg) => {
      emit({ event: 'step', name: classifyStartStep(msg), message: msg });
    },
  );

  if (!result || !result.success) {
    emit({
      event: 'error',
      code: 'start-failed',
      message: result?.message ?? 'unknown start failure',
    });
    process.exit(1);
  }

  emit({
    event: 'done',
    machineId: tokens.machineId,
    agentStatus: result.agentStatus,
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
