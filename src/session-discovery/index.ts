/**
 * Unified session discovery across supported external agents.
 *
 * Fans out a single discovery query to every registered adapter and returns
 * the merged result, sorted newest-first and capped to `limit`. Adapters
 * whose provider is not in the requested set, or whose root directory does
 * not exist on this machine, are skipped.
 */

import { ADAPTERS, getAdapter } from './registry.js';
import type { DiscoveryOptions, ExternalAgentProvider, ExternalAgentSessionInfo } from './types.js';

export { ADAPTERS, getAdapter };
export type {
  DiscoveryOptions,
  ExternalAgentProvider,
  ExternalAgentSessionInfo,
  SessionDiscoveryAdapter,
} from './types.js';

export interface DiscoverSessionsOptions extends DiscoveryOptions {
  providers?: ExternalAgentProvider[];
  /** Cap on total results across all providers. Defaults to 50. */
  limit?: number;
}

export function discoverSessions(opts: DiscoverSessionsOptions = {}): ExternalAgentSessionInfo[] {
  const providerFilter = opts.providers?.length ? new Set(opts.providers) : null;
  const selected = providerFilter
    ? ADAPTERS.filter((a) => providerFilter.has(a.provider))
    : ADAPTERS;

  const all: ExternalAgentSessionInfo[] = [];
  for (const adapter of selected) {
    if (!adapter.isAvailable()) continue;
    try {
      const items = adapter.listSessions({ maxAgeMs: opts.maxAgeMs, cwd: opts.cwd });
      all.push(...items);
    } catch {
      /* adapter bug: skip rather than fail whole discovery */
    }
  }

  all.sort((a, b) => b.lastModified - a.lastModified);
  const limit = opts.limit ?? 50;
  return all.slice(0, limit);
}

/** Resolve a session's transcript path by scanning adapters in order. */
export function resolveTranscriptPath(
  provider: ExternalAgentProvider,
  sessionId: string,
): string | null {
  const adapter = getAdapter(provider);
  if (!adapter || !adapter.isAvailable()) return null;
  return adapter.resolveTranscriptPath(sessionId);
}
