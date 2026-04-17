/**
 * Session discovery adapter tests.
 *
 * Each adapter is invoked against a temporary HOME directory populated with
 * fixture JSONL files matching the provider's on-disk layout. We verify
 * that listSessions() correctly extracts session id, cwd, summary, and
 * provider tag; that resolveTranscriptPath() finds the file; and that the
 * unified discoverSessions() merges + filters by provider / cwd / maxAge.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter } from '../src/session-discovery/adapters/claude';
import { codexAdapter } from '../src/session-discovery/adapters/codex';
import { piAdapter } from '../src/session-discovery/adapters/pi';
import { discoverSessions } from '../src/session-discovery/index';

// ============================================================================
// Harness — temporary HOME dir with per-test cleanup
// ============================================================================

let originalHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempHome = join(tmpdir(), `session-discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempHome, { recursive: true });
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tempHome, { recursive: true, force: true });
});

function writeClaudeSession(cwd: string, sessionId: string, lines: Array<Record<string, unknown>>): string {
  // Encoding: "/Users/xf2217/foo" -> "-Users-xf2217-foo"
  const encoded = cwd.replace(/\//g, '-');
  const dir = join(tempHome, '.claude', 'projects', encoded);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

function writeCodexSession(
  ymd: [string, string, string],
  sessionId: string,
  cwd: string,
  opts: { gitBranch?: string; firstUserPrompt?: string } = {},
): string {
  const dir = join(tempHome, '.codex', 'sessions', ...ymd);
  mkdirSync(dir, { recursive: true });
  const filename = `rollout-${ymd.join('')}T000000-${sessionId}.jsonl`;
  const path = join(dir, filename);
  const meta = {
    timestamp: new Date().toISOString(),
    type: 'session_meta',
    payload: {
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd,
      git: opts.gitBranch ? { branch: opts.gitBranch } : undefined,
    },
  };
  const prompt = opts.firstUserPrompt
    ? {
        timestamp: new Date().toISOString(),
        type: 'response_item',
        payload: { role: 'user', content: [{ type: 'input_text', text: opts.firstUserPrompt }] },
      }
    : null;
  const lines = [meta, prompt].filter(Boolean);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

function writePiSession(cwd: string, sessionId: string, opts: { firstUserPrompt?: string } = {}): string {
  const encoded = `--${cwd.slice(1).replace(/\//g, '-')}--`;
  const dir = join(tempHome, '.pi', 'agent', 'sessions', encoded);
  mkdirSync(dir, { recursive: true });
  const filename = `2026-04-16T12-00-00-000Z_${sessionId}.jsonl`;
  const path = join(dir, filename);
  const header = { type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd };
  const message = opts.firstUserPrompt
    ? {
        type: 'message',
        id: 'm1',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: opts.firstUserPrompt }] },
      }
    : null;
  const lines = [header, message].filter(Boolean);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

// ============================================================================
// Claude adapter
// ============================================================================

describe('claudeAdapter', () => {
  it('reports unavailable when ~/.claude/projects does not exist', () => {
    expect(claudeAdapter.isAvailable()).toBe(false);
  });

  it('lists sessions with provider tag, cwd, and summary', () => {
    writeClaudeSession('/Users/alice/app', 'sess-abc', [
      {
        type: 'user',
        message: { content: 'Add tests for the login flow, including session handling and persistent cookies' },
      },
    ]);
    expect(claudeAdapter.isAvailable()).toBe(true);
    const sessions = claudeAdapter.listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].provider).toBe('claude');
    expect(sessions[0].sessionId).toBe('sess-abc');
    expect(sessions[0].cwd).toBe('/Users/alice/app');
    expect(sessions[0].summary).toContain('Add tests');
    expect(sessions[0].transcriptPath).toContain('sess-abc.jsonl');
  });

  it('filters by cwd when requested', () => {
    writeClaudeSession('/Users/alice/app', 's1', [
      { type: 'user', message: { content: 'work on the shared app module with the new navigation patterns' } },
    ]);
    writeClaudeSession('/Users/alice/other', 's2', [
      { type: 'user', message: { content: 'work on the other codebase refactor task with big enough padding text' } },
    ]);
    const matched = claudeAdapter.listSessions({ cwd: '/Users/alice/app' });
    expect(matched).toHaveLength(1);
    expect(matched[0].sessionId).toBe('s1');
  });

  it('filters by maxAgeMs via mtime check', () => {
    writeClaudeSession('/Users/alice/app', 'fresh', [
      { type: 'user', message: { content: 'a message long enough to pass the 100-byte filter blah blah blah' } },
    ]);
    // maxAgeMs so small that the just-written file is outside the window
    const sessions = claudeAdapter.listSessions({ maxAgeMs: -1 });
    expect(sessions).toHaveLength(0);
  });

  it('resolveTranscriptPath returns the .jsonl file', () => {
    const path = writeClaudeSession('/Users/alice/app', 'xyz', [
      { type: 'user', message: { content: 'hello world and then some more text padding' } },
    ]);
    expect(claudeAdapter.resolveTranscriptPath('xyz')).toBe(path);
    expect(claudeAdapter.resolveTranscriptPath('missing')).toBeNull();
  });
});

// ============================================================================
// Codex adapter
// ============================================================================

describe('codexAdapter', () => {
  it('lists sessions from nested YYYY/MM/DD layout', () => {
    writeCodexSession(['2026', '04', '16'], '019d0972-90f7-7300-a6b5-03af0946668f', '/Users/bob/repo', {
      gitBranch: 'feat/x',
      firstUserPrompt: 'Refactor the auth module',
    });
    expect(codexAdapter.isAvailable()).toBe(true);
    const sessions = codexAdapter.listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].provider).toBe('codex');
    expect(sessions[0].sessionId).toBe('019d0972-90f7-7300-a6b5-03af0946668f');
    expect(sessions[0].cwd).toBe('/Users/bob/repo');
    expect(sessions[0].gitBranch).toBe('feat/x');
    expect(sessions[0].summary).toContain('Refactor');
  });

  it('filters by cwd', () => {
    writeCodexSession(['2026', '04', '16'], 'id-1', '/Users/bob/a', { firstUserPrompt: 'do a' });
    writeCodexSession(['2026', '04', '16'], 'id-2', '/Users/bob/b', { firstUserPrompt: 'do b' });
    const matched = codexAdapter.listSessions({ cwd: '/Users/bob/b' });
    expect(matched).toHaveLength(1);
    expect(matched[0].sessionId).toBe('id-2');
  });

  it('resolveTranscriptPath locates the rollout file via session_meta id', () => {
    const path = writeCodexSession(['2026', '04', '16'], 'target-id', '/Users/bob/repo');
    expect(codexAdapter.resolveTranscriptPath('target-id')).toBe(path);
    expect(codexAdapter.resolveTranscriptPath('missing')).toBeNull();
  });
});

// ============================================================================
// Pi adapter
// ============================================================================

describe('piAdapter', () => {
  it('lists sessions with tree-format JSONL', () => {
    writePiSession('/Users/carol/proj', 'pi-session-1', { firstUserPrompt: 'build a slug generator' });
    expect(piAdapter.isAvailable()).toBe(true);
    const sessions = piAdapter.listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].provider).toBe('pi');
    expect(sessions[0].sessionId).toBe('pi-session-1');
    expect(sessions[0].cwd).toBe('/Users/carol/proj');
    expect(sessions[0].summary).toContain('slug');
  });

  it('resolveTranscriptPath finds by header sessionId', () => {
    const path = writePiSession('/Users/carol/proj', 'pi-x', { firstUserPrompt: 'x' });
    expect(piAdapter.resolveTranscriptPath('pi-x')).toBe(path);
    expect(piAdapter.resolveTranscriptPath('missing')).toBeNull();
  });
});

// ============================================================================
// discoverSessions — cross-adapter merge
// ============================================================================

describe('discoverSessions', () => {
  it('merges and sorts across all three providers', () => {
    writeClaudeSession('/Users/dave/app', 'claude-1', [
      { type: 'user', message: { content: 'claude prompt 1 with enough text to survive filtering heuristics' } },
    ]);
    writeCodexSession(['2026', '04', '16'], 'codex-1', '/Users/dave/app', { firstUserPrompt: 'codex prompt' });
    writePiSession('/Users/dave/app', 'pi-1', { firstUserPrompt: 'pi prompt' });

    const all = discoverSessions({});
    const providers = all.map((s) => s.provider).sort();
    expect(providers).toEqual(['claude', 'codex', 'pi']);
  });

  it('respects the providers filter', () => {
    writeClaudeSession('/Users/dave/app', 'claude-1', [
      { type: 'user', message: { content: 'claude message long enough long enough long enough long enough' } },
    ]);
    writePiSession('/Users/dave/app', 'pi-1', { firstUserPrompt: 'pi prompt' });

    const only = discoverSessions({ providers: ['pi'] });
    expect(only).toHaveLength(1);
    expect(only[0].provider).toBe('pi');
  });

  it('respects the cwd filter across providers', () => {
    writeClaudeSession('/Users/dave/app', 'c1', [
      { type: 'user', message: { content: 'a message in app with enough text to survive the filesystem size filter' } },
    ]);
    writePiSession('/Users/dave/other', 'p1', { firstUserPrompt: 'a message in the other workspace' });
    const inApp = discoverSessions({ cwd: '/Users/dave/app' });
    expect(inApp).toHaveLength(1);
    expect(inApp[0].sessionId).toBe('c1');
  });

  it('applies the limit', () => {
    for (let i = 0; i < 5; i++) {
      writeClaudeSession('/Users/dave/app', `s-${i}`, [
        { type: 'user', message: { content: `message ${i} with enough text to survive the filtering heuristics` } },
      ]);
    }
    const limited = discoverSessions({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});
