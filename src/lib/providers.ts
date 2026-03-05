/**
 * Agent provider detection and management
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';
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
 * Read the configured model from ~/.codex/config.toml
 * Parses basic TOML to extract the model field.
 */
async function readCodexConfigModel(): Promise<string | null> {
  try {
    const configPath = join(homedir(), '.codex', 'config.toml');
    const content = await readFile(configPath, 'utf-8');

    // Parse active profile name (top-level `profile = "name"`)
    let activeProfile: string | null = null;
    const profileMatch = content.match(/^profile\s*=\s*"([^"]+)"/m);
    if (profileMatch) {
      activeProfile = profileMatch[1];
    }

    // If a profile is set, look for [profiles.<name>] section's model
    if (activeProfile) {
      const profileSection = new RegExp(
        `\\[profiles\\.${activeProfile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]([\\s\\S]*?)(?=\\n\\[|$)`
      );
      const sectionMatch = content.match(profileSection);
      if (sectionMatch) {
        const modelInProfile = sectionMatch[1].match(/^model\s*=\s*"([^"]+)"/m);
        if (modelInProfile) {
          return modelInProfile[1];
        }
      }
    }

    // Fall back to top-level model
    const topLevelModel = content.match(/^model\s*=\s*"([^"]+)"/m);
    if (topLevelModel) {
      return topLevelModel[1];
    }

    return null;
  } catch {
    return null;
  }
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
    const configModel = await readCodexConfigModel();

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
        ...(configModel ? { defaultModel: configModel, availableModels: [configModel] } : {}),
      },
    };
  }

  // If not in PATH, check common installation locations
  const commonPaths = getCodexPaths();

  for (const codexPath of commonPaths) {
    const isExecutable = await fileExecutable(codexPath);
    if (isExecutable) {
      const version = await getCommandVersion(codexPath, '--version');
      const configModel = await readCodexConfigModel();

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
          ...(configModel ? { defaultModel: configModel, availableModels: [configModel] } : {}),
        },
      };
    }
  }

  return null;
}

/**
 * Quick probe: connect to a WebSocket URL and check for connect.challenge.
 * Does NOT perform a full handshake — just confirms the gateway is reachable.
 */
function probeGatewayReachable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { ws.close(); resolve(false) }, 5000);
    const ws = new WebSocket(url);
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(String(data));
        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        }
      } catch { /* ignore */ }
    });
    ws.on('error', () => { clearTimeout(timeout); resolve(false) });
  });
}

/**
 * Detect OpenClaw gateway availability.
 *
 * Reads ~/.openclaw/openclaw.json for gateway port + auth token,
 * then probes ws://127.0.0.1:{port} for a connect.challenge event.
 * The adapter itself handles the full handshake at execution time.
 */
async function detectOpenClaw(): Promise<ProviderInfo | null> {
  try {
    const configPath = join(homedir(), '.openclaw', 'openclaw.json');
    const raw = JSON.parse(await readFile(configPath, 'utf-8'));
    const port = raw?.gateway?.port as number | undefined;
    if (!port) return null;

    const bind = (raw?.gateway?.bind as string) || '127.0.0.1';
    const host = bind === 'loopback' || bind === '127.0.0.1' ? '127.0.0.1' : bind;
    const url = `ws://${host}:${port}`;

    // Quick probe — just check for connect.challenge (no full handshake)
    const reachable = await probeGatewayReachable(url);
    if (!reachable) return null;

    return {
      type: 'openclaw' as ProviderType,
      name: 'OpenClaw',
      version: null,
      path: url,
      available: true,
      capabilities: {
        streaming: true,
        tools: true,
        multiTurn: true,
        maxConcurrentTasks: 10,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Common installation paths for OpenCode
 */
function getOpenCodePaths(): string[] {
  const home = homedir();
  const platform = process.platform;

  const paths: string[] = [];

  // bun global installs (OpenCode uses bun)
  paths.push(join(home, '.bun', 'bin', 'opencode'));

  // npm/pnpm global installs
  paths.push(join(home, '.npm', 'bin', 'opencode'));
  paths.push(join(home, '.npm-global', 'bin', 'opencode'));
  paths.push(join(home, '.local', 'bin', 'opencode'));
  paths.push(join(home, '.yarn', 'bin', 'opencode'));
  paths.push(join(home, '.pnpm-global', 'bin', 'opencode'));

  if (platform === 'darwin') {
    paths.push('/usr/local/bin/opencode');
    paths.push('/opt/homebrew/bin/opencode');
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    paths.push(join(appData, 'npm', 'opencode.cmd'));
    paths.push(join(appData, 'npm', 'opencode'));
  } else {
    paths.push('/usr/local/bin/opencode');
    paths.push('/usr/bin/opencode');
  }

  return paths;
}

/**
 * Detect OpenCode CLI installation
 */
async function detectOpenCode(): Promise<ProviderInfo | null> {
  const exists = await commandExists('opencode');
  if (exists) {
    const path = await getCommandPath('opencode');
    const version = await getCommandVersion('opencode', '--version');

    return {
      type: 'opencode' as ProviderType,
      name: 'OpenCode',
      version,
      path: path ?? 'opencode',
      available: true,
      capabilities: {
        streaming: true,
        tools: true,
        multiTurn: true,
        maxConcurrentTasks: 1,
      },
    };
  }

  const commonPaths = getOpenCodePaths();
  for (const codePath of commonPaths) {
    const isExecutable = await fileExecutable(codePath);
    if (isExecutable) {
      const version = await getCommandVersion(codePath, '--version');
      return {
        type: 'opencode' as ProviderType,
        name: 'OpenCode',
        version,
        path: codePath,
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
    detectOpenClaw(),
    detectOpenCode(),
    detectHpcCapability(),
    detectCustomProviders(),
  ]);

  const providers: ProviderInfo[] = [];

  const [claudeSdk, claudeCode, codex, openclaw, opencode, hpcCapability, customProviders] = detectionResults;

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

  if (openclaw) {
    providers.push(openclaw);
  }

  if (opencode) {
    providers.push(opencode);
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
