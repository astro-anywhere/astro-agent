/**
 * Tests for checkRemoteAgentRunning helper.
 */

import { describe, it, expect, vi } from 'vitest';

const mockExecFileAsync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:util', () => ({
  promisify: () => mockExecFileAsync,
}));
vi.mock('node:os', () => ({
  networkInterfaces: () => ({}),
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

import { checkRemoteAgentRunning } from '../ssh-installer.js';
import type { DiscoveredHost } from '../../types.js';

const testHost: DiscoveredHost = {
  name: 'test-host',
  hostname: '10.0.0.1',
  user: 'testuser',
  source: 'ssh-config',
};

describe('checkRemoteAgentRunning', () => {
  it('should return true when pgrep finds a running process', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '12345\n', stderr: '' });

    const result = await checkRemoteAgentRunning(testHost);
    expect(result).toBe(true);

    // Verify the SSH command includes the bracket trick pgrep pattern
    const call = mockExecFileAsync.mock.calls[0];
    expect(call[0]).toBe('ssh');
    const args = call[1] as string[];
    const command = args[args.length - 1];
    expect(command).toContain('pgrep -f "[a]stro-agent start"');
  });

  it('should return false when pgrep finds no process', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await checkRemoteAgentRunning(testHost);
    expect(result).toBe(false);
  });

  it('should return false when SSH fails', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await checkRemoteAgentRunning(testHost);
    expect(result).toBe(false);
  });

  it('should return false when pgrep exits non-zero (no match)', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('exit code 1'));

    const result = await checkRemoteAgentRunning(testHost);
    expect(result).toBe(false);
  });
});
