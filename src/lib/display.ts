/**
 * Terminal display utilities for structured, elegant output.
 *
 * Renders machine/provider information in bordered boxes with
 * consistent formatting for both local and remote hosts.
 */

import chalk from 'chalk';
import type { ProviderInfo, MachineResources, DiscoveredHost } from '../types.js';
import type { RemoteAgentStatus } from './ssh-installer.js';
import { formatBytes } from './resources.js';

// ── Box-drawing helpers ──────────────────────────────────────────────

const BOX = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│', sep: '├', sepR: '┤',
} as const;

function boxLine(content: string, width: number): string {
  // Strip ANSI codes to measure visible length
  const visible = content.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, width - visible.length);
  return `${BOX.v} ${content}${' '.repeat(pad)} ${BOX.v}`;
}

function boxTop(width: number): string {
  return `${BOX.tl}${BOX.h.repeat(width + 2)}${BOX.tr}`;
}

function boxBottom(width: number): string {
  return `${BOX.bl}${BOX.h.repeat(width + 2)}${BOX.br}`;
}

function boxSeparator(width: number): string {
  return `${BOX.sep}${BOX.h.repeat(width + 2)}${BOX.sepR}`;
}

/**
 * Render lines inside a box. Each line is left-aligned within the box.
 */
function renderBox(lines: string[], minWidth = 50): string {
  // Calculate width from longest visible line
  const maxVisible = lines.reduce((max, line) => {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
    return Math.max(max, visible.length);
  }, 0);
  const width = Math.max(minWidth, maxVisible);

  const output: string[] = [];
  output.push(boxTop(width));
  for (const line of lines) {
    output.push(boxLine(line, width));
  }
  output.push(boxBottom(width));
  return output.join('\n');
}

// ── Machine type classification ──────────────────────────────────────

function classifyMachine(resources: MachineResources): string {
  const hasNvidiaGpu = resources.gpu.some(g => g.vendor === 'NVIDIA');
  const hasAppleGpu = resources.gpu.some(g => g.vendor === 'Apple');
  const totalGpuMem = resources.gpu.reduce((sum, g) => sum + g.memoryTotal, 0);
  const totalRamGB = resources.memory.total / (1024 ** 3);

  if (hasNvidiaGpu && totalGpuMem > 16 * 1024 ** 3) return 'GPU Workstation';
  if (hasNvidiaGpu) return 'GPU Machine';
  if (hasAppleGpu && totalRamGB >= 32) return 'Apple Silicon Workstation';
  if (hasAppleGpu) return 'Apple Silicon';
  if (totalRamGB >= 64) return 'High-Memory Server';
  if (resources.cpu.cores >= 16) return 'Multi-Core Server';
  return 'Workstation';
}

// ── Format local machine box ─────────────────────────────────────────

export function formatLocalMachineBox(
  resources: MachineResources,
  providers: ProviderInfo[],
  version: string,
  runnerId: string,
): string {
  const machineType = classifyMachine(resources);
  const lines: string[] = [];

  // Title
  lines.push(chalk.bold.cyan(`  ${resources.hostname}`) + chalk.dim(` (this device)`));
  lines.push(chalk.dim(`  ${machineType} · ${resources.platform}/${resources.arch} · v${version}`));
  lines.push('');

  // Hardware
  lines.push(chalk.white('  Hardware'));
  lines.push(`    CPU   ${chalk.white(resources.cpu.model)} ${chalk.dim(`(${resources.cpu.cores} cores)`)}`);

  const totalRAM = formatBytes(resources.memory.total);
  const freeRAM = formatBytes(resources.memory.free);
  lines.push(`    RAM   ${chalk.white(totalRAM)} ${chalk.dim(`(${freeRAM} available)`)}`);

  if (resources.gpu.length > 0) {
    for (const gpu of resources.gpu) {
      const gpuMem = formatBytes(gpu.memoryTotal);
      const gpuLabel = 'GPU';
      lines.push(`    ${gpuLabel}   ${chalk.white(gpu.name)} ${chalk.dim(`(${gpuMem})`)}`);
    }
  }

  // Providers
  lines.push('');
  lines.push(chalk.white('  AI Providers'));
  if (providers.length === 0) {
    lines.push(chalk.yellow('    No providers detected'));
  } else {
    for (const p of providers) {
      const ver = p.version ? chalk.dim(` v${p.version}`) : '';
      const model = p.capabilities.defaultModel
        ? chalk.dim(` · model: ${p.capabilities.defaultModel}`)
        : '';
      const hpc = p.hpcCapability
        ? chalk.dim(` · HPC: ${p.hpcCapability.clusterName || 'Slurm'}`)
        : '';
      lines.push(`    ${chalk.green('✓')} ${chalk.white(p.name)}${ver}${model}${hpc}`);
    }
  }

  // Runner ID (compact)
  lines.push('');
  lines.push(chalk.dim(`  Runner: ${runnerId.slice(0, 8)}…`));

  return renderBox(lines);
}

// ── Format remote host box ───────────────────────────────────────────

export function formatRemoteHostBox(
  host: DiscoveredHost,
  status: 'running' | 'failed' | 'pending',
  message?: string,
  agentStatus?: RemoteAgentStatus,
): string {
  const lines: string[] = [];

  // Title
  const statusIcon = status === 'running' ? chalk.green('●')
    : status === 'failed' ? chalk.red('●')
    : chalk.yellow('●');
  const statusText = status === 'running' ? chalk.green('running')
    : status === 'failed' ? chalk.red('failed')
    : chalk.yellow('starting');

  lines.push(`  ${statusIcon} ${chalk.bold.cyan(host.name)} ${chalk.dim(`(${statusText})`)}`);

  // Connection info
  const userHost = host.user ? `${host.user}@${host.hostname}` : host.hostname;
  const port = host.port && host.port !== 22 ? `:${host.port}` : '';
  lines.push(chalk.dim(`  ${userHost}${port}`));

  // Hardware summary from agent status
  if (agentStatus) {
    const hwParts: string[] = [];
    if (agentStatus.platform) hwParts.push(`${agentStatus.platform}/${agentStatus.arch || 'unknown'}`);
    if (agentStatus.cpuCores) hwParts.push(`${agentStatus.cpuCores} cores`);
    if (agentStatus.memoryGB) hwParts.push(`${agentStatus.memoryGB} GB RAM`);
    if (hwParts.length > 0) {
      lines.push(chalk.dim(`  ${hwParts.join(' · ')}`));
    }

    // GPU
    if (agentStatus.gpu && agentStatus.gpu.length > 0) {
      for (const g of agentStatus.gpu) {
        lines.push(`    ${chalk.white(g.name)} ${chalk.dim(`(${g.memoryGB} GB)`)}`);
      }
    }

    // AI Providers
    if (agentStatus.providers && agentStatus.providers.length > 0) {
      lines.push('');
      lines.push(chalk.white('  AI Providers'));
      for (const p of agentStatus.providers) {
        const ver = p.version ? chalk.dim(` v${p.version}`) : '';
        const model = p.model ? chalk.dim(` · model: ${p.model}`) : '';
        lines.push(`    ${chalk.green('✓')} ${chalk.white(p.name)}${ver}${model}`);
      }
    }
  }

  if (message && status === 'failed') {
    lines.push(`  ${chalk.red('Error:')} ${chalk.dim(message.slice(0, 60))}`);
  }

  return renderBox(lines, 44);
}

// ── Summary banner ───────────────────────────────────────────────────

export function formatLaunchBanner(version: string): string {
  return [
    '',
    chalk.bold(`  Astro Agent Runner ${chalk.dim(`v${version}`)}`),
    '',
  ].join('\n');
}

export function formatSetupHint(hostCount: number): string {
  if (hostCount > 0) {
    return chalk.dim(
      `  Tip: Run with ${chalk.white('--force-setup')} to reconfigure SSH hosts or re-discover providers.`,
    );
  }
  return chalk.dim(
    `  Tip: Run with ${chalk.white('--force-setup')} to configure SSH remote hosts.`,
  );
}

/**
 * Format "no providers" warning with install hints.
 */
export function formatNoProvidersWarning(): string {
  return [
    chalk.yellow('  No AI providers detected.'),
    chalk.dim('  Install one of the following to get started:'),
    chalk.dim(`    • Claude (SDK)   ${chalk.white('npm i -g @anthropic-ai/claude-code')}`),
    chalk.dim(`    • OpenAI Codex   ${chalk.white('npm i -g @openai/codex')}`),
    chalk.dim(`    • OpenClaw       ${chalk.white('npm i -g openclaw')}`),
    chalk.dim(`    • OpenCode       ${chalk.white('bun i -g opencode')}`),
  ].join('\n');
}

// ── Installation error box ───────────────────────────────────────────

export interface InstallErrorInfo {
  host: string;
  hostname: string;
  user?: string;
  error: string;
  reason: 'node_not_found' | 'node_too_old' | 'ssh_failed' | 'install_failed' | 'permission_denied';
  nodeVersion?: string | null;
}

/**
 * Format an error box for hosts where installation failed.
 * Shows the error in red with suggestions for manual installation.
 */
export function formatInstallErrorBox(errors: InstallErrorInfo[]): string {
  if (errors.length === 0) return '';

  const lines: string[] = [];

  lines.push(chalk.red.bold('  Installation Errors'));
  lines.push('');
  lines.push(chalk.dim('  The following hosts could not be set up via SSH.'));
  lines.push(chalk.dim('  Please log in directly and install Astro Agent manually.'));
  lines.push('');

  for (const err of errors) {
    const userHost = err.user ? `${err.user}@${err.hostname}` : err.hostname;
    lines.push(`  ${chalk.red('✗')} ${chalk.bold(err.host)} ${chalk.dim(`(${userHost})`)}`);

    // Show specific error reason
    switch (err.reason) {
      case 'node_not_found':
        lines.push(chalk.red('    Node.js not found'));
        lines.push(chalk.dim('    This host may use a module system (Lmod, Environment Modules)'));
        lines.push(chalk.dim('    that requires interactive login to load Node.js.'));
        break;
      case 'node_too_old':
        lines.push(chalk.red(`    Node.js ${err.nodeVersion || 'version'} is too old (need >= 18)`));
        lines.push(chalk.dim('    Upgrade Node.js or load a newer module version.'));
        break;
      case 'ssh_failed':
        lines.push(chalk.red('    SSH connection failed'));
        lines.push(chalk.dim('    Check SSH keys, permissions, or network connectivity.'));
        break;
      case 'permission_denied':
        lines.push(chalk.red('    Permission denied'));
        lines.push(chalk.dim('    SSH key may not be authorized on this host.'));
        break;
      case 'install_failed':
        lines.push(chalk.red(`    Installation failed: ${err.error.slice(0, 60)}`));
        break;
    }

    // Show manual installation instructions
    lines.push('');
    lines.push(chalk.cyan('    Manual installation:'));
    lines.push(chalk.dim(`      1. ssh ${userHost}`));
    if (err.reason === 'node_not_found' || err.reason === 'node_too_old') {
      lines.push(chalk.dim('      2. module load nodejs  # or: nvm use 20'));
    }
    lines.push(chalk.dim('      3. npx @astroanywhere/agent@latest launch'));
    lines.push('');
  }

  // Render in a red-tinted box
  const boxLines: string[] = [];
  const maxVisible = lines.reduce((max, line) => {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
    return Math.max(max, visible.length);
  }, 0);
  const width = Math.max(60, maxVisible);

  // Red box borders
  const B = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
  boxLines.push(chalk.red(`${B.tl}${B.h.repeat(width + 2)}${B.tr}`));
  for (const line of lines) {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = Math.max(0, width - visible.length);
    boxLines.push(chalk.red(B.v) + ` ${line}${' '.repeat(pad)} ` + chalk.red(B.v));
  }
  boxLines.push(chalk.red(`${B.bl}${B.h.repeat(width + 2)}${B.br}`));

  return boxLines.join('\n');
}

// ── Box separator for visual grouping ────────────────────────────────

export { boxSeparator, renderBox };
