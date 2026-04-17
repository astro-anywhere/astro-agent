/**
 * Import external agent sessions into an Astro project workspace.
 *
 * For each requested session, resolves its transcript path via the matching
 * discovery adapter and copies the JSONL into
 *   `<workingDirectory>/.astro/imports/raw/<provider>-<sessionId>.jsonl`.
 * The memory/ subdirectory is created empty; per-session summaries are
 * written there later by subagents during planning. A manifest.json at
 * `.astro/imports/manifest.json` records the import for provenance.
 *
 * Per-session failures do not abort the whole import; they accumulate in
 * `failures[]`. The operation is considered ok as long as the workspace
 * structure is set up and the manifest is written.
 */

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { getAdapter } from '../session-discovery/index.js';
import type {
  ExternalAgentProvider,
  ImportManifestEntry,
  ImportSessionsFailure,
} from '../types.js';

export interface ImportSessionsInput {
  workingDirectory: string;
  sessions: Array<{
    provider: ExternalAgentProvider;
    sessionId: string;
    title: string;
    cwd?: string;
    gitBranch?: string;
    lastModified?: number;
  }>;
}

export interface ImportSessionsResult {
  ok: boolean;
  manifestPath?: string;
  rawCount: number;
  failures: ImportSessionsFailure[];
  error?: string;
}

interface ImportManifest {
  version: 1;
  importedAt: string;
  workingDirectory: string;
  sessions: ImportManifestEntry[];
}

/**
 * Reject (don't silently strip) sessionIds that contain characters unsafe
 * for a filename. Claude / Codex / Pi all use UUID-shaped or filename-safe
 * ids; anything with `/`, `\`, `..`, NUL, or other path metacharacters is
 * hostile and the whole id should be refused rather than normalized into a
 * different-but-still-valid filename.
 * Returns the id unchanged if acceptable, or null if hostile.
 */
function sanitizeSessionIdForFilename(sessionId: string): string | null {
  if (!sessionId || sessionId.length > 200) return null;
  if (sessionId.includes('..')) return null;
  // Disallow anything outside a conservative filename alphabet.
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  return sessionId;
}

function rawFilename(provider: ExternalAgentProvider, sessionId: string): string {
  return `${provider}-${sessionId}.jsonl`;
}

function memoryFilename(provider: ExternalAgentProvider, sessionId: string): string {
  return `${provider}-${sessionId}.md`;
}

export async function importSessions(
  input: ImportSessionsInput,
): Promise<ImportSessionsResult> {
  const { workingDirectory, sessions } = input;
  if (!workingDirectory) {
    return { ok: false, rawCount: 0, failures: [], error: 'workingDirectory is required' };
  }
  if (!sessions.length) {
    return { ok: false, rawCount: 0, failures: [], error: 'no sessions requested' };
  }

  const importsDir = join(workingDirectory, '.astro', 'imports');
  const rawDir = join(importsDir, 'raw');
  const memoryDir = join(importsDir, 'memory');
  await mkdir(rawDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });

  const manifestSessions: ImportManifestEntry[] = [];
  const failures: ImportSessionsFailure[] = [];

  for (const req of sessions) {
    // Hostile sessionIds (path traversal, NUL, shell metachars) would escape
    // the raw dir once interpolated into the destination filename. Guard
    // before touching the adapter or the filesystem.
    const safeSessionId = sanitizeSessionIdForFilename(req.sessionId);
    if (!safeSessionId) {
      failures.push({
        provider: req.provider,
        sessionId: req.sessionId,
        reason: 'invalid sessionId',
      });
      continue;
    }

    const adapter = getAdapter(req.provider);
    if (!adapter) {
      failures.push({
        provider: req.provider,
        sessionId: req.sessionId,
        reason: `unknown provider ${req.provider}`,
      });
      continue;
    }
    if (!adapter.isAvailable()) {
      failures.push({
        provider: req.provider,
        sessionId: req.sessionId,
        reason: `${req.provider} not available on this machine`,
      });
      continue;
    }

    // Adapter uses the original id (which may differ from the sanitized one
    // only in characters we'd have rejected above — so any session that
    // resolves has a id that also survives sanitization).
    const sourcePath = adapter.resolveTranscriptPath(req.sessionId);
    if (!sourcePath) {
      failures.push({
        provider: req.provider,
        sessionId: req.sessionId,
        reason: 'transcript file not found',
      });
      continue;
    }

    const destFilename = rawFilename(req.provider, safeSessionId);
    const destPath = join(rawDir, destFilename);
    try {
      await copyFile(sourcePath, destPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ provider: req.provider, sessionId: req.sessionId, reason: `copy failed: ${msg}` });
      continue;
    }

    manifestSessions.push({
      provider: req.provider,
      sessionId: req.sessionId,
      originalPath: sourcePath,
      localPath: relative(importsDir, destPath),
      memoryPath: relative(importsDir, join(memoryDir, memoryFilename(req.provider, safeSessionId))),
      cwd: req.cwd,
      gitBranch: req.gitBranch,
      lastModified: req.lastModified,
      title: req.title,
    });
  }

  const manifest: ImportManifest = {
    version: 1,
    importedAt: new Date().toISOString(),
    workingDirectory,
    sessions: manifestSessions,
  };
  const manifestPath = join(importsDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  return {
    ok: manifestSessions.length > 0,
    manifestPath,
    rawCount: manifestSessions.length,
    failures,
    error:
      manifestSessions.length === 0
        ? 'no sessions were imported successfully'
        : undefined,
  };
}
