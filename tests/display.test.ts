/**
 * Tests for terminal display utilities
 *
 * Covers:
 * - formatLocalMachineBox() — local machine info rendering
 * - formatRemoteHostBox() — remote host status rendering
 * - formatInstallErrorBox() — installation error summary
 * - formatLaunchBanner() / formatSetupHint() / formatNoProvidersWarning()
 * - Box-drawing helpers (renderBox, boxSeparator)
 */
import { describe, it, expect } from 'vitest';
import {
  formatLocalMachineBox,
  formatRemoteHostBox,
  formatInstallErrorBox,
  formatLaunchBanner,
  formatSetupHint,
  formatNoProvidersWarning,
  renderBox,
  boxSeparator,
  type InstallErrorInfo,
} from '../src/lib/display.js';
import type { ProviderInfo, MachineResources, DiscoveredHost } from '../src/types.js';
import type { RemoteAgentStatus } from '../src/lib/ssh-installer.js';

// ── Helpers ───────────────────────────────────────────────────────

/** Strip ANSI escape codes for content assertions */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeMachineResources(overrides: Partial<MachineResources> = {}): MachineResources {
  return {
    hostname: 'dev-machine',
    platform: 'darwin',
    arch: 'arm64',
    cpu: { model: 'Apple M2 Pro', cores: 12 },
    memory: { total: 32 * 1024 ** 3, free: 16 * 1024 ** 3 },
    gpu: [{ name: 'Apple M2 Pro', vendor: 'Apple', memoryTotal: 32 * 1024 ** 3 }],
    ...overrides,
  };
}

function makeProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    name: 'Claude Code',
    type: 'claude-sdk' as ProviderInfo['type'],
    available: true,
    version: '1.2.3',
    path: '/usr/local/bin/claude',
    capabilities: {
      streaming: true,
      tools: true,
      multiTurn: true,
      defaultModel: 'claude-sonnet-4-5-20250514',
    },
    ...overrides,
  };
}

function makeHost(overrides: Partial<DiscoveredHost> = {}): DiscoveredHost {
  return {
    name: 'gpu-server',
    hostname: '10.0.1.50',
    source: 'ssh-config',
    user: 'researcher',
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════
// renderBox
// ════════════════════════════════════════════════════════════════════

describe('renderBox', () => {
  it('wraps lines in a box with box-drawing characters', () => {
    const result = renderBox(['Hello', 'World']);
    const plain = stripAnsi(result);

    expect(plain).toContain('╭');
    expect(plain).toContain('╰');
    expect(plain).toContain('│');
    expect(plain).toContain('Hello');
    expect(plain).toContain('World');
  });

  it('respects minWidth parameter', () => {
    const result = renderBox(['Hi'], 60);
    const lines = result.split('\n');
    const topLine = stripAnsi(lines[0]);
    // Top border = ╭ + 62 chars (60 content + 2 padding) + ╮
    expect(topLine.length).toBe(64);
  });

  it('auto-sizes to longest line', () => {
    const longLine = 'A'.repeat(80);
    const result = renderBox([longLine, 'short']);
    const lines = result.split('\n');
    const topLine = stripAnsi(lines[0]);
    // Should accommodate the 80-char line
    expect(topLine.length).toBe(84); // 80 + 2 padding + 2 borders
  });

  it('handles empty lines', () => {
    const result = renderBox(['', 'content', '']);
    const plain = stripAnsi(result);
    expect(plain).toContain('content');
  });
});

// ════════════════════════════════════════════════════════════════════
// boxSeparator
// ════════════════════════════════════════════════════════════════════

describe('boxSeparator', () => {
  it('produces a horizontal separator line', () => {
    const sep = boxSeparator(40);
    expect(sep).toContain('├');
    expect(sep).toContain('┤');
    expect(sep).toContain('─');
  });

  it('has correct width', () => {
    const sep = boxSeparator(50);
    // ├ + 52 dashes + ┤
    expect(sep.length).toBe(54);
  });
});

// ════════════════════════════════════════════════════════════════════
// formatLocalMachineBox
// ════════════════════════════════════════════════════════════════════

describe('formatLocalMachineBox', () => {
  it('includes hostname and "this device" label', () => {
    const result = formatLocalMachineBox(
      makeMachineResources(),
      [makeProvider()],
      '0.2.0',
      'abc12345-6789',
    );
    const plain = stripAnsi(result);

    expect(plain).toContain('dev-machine');
    expect(plain).toContain('this device');
  });

  it('includes version', () => {
    const result = formatLocalMachineBox(
      makeMachineResources(),
      [makeProvider()],
      '0.2.0',
      'abc12345',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('v0.2.0');
  });

  it('shows CPU info', () => {
    const result = formatLocalMachineBox(
      makeMachineResources({ cpu: { model: 'Intel i9-13900K', cores: 24 } }),
      [],
      '1.0.0',
      'id123',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('Intel i9-13900K');
    expect(plain).toContain('24 cores');
  });

  it('shows RAM info', () => {
    const result = formatLocalMachineBox(
      makeMachineResources({ memory: { total: 64 * 1024 ** 3, free: 32 * 1024 ** 3 } }),
      [],
      '1.0.0',
      'id123',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('64');
    expect(plain).toContain('available');
  });

  it('shows GPU info when present', () => {
    const result = formatLocalMachineBox(
      makeMachineResources({
        gpu: [{ name: 'NVIDIA RTX 4090', vendor: 'NVIDIA', memoryTotal: 24 * 1024 ** 3 }],
      }),
      [],
      '1.0.0',
      'id123',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('NVIDIA RTX 4090');
  });

  it('skips GPU section when no GPUs', () => {
    const result = formatLocalMachineBox(
      makeMachineResources({ gpu: [] }),
      [],
      '1.0.0',
      'id123',
    );
    const plain = stripAnsi(result);
    expect(plain).not.toContain('GPU');
  });

  it('lists providers with checkmarks', () => {
    const result = formatLocalMachineBox(
      makeMachineResources(),
      [
        makeProvider({ name: 'Claude Code', version: '1.2.3' }),
        makeProvider({ name: 'Codex', type: 'codex' as ProviderInfo['type'], version: '0.5.0' }),
      ],
      '1.0.0',
      'id123',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('Claude Code');
    expect(plain).toContain('Codex');
    expect(plain).toContain('✓');
  });

  it('shows warning when no providers', () => {
    const result = formatLocalMachineBox(
      makeMachineResources(),
      [],
      '1.0.0',
      'id123',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('No providers detected');
  });

  it('shows truncated runner ID', () => {
    const result = formatLocalMachineBox(
      makeMachineResources(),
      [],
      '1.0.0',
      'abcdef1234567890',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('abcdef12');
  });

  it('classifies Apple Silicon workstation correctly', () => {
    const result = formatLocalMachineBox(
      makeMachineResources({
        gpu: [{ name: 'Apple M2 Pro', vendor: 'Apple', memoryTotal: 32 * 1024 ** 3 }],
        memory: { total: 32 * 1024 ** 3, free: 16 * 1024 ** 3 },
      }),
      [],
      '1.0.0',
      'id',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('Apple Silicon Workstation');
  });

  it('classifies GPU Workstation correctly', () => {
    const result = formatLocalMachineBox(
      makeMachineResources({
        gpu: [{ name: 'RTX 4090', vendor: 'NVIDIA', memoryTotal: 24 * 1024 ** 3 }],
      }),
      [],
      '1.0.0',
      'id',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('GPU Workstation');
  });

  it('shows HPC capability for providers', () => {
    const result = formatLocalMachineBox(
      makeMachineResources(),
      [makeProvider({
        hpcCapability: { type: 'slurm', clusterName: 'Sherlock' },
      } as Partial<ProviderInfo>)],
      '1.0.0',
      'id',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('HPC');
    expect(plain).toContain('Sherlock');
  });

  it('shows default model for providers', () => {
    const result = formatLocalMachineBox(
      makeMachineResources(),
      [makeProvider({
        capabilities: { streaming: true, tools: true, multiTurn: true, defaultModel: 'gpt-4o' },
      })],
      '1.0.0',
      'id',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('model: gpt-4o');
  });
});

// ════════════════════════════════════════════════════════════════════
// formatRemoteHostBox
// ════════════════════════════════════════════════════════════════════

describe('formatRemoteHostBox', () => {
  it('shows running status with green indicator', () => {
    const result = formatRemoteHostBox(makeHost(), 'running');
    const plain = stripAnsi(result);
    expect(plain).toContain('gpu-server');
    expect(plain).toContain('running');
    expect(plain).toContain('●');
  });

  it('shows failed status with error message', () => {
    const result = formatRemoteHostBox(makeHost(), 'failed', 'Connection timeout');
    const plain = stripAnsi(result);
    expect(plain).toContain('failed');
    expect(plain).toContain('Connection timeout');
  });

  it('shows pending status', () => {
    const result = formatRemoteHostBox(makeHost(), 'pending');
    const plain = stripAnsi(result);
    expect(plain).toContain('starting');
  });

  it('includes user@hostname connection info', () => {
    const result = formatRemoteHostBox(
      makeHost({ user: 'admin', hostname: 'hpc.edu' }),
      'running',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('admin@hpc.edu');
  });

  it('shows hostname without user when user is not set', () => {
    const result = formatRemoteHostBox(
      makeHost({ user: undefined, hostname: 'server.local' }),
      'running',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain('server.local');
    expect(plain).not.toContain('@server.local');
  });

  it('shows port when non-standard', () => {
    const result = formatRemoteHostBox(
      makeHost({ port: 2222 }),
      'running',
    );
    const plain = stripAnsi(result);
    expect(plain).toContain(':2222');
  });

  it('omits port for standard SSH port 22', () => {
    const result = formatRemoteHostBox(
      makeHost({ port: 22 }),
      'running',
    );
    const plain = stripAnsi(result);
    expect(plain).not.toContain(':22');
  });

  it('includes hardware info from agent status', () => {
    const status: RemoteAgentStatus = {
      hostname: 'gpu-server',
      platform: 'linux',
      arch: 'x64',
      cpuCores: 64,
      memoryGB: 256,
    };
    const result = formatRemoteHostBox(makeHost(), 'running', undefined, status);
    const plain = stripAnsi(result);
    expect(plain).toContain('linux/x64');
    expect(plain).toContain('64 cores');
    expect(plain).toContain('256 GB RAM');
  });

  it('shows GPU info from agent status', () => {
    const status: RemoteAgentStatus = {
      gpu: [{ name: 'A100 80GB', vendor: 'NVIDIA', memoryGB: 80 }],
    };
    const result = formatRemoteHostBox(makeHost(), 'running', undefined, status);
    const plain = stripAnsi(result);
    expect(plain).toContain('A100 80GB');
    expect(plain).toContain('80 GB');
  });

  it('shows providers from agent status', () => {
    const status: RemoteAgentStatus = {
      providers: [
        { name: 'Claude Code', type: 'claude-sdk', version: '2.0.0', model: 'opus' },
        { name: 'Codex', type: 'codex', version: '0.5' },
      ],
    };
    const result = formatRemoteHostBox(makeHost(), 'running', undefined, status);
    const plain = stripAnsi(result);
    expect(plain).toContain('Claude Code');
    expect(plain).toContain('Codex');
    expect(plain).toContain('model: opus');
  });

  it('does not show error message for non-failed status', () => {
    const result = formatRemoteHostBox(makeHost(), 'running', 'some message');
    const plain = stripAnsi(result);
    expect(plain).not.toContain('Error:');
  });

  it('truncates long error messages', () => {
    const longError = 'A'.repeat(100);
    const result = formatRemoteHostBox(makeHost(), 'failed', longError);
    const plain = stripAnsi(result);
    // Message is sliced to 60 chars
    expect(plain).toContain('A'.repeat(60));
    expect(plain).not.toContain('A'.repeat(100));
  });
});

// ════════════════════════════════════════════════════════════════════
// formatInstallErrorBox
// ════════════════════════════════════════════════════════════════════

describe('formatInstallErrorBox', () => {
  it('returns empty string for no errors', () => {
    expect(formatInstallErrorBox([])).toBe('');
  });

  it('shows node_not_found error with manual install instructions', () => {
    const errors: InstallErrorInfo[] = [
      {
        host: 'hpc-node1',
        hostname: 'node1.cluster.edu',
        user: 'user1',
        error: 'Node.js not found',
        reason: 'node_not_found',
      },
    ];
    const result = formatInstallErrorBox(errors);
    const plain = stripAnsi(result);

    expect(plain).toContain('hpc-node1');
    expect(plain).toContain('Node.js not found');
    expect(plain).toContain('module system');
    expect(plain).toContain('Manual installation');
    expect(plain).toContain('ssh user1@node1.cluster.edu');
    expect(plain).toContain('module load nodejs');
  });

  it('shows node_too_old error', () => {
    const errors: InstallErrorInfo[] = [
      {
        host: 'old-server',
        hostname: 'old.host',
        error: 'Node.js v16.0.0 is too old',
        reason: 'node_too_old',
        nodeVersion: 'v16.0.0',
      },
    ];
    const result = formatInstallErrorBox(errors);
    const plain = stripAnsi(result);

    expect(plain).toContain('v16.0.0');
    expect(plain).toContain('too old');
    expect(plain).toContain('need >= 18');
  });

  it('shows ssh_failed error', () => {
    const errors: InstallErrorInfo[] = [
      {
        host: 'unreachable',
        hostname: 'down.host',
        error: 'Connection refused',
        reason: 'ssh_failed',
      },
    ];
    const result = formatInstallErrorBox(errors);
    const plain = stripAnsi(result);

    expect(plain).toContain('SSH connection failed');
    expect(plain).toContain('Check SSH keys');
  });

  it('shows permission_denied error', () => {
    const errors: InstallErrorInfo[] = [
      {
        host: 'locked-server',
        hostname: 'locked.host',
        error: 'Permission denied (publickey)',
        reason: 'permission_denied',
      },
    ];
    const result = formatInstallErrorBox(errors);
    const plain = stripAnsi(result);

    expect(plain).toContain('Permission denied');
    expect(plain).toContain('SSH key may not be authorized');
  });

  it('shows install_failed error', () => {
    const errors: InstallErrorInfo[] = [
      {
        host: 'broken-server',
        hostname: 'broken.host',
        error: 'npm ERR! ENOSPC: no space left on device',
        reason: 'install_failed',
      },
    ];
    const result = formatInstallErrorBox(errors);
    const plain = stripAnsi(result);

    expect(plain).toContain('Installation failed');
    expect(plain).toContain('ENOSPC');
  });

  it('handles multiple errors', () => {
    const errors: InstallErrorInfo[] = [
      { host: 'h1', hostname: 'h1.com', error: 'no node', reason: 'node_not_found' },
      { host: 'h2', hostname: 'h2.com', error: 'ssh fail', reason: 'ssh_failed' },
      { host: 'h3', hostname: 'h3.com', error: 'denied', reason: 'permission_denied' },
    ];
    const result = formatInstallErrorBox(errors);
    const plain = stripAnsi(result);

    expect(plain).toContain('h1');
    expect(plain).toContain('h2');
    expect(plain).toContain('h3');
  });

  it('includes manual install command with npx', () => {
    const errors: InstallErrorInfo[] = [
      { host: 'server', hostname: 'srv.com', user: 'deploy', error: 'failed', reason: 'install_failed' },
    ];
    const result = formatInstallErrorBox(errors);
    const plain = stripAnsi(result);

    expect(plain).toContain('npx @astroanywhere/agent@latest launch');
  });

  it('renders with box-drawing characters', () => {
    const errors: InstallErrorInfo[] = [
      { host: 'h1', hostname: 'h1.com', error: 'err', reason: 'ssh_failed' },
    ];
    const result = formatInstallErrorBox(errors);
    const plain = stripAnsi(result);

    expect(plain).toContain('╭');
    expect(plain).toContain('╰');
    expect(plain).toContain('│');
  });
});

// ════════════════════════════════════════════════════════════════════
// formatLaunchBanner
// ════════════════════════════════════════════════════════════════════

describe('formatLaunchBanner', () => {
  it('includes version', () => {
    const result = formatLaunchBanner('0.2.0');
    const plain = stripAnsi(result);
    expect(plain).toContain('v0.2.0');
    expect(plain).toContain('Astro Agent Runner');
  });
});

// ════════════════════════════════════════════════════════════════════
// formatSetupHint
// ════════════════════════════════════════════════════════════════════

describe('formatSetupHint', () => {
  it('shows reconfigure hint when hosts exist', () => {
    const result = formatSetupHint(3);
    const plain = stripAnsi(result);
    expect(plain).toContain('--force-setup');
    expect(plain).toContain('reconfigure');
  });

  it('shows configure hint when no hosts', () => {
    const result = formatSetupHint(0);
    const plain = stripAnsi(result);
    expect(plain).toContain('--force-setup');
    expect(plain).toContain('configure SSH');
  });
});

// ════════════════════════════════════════════════════════════════════
// formatNoProvidersWarning
// ════════════════════════════════════════════════════════════════════

describe('formatNoProvidersWarning', () => {
  it('lists all supported providers', () => {
    const result = formatNoProvidersWarning();
    const plain = stripAnsi(result);
    expect(plain).toContain('Claude');
    expect(plain).toContain('Codex');
    expect(plain).toContain('OpenClaw');
    expect(plain).toContain('OpenCode');
  });

  it('includes install commands', () => {
    const result = formatNoProvidersWarning();
    const plain = stripAnsi(result);
    expect(plain).toContain('npm i -g');
    expect(plain).toContain('bun i -g');
  });
});
