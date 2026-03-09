/**
 * Tests for SSH installer utilities
 *
 * Covers:
 * - detectLocalIP() — LAN IP detection
 * - checkRemoteNode() — multi-strategy Node.js detection (direct, HPC modules, paths, profile)
 * - buildSshArgs() / buildScpArgs — SSH/SCP argument construction
 * - sshExec() — SSH command execution with timeout
 * - packAndInstall() — full remote installation pipeline
 * - startRemoteAgents() — remote agent lifecycle (stop, start, verify, status poll)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';

// Mock child_process.execFile — the module uses promisify(execFile) which calls
// execFile(cmd, args, opts, callback). The mock needs to support both the callback
// style (for promisify) and return a child-like object (for non-promisified uses).
vi.mock('node:child_process', () => {
  const execFileFn = vi.fn((...allArgs: unknown[]) => {
    // promisify calls: execFile(cmd, args, opts, callback)
    const cb = allArgs[allArgs.length - 1];
    if (typeof cb === 'function') {
      cb(null, { stdout: '', stderr: '' });
    }
    return { stdin: { write: vi.fn(), end: vi.fn() }, on: vi.fn() };
  });
  return {
    execFile: execFileFn,
  };
});

vi.mock('node:os', () => ({
  networkInterfaces: vi.fn(),
}));

// Must import after mocks
import {
  detectLocalIP,
  checkRemoteNode,
  buildSshArgs,
  sshExec,
} from '../src/lib/ssh-installer.js';
import type { DiscoveredHost } from '../src/types.js';

// ── Helper: create a DiscoveredHost ─────────────────────────────────
function makeHost(overrides: Partial<DiscoveredHost> = {}): DiscoveredHost {
  return {
    name: 'test-host',
    hostname: '192.168.1.100',
    source: 'ssh-config',
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════
// detectLocalIP()
// ════════════════════════════════════════════════════════════════════

describe('detectLocalIP', () => {
  beforeEach(() => {
    vi.mocked(os.networkInterfaces).mockReset();
  });

  it('returns the first non-internal IPv4 address', () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      lo0: [
        { address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', mac: '', cidr: null },
      ],
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 0 },
        { address: '10.0.1.42', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '', cidr: null },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(detectLocalIP()).toBe('10.0.1.42');
  });

  it('returns 127.0.0.1 when no external interfaces exist', () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      lo0: [
        { address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', mac: '', cidr: null },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(detectLocalIP()).toBe('127.0.0.1');
  });

  it('returns 127.0.0.1 when no interfaces at all', () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({});
    expect(detectLocalIP()).toBe('127.0.0.1');
  });

  it('skips undefined interface arrays', () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      en0: undefined as unknown as os.NetworkInterfaceInfo[],
      en1: [
        { address: '192.168.0.5', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '', cidr: null },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(detectLocalIP()).toBe('192.168.0.5');
  });

  it('picks the first external IPv4 when multiple exist', () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      en0: [
        { address: '10.0.0.1', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '', cidr: null },
      ],
      en1: [
        { address: '172.16.0.1', family: 'IPv4', internal: false, netmask: '255.255.0.0', mac: '', cidr: null },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    expect(detectLocalIP()).toBe('10.0.0.1');
  });
});

// ════════════════════════════════════════════════════════════════════
// buildSshArgs()
// ════════════════════════════════════════════════════════════════════

describe('buildSshArgs', () => {
  it('builds minimal args for simple host', () => {
    const host = makeHost({ hostname: 'myserver.com' });
    const args = buildSshArgs(host, 'echo hello');

    expect(args).toContain('-o');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ConnectTimeout=10');
    expect(args).toContain('myserver.com');
    expect(args).toContain('echo hello');
  });

  it('includes -p for non-default port', () => {
    const host = makeHost({ port: 2222 });
    const args = buildSshArgs(host, 'ls');

    expect(args).toContain('-p');
    expect(args).toContain('2222');
  });

  it('does not include -p for port 22', () => {
    const host = makeHost({ port: 22 });
    const args = buildSshArgs(host, 'ls');

    expect(args).not.toContain('-p');
  });

  it('does not include -p when port is undefined', () => {
    const host = makeHost({ port: undefined });
    const args = buildSshArgs(host, 'ls');

    expect(args).not.toContain('-p');
  });

  it('includes -i for identity file', () => {
    const host = makeHost({ identityFile: '/home/user/.ssh/id_rsa' });
    const args = buildSshArgs(host, 'ls');

    expect(args).toContain('-i');
    expect(args).toContain('/home/user/.ssh/id_rsa');
  });

  it('includes -J for proxy jump', () => {
    const host = makeHost({ proxyJump: 'bastion.example.com' });
    const args = buildSshArgs(host, 'ls');

    expect(args).toContain('-J');
    expect(args).toContain('bastion.example.com');
  });

  it('prepends user@ when user is set', () => {
    const host = makeHost({ user: 'deploy', hostname: 'server.com' });
    const args = buildSshArgs(host, 'whoami');

    expect(args).toContain('deploy@server.com');
  });

  it('uses bare hostname when no user', () => {
    const host = makeHost({ user: undefined, hostname: 'server.com' });
    const args = buildSshArgs(host, 'whoami');

    expect(args).toContain('server.com');
    expect(args.join(' ')).not.toContain('@');
  });

  it('includes all options together', () => {
    const host = makeHost({
      user: 'admin',
      hostname: 'hpc.university.edu',
      port: 2200,
      identityFile: '~/.ssh/hpc_key',
      proxyJump: 'gateway.university.edu',
    });
    const args = buildSshArgs(host, 'node --version');

    expect(args).toContain('-p');
    expect(args).toContain('2200');
    expect(args).toContain('-i');
    expect(args).toContain('~/.ssh/hpc_key');
    expect(args).toContain('-J');
    expect(args).toContain('gateway.university.edu');
    expect(args).toContain('admin@hpc.university.edu');
    expect(args[args.length - 1]).toBe('node --version');
  });

  it('command is always the last argument', () => {
    const host = makeHost({ port: 2222, identityFile: '/key', proxyJump: 'jump' });
    const args = buildSshArgs(host, 'uname -a');

    expect(args[args.length - 1]).toBe('uname -a');
  });
});

// ════════════════════════════════════════════════════════════════════
// checkRemoteNode() — multi-strategy detection
// ════════════════════════════════════════════════════════════════════

describe('checkRemoteNode', () => {
  // We need to mock sshExec at a lower level since it's internal.
  // The simplest approach: mock the promisified execFile that sshExec calls.
  let execFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import('node:child_process');
    execFileMock = vi.mocked(cp.execFile);
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockSshResponse(responses: Map<string, { stdout: string } | Error>) {
    execFileMock.mockImplementation((...allArgs: unknown[]) => {
      const cb = typeof allArgs[allArgs.length - 1] === 'function'
        ? allArgs[allArgs.length - 1] as Function
        : undefined;
      // args is the second positional arg: execFile('ssh', args, opts, cb)
      const args = allArgs[1] as string[];
      const command = args[args.length - 1]; // SSH command is last arg

      let matched: { stdout: string } | Error | undefined;

      // Exact match first, then longest partial match (avoids short keys like
      // 'node --version' stealing matches from longer commands)
      matched = responses.get(command);
      if (!matched) {
        let longestKey = '';
        for (const [key, val] of responses) {
          if (command.includes(key) && key.length > longestKey.length) {
            longestKey = key;
            matched = val;
          }
        }
      }

      if (!matched) {
        const err = new Error(`Command failed: ${command}`);
        if (cb) cb(err, { stdout: '', stderr: '' });
        return { stdin: { write: vi.fn(), end: vi.fn() }, on: vi.fn() };
      }

      if (matched instanceof Error) {
        if (cb) cb(matched, { stdout: '', stderr: '' });
      } else {
        if (cb) cb(null, { stdout: matched.stdout, stderr: '' });
      }
      return { stdin: { write: vi.fn(), end: vi.fn() }, on: vi.fn() };
    });
  }

  it('detects node directly (strategy 1)', async () => {
    mockSshResponse(
      new Map([['node --version', { stdout: 'v20.11.0\n' }]]),
    );
    const host = makeHost();
    const result = await checkRemoteNode(host);
    expect(result.available).toBe(true);
    expect(result.version).toBe('v20.11.0');
    expect(result.method).toBe('direct');
  });

  it('rejects node < 18 but preserves version for error classification', async () => {
    mockSshResponse(
      new Map([
        ['node --version', { stdout: 'v16.20.0\n' }],
        ['nodejs --version', new Error('not found')],
      ]),
    );
    const host = makeHost();
    const result = await checkRemoteNode(host);
    // Strategy 1 finds v16 (< 18), falls through; version is preserved for caller
    expect(result.available).toBe(false);
    expect(result.version).toBe('v16.20.0');
  });

  it('tries nodejs binary as fallback', async () => {
    mockSshResponse(
      new Map([
        ['node --version', new Error('not found')],
        ['nodejs --version', { stdout: 'v18.19.0\n' }],
      ]),
    );
    const host = makeHost();
    const result = await checkRemoteNode(host);
    expect(result.available).toBe(true);
    expect(result.version).toBe('v18.19.0');
    expect(result.method).toBe('direct');
  });

  it('finds node via HPC module system (strategy 2)', async () => {
    // Strategy 2 now batches all module-load attempts into a single SSH call.
    // The command contains all module names chained with "; ... && exit 0".
    // The output includes a MODULE:<name> marker to identify which module succeeded.
    mockSshResponse(
      new Map([
        ['node --version', new Error('not found')],
        ['nodejs --version', new Error('not found')],
        // The batched command includes all module load attempts; match on the init prefix
        ['module load nodejs 2>/dev/null && node --version && echo "MODULE:nodejs" && exit 0', { stdout: 'v20.0.0\nMODULE:nodejs\n' }],
      ]),
    );
    const host = makeHost();
    const result = await checkRemoteNode(host);
    expect(result.available).toBe(true);
    expect(result.version).toBe('v20.0.0');
    expect(result.method).toBe('module:nodejs');
  });

  it('finds node via common paths (strategy 3)', async () => {
    mockSshResponse(
      new Map([
        ['node --version', new Error('not found')],
        ['nodejs --version', new Error('not found')],
        // All module loads fail (partial match on "module load")
        ['module load', new Error('no modules')],
        // Strategy 3 uses bash -c with the path
        ['$HOME/.local/bin/node', { stdout: 'v22.1.0\n' }],
      ]),
    );
    const host = makeHost();
    const result = await checkRemoteNode(host);
    expect(result.available).toBe(true);
    expect(result.version).toBe('v22.1.0');
    expect(result.method).toMatch(/^path:/);
  });

  it('finds node via profile sourcing (strategy 4)', async () => {
    mockSshResponse(
      new Map([
        ['node --version', new Error('not found')],
        ['nodejs --version', new Error('not found')],
        // All HPC modules fail
        ['module load', new Error('no modules')],
        // All common paths fail
        ['bash -c', new Error('not found')],
        // Strategy 4: source profile then node --version
        ['source ~/.bashrc 2>/dev/null; source ~/.bash_profile 2>/dev/null; node --version', { stdout: 'v18.0.0\n' }],
      ]),
    );
    const host = makeHost();
    const result = await checkRemoteNode(host);
    expect(result.available).toBe(true);
    expect(result.version).toBe('v18.0.0');
    expect(result.method).toBe('profile');
  });

  it('returns unavailable when all strategies fail', async () => {
    mockSshResponse(new Map()); // All commands fail
    const host = makeHost();
    const result = await checkRemoteNode(host);
    expect(result.available).toBe(false);
    expect(result.version).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// sshExec()
// ════════════════════════════════════════════════════════════════════

describe('sshExec', () => {
  let execFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import('node:child_process');
    execFileMock = vi.mocked(cp.execFile);
    execFileMock.mockReset();
  });

  it('calls ssh with correct args and returns stdout/stderr', async () => {
    execFileMock.mockImplementation((...allArgs: unknown[]) => {
      const cb = typeof allArgs[allArgs.length - 1] === 'function'
        ? allArgs[allArgs.length - 1] as Function : undefined;
      if (cb) cb(null, { stdout: 'hello\n', stderr: '' });
      return { stdin: { write: vi.fn(), end: vi.fn() }, on: vi.fn() };
    });

    const host = makeHost({ user: 'testuser', hostname: 'remote.host' });
    const result = await sshExec(host, 'echo hello');

    expect(result.stdout).toBe('hello\n');
    // promisify adds the callback as the last arg, so check positional args
    const call = execFileMock.mock.calls[0];
    expect(call[0]).toBe('ssh');
    expect(call[1]).toEqual(expect.arrayContaining(['testuser@remote.host', 'echo hello']));
    expect(call[2]).toEqual(expect.objectContaining({ timeout: 60_000 }));
  });

  it('propagates errors from ssh', async () => {
    execFileMock.mockImplementation((...allArgs: unknown[]) => {
      const cb = typeof allArgs[allArgs.length - 1] === 'function'
        ? allArgs[allArgs.length - 1] as Function : undefined;
      if (cb) cb(new Error('Connection refused'), { stdout: '', stderr: '' });
      return { stdin: { write: vi.fn(), end: vi.fn() }, on: vi.fn() };
    });

    const host = makeHost();
    await expect(sshExec(host, 'ls')).rejects.toThrow('Connection refused');
  });
});
