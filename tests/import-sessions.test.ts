/**
 * Import sessions command tests.
 *
 * Seed fake Claude / Codex / Pi session directories under a fake HOME,
 * then call importSessions() and assert:
 *  - `<workingDir>/.astro/imports/raw/*.jsonl` files are byte-for-byte copies
 *  - `manifest.json` is written with correct entries
 *  - failures[] captures requests that have no matching transcript
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importSessions } from '../src/commands/import-sessions';

let originalHome: string | undefined;
let tempHome: string;
let workspace: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tempHome = join(tmpdir(), `import-sessions-home-${ts}`);
  workspace = join(tmpdir(), `import-sessions-ws-${ts}`);
  mkdirSync(tempHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function seedClaude(cwd: string, sessionId: string, body: string): string {
  const encoded = cwd.replace(/\//g, '-');
  const dir = join(tempHome, '.claude', 'projects', encoded);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, body);
  return path;
}

function seedPi(cwd: string, sessionId: string, body: string): string {
  const encoded = `--${cwd.slice(1).replace(/\//g, '-')}--`;
  const dir = join(tempHome, '.pi', 'agent', 'sessions', encoded);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-04-16T12-00-00-000Z_${sessionId}.jsonl`);
  const header = JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd });
  writeFileSync(path, header + '\n' + body);
  return path;
}

describe('importSessions', () => {
  it('copies transcripts and writes a manifest', async () => {
    const claudeBody = '{"type":"user","message":{"content":"a claude prompt with enough text"}}\n';
    const claudePath = seedClaude('/Users/alice/app', 'c-1', claudeBody);
    const piBody = '{"type":"message","id":"m1","timestamp":"2026-04-16T12:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n';
    const piPath = seedPi('/Users/alice/app', 'p-1', piBody);

    const result = await importSessions({
      workingDirectory: workspace,
      sessions: [
        { provider: 'claude', sessionId: 'c-1', title: 'Claude task', cwd: '/Users/alice/app' },
        { provider: 'pi', sessionId: 'p-1', title: 'Pi task', cwd: '/Users/alice/app' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.rawCount).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.manifestPath).toBe(join(workspace, '.astro', 'imports', 'manifest.json'));

    // Raw files copied
    const copiedClaude = join(workspace, '.astro', 'imports', 'raw', 'claude-c-1.jsonl');
    const copiedPi = join(workspace, '.astro', 'imports', 'raw', 'pi-p-1.jsonl');
    expect(existsSync(copiedClaude)).toBe(true);
    expect(existsSync(copiedPi)).toBe(true);
    expect(readFileSync(copiedClaude, 'utf-8')).toBe(claudeBody);
    expect(readFileSync(copiedPi, 'utf-8')).toBe(readFileSync(piPath, 'utf-8'));

    // Manifest content
    const manifest = JSON.parse(readFileSync(result.manifestPath!, 'utf-8'));
    expect(manifest.version).toBe(1);
    expect(manifest.workingDirectory).toBe(workspace);
    expect(manifest.sessions).toHaveLength(2);
    const claudeEntry = manifest.sessions.find((s: { provider: string }) => s.provider === 'claude');
    expect(claudeEntry.originalPath).toBe(claudePath);
    expect(claudeEntry.localPath).toBe('raw/claude-c-1.jsonl');
    expect(claudeEntry.memoryPath).toBe('memory/claude-c-1.md');

    // memory/ dir is created empty but present
    expect(existsSync(join(workspace, '.astro', 'imports', 'memory'))).toBe(true);
  });

  it('records failures for sessions whose transcripts are missing', async () => {
    const result = await importSessions({
      workingDirectory: workspace,
      sessions: [{ provider: 'claude', sessionId: 'nope', title: 'Missing' }],
    });
    expect(result.ok).toBe(false);
    expect(result.rawCount).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toMatch(/not available|not found/);
  });

  it('rejects empty requests with an error', async () => {
    const result = await importSessions({ workingDirectory: workspace, sessions: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects hostile sessionIds (path traversal) before touching the filesystem', async () => {
    // Guard is at the top of the per-session loop, so we don't need a seeded
    // transcript — the sanitizer rejects before the adapter is consulted.
    const result = await importSessions({
      workingDirectory: workspace,
      sessions: [
        { provider: 'claude', sessionId: '../../../etc/passwd', title: 'Hostile', cwd: '/Users/alice/app' },
        { provider: 'claude', sessionId: 'with/slash', title: 'Also bad' },
        { provider: 'claude', sessionId: 'nul\0here', title: 'NUL inject' },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(3);
    for (const f of result.failures) {
      expect(f.reason).toMatch(/invalid sessionId/);
    }

    // Nothing should have been written outside the imports/raw/ dir.
    const traversalTarget = join(workspace, '..', 'etc', 'passwd.jsonl');
    expect(existsSync(traversalTarget)).toBe(false);
  });
});
