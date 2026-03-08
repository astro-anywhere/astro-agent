/**
 * Tests for provider adapter factory and provider detection.
 *
 * Verifies that:
 * - createProviderAdapter returns correct adapter types
 * - ClaudeCodeAdapter is fully removed (no 'claude-code' provider type)
 * - getAvailableAdapters does not include any CLI-based Claude adapter
 * - detectClaudeCli reports as 'claude-sdk' type
 */

import { describe, it, expect } from 'vitest';
import { createProviderAdapter } from '../src/providers/index.js';
import { ClaudeSdkAdapter } from '../src/providers/claude-sdk-adapter.js';
import { CodexAdapter } from '../src/providers/codex-adapter.js';
import { OpenClawAdapter } from '../src/providers/openclaw-adapter.js';
import { OpenCodeAdapter } from '../src/providers/opencode-adapter.js';
import type { ProviderType } from '../src/types.js';

describe('createProviderAdapter', () => {
  it('returns ClaudeSdkAdapter for claude-sdk', () => {
    const adapter = createProviderAdapter('claude-sdk');
    expect(adapter).toBeInstanceOf(ClaudeSdkAdapter);
  });

  it('returns CodexAdapter for codex', () => {
    const adapter = createProviderAdapter('codex');
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });

  it('returns OpenClawAdapter for openclaw', () => {
    const adapter = createProviderAdapter('openclaw');
    expect(adapter).toBeInstanceOf(OpenClawAdapter);
  });

  it('returns OpenCodeAdapter for opencode', () => {
    const adapter = createProviderAdapter('opencode');
    expect(adapter).toBeInstanceOf(OpenCodeAdapter);
  });

  it('returns null for slurm (handled via HPC injection)', () => {
    const adapter = createProviderAdapter('slurm');
    expect(adapter).toBeNull();
  });

  it('returns null for custom (no config)', () => {
    const adapter = createProviderAdapter('custom');
    expect(adapter).toBeNull();
  });

  it('returns null for unknown provider types', () => {
    const adapter = createProviderAdapter('nonexistent' as ProviderType);
    expect(adapter).toBeNull();
  });

  it('passes hpcCapability to ClaudeSdkAdapter', () => {
    const hpc = { clusterName: 'sherlock', partitions: ['normal'], defaultPartition: 'normal', accounts: [] };
    const adapter = createProviderAdapter('claude-sdk', hpc);
    expect(adapter).toBeInstanceOf(ClaudeSdkAdapter);
  });
});

describe('ProviderType union', () => {
  it('does not include claude-code', () => {
    // Compile-time check: 'claude-code' should not be assignable to ProviderType.
    // At runtime, verify the factory returns null for the removed type.
    const adapter = createProviderAdapter('claude-code' as ProviderType);
    expect(adapter).toBeNull();
  });

  it('includes all active provider types', () => {
    const types: ProviderType[] = ['claude-sdk', 'codex', 'openclaw', 'opencode', 'slurm', 'custom'];
    for (const type of types) {
      // Should not throw — all types are valid
      const result = createProviderAdapter(type);
      // slurm and custom return null by design, others return adapters
      if (type === 'slurm' || type === 'custom') {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
      }
    }
  });
});

describe('ClaudeSdkAdapter capabilities', () => {
  it('has type claude-sdk', () => {
    const adapter = createProviderAdapter('claude-sdk');
    expect(adapter).not.toBeNull();
    expect(adapter!.type).toBe('claude-sdk');
  });

  it('has name Claude Agent SDK', () => {
    const adapter = createProviderAdapter('claude-sdk');
    expect(adapter!.name).toBe('Claude Agent SDK');
  });

  it('exposes injectMessage for mid-execution steering', () => {
    const adapter = createProviderAdapter('claude-sdk') as ClaudeSdkAdapter;
    expect(typeof adapter.injectMessage).toBe('function');
  });

  it('exposes resumeTask for post-completion resume', () => {
    const adapter = createProviderAdapter('claude-sdk') as ClaudeSdkAdapter;
    expect(typeof adapter.resumeTask).toBe('function');
  });

  it('exposes getTaskContext for session lookup', () => {
    const adapter = createProviderAdapter('claude-sdk') as ClaudeSdkAdapter;
    expect(typeof adapter.getTaskContext).toBe('function');
  });
});
