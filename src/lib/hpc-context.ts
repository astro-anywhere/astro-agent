/**
 * HPC Context Builder
 *
 * Loads HPC configuration from ~/.astro/hpc/config.json, merges with
 * auto-detected Slurm cluster info, and builds a prompt prefix that
 * makes the Claude Code agent HPC-aware.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectSlurm } from './slurm-detect.js';
import type { SlurmInfo } from '../types.js';

/** User-provided HPC overrides (~/.astro/hpc/config.json) */
export interface HpcConfig {
  defaultPartition?: string;
  defaultAccount?: string;
  defaultTime?: string;
  defaultMem?: string;
  defaultCpusPerTask?: number;
  gpuPartition?: string;
  defaultGpuTime?: string;
  defaultGpuMem?: string;
  defaultModules?: string[];
  customRules?: string;
  templateDir?: string;
}

/** Result of HPC context assembly */
export interface HpcContext {
  available: boolean;
  contextString: string;
  slurmInfo?: SlurmInfo;
  config?: HpcConfig;
}

/**
 * Load user HPC config from ~/.astro/hpc/config.json.
 * Returns undefined if the file doesn't exist or is invalid.
 */
async function loadHpcConfig(): Promise<HpcConfig | undefined> {
  try {
    const configPath = join(homedir(), '.astro', 'hpc', 'config.json');
    const content = await readFile(configPath, 'utf-8');
    return JSON.parse(content) as HpcConfig;
  } catch {
    return undefined;
  }
}

/**
 * Build the HPC context prompt prefix.
 * If pre-classified SlurmInfo is provided (from startup detection), uses it
 * directly instead of re-running detectSlurm(). Otherwise falls back to
 * auto-detection.
 */
export async function buildHpcContext(preclassifiedSlurm?: SlurmInfo): Promise<HpcContext> {
  const [slurmInfo, config] = await Promise.all([
    preclassifiedSlurm ?? detectSlurm(),
    loadHpcConfig(),
  ]);

  if (!slurmInfo.available) {
    return { available: false, contextString: '' };
  }

  const contextString = generateHpcPrompt(slurmInfo, config);
  return { available: true, contextString, slurmInfo, config };
}

/**
 * Generate the HPC prompt prefix from detected info and config.
 */
function generateHpcPrompt(slurm: SlurmInfo, config?: HpcConfig): string {
  const sections: string[] = [];

  // Header
  sections.push('# HPC Environment — Slurm Cluster');
  sections.push('');
  sections.push('You are running on an HPC login node. Follow these rules strictly:');
  sections.push('');

  // Login node rules
  sections.push('## Login Node Rules');
  sections.push('- **NEVER** run compute-intensive tasks directly on the login node');
  sections.push('- **ALWAYS** use `srun` for interactive/short jobs or `sbatch` for batch jobs');
  sections.push('- Quick commands (ls, cat, git, pip install, file editing) are fine on the login node');
  sections.push('- Anything involving significant CPU, GPU, or memory MUST go through Slurm');
  sections.push('');

  // Cluster info
  sections.push('## Cluster Information');
  if (slurm.clusterName) {
    sections.push(`- Cluster: ${slurm.clusterName}`);
  }
  if (slurm.version) {
    sections.push(`- Slurm version: ${slurm.version}`);
  }
  if (slurm.partitions.length > 0) {
    sections.push(`- Partitions: ${slurm.partitions.join(', ')}`);
  }
  if (slurm.defaultPartition || config?.defaultPartition) {
    sections.push(`- Default partition: ${config?.defaultPartition || slurm.defaultPartition}`);
  }
  if (slurm.accounts.length > 0) {
    sections.push(`- Available accounts: ${slurm.accounts.join(', ')}`);
  }
  if (config?.defaultAccount) {
    sections.push(`- Default account: ${config.defaultAccount}`);
  }
  if (slurm.qosLevels.length > 0) {
    sections.push(`- QOS levels: ${slurm.qosLevels.join(', ')}`);
  }
  sections.push('');

  // Default resource parameters
  sections.push('## Default Resources');
  const partition = config?.defaultPartition || slurm.defaultPartition;
  const account = config?.defaultAccount || (slurm.accounts.length > 0 ? slurm.accounts[0] : undefined);
  const time = config?.defaultTime || '02:00:00';
  const mem = config?.defaultMem || '16G';
  const cpus = config?.defaultCpusPerTask || 4;

  const defaults: string[] = [];
  if (partition) defaults.push(`--partition=${partition}`);
  if (account) defaults.push(`--account=${account}`);
  defaults.push(`--time=${time}`);
  defaults.push(`--mem=${mem}`);
  defaults.push(`--cpus-per-task=${cpus}`);
  sections.push(`Default flags: \`${defaults.join(' ')}\``);
  sections.push('');

  // srun helper patterns
  sections.push('## Quick srun Patterns');
  sections.push('');
  sections.push('**Run a single command:**');

  const srunBase = ['srun'];
  if (partition) srunBase.push(`--partition=${partition}`);
  if (account) srunBase.push(`--account=${account}`);

  sections.push('```bash');
  sections.push(`# Quick job (30 min, 4 CPUs, 16G):`);
  sections.push(`${srunBase.join(' ')} --time=00:30:00 --cpus-per-task=4 --mem=16G <command>`);
  sections.push('');
  sections.push('# GPU job:');
  const gpuPartition = config?.gpuPartition || partition;
  const gpuSrun = ['srun'];
  if (gpuPartition) gpuSrun.push(`--partition=${gpuPartition}`);
  if (account) gpuSrun.push(`--account=${account}`);
  gpuSrun.push(`--gres=gpu:1`);
  gpuSrun.push(`--time=${config?.defaultGpuTime || '04:00:00'}`);
  gpuSrun.push(`--mem=${config?.defaultGpuMem || '32G'}`);
  sections.push(`${gpuSrun.join(' ')} <command>`);
  sections.push('```');
  sections.push('');

  // sbatch template
  sections.push('## sbatch Template');
  sections.push('```bash');
  sections.push('#!/bin/bash');
  if (partition) sections.push(`#SBATCH --partition=${partition}`);
  if (account) sections.push(`#SBATCH --account=${account}`);
  sections.push(`#SBATCH --time=${time}`);
  sections.push(`#SBATCH --mem=${mem}`);
  sections.push(`#SBATCH --cpus-per-task=${cpus}`);
  sections.push('#SBATCH --job-name=astro-task');
  sections.push('#SBATCH --output=slurm-%j.out');
  sections.push('#SBATCH --error=slurm-%j.err');
  sections.push('');
  if (config?.defaultModules && config.defaultModules.length > 0) {
    for (const mod of config.defaultModules) {
      sections.push(`module load ${mod}`);
    }
    sections.push('');
  }
  sections.push('# Your commands here');
  sections.push('```');
  sections.push('');

  // Job tracking
  sections.push('## Job Tracking');
  sections.push('When you submit batch jobs with sbatch, the system automatically tracks them.');
  sections.push('After sbatch, note the job ID and you can:');
  sections.push('- Check status: `sacct -j <JOB_ID> --format=JobID,State,ExitCode,Elapsed -n`');
  sections.push('- View output: `tail -f <output_file>`');
  sections.push('- Cancel: `scancel <JOB_ID>`');
  sections.push('');
  sections.push('The platform will continue monitoring your submitted jobs after this session ends.');
  sections.push('');

  // Custom rules
  if (config?.customRules) {
    sections.push('## Additional Rules');
    sections.push(config.customRules);
    sections.push('');
  }

  return sections.join('\n');
}
