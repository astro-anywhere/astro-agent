/**
 * SSH config discovery for remote host detection
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SSHHost, DiscoveredHost } from '../types.js';

/** Hostnames that are git forges / not compute machines — auto-skipped */
const GIT_FORGE_HOSTS = new Set([
  'github.com', 'gitlab.com', 'bitbucket.org',
  'ssh.github.com', 'altssh.gitlab.com',
  'ssh.dev.azure.com', 'vs-ssh.visualstudio.com',
]);

/**
 * Parse SSH config file and extract host configurations
 */
async function parseSSHConfig(): Promise<SSHHost[]> {
  const sshConfigPath = join(homedir(), '.ssh', 'config');

  console.log(`[ssh-discovery] Parsing SSH config from: ${sshConfigPath}`);

  try {
    const content = await readFile(sshConfigPath, 'utf-8');
    const hosts: SSHHost[] = [];
    let currentHost: SSHHost | null = null;
    let skippedCount = 0;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Parse key-value pair
      const match = trimmed.match(/^(\S+)\s+(.+)$/);
      if (!match) continue;

      const [, key, value] = match;
      const keyLower = key?.toLowerCase();

      if (keyLower === 'host') {
        // Save previous host if valid
        if (currentHost) {
          const hn = currentHost.hostname.toLowerCase();
          if (hn === 'localhost' || hn === '127.0.0.1' || GIT_FORGE_HOSTS.has(hn)) {
            console.log(`[ssh-discovery] ⊗ Skipped non-compute host: ${currentHost.name} (${currentHost.hostname})`);
            skippedCount++;
          } else {
            hosts.push(currentHost);
            console.log(`[ssh-discovery] ✓ Added host: ${currentHost.name} (${currentHost.hostname})`);
          }
        }

        const hostPattern = value?.trim() ?? '';

        // Skip wildcard patterns and local-only patterns
        if (
          hostPattern.includes('*') ||
          hostPattern === 'localhost' ||
          hostPattern === '127.0.0.1'
        ) {
          console.log(`[ssh-discovery] ⊗ Skipped pattern/localhost: ${hostPattern}`);
          skippedCount++;
          currentHost = null;
          continue;
        }

        currentHost = {
          name: hostPattern,
          hostname: hostPattern, // Default to the host alias
        };
      } else if (currentHost && value) {
        switch (keyLower) {
          case 'hostname': {
            // Strip inline comments (e.g., "1.2.3.4  # my server" → "1.2.3.4")
            currentHost.hostname = value.trim().replace(/\s+#.*$/, '');
            break;
          }
          case 'user':
            currentHost.user = value.trim();
            break;
          case 'port':
            currentHost.port = parseInt(value.trim(), 10);
            break;
          case 'identityfile':
            currentHost.identityFile = value.trim().replace('~', homedir());
            break;
          case 'proxyjump':
            currentHost.proxyJump = value.trim();
            break;
        }
      }
    }

    // Don't forget the last host (same validation)
    if (currentHost) {
      const hn = currentHost.hostname.toLowerCase();
      if (hn === 'localhost' || hn === '127.0.0.1' || GIT_FORGE_HOSTS.has(hn)) {
        console.log(`[ssh-discovery] ⊗ Skipped non-compute host: ${currentHost.name} (${currentHost.hostname})`);
        skippedCount++;
      } else {
        hosts.push(currentHost);
        console.log(`[ssh-discovery] ✓ Added host: ${currentHost.name} (${currentHost.hostname})`);
      }
    }

    console.log(`[ssh-discovery] Parsed ${hosts.length} valid hosts (skipped ${skippedCount} wildcards/localhost)`);
    return hosts;
  } catch (error) {
    // SSH config doesn't exist or can't be read
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`[ssh-discovery] No SSH config file found at ${sshConfigPath}`);
      return [];
    }
    console.error(`[ssh-discovery] Error reading SSH config:`, error);
    throw error;
  }
}

/**
 * Discover VS Code Remote SSH tunnel configurations
 */
async function discoverVSCodeTunnels(): Promise<SSHHost[]> {
  const hosts: SSHHost[] = [];

  // VS Code stores remote configurations in different locations based on platform
  const vscodeConfigPaths = [
    join(homedir(), '.vscode-server', 'data', 'Machine', 'settings.json'),
    join(homedir(), '.vscode', 'globalStorage', 'ms-vscode-remote.remote-ssh', 'hosts.json'),
    join(
      homedir(),
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'ms-vscode-remote.remote-ssh',
      'hosts.json'
    ),
    join(
      homedir(),
      '.config',
      'Code',
      'User',
      'globalStorage',
      'ms-vscode-remote.remote-ssh',
      'hosts.json'
    ),
  ];

  for (const configPath of vscodeConfigPaths) {
    try {
      const content = await readFile(configPath, 'utf-8');
      const config = JSON.parse(content) as VSCodeConfig;

      // Handle different VS Code config formats
      if (Array.isArray(config)) {
        for (const entry of config) {
          if (entry.host && entry.hostName) {
            hosts.push({
              name: entry.host,
              hostname: entry.hostName,
              user: entry.user,
              port: entry.port,
              identityFile: entry.identityFile,
            });
          }
        }
      } else if (config.remote?.SSH?.remotePlatform) {
        // Newer VS Code format
        for (const hostName of Object.keys(config.remote.SSH.remotePlatform)) {
          if (!hosts.some((h) => h.name === hostName)) {
            hosts.push({
              name: hostName,
              hostname: hostName,
            });
          }
        }
      }
    } catch {
      // Config doesn't exist or is invalid, continue to next path
      continue;
    }
  }

  return hosts;
}

type VSCodeConfig =
  | Array<{ host?: string; hostName?: string; user?: string; port?: number; identityFile?: string }>
  | { remote?: { SSH?: { remotePlatform?: Record<string, string> } } };

/**
 * Parse known_hosts file to find additional hosts
 */
async function parseKnownHosts(): Promise<string[]> {
  const knownHostsPath = join(homedir(), '.ssh', 'known_hosts');

  try {
    const content = await readFile(knownHostsPath, 'utf-8');
    const hostnames = new Set<string>();

    for (const line of content.split('\n')) {
      if (!line.trim() || line.startsWith('#')) {
        continue;
      }

      // Known hosts format: hostname[,hostname,...] keytype key [comment]
      const hostPart = line.split(' ')[0];
      if (!hostPart) {
        continue;
      }

      // Split by comma for multiple hostnames on same line
      for (let hostname of hostPart.split(',')) {
        // Remove port if present (e.g., [hostname]:port)
        hostname = hostname.replace(/^\[(.+)\]:\d+$/, '$1');

        // Skip IP addresses and localhost
        if (
          hostname.match(/^\d+\.\d+\.\d+\.\d+$/) ||
          hostname === 'localhost' ||
          hostname === '127.0.0.1'
        ) {
          continue;
        }

        // Skip hashed hostnames (start with |)
        if (hostname.startsWith('|')) {
          continue;
        }

        // Skip git forges
        if (GIT_FORGE_HOSTS.has(hostname.toLowerCase())) {
          continue;
        }

        hostnames.add(hostname);
      }
    }

    return Array.from(hostnames);
  } catch {
    return [];
  }
}

/**
 * Discover all remote hosts from various sources
 */
export async function discoverRemoteHosts(): Promise<DiscoveredHost[]> {
  console.log('[ssh-discovery] Starting remote host discovery...');

  const discovered: DiscoveredHost[] = [];
  const seenNames = new Set<string>();
  const seenHostnames = new Set<string>(); // resolved hostnames/IPs for cross-source dedup

  // Parse SSH config (highest priority)
  console.log('[ssh-discovery] 1/3 Checking SSH config (~/.ssh/config)...');
  const sshHosts = await parseSSHConfig();
  for (const host of sshHosts) {
    const resolvedLower = host.hostname.toLowerCase();
    if (seenHostnames.has(resolvedLower)) {
      console.log(`[ssh-discovery] ⊗ Skipped duplicate hostname: ${host.name} → ${host.hostname} (already discovered)`);
      continue;
    }
    seenNames.add(host.name);
    seenHostnames.add(resolvedLower);
    discovered.push({
      ...host,
      source: 'ssh-config',
    });
  }
  console.log(`[ssh-discovery] Found ${discovered.length} hosts from SSH config`);

  // Discover VS Code tunnels
  console.log('[ssh-discovery] 2/3 Checking VS Code Remote SSH...');
  const vscodeTunnels = await discoverVSCodeTunnels();
  let vscodeAdded = 0;
  for (const host of vscodeTunnels) {
    const resolvedLower = host.hostname.toLowerCase();
    if (!seenNames.has(host.name) && !seenHostnames.has(resolvedLower)) {
      seenNames.add(host.name);
      seenHostnames.add(resolvedLower);
      discovered.push({
        ...host,
        source: 'vscode-tunnel',
      });
      vscodeAdded++;
    }
  }
  console.log(`[ssh-discovery] Found ${vscodeAdded} unique VS Code hosts`);

  // Parse known_hosts (lowest priority - just suggests hostnames)
  console.log('[ssh-discovery] 3/3 Checking known_hosts...');
  const knownHostnames = await parseKnownHosts();
  let knownHostsAdded = 0;
  for (const hostname of knownHostnames) {
    const hostnameLower = hostname.toLowerCase();
    if (!seenNames.has(hostname) && !seenHostnames.has(hostnameLower)) {
      seenNames.add(hostname);
      seenHostnames.add(hostnameLower);
      discovered.push({
        name: hostname,
        hostname,
        source: 'known-hosts',
      });
      knownHostsAdded++;
    }
  }
  console.log(`[ssh-discovery] Found ${knownHostsAdded} unique hosts from known_hosts`);

  console.log(`[ssh-discovery] Discovery complete: ${discovered.length} total unique hosts`);
  return discovered;
}

/**
 * Format discovered hosts for display
 */
export function formatDiscoveredHosts(hosts: DiscoveredHost[]): string {
  if (hosts.length === 0) {
    return 'No remote hosts discovered.';
  }

  const lines = ['Discovered Remote Hosts:', ''];

  // Group by source
  const bySource = new Map<string, DiscoveredHost[]>();
  for (const host of hosts) {
    const existing = bySource.get(host.source) ?? [];
    existing.push(host);
    bySource.set(host.source, existing);
  }

  const sourceLabels: Record<string, string> = {
    'ssh-config': 'From SSH config (~/.ssh/config):',
    'vscode-tunnel': 'From VS Code Remote SSH:',
    'known-hosts': 'From known hosts:',
  };

  for (const [source, sourceHosts] of bySource) {
    lines.push(`  ${sourceLabels[source] ?? source}`);
    for (const host of sourceHosts) {
      const details: string[] = [];
      if (host.user) details.push(`user: ${host.user}`);
      if (host.port && host.port !== 22) details.push(`port: ${host.port}`);
      if (host.proxyJump) details.push(`via: ${host.proxyJump}`);

      const detailStr = details.length > 0 ? ` (${details.join(', ')})` : '';
      const targetStr = host.hostname !== host.name ? ` → ${host.hostname}` : '';

      lines.push(`    • ${host.name}${targetStr}${detailStr}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build SSH command for connecting to a host
 */
export function buildSSHCommand(host: DiscoveredHost, command?: string): string {
  const parts = ['ssh'];

  if (host.port && host.port !== 22) {
    parts.push('-p', String(host.port));
  }

  if (host.identityFile) {
    parts.push('-i', host.identityFile);
  }

  if (host.proxyJump) {
    parts.push('-J', host.proxyJump);
  }

  const target = host.user ? `${host.user}@${host.hostname}` : host.hostname;
  parts.push(target);

  if (command) {
    parts.push(command);
  }

  return parts.join(' ');
}
