/**
 * Tests for SSH Strategy
 *
 * Covers:
 * - parseSSHConfig() — SSH config file parsing
 * - Non-compute host filtering (github.com, gitlab.com, etc.)
 * - Host pattern filtering (wildcards, localhost)
 * - SSHStrategy.detect() — detection and additionalEntries
 * - SSHStrategy.execute() — alias validation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

// We need to mock fs and os before importing the module
vi.mock('node:fs/promises');
vi.mock('node:os');
vi.mock('node:net', () => ({
  createConnection: vi.fn((_opts, callback) => {
    // Simulate successful TCP connection
    const socket = {
      destroy: vi.fn(),
      on: vi.fn(),
    };
    setTimeout(() => callback?.(), 0);
    return socket;
  }),
}));

import { parseSSHConfig, SSHStrategy } from '../src/execution/ssh-strategy.js';

describe('parseSSHConfig', () => {
  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue('/home/testuser');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses basic SSH config with multiple hosts', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(`
Host myserver
  HostName 10.0.0.1
  User admin
  Port 2222
  IdentityFile ~/.ssh/id_rsa

Host hpc-login
  HostName hpc.university.edu
  User researcher
  ProxyJump bastion
`);

    const entries = await parseSSHConfig();
    expect(entries).toHaveLength(2);

    expect(entries[0]).toMatchObject({
      name: 'myserver',
      hostname: '10.0.0.1',
      user: 'admin',
      port: 2222,
      identityFile: '~/.ssh/id_rsa',
      source: 'ssh-config',
    });

    expect(entries[1]).toMatchObject({
      name: 'hpc-login',
      hostname: 'hpc.university.edu',
      user: 'researcher',
      proxyJump: 'bastion',
      source: 'ssh-config',
    });
  });

  it('filters out non-compute hosts (github, gitlab, etc.)', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(`
Host github.com
  HostName github.com
  User git

Host gitlab.com
  HostName gitlab.com
  User git

Host my-compute
  HostName compute.example.com
  User admin
`);

    const entries = await parseSSHConfig();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('my-compute');
  });

  it('filters out AWS CodeCommit hosts (prefix match)', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(`
Host codecommit
  HostName git-codecommit.us-east-1.amazonaws.com
  User AKIA123

Host my-server
  HostName 10.0.0.1
`);

    const entries = await parseSSHConfig();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('my-server');
  });

  it('filters out wildcard hosts and localhost', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(`
Host *
  ServerAliveInterval 60

Host localhost
  User local

Host 127.0.0.1
  User local

Host real-server
  HostName 192.168.1.100
`);

    const entries = await parseSSHConfig();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('real-server');
  });

  it('returns empty array when no SSH config exists', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

    const entries = await parseSSHConfig();
    expect(entries).toEqual([]);
  });

  it('handles empty SSH config', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('');

    const entries = await parseSSHConfig();
    expect(entries).toEqual([]);
  });

  it('handles comments and blank lines', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(`
# This is a comment
Host myhost
  # Nested comment
  HostName 10.0.0.1

  User myuser
`);

    const entries = await parseSSHConfig();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.user).toBe('myuser');
  });

  it('uses host name as hostname when no HostName directive', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(`
Host myhost.example.com
  User admin
`);

    const entries = await parseSSHConfig();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hostname).toBe('myhost.example.com');
  });
});

describe('SSHStrategy', () => {
  let strategy: SSHStrategy;

  beforeEach(() => {
    strategy = new SSHStrategy();
    vi.mocked(os.homedir).mockReturnValue('/home/testuser');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct id, name, and isAsync', () => {
    expect(strategy.id).toBe('ssh');
    expect(strategy.name).toBe('SSH Remote');
    expect(strategy.isAsync).toBe(false);
  });

  it('detect() returns additionalEntries for each SSH host', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(`
Host server1
  HostName 10.0.0.1
  User admin

Host server2
  HostName 10.0.0.2
  User root
`);

    const detection = await strategy.detect();
    expect(detection.available).toBe(true);
    expect(detection.additionalEntries).toBeDefined();
    expect(detection.additionalEntries!.length).toBe(2);

    const entry1 = detection.additionalEntries![0]!;
    expect(entry1.id).toBe('ssh:server1');
    expect(entry1.name).toBe('server1');
    expect(entry1.available).toBe(true);
    expect(entry1.metadata).toMatchObject({
      alias: 'server1',
      hostname: '10.0.0.1',
      user: 'admin',
      source: 'ssh-config',
    });

    const entry2 = detection.additionalEntries![1]!;
    expect(entry2.id).toBe('ssh:server2');
    expect(entry2.name).toBe('server2');
  });

  it('detect() returns available:false when no SSH hosts', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

    const detection = await strategy.detect();
    expect(detection.available).toBe(false);
    expect(detection.additionalEntries).toBeUndefined();
  });

  it('detect() metadata includes host counts', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(`
Host server1
  HostName 10.0.0.1

Host server2
  HostName 10.0.0.2
`);

    const detection = await strategy.detect();
    expect(detection.metadata).toMatchObject({
      hostCount: 2,
      availableCount: 2,
    });
  });

  it('execute() rejects invalid SSH alias', async () => {
    const spec = {
      jobId: 'test-1',
      command: 'echo hello',
      cwd: '/tmp',
      options: { sshAlias: '; rm -rf /' },
    };
    const callbacks = {
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onStatus: vi.fn(),
    };
    const controller = new AbortController();

    const result = await strategy.execute(spec, callbacks, controller.signal);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Invalid SSH alias');
  });

  it('execute() rejects when no sshAlias provided', async () => {
    const spec = {
      jobId: 'test-1',
      command: 'echo hello',
      cwd: '/tmp',
    };
    const callbacks = {
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onStatus: vi.fn(),
    };
    const controller = new AbortController();

    const result = await strategy.execute(spec, callbacks, controller.signal);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('sshAlias');
  });

  it('execute() returns cancelled when signal already aborted', async () => {
    const spec = {
      jobId: 'test-1',
      command: 'echo hello',
      cwd: '/tmp',
      options: { sshAlias: 'myhost' },
    };
    const callbacks = {
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onStatus: vi.fn(),
    };
    const controller = new AbortController();
    controller.abort();

    const result = await strategy.execute(spec, callbacks, controller.signal);
    expect(result.status).toBe('cancelled');
  });

  it('cancel() and getStatus() handle unknown jobIds gracefully', async () => {
    await strategy.cancel('nonexistent');
    const status = await strategy.getStatus('nonexistent');
    expect(status).toBeNull();
  });
});
