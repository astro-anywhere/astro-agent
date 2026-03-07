/**
 * Provider adapters index
 */

export type { ProviderAdapter, TaskOutputStream, ProviderStatus } from './base-adapter.js';
export { ClaudeCodeAdapter } from './claude-code-adapter.js';
export { ClaudeSdkAdapter } from './claude-sdk-adapter.js';
export { CodexAdapter } from './codex-adapter.js';
export { OpenClawAdapter } from './openclaw-adapter.js';
export { OpenCodeAdapter } from './opencode-adapter.js';

import type { ProviderType, HpcCapability } from '../types.js';
import type { ProviderAdapter } from './base-adapter.js';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { ClaudeSdkAdapter } from './claude-sdk-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { OpenClawAdapter } from './openclaw-adapter.js';
import { OpenCodeAdapter } from './opencode-adapter.js';

/** Extended provider types including SDK variant */
export type ExtendedProviderType = ProviderType | 'claude-sdk';

/**
 * Create a provider adapter by type.
 * For 'claude-code', prefers the SDK adapter (in-process, supports steering)
 * and falls back to the CLI adapter.
 *
 * @param hpcCapability Pre-classified HPC info from startup detection.
 *   Passed to ClaudeSdkAdapter to avoid re-running SLURM detection at query time.
 */
export function createProviderAdapter(type: ProviderType | ExtendedProviderType, hpcCapability?: HpcCapability | null): ProviderAdapter | null {
  switch (type) {
    case 'claude-code':
      // Prefer SDK adapter over CLI adapter for claude-code type
      return new ClaudeSdkAdapter(hpcCapability);
    case 'claude-sdk':
      return new ClaudeSdkAdapter(hpcCapability);
    case 'codex':
      return new CodexAdapter();
    case 'openclaw':
      return new OpenClawAdapter();
    case 'opencode':
      return new OpenCodeAdapter();
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
    new ClaudeSdkAdapter(), // Prefer SDK over CLI
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
    new OpenClawAdapter(),
    new OpenCodeAdapter(),
  ];

  const available: ProviderAdapter[] = [];

  for (const adapter of adapters) {
    if (await adapter.isAvailable()) {
      available.push(adapter);
    }
  }

  return available;
}
