/**
 * Agent provider detection and management
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProviderInfo, ProviderType, ProviderCapabilities, HpcCapability } from '../types.js';
import { detectSlurm } from './slurm-detect.js';

const execAsync = promisify(exec);

/**
 * Check if a command exists in PATH
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    const platform = process.platform;
    const checkCommand = platform === 'win32' ? `where ${command}` : `which ${command}`;
    await execAsync(checkCommand, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a file exists and is executable
 */
async function fileExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the version of a command
 */
async function getCommandVersion(command: string, versionArg = '--version'): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`${command} ${versionArg}`, { timeout: 5000 });
    // Extract version number from output
    const versionMatch = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
    return versionMatch?.[1] ?? stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the path of a command
 */
async function getCommandPath(command: string): Promise<string | null> {
  try {
    const platform = process.platform;
    const whichCommand = platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execAsync(`${whichCommand} ${command}`, { timeout: 5000 });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Common installation paths for Claude Code
 * These are checked if 'which claude' fails (e.g., ~/.local/bin not in PATH)
 */
function getClaudeCodePaths(): string[] {
  const home = homedir();
  const platform = process.platform;

  const paths: string[] = [];

  // Standard installation path for Claude Code
  paths.push(join(home, '.local', 'bin', 'claude'));

  // npm global installs
  paths.push(join(home, '.npm', 'bin', 'claude'));
  paths.push(join(home, '.npm-global', 'bin', 'claude'));

  // Platform-specific paths
  if (platform === 'darwin') {
    // macOS: Homebrew and user local
    paths.push('/usr/local/bin/claude');
    paths.push('/opt/homebrew/bin/claude');
    paths.push(join(home, 'Library', 'Application Support', 'claude', 'bin', 'claude'));
  } else if (platform === 'win32') {
    // Windows: AppData locations
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    paths.push(join(appData, 'claude', 'bin', 'claude.exe'));
    paths.push(join(localAppData, 'claude', 'bin', 'claude.exe'));
    paths.push(join(appData, 'npm', 'claude.cmd'));
  } else {
    // Linux: Standard locations
    paths.push('/usr/local/bin/claude');
    paths.push('/usr/bin/claude');
    paths.push(join(home, '.local', 'share', 'claude', 'bin', 'claude'));
  }

  return paths;
}

/**
 * Detect Claude Code installation
 */
async function detectClaudeCode(): Promise<ProviderInfo | null> {
  // First, check if 'claude' is in PATH
  const existsInPath = await commandExists('claude');
  if (existsInPath) {
    const path = await getCommandPath('claude');
    const version = await getCommandVersion('claude', '--version');

    return {
      type: 'claude-code',
      name: 'Claude Code',
      version,
      path: path ?? 'claude',
      available: true,
      capabilities: {
        streaming: true,
        tools: true,
        multiTurn: true,
        maxConcurrentTasks: 1, // Claude Code runs one task at a time per instance
      },
    };
  }

  // If not in PATH, check common installation locations
  const commonPaths = getClaudeCodePaths();

  for (const claudePath of commonPaths) {
    const isExecutable = await fileExecutable(claudePath);
    if (isExecutable) {
      // Found Claude Code at this path, get version
      const version = await getCommandVersion(claudePath, '--version');

      return {
        type: 'claude-code',
        name: 'Claude Code',
        version,
        path: claudePath,
        available: true,
        capabilities: {
          streaming: true,
          tools: true,
          multiTurn: true,
          maxConcurrentTasks: 1,
        },
      };
    }
  }

  return null;
}

/**
 * Common installation paths for Codex CLI
 */
function getCodexPaths(): string[] {
  const home = homedir();
  const platform = process.platform;

  const paths: string[] = [];

  // npm global installs (most common for Codex)
  paths.push(join(home, '.npm', 'bin', 'codex'));
  paths.push(join(home, '.npm-global', 'bin', 'codex'));
  paths.push(join(home, '.local', 'bin', 'codex'));

  // npx / pnpm / yarn global locations
  paths.push(join(home, '.yarn', 'bin', 'codex'));
  paths.push(join(home, '.pnpm-global', 'bin', 'codex'));

  if (platform === 'darwin') {
    paths.push('/usr/local/bin/codex');
    paths.push('/opt/homebrew/bin/codex');
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    paths.push(join(appData, 'npm', 'codex.cmd'));
    paths.push(join(appData, 'npm', 'codex'));
  } else {
    paths.push('/usr/local/bin/codex');
    paths.push('/usr/bin/codex');
  }

  return paths;
}

/**
 * Detect OpenAI Codex CLI installation
 */
async function detectCodex(): Promise<ProviderInfo | null> {
  // First, check if 'codex' is in PATH
  const exists = await commandExists('codex');
  if (exists) {
    const path = await getCommandPath('codex');
    const version = await getCommandVersion('codex', '--version');

    return {
      type: 'codex',
      name: 'OpenAI Codex',
      version,
      path: path ?? 'codex',
      available: true,
      capabilities: {
        streaming: true,
        tools: true,
        multiTurn: true,
        maxConcurrentTasks: 1,
      },
    };
  }

  // If not in PATH, check common installation locations
  const commonPaths = getCodexPaths();

  for (const codexPath of commonPaths) {
    const isExecutable = await fileExecutable(codexPath);
    if (isExecutable) {
      const version = await getCommandVersion(codexPath, '--version');

      return {
        type: 'codex',
        name: 'OpenAI Codex',
        version,
        path: codexPath,
        available: true,
        capabilities: {
          streaming: true,
          tools: true,
          multiTurn: true,
          maxConcurrentTasks: 1,
        },
      };
    }
  }

  return null;
}

/**
 * Check for custom provider configuration
 */
async function detectCustomProviders(): Promise<ProviderInfo[]> {
  const configPath = join(homedir(), '.astro', 'providers.json');

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content) as CustomProviderConfig[];
    const providers: ProviderInfo[] = [];

    for (const provider of config) {
      const executable = await fileExecutable(provider.path);

      providers.push({
        type: 'custom',
        name: provider.name,
        version: provider.version ?? null,
        path: provider.path,
        available: executable,
        capabilities: provider.capabilities ?? {
          streaming: false,
          tools: false,
          multiTurn: false,
          maxConcurrentTasks: 1,
        },
      });
    }

    return providers;
  } catch {
    // No custom provider config or invalid config
    return [];
  }
}

interface CustomProviderConfig {
  name: string;
  path: string;
  version?: string;
  capabilities?: ProviderCapabilities;
}

/**
 * Detect HPC capability (Slurm on this machine).
 * Returns metadata to annotate Claude provider rather than registering
 * Slurm as a standalone provider.
 */
async function detectHpcCapability(): Promise<HpcCapability | null> {
  try {
    const info = await detectSlurm();
    if (!info.available) return null;

    return {
      clusterName: info.clusterName,
      partitions: info.partitions,
      defaultPartition: info.defaultPartition,
      accounts: info.accounts,
    };
  } catch {
    return null;
  }
}

/**
 * Detect Claude Agent SDK availability (in-process, uses OAuth from claude CLI login)
 */
async function detectClaudeSdk(): Promise<ProviderInfo | null> {
  try {
    // Try dynamic import to check if SDK is available
    await import('@anthropic-ai/claude-agent-sdk');
    return {
      type: 'claude-sdk' as ProviderType,
      name: 'Claude Agent SDK',
      version: null,
      path: '@anthropic-ai/claude-agent-sdk',
      available: true,
      capabilities: {
        streaming: true,
        tools: true,
        multiTurn: true,
        maxConcurrentTasks: 4,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Detect all available providers on the system.
 * Slurm is no longer a standalone provider — when detected, it annotates
 * the Claude provider with hpcCapability metadata instead.
 */
export async function detectProviders(): Promise<ProviderInfo[]> {
  const detectionResults = await Promise.all([
    detectClaudeSdk(),
    detectClaudeCode(),
    detectCodex(),
    detectHpcCapability(),
    detectCustomProviders(),
  ]);

  const providers: ProviderInfo[] = [];

  const [claudeSdk, claudeCode, codex, hpcCapability, customProviders] = detectionResults;

  // Add Claude provider (SDK preferred over CLI — runs in-process with lower overhead)
  if (claudeSdk) {
    if (hpcCapability) {
      claudeSdk.hpcCapability = hpcCapability;
    }
    providers.push(claudeSdk);
  } else if (claudeCode) {
    if (hpcCapability) {
      claudeCode.hpcCapability = hpcCapability;
    }
    providers.push(claudeCode);
  }

  if (codex) {
    providers.push(codex);
  }

  // Add custom providers
  providers.push(...customProviders);

  return providers;
}

/**
 * Get a specific provider by type
 */
export async function getProvider(type: ProviderType): Promise<ProviderInfo | null> {
  const providers = await detectProviders();
  return providers.find((p) => p.type === type) ?? null;
}

/**
 * Check if a specific provider is available
 */
export async function isProviderAvailable(type: ProviderType): Promise<boolean> {
  const provider = await getProvider(type);
  return provider?.available ?? false;
}

/**
 * Format provider info for display
 */
export function formatProviderInfo(provider: ProviderInfo): string {
  const status = provider.available ? '✓' : '✗';
  const version = provider.version ? `v${provider.version}` : 'unknown version';
  return `${status} ${provider.name} (${version}) - ${provider.path}`;
}

/**
 * Format all providers summary
 */
export function formatProvidersSummary(providers: ProviderInfo[]): string {
  if (providers.length === 0) {
    return 'No agent providers detected. Install Claude Code or Codex to get started.';
  }

  const lines = ['Detected Agent Providers:', ''];

  for (const provider of providers) {
    lines.push(`  ${formatProviderInfo(provider)}`);
    lines.push(`    Capabilities: streaming=${provider.capabilities.streaming}, tools=${provider.capabilities.tools}, maxTasks=${provider.capabilities.maxConcurrentTasks}`);
  }

  return lines.join('\n');
}
