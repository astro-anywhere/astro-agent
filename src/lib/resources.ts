/**
 * Machine resource detection and reporting
 */

import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { MachineResources, CpuInfo, MemoryInfo, GpuInfo } from '../types.js';

const execAsync = promisify(exec);

/**
 * Get CPU information
 */
function getCpuInfo(): CpuInfo {
  const cpus = os.cpus();
  const firstCpu = cpus[0];
  const loadAvg = os.loadavg();

  return {
    model: firstCpu?.model ?? 'Unknown',
    cores: cpus.length,
    speed: firstCpu?.speed ?? 0,
    loadAvg,
  };
}

/**
 * Get memory information
 *
 * On macOS, os.freemem() only counts truly free pages and ignores
 * inactive/purgeable pages that the OS can reclaim instantly, causing
 * memory to appear ~99% used. We parse vm_stat to get accurate numbers.
 */
async function getMemoryInfo(): Promise<MemoryInfo> {
  const total = os.totalmem();

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execAsync('vm_stat', { timeout: 5000 });
      const pageMatch = stdout.match(/page size of (\d+) bytes/);
      const pageSize = pageMatch ? parseInt(pageMatch[1]) : 16384;

      const parse = (label: string): number => {
        const match = stdout.match(new RegExp(`${label}:\\s+(\\d+)`));
        return match ? parseInt(match[1]) * pageSize : 0;
      };

      const free = parse('Pages free');
      const inactive = parse('Pages inactive');
      const purgeable = parse('Pages purgeable');

      // Available = free + inactive + purgeable (all reclaimable by the OS)
      const available = free + inactive + purgeable;
      const used = total - available;
      const usedPercent = (used / total) * 100;

      return { total, free: available, used, usedPercent };
    } catch {
      // Fall through to os.freemem()
    }
  }

  const free = os.freemem();
  const used = total - free;
  const usedPercent = (used / total) * 100;

  return { total, free, used, usedPercent };
}

/**
 * Parse nvidia-smi output to get GPU information
 */
function parseNvidiaSmiOutput(output: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  const lines = output.trim().split('\n');

  for (const line of lines) {
    const parts = line.split(', ');
    if (parts.length >= 4) {
      const [name, memoryTotal, memoryFree, utilization] = parts;
      gpus.push({
        name: name?.trim() ?? 'Unknown GPU',
        vendor: 'NVIDIA',
        memoryTotal: parseInt(memoryTotal ?? '0', 10) * 1024 * 1024, // MiB to bytes
        memoryFree: parseInt(memoryFree ?? '0', 10) * 1024 * 1024,
        utilization: parseInt(utilization ?? '0', 10),
      });
    }
  }

  return gpus;
}

/**
 * Detect NVIDIA GPUs using nvidia-smi
 */
async function detectNvidiaGpus(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=name,memory.total,memory.free,utilization.gpu --format=csv,noheader,nounits',
      { timeout: 5000 }
    );
    return parseNvidiaSmiOutput(stdout);
  } catch {
    // nvidia-smi not available or failed
    return [];
  }
}

/**
 * Detect AMD GPUs using rocm-smi
 */
async function detectAmdGpus(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execAsync('rocm-smi --showproductname --showmeminfo vram --showuse', {
      timeout: 5000,
    });

    // Parse rocm-smi output (format varies by version)
    const gpus: GpuInfo[] = [];
    const lines = stdout.split('\n');
    let currentGpu: Partial<GpuInfo> = { vendor: 'AMD' };

    for (const line of lines) {
      if (line.includes('GPU[')) {
        if (currentGpu.name) {
          gpus.push(currentGpu as GpuInfo);
        }
        currentGpu = { vendor: 'AMD', memoryTotal: 0, memoryFree: 0, utilization: 0 };
      }
      if (line.includes('Card series:')) {
        currentGpu.name = line.split(':')[1]?.trim() ?? 'AMD GPU';
      }
      if (line.includes('Total Memory')) {
        const match = line.match(/(\d+)/);
        if (match) {
          currentGpu.memoryTotal = parseInt(match[1], 10) * 1024 * 1024;
        }
      }
      if (line.includes('GPU use')) {
        const match = line.match(/(\d+)/);
        if (match) {
          currentGpu.utilization = parseInt(match[1], 10);
        }
      }
    }

    if (currentGpu.name) {
      gpus.push(currentGpu as GpuInfo);
    }

    return gpus;
  } catch {
    // rocm-smi not available or failed
    return [];
  }
}

/**
 * Detect Apple Silicon GPUs (macOS only)
 */
async function detectAppleGpus(): Promise<GpuInfo[]> {
  if (os.platform() !== 'darwin') {
    return [];
  }

  try {
    const { stdout } = await execAsync('system_profiler SPDisplaysDataType -json', {
      timeout: 5000,
    });

    const data = JSON.parse(stdout);
    const displays = data?.SPDisplaysDataType ?? [];
    const gpus: GpuInfo[] = [];

    for (const display of displays) {
      const gpuName = display.sppci_model ?? display._name ?? 'Apple GPU';
      const vramMatch = display.spdisplays_vram?.match(/(\d+)/);
      const vramMB = vramMatch ? parseInt(vramMatch[1], 10) : 0;

      gpus.push({
        name: gpuName,
        vendor: 'Apple',
        memoryTotal: vramMB * 1024 * 1024,
        memoryFree: 0, // Not available on macOS
        utilization: 0, // Not easily available
      });
    }

    return gpus;
  } catch {
    return [];
  }
}

/**
 * Detect all GPUs on the system
 */
async function getGpuInfo(): Promise<GpuInfo[]> {
  // Try all GPU detection methods in parallel
  const [nvidiaGpus, amdGpus, appleGpus] = await Promise.all([
    detectNvidiaGpus(),
    detectAmdGpus(),
    detectAppleGpus(),
  ]);

  return [...nvidiaGpus, ...amdGpus, ...appleGpus];
}

/**
 * Get complete machine resource information
 */
export async function getMachineResources(): Promise<MachineResources> {
  const [gpu, memory] = await Promise.all([getGpuInfo(), getMemoryInfo()]);

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpu: getCpuInfo(),
    memory,
    gpu,
  };
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Format resource summary for display
 */
export function formatResourceSummary(resources: MachineResources): string {
  const lines: string[] = [];

  lines.push(`Host: ${resources.hostname} (${resources.platform}/${resources.arch})`);
  lines.push(`CPU: ${resources.cpu.model} (${resources.cpu.cores} cores @ ${resources.cpu.speed}MHz)`);
  lines.push(`Memory: ${formatBytes(resources.memory.used)} / ${formatBytes(resources.memory.total)} (${resources.memory.usedPercent.toFixed(1)}% used)`);

  if (resources.gpu.length > 0) {
    for (const gpu of resources.gpu) {
      const memUsed = gpu.memoryTotal - gpu.memoryFree;
      lines.push(`GPU: ${gpu.name} - ${formatBytes(memUsed)} / ${formatBytes(gpu.memoryTotal)} (${gpu.utilization}% util)`);
    }
  } else {
    lines.push('GPU: None detected');
  }

  return lines.join('\n');
}
