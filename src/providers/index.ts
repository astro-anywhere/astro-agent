/**
 * Provider adapters index
 */

export type { ProviderAdapter, TaskOutputStream, ProviderStatus } from './base-adapter.js';
export { ClaudeSdkAdapter } from './claude-sdk-adapter.js';
export { CodexAdapter } from './codex-adapter.js';
export { OpenClawAdapter } from './openclaw-adapter.js';
export { OpenCodeAdapter } from './opencode-adapter.js';
export { PiAdapter } from './pi-adapter.js';

import type { ProviderType, HpcCapability } from '../types.js';
import type { ProviderAdapter } from './base-adapter.js';
import { ClaudeSdkAdapter } from './claude-sdk-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { OpenClawAdapter } from './openclaw-adapter.js';
import { OpenCodeAdapter } from './opencode-adapter.js';
import { PiAdapter } from './pi-adapter.js';
import type { OpenClawBridge } from '../lib/openclaw-bridge.js';

/**
 * Create a provider adapter by type.
 *
 * @param hpcCapability Pre-classified HPC info from startup detection.
 *   Passed to ClaudeSdkAdapter to avoid re-running SLURM detection at query time.
 * @param openclawBridge Optional bridge instance for OpenClaw adapter delegation.
 */
export function createProviderAdapter(type: ProviderType, hpcCapability?: HpcCapability | null, openclawBridge?: OpenClawBridge | null): ProviderAdapter | null {
  switch (type) {
    case 'claude-sdk':
      return new ClaudeSdkAdapter(hpcCapability);
    case 'codex':
      return new CodexAdapter();
    case 'openclaw': {
      const adapter = new OpenClawAdapter();
      if (openclawBridge) {
        adapter.setBridge(openclawBridge);
      }
      return adapter;
    }
    case 'opencode':
      return new OpenCodeAdapter();
    case 'pi':
      return new PiAdapter();
    case 'slurm':
      // Slurm is no longer a standalone provider — HPC is handled via
      // prompt injection in ClaudeSdkAdapter. Return null for backward compat.
      return null;
    case 'custom':
      // Custom providers would need additional configuration
      return null;
    default:
      return null;
  }
}

/**
 * Get all available provider adapters
 */
export async function getAvailableAdapters(): Promise<ProviderAdapter[]> {
  const adapters: ProviderAdapter[] = [
    new ClaudeSdkAdapter(),
    new CodexAdapter(),
    new OpenClawAdapter(),
    new OpenCodeAdapter(),
    new PiAdapter(),
  ];

  const available: ProviderAdapter[] = [];

  for (const adapter of adapters) {
    if (await adapter.isAvailable()) {
      available.push(adapter);
    }
  }

  return available;
}
