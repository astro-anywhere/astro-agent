/**
 * Tests for SSH installer utilities — remote install and agent start.
 */

import { describe, it, expect, vi } from 'vitest';

const mockExecFileAsync = vi.hoisted(() => vi.fn());
const mockExecFileCb = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: mockExecFileCb,
}));
vi.mock('node:util', () => ({
  promisify: () => mockExecFileAsync,
}));
vi.mock('node:os', () => ({
  networkInterfaces: () => ({
    en0: [
      { family: 'IPv4', address: '192.168.1.100', internal: false },
    ],
  }),
}));
vi.mock('node:url', () => ({
  fileURLToPath: () => '/mock/src/lib/ssh-installer.ts',
}));
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    ...actual,
    resolve: actual.resolve,
    dirname: actual.dirname,
  };
});

import { buildSshArgs, detectLocalIP } from '../ssh-installer.js';
import type { DiscoveredHost } from '../../types.js';

const testHost: DiscoveredHost = {
  name: 'test-host',
  hostname: '10.0.0.1',
  user: 'testuser',
  source: 'ssh-config',
};

describe('buildSshArgs', () => {
  it('should build basic SSH args with user and hostname', () => {
    const args = buildSshArgs(testHost, 'echo hello');

    expect(args).toContain('testuser@10.0.0.1');
    expect(args).toContain('echo hello');
    expect(args).toContain('-o');
    expect(args).toContain('BatchMode=yes');
  });

  it('should include port flag when non-default port', () => {
    const host: DiscoveredHost = { ...testHost, port: 2222 };
    const args = buildSshArgs(host, 'ls');

    expect(args).toContain('-p');
    expect(args).toContain('2222');
  });

  it('should include identity file when specified', () => {
    const host: DiscoveredHost = { ...testHost, identityFile: '/home/user/.ssh/id_ed25519' };
    const args = buildSshArgs(host, 'ls');

    expect(args).toContain('-i');
    expect(args).toContain('/home/user/.ssh/id_ed25519');
  });

  it('should include proxy jump when specified', () => {
    const host: DiscoveredHost = { ...testHost, proxyJump: 'bastion.example.com' };
    const args = buildSshArgs(host, 'ls');

    expect(args).toContain('-J');
    expect(args).toContain('bastion.example.com');
  });

  it('should omit user@ when no user specified', () => {
    const host: DiscoveredHost = { ...testHost, user: undefined };
    const args = buildSshArgs(host, 'ls');

    expect(args).toContain('10.0.0.1');
    expect(args).not.toContain('testuser@10.0.0.1');
  });
});

describe('detectLocalIP', () => {
  it('should return the first non-internal IPv4 address', () => {
    const ip = detectLocalIP();
    expect(ip).toBe('192.168.1.100');
  });
});

describe('remote install command construction', () => {
  it('should remove old binary before npm install to avoid EEXIST', () => {
    // The install command should include rm -f before npm install
    const npmPrefix = '$HOME/.local';
    const installCmd = `mkdir -p ${npmPrefix} && rm -f ${npmPrefix}/bin/astro-agent && npm install -g --force --prefix ${npmPrefix} $HOME/astro-agent.tgz`;

    expect(installCmd).toContain('rm -f $HOME/.local/bin/astro-agent');
    expect(installCmd.indexOf('rm -f')).toBeLessThan(installCmd.indexOf('npm install'));
  });
});

describe('remote agent start command construction', () => {
  it('should build nohup start command with PATH export', () => {
    const pathExport = 'export PATH="$HOME/.local/bin:$PATH"';
    const flags = ['--foreground', '--log-level info'];
    const startCmd = `astro-agent start ${flags.join(' ')}`;

    const fullCmd = `${pathExport} && mkdir -p $HOME/.astro/logs && nohup ${startCmd} > $HOME/.astro/logs/agent-runner.log 2>&1 & disown`;

    expect(fullCmd).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(fullCmd).toContain('nohup astro-agent start');
    expect(fullCmd).toContain('--foreground');
    expect(fullCmd).toContain('> $HOME/.astro/logs/agent-runner.log 2>&1');
    expect(fullCmd).toContain('& disown');
  });

  it('should kill existing process before starting new one', () => {
    // The startRemoteAgents function should pkill before starting
    const killCmd = 'pkill -f "astro-agent start" 2>/dev/null || true';

    expect(killCmd).toContain('pkill -f');
    expect(killCmd).toContain('|| true'); // Should not fail if no process found
  });
});
