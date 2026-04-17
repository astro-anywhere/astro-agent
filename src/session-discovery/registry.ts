import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { piAdapter } from './adapters/pi.js';
import type { ExternalAgentProvider, SessionDiscoveryAdapter } from './types.js';

export const ADAPTERS: SessionDiscoveryAdapter[] = [claudeAdapter, codexAdapter, piAdapter];

export function getAdapter(provider: ExternalAgentProvider): SessionDiscoveryAdapter | undefined {
  return ADAPTERS.find((a) => a.provider === provider);
}
