/**
 * Provider adapters index
 */

export type { ProviderAdapter, TaskOutputStream, ProviderStatus } from './base-adapter.js';
export { ClaudeCodeAdapter } from './claude-code-adapter.js';
export { ClaudeSdkAdapter } from './claude-sdk-adapter.js';
export { CodexAdapter } from './codex-adapter.js';

import type { ProviderType } from '../types.js';
import type { ProviderAdapter } from './base-adapter.js';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { ClaudeSdkAdapter } from './claude-sdk-adapter.js';
import { CodexAdapter } from './codex-adapter.js';

/** Extended provider types including SDK variant */
export type ExtendedProviderType = ProviderType | 'claude-sdk';

/**
 * Create a provider adapter by type.
 * For 'claude-code', prefers the SDK adapter (in-process, supports steering)
 * and falls back to the CLI adapter.
 */
export function createProviderAdapter(type: ProviderType | ExtendedProviderType): ProviderAdapter | null {
  switch (type) {
    case 'claude-code':
      // Prefer SDK adapter over CLI adapter for claude-code type
      return new ClaudeSdkAdapter();
    case 'claude-sdk':
      return new ClaudeSdkAdapter();
    case 'codex':
      return new CodexAdapter();
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
 * Create a CLI-only provider adapter (for fallback when SDK is unavailable)
 */
export function createCliProviderAdapter(): ProviderAdapter {
  return new ClaudeCodeAdapter();
}

/**
 * Get all available provider adapters
 */
export async function getAvailableAdapters(): Promise<ProviderAdapter[]> {
  const adapters: ProviderAdapter[] = [
    new ClaudeSdkAdapter(), // Prefer SDK over CLI
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
  ];

  const available: ProviderAdapter[] = [];

  for (const adapter of adapters) {
    if (await adapter.isAvailable()) {
      available.push(adapter);
    }
  }

  return available;
}
