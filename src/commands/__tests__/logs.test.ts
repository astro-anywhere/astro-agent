/**
 * Tests for the logs command.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Mock child_process
const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
}));

// Track existsSync behavior
const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

// Mock chalk to pass through strings
vi.mock('chalk', () => ({
  default: {
    yellow: (s: string) => s,
    dim: (s: string) => s,
    cyan: (s: string) => s,
    red: (s: string) => s,
  },
}));

// Mock config
vi.mock('../../lib/config.js', () => ({
  config: {
    getRemoteHosts: () => [],
  },
}));

// Mock ssh-installer
vi.mock('../../lib/ssh-installer.js', () => ({
  buildSshArgs: vi.fn(() => ['ssh-arg']),
}));

import { logsCommand } from '../logs.js';

const LOG_FILE = join(homedir(), '.astro', 'logs', 'agent-runner.log');

describe('logsCommand', () => {
  const originalProcessExit = process.exit;
  const consoleLogs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogs.length = 0;
    console.log = (...args: unknown[]) => consoleLogs.push(args.join(' '));
    console.error = (...args: unknown[]) => consoleLogs.push(args.join(' '));
    // Prevent actual process.exit
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalProcessExit;
  });

  it('should print "No log file found" when log file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    await logsCommand({});

    expect(consoleLogs.some((msg) => msg.includes('No log file found'))).toBe(true);
    expect(consoleLogs.some((msg) => msg.includes('npx @astroanywhere/agent start'))).toBe(true);
  });

  it('should read last N lines with tail when not following', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue('line1\nline2\nline3\n');

    // Mock process.stdout.write
    const writtenOutput: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writtenOutput.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    await logsCommand({ lines: 10 });

    process.stdout.write = origWrite;

    expect(mockExecFileSync).toHaveBeenCalledWith('tail', ['-n', '10', LOG_FILE], {
      encoding: 'utf-8',
    });
    expect(writtenOutput.join('')).toContain('line1');
  });

  it('should use default 50 lines when no --lines specified', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue('output\n');

    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await logsCommand({});

    process.stdout.write = origWrite;

    expect(mockExecFileSync).toHaveBeenCalledWith('tail', ['-n', '50', LOG_FILE], {
      encoding: 'utf-8',
    });
  });

  it('should spawn tail -f when --follow is set', async () => {
    mockExistsSync.mockReturnValue(true);

    // Mock spawn to return a fake child process
    const fakeChild = {
      kill: vi.fn(),
      on: vi.fn((_event: string, cb: () => void) => {
        // Immediately trigger 'close' to end the await
        if (_event === 'close') {
          setTimeout(cb, 10);
        }
      }),
    };
    mockSpawn.mockReturnValue(fakeChild);

    await logsCommand({ follow: true, lines: 20 });

    expect(mockSpawn).toHaveBeenCalledWith(
      'tail',
      ['-f', '-n', '20', LOG_FILE],
      { stdio: 'inherit' },
    );
  });
});
