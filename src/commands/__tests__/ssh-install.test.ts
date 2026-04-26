/**
 * Tests for the ssh-install command's NDJSON contract.
 *
 * We don't exercise real SSH here — `packAndInstall` and `startRemoteAgents`
 * are mocked so we can verify the orchestration: emitted event sequence,
 * step classification, error handling, and exit codes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/ssh-discovery.js', () => ({
  discoverRemoteHosts: vi.fn(async () => [
    { name: 'demo', hostname: 'demo.example.com', user: 'alice', port: 22, source: 'ssh-config' as const },
  ]),
}));

const packAndInstall = vi.fn();
const startRemoteAgents = vi.fn();
const buildSshArgs = vi.fn(
  (host: { name: string }, command: string) => ['-o', 'BatchMode=yes', host.name, command],
);

vi.mock('../../lib/ssh-installer.js', () => ({
  packAndInstall: (...args: Parameters<typeof packAndInstall>) => packAndInstall(...args),
  startRemoteAgents: (...args: Parameters<typeof startRemoteAgents>) => startRemoteAgents(...args),
  buildSshArgs: (...args: Parameters<typeof buildSshArgs>) => buildSshArgs(...args),
}));

// Mock execFile so the preflight `ssh <alias> echo astro-preflight-ok` can
// be steered per-test. Default: succeed.
const execFileImpl = vi.fn<
  (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => void
>((_cmd, _args, _opts, cb) => {
  cb(null, { stdout: 'astro-preflight-ok\n', stderr: '' });
});

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) =>
      execFileImpl(cmd, args, opts, cb),
  };
});

import { sshInstallCommand, type TokenBundle } from '../ssh-install.js';

const validTokens: TokenBundle = {
  accessToken: 'tok-access',
  refreshToken: 'tok-refresh',
  wsToken: 'tok-ws',
  machineId: 'mach-123',
  apiUrl: 'http://localhost:3001',
  relayUrl: 'ws://localhost:3002',
};

interface CapturedEvent {
  event: string;
  [k: string]: unknown;
}

function captureStdout(): { lines: () => CapturedEvent[]; restore: () => void } {
  const original = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines: () =>
      captured
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as CapturedEvent),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

describe('sshInstallCommand', () => {
  beforeEach(() => {
    packAndInstall.mockReset();
    startRemoteAgents.mockReset();
    execFileImpl.mockReset();
    execFileImpl.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: 'astro-preflight-ok\n', stderr: '' });
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits step → done events on a successful install', async () => {
    packAndInstall.mockImplementation(async (_opts, onProgress) => {
      onProgress?.('Packing agent-runner...');
      onProgress?.('Copying to demo...');
      onProgress?.('Installing on demo...');
      onProgress?.('Configuring tokens on demo...');
    });
    startRemoteAgents.mockImplementation(async (_hosts, _opts, onProgress) => {
      onProgress?.('demo', 'Stopping existing agent (if any)...');
      onProgress?.('demo', 'Starting agent...');
      onProgress?.('demo', 'Verifying process started...');
      return [{ host: { name: 'demo' }, success: true, message: 'Started', agentStatus: { hostname: 'demo' } }];
    });

    const cap = captureStdout();
    try {
      await sshInstallCommand({ host: 'demo', tokens: validTokens });
    } finally {
      cap.restore();
    }

    const events = cap.lines();
    const stepNames = events.filter((e) => e.event === 'step').map((e) => e.name);

    expect(stepNames).toEqual(
      expect.arrayContaining(['preflight', 'pack', 'upload', 'install', 'configure', 'stop-existing', 'start', 'verify']),
    );
    const last = events[events.length - 1];
    expect(last.event).toBe('done');
    expect(last.machineId).toBe('mach-123');
    expect(last.agentStatus).toEqual({ hostname: 'demo' });
  });

  it('emits {event:"error", code:"host-not-found"} for unknown alias', async () => {
    const cap = captureStdout();
    let thrown: unknown;
    try {
      await sshInstallCommand({ host: 'nope-not-real', tokens: validTokens });
    } catch (err) {
      thrown = err;
    } finally {
      cap.restore();
    }

    const events = cap.lines();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'error', code: 'host-not-found' });
    expect(String(thrown)).toContain('__exit:1');
  });

  it('emits {event:"error", code:"install-failed"} when packAndInstall throws', async () => {
    packAndInstall.mockRejectedValue(new Error('scp: permission denied'));

    const cap = captureStdout();
    let thrown: unknown;
    try {
      await sshInstallCommand({ host: 'demo', tokens: validTokens });
    } catch (err) {
      thrown = err;
    } finally {
      cap.restore();
    }

    const events = cap.lines();
    const errEvent = events.find((e) => e.event === 'error');
    expect(errEvent).toMatchObject({ event: 'error', code: 'install-failed' });
    expect(String(errEvent?.message)).toContain('permission denied');
    expect(String(thrown)).toContain('__exit:1');
    expect(startRemoteAgents).not.toHaveBeenCalled();
  });

  it('emits {event:"error", code:"start-failed"} when remote start verification fails', async () => {
    packAndInstall.mockResolvedValue(undefined);
    startRemoteAgents.mockResolvedValue([
      { host: { name: 'demo' }, success: false, message: 'Agent process not found after start' },
    ]);

    const cap = captureStdout();
    let thrown: unknown;
    try {
      await sshInstallCommand({ host: 'demo', tokens: validTokens });
    } catch (err) {
      thrown = err;
    } finally {
      cap.restore();
    }

    const events = cap.lines();
    const errEvent = events.find((e) => e.event === 'error');
    expect(errEvent).toMatchObject({ event: 'error', code: 'start-failed' });
    expect(String(errEvent?.message)).toContain('Agent process not found');
    expect(String(thrown)).toContain('__exit:1');
  });

  it('emits {event:"error", code:"auth-required"} when preflight detects 2FA / password auth', async () => {
    execFileImpl.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = Object.assign(new Error('exit 255'), {
        stderr: 'Permission denied (publickey,keyboard-interactive).\n',
      });
      cb(err, { stdout: '', stderr: 'Permission denied (publickey,keyboard-interactive).\n' });
    });

    const cap = captureStdout();
    let thrown: unknown;
    try {
      await sshInstallCommand({ host: 'demo', tokens: validTokens });
    } catch (err) {
      thrown = err;
    } finally {
      cap.restore();
    }

    const events = cap.lines();
    const errEvent = events.find((e) => e.event === 'error');
    expect(errEvent).toMatchObject({ event: 'error', code: 'auth-required' });
    expect(String(thrown)).toContain('__exit:1');
    expect(packAndInstall).not.toHaveBeenCalled();
  });

  it('emits {event:"error", code:"start-failed"} when startRemoteAgents itself throws after install completes', async () => {
    packAndInstall.mockResolvedValue(undefined);
    startRemoteAgents.mockRejectedValue(new Error('connection lost during verify'));

    const cap = captureStdout();
    let thrown: unknown;
    try {
      await sshInstallCommand({ host: 'demo', tokens: validTokens });
    } catch (err) {
      thrown = err;
    } finally {
      cap.restore();
    }

    const events = cap.lines();
    const errEvent = events.find((e) => e.event === 'error');
    expect(errEvent).toMatchObject({ event: 'error', code: 'start-failed' });
    expect(String(errEvent?.message)).toContain('connection lost');
    expect(String(thrown)).toContain('__exit:1');
  });

  it('trims whitespace on the host alias', async () => {
    packAndInstall.mockResolvedValue(undefined);
    startRemoteAgents.mockResolvedValue([{ host: { name: 'demo' }, success: true, message: 'ok' }]);

    const cap = captureStdout();
    try {
      await sshInstallCommand({ host: '  demo  ', tokens: validTokens });
    } finally {
      cap.restore();
    }

    const events = cap.lines();
    expect(events[events.length - 1]).toMatchObject({ event: 'done' });
  });

  it('rejects token bundles missing required fields', async () => {
    const cap = captureStdout();
    let thrown: unknown;
    try {
      await sshInstallCommand({
        host: 'demo',
        tokens: { ...validTokens, accessToken: '' } as TokenBundle,
      });
    } catch (err) {
      thrown = err;
    } finally {
      cap.restore();
    }

    const events = cap.lines();
    expect(events[0]).toMatchObject({ event: 'error', code: 'bad-tokens' });
    expect(String(events[0].message)).toContain('accessToken');
    expect(String(thrown)).toContain('__exit:1');
  });
});
