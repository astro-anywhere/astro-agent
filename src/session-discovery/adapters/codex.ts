/**
 * Codex session discovery adapter.
 *
 * Codex stores sessions under `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`.
 * The first line is a `session_meta` record carrying the session id, cwd,
 * and git metadata. Subsequent lines are events (response_item, turn_context,
 * etc.) — we don't need them for listing.
 *
 * The summary is derived from the first user input we can find in the
 * opening ~30 lines; falling back to the session's cwd/branch when empty.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  DiscoveryOptions,
  ExternalAgentSessionInfo,
  SessionDiscoveryAdapter,
} from '../types.js';

const PROVIDER = 'codex' as const;
const HEAD_LINES_SUMMARY = 30;
const SUMMARY_MAX = 100;
const PROMPT_MAX = 200;
const MIN_FILE_BYTES = 100;

function rootDir(): string {
  return join(homedir(), '.codex', 'sessions');
}

interface ParsedMeta {
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  firstUserPrompt?: string;
}

function parseCodexHead(content: string): ParsedMeta | null {
  const lines = content.split('\n');
  if (lines.length === 0) return null;

  let meta: ParsedMeta | null = null;
  let firstUserPrompt: string | undefined;

  for (let i = 0; i < Math.min(lines.length, HEAD_LINES_SUMMARY); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'session_meta' && entry.payload && typeof entry.payload === 'object') {
      const p = entry.payload as Record<string, unknown>;
      const id = typeof p.id === 'string' ? p.id : '';
      const cwd = typeof p.cwd === 'string' ? p.cwd : undefined;
      const git = (p.git ?? null) as Record<string, unknown> | null;
      const gitBranch = git && typeof git.branch === 'string' ? git.branch : undefined;
      meta = { sessionId: id, cwd, gitBranch };
      continue;
    }

    // Extract the first user-authored text we encounter. The Codex rollout
    // format uses `response_item` entries with a `payload.content` array.
    if (!firstUserPrompt && entry.type === 'response_item' && entry.payload) {
      const p = entry.payload as Record<string, unknown>;
      if (p.role === 'user' && Array.isArray(p.content)) {
        const textBlock = (p.content as Array<Record<string, unknown>>).find(
          (b) => typeof b.text === 'string',
        );
        if (textBlock) {
          firstUserPrompt = String(textBlock.text).trim().slice(0, PROMPT_MAX);
        }
      }
    }
  }

  if (!meta) return null;
  if (firstUserPrompt) meta.firstUserPrompt = firstUserPrompt;
  return meta;
}

function extractSessionIdFromFilename(filename: string): string {
  // rollout-<ISO>-<uuid>.jsonl → last UUID-shaped chunk
  const stripped = filename.replace(/\.jsonl$/, '');
  const parts = stripped.split('-');
  if (parts.length >= 5) {
    // uuid is the last 5 dash-separated fields
    return parts.slice(-5).join('-');
  }
  return stripped;
}

function* walkDatedDirs(root: string): Generator<string> {
  // ~/.codex/sessions/YYYY/MM/DD/*.jsonl — but also tolerate flat layouts.
  let years: string[];
  try {
    years = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return;
  }

  for (const year of years) {
    const yearPath = join(root, year);
    let months: string[];
    try {
      months = readdirSync(yearPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const month of months) {
      const monthPath = join(yearPath, month);
      let days: string[];
      try {
        days = readdirSync(monthPath, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        continue;
      }
      for (const day of days) {
        const dayPath = join(monthPath, day);
        let files: string[];
        try {
          files = readdirSync(dayPath).filter((f) => f.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const f of files) yield join(dayPath, f);
      }
    }
  }

  // Also check for flat .jsonl files at root (legacy).
  try {
    const flat = readdirSync(root).filter((f) => f.endsWith('.jsonl'));
    for (const f of flat) yield join(root, f);
  } catch {
    /* ignore */
  }
}

export const codexAdapter: SessionDiscoveryAdapter = {
  provider: PROVIDER,

  isAvailable(): boolean {
    return existsSync(rootDir());
  },

  listSessions(opts: DiscoveryOptions): ExternalAgentSessionInfo[] {
    const root = rootDir();
    if (!existsSync(root)) return [];
    const cutoff = opts.maxAgeMs ? Date.now() - opts.maxAgeMs : 0;
    const sessions: ExternalAgentSessionInfo[] = [];

    for (const filePath of walkDatedDirs(root)) {
      try {
        const stat = statSync(filePath);
        if (stat.size < MIN_FILE_BYTES) continue;
        if (cutoff && stat.mtimeMs < cutoff) continue;

        // Only need the first ~8KB for metadata; the first line alone may be
        // many KB (session_meta carries base instructions), so read 32KB.
        const content = readFileSync(filePath, 'utf-8').slice(0, 32_768);
        const meta = parseCodexHead(content);
        if (!meta) continue;
        if (opts.cwd && meta.cwd !== opts.cwd) continue;

        const basename = filePath.split('/').pop() || '';
        const sessionId = meta.sessionId || extractSessionIdFromFilename(basename);
        const summary = (meta.firstUserPrompt || meta.cwd || '').slice(0, SUMMARY_MAX);

        sessions.push({
          provider: PROVIDER,
          sessionId,
          summary,
          lastModified: stat.mtimeMs,
          fileSize: stat.size,
          firstPrompt: meta.firstUserPrompt,
          gitBranch: meta.gitBranch,
          cwd: meta.cwd,
          transcriptPath: filePath,
        });
      } catch {
        /* skip unreadable files */
      }
    }

    return sessions;
  },

  resolveTranscriptPath(sessionId: string): string | null {
    const root = rootDir();
    if (!existsSync(root)) return null;
    for (const filePath of walkDatedDirs(root)) {
      try {
        const content = readFileSync(filePath, 'utf-8').slice(0, 32_768);
        const meta = parseCodexHead(content);
        if (meta?.sessionId === sessionId) return filePath;
      } catch {
        /* skip */
      }
    }
    return null;
  },
};

export const __testing = { parseCodexHead, extractSessionIdFromFilename, walkDatedDirs };
