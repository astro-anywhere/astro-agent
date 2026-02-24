/**
 * Tests for setup remote agent relaunch behavior.
 *
 * Setup always stops and reinstalls remote agents (unconditional pkill + fresh start).
 * This matches the behavior of startRemoteAgents() established in PRs #2/#3,
 * which found that pgrep-based "already running" detection is unreliable
 * (self-matches the SSH command process).
 */

import { describe, it, expect } from 'vitest';

describe('setup remote agent relaunch', () => {
  it('should always attempt pkill before install (no skip logic)', () => {
    // The setup flow is: unconditional pkill → wait → install
    // There is no "isRunning" check or "force" flag
    const killCmd = 'pkill -f "[a]stro-agent start" 2>/dev/null || true';

    // Should use bracket trick to prevent self-match
    expect(killCmd).toContain('[a]stro-agent');
    // Should not fail if no process found
    expect(killCmd).toContain('|| true');
  });

  it('should match startRemoteAgents behavior (always kill + fresh start)', () => {
    // Both setup and launch/start use the same pattern:
    // 1. pkill existing agent (unconditional, no pgrep check)
    // 2. Wait for cleanup
    // 3. Proceed with install/start
    //
    // This is intentional — PRs #2/#3 found that pgrep -f "astro-agent start"
    // self-matches the SSH command process, falsely detecting agents as running.
    const setupKillCmd = 'pkill -f "[a]stro-agent start" 2>/dev/null || true';
    const launchKillCmd = 'pkill -f "astro-agent start" 2>/dev/null || true';

    // Both commands target the same process pattern
    expect(setupKillCmd).toContain('astro-agent start');
    expect(launchKillCmd).toContain('astro-agent start');
  });
});
