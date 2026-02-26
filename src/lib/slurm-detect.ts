/**
 * Slurm Detection
 *
 * Detects Slurm installation and gathers cluster information.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SlurmInfo, SlurmPartitionDetail } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Detect Slurm and gather cluster information
 */
export async function detectSlurm(): Promise<SlurmInfo> {
  const info: SlurmInfo = {
    available: false,
    partitions: [],
    accounts: [],
    qosLevels: [],
  };

  // Check if sinfo is available
  try {
    await execFileAsync('which', ['sinfo'], { timeout: 5000 });
    info.available = true;
  } catch {
    return info;
  }

  // Get Slurm version
  try {
    const { stdout } = await execFileAsync('sinfo', ['--version'], { timeout: 5000 });
    const match = stdout.match(/slurm\s+(\d+\.\d+\.\d+)/);
    if (match) {
      info.version = match[1];
    }
  } catch {
    // Version detection failed
  }

  // Get cluster name
  try {
    const { stdout: rawConfig } = await execFileAsync('scontrol', ['show', 'config'], { timeout: 10000 });
    const stdout = rawConfig.split('\n').filter(l => l.includes('ClusterName')).join('\n');
    const match = stdout.match(/ClusterName\s*=\s*(\S+)/);
    if (match) {
      info.clusterName = match[1];
    }
  } catch {
    // Cluster name detection failed
  }

  // Get partitions
  try {
    const { stdout } = await execFileAsync('sinfo', ['-h', '-o', '%P'], { timeout: 10000 });
    info.partitions = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((name) => {
        const isDefault = name.endsWith('*');
        const partitionName = name.replace('*', '');
        if (isDefault) {
          info.defaultPartition = partitionName;
        }
        return partitionName;
      });
  } catch {
    // Partition detection failed
  }

  // Get user accounts
  try {
    const username = process.env.USER || process.env.LOGNAME;
    if (username && /^[a-zA-Z0-9._-]+$/.test(username)) {
      const { stdout } = await execFileAsync(
        'sacctmgr', ['-p', 'show', 'assoc', `user=${username}`, 'format=Account', '--noheader'],
        { timeout: 10000 }
      );
      info.accounts = [
        ...new Set(
          stdout
            .split('\n')
            .map((line) => line.split('|')[0]?.trim())
            .filter((a): a is string => !!a && a.length > 0)
        ),
      ];
    }
  } catch {
    // Account detection failed
  }

  // Get QOS levels
  try {
    const username = process.env.USER || process.env.LOGNAME;
    if (username && /^[a-zA-Z0-9._-]+$/.test(username)) {
      const { stdout } = await execFileAsync(
        'sacctmgr', ['-p', 'show', 'assoc', `user=${username}`, 'format=QOS', '--noheader'],
        { timeout: 10000 }
      );
      const qosSet = new Set<string>();
      stdout.split('\n').forEach((line) => {
        const qos = line.split('|')[0]?.trim();
        if (qos) {
          qos.split(',').forEach((q) => {
            if (q.trim()) qosSet.add(q.trim());
          });
        }
      });
      info.qosLevels = [...qosSet];
    }
  } catch {
    // QOS detection failed
  }

  return info;
}

/**
 * Get detailed partition info
 */
export async function getPartitionInfo(): Promise<SlurmPartitionDetail[]> {
  try {
    const { stdout } = await execFileAsync('sinfo', ['-h', '-o', '%P|%a|%l|%D|%T|%f'], { timeout: 10000 });

    const partitionMap = new Map<string, SlurmPartitionDetail>();

    stdout.split('\n').forEach((line) => {
      const parts = line.split('|');
      if (parts.length < 6) return;

      const [partitionRaw, , maxTime, nodesCount, nodeState, features] = parts;

      const isDefault = partitionRaw?.endsWith('*') || false;
      const name = partitionRaw?.replace('*', '') || '';

      if (!name) return;

      let partition = partitionMap.get(name);
      if (!partition) {
        partition = {
          name,
          isDefault,
          totalNodes: 0,
          availableNodes: 0,
          maxTime: maxTime !== '(null)' ? maxTime : undefined,
          features: features !== '(null)' ? features?.split(',') || [] : [],
        };
        partitionMap.set(name, partition);
      }

      const count = parseInt(nodesCount || '0') || 0;
      partition.totalNodes += count;

      if (nodeState?.startsWith('idle') || nodeState?.startsWith('mixed') || nodeState?.startsWith('alloc')) {
        partition.availableNodes += count;
      }
    });

    return Array.from(partitionMap.values());
  } catch {
    return [];
  }
}
