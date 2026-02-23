/**
 * Hardware-based machine identification
 * Provides network-agnostic identifiers that remain stable across WiFi changes
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces, userInfo, type NetworkInterfaceInfo } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const execFile = promisify(execFileCb);

/**
 * Get a stable, per-user, hardware-based machine identifier.
 *
 * The ID incorporates both the hardware identity and the OS username so that
 * different users on the same physical machine (e.g., a shared Slurm login node)
 * get distinct, non-colliding IDs.
 *
 * Priority for the hardware component:
 * 1. Hardware UUID (most stable, survives OS reinstalls on same hardware)
 * 2. Primary network interface MAC address
 * 3. Random UUID (fallback, stored persistently by caller)
 */
export async function getHardwareId(): Promise<{ id: string; source: 'uuid' | 'mac' | 'random' }> {
  const username = getOsUsername();

  // Try hardware UUID first (best option)
  const hwUuid = await getHardwareUUID();
  if (hwUuid) {
    const id = deriveUserMachineId(hwUuid, username);
    return { id, source: 'uuid' };
  }

  // Fall back to primary MAC address
  const mac = getPrimaryMacAddress();
  if (mac) {
    const id = deriveUserMachineId(`mac-${mac}`, username);
    return { id, source: 'mac' };
  }

  // Last resort: generate random UUID (caller should persist this)
  return { id: `rand-${randomUUID()}`, source: 'random' };
}

/**
 * Derive a stable UUID v5-style ID from hardware identity + OS username.
 * Uses SHA-256 truncated to UUID format so different users on the same
 * physical machine produce different, deterministic IDs.
 */
function deriveUserMachineId(hardwareId: string, username: string): string {
  const hash = createHash('sha256')
    .update(`${hardwareId}:${username}`)
    .digest('hex');
  // Format as UUID: 8-4-4-4-12
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

/**
 * Get the current OS username, with fallback.
 */
function getOsUsername(): string {
  try {
    return userInfo().username;
  } catch {
    // userInfo() can throw on some platforms (e.g., Android)
    return process.env.USER || process.env.USERNAME || 'unknown';
  }
}

/**
 * Get hardware UUID from the system
 * - macOS: IOPlatformUUID from system_profiler
 * - Linux: /sys/class/dmi/id/product_uuid or dmidecode
 * - Windows: WMIC output
 */
async function getHardwareUUID(): Promise<string | null> {
  try {
    switch (process.platform) {
      case 'darwin': {
        // macOS: Use IOPlatformUUID
        const { stdout } = await execFile('system_profiler', [
          'SPHardwareDataType',
          '-json',
        ], { timeout: 5000 });
        const data = JSON.parse(stdout);
        const uuid = data?.SPHardwareDataType?.[0]?.platform_UUID;
        if (uuid && typeof uuid === 'string' && uuid.length > 10) {
          return uuid.toLowerCase();
        }
        break;
      }

      case 'linux': {
        // Try reading from sysfs first (no sudo required)
        try {
          const { readFile } = await import('node:fs/promises');
          const uuid = await readFile('/sys/class/dmi/id/product_uuid', 'utf-8');
          const cleaned = uuid.trim().toLowerCase();
          if (cleaned && cleaned !== '00000000-0000-0000-0000-000000000000') {
            return cleaned;
          }
        } catch {
          // sysfs not available, try dmidecode (requires sudo)
          try {
            const { stdout } = await execFile('dmidecode', ['-s', 'system-uuid'], { timeout: 5000 });
            const cleaned = stdout.trim().toLowerCase();
            if (cleaned && cleaned !== '00000000-0000-0000-0000-000000000000') {
              return cleaned;
            }
          } catch {
            // dmidecode not available or no permissions
          }
        }
        break;
      }

      case 'win32': {
        // Windows: Use WMIC
        const { stdout } = await execFile('wmic', ['csproduct', 'get', 'UUID'], { timeout: 5000 });
        const lines = stdout.trim().split('\n');
        if (lines.length > 1) {
          const uuid = lines[1].trim().toLowerCase();
          if (uuid && uuid !== '00000000-0000-0000-0000-000000000000') {
            return uuid;
          }
        }
        break;
      }
    }
  } catch {
    // Silently fail - will fall back to MAC address or random UUID
  }

  return null;
}

/**
 * Get MAC address of the primary network interface
 * Excludes loopback, internal, and virtual interfaces
 */
function getPrimaryMacAddress(): string | null {
  const interfaces = networkInterfaces();

  // Priority order: en0 (macOS), eth0 (Linux), Ethernet (Windows), then any other
  const priorityInterfaces = ['en0', 'eth0', 'Ethernet'];

  // Try priority interfaces first
  for (const ifName of priorityInterfaces) {
    const iface = interfaces[ifName];
    if (iface) {
      const mac = extractMacFromInterface(iface);
      if (mac) return mac;
    }
  }

  // Fall back to any valid interface
  for (const [name, iface] of Object.entries(interfaces)) {
    if (iface && !name.startsWith('lo') && !name.startsWith('docker') && !name.startsWith('veth')) {
      const mac = extractMacFromInterface(iface);
      if (mac) return mac;
    }
  }

  return null;
}

/**
 * Extract MAC address from network interface info
 */
function extractMacFromInterface(iface: NetworkInterfaceInfo[]): string | null {
  for (const addr of iface) {
    // Skip internal/loopback addresses
    if (addr.internal) continue;

    // MAC address should be non-zero
    if (addr.mac && addr.mac !== '00:00:00:00:00:00') {
      return addr.mac.replace(/:/g, '').toLowerCase();
    }
  }
  return null;
}

/**
 * Generate a human-friendly machine name based on hardware ID
 */
export function generateMachineName(hardwareId: string, source: 'uuid' | 'mac' | 'random'): string {
  // Use last 8 chars of hardware ID for uniqueness
  const suffix = hardwareId.replace(/[^a-z0-9]/gi, '').slice(-8);
  const prefix = source === 'uuid' ? 'machine' : source === 'mac' ? 'device' : 'agent';
  return `${prefix}-${suffix}`;
}
