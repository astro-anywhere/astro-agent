/**
 * Pi coding agent session discovery adapter.
 *
 * Pi stores sessions under
 *   `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`
 * where `<path>` is the cwd with `/` replaced by `-`. The first line is a
 * session header (`{type: "session", version, id, timestamp, cwd}`);
 * subsequent lines are tree-linked messages.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  DiscoveryOptions,
  ExternalAgentSessionInfo,
  SessionDiscoveryAdapter,
} from '../types.js';

const PROVIDER = 'pi' as const;
const HEAD_LINES_SCAN = 50;
const TAIL_BYTES = 16_384;
const SUMMARY_MAX = 100;
const PROMPT_MAX = 200;
const MIN_FILE_BYTES = 100;

function rootDir(): string {
  return join(homedir(), '.pi', 'agent', 'sessions');
}

/** Decode Pi's `--<cwd-with-dashes>--` directory name back to an absolute path. */
function decodeCwd(dirName: string): string {
  const inner = dirName.replace(/^--/, '').replace(/--$/, '');
  return '/' + inner.replace(/-/g, '/');
}

interface PiHeader {
  sessionId: string;
  cwd?: string;
  timestamp?: string;
}

function parsePiHeader(content: string): PiHeader | null {
  const firstNewline = content.indexOf('\n');
  const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
  if (!firstLine.trim()) return null;
  try {
    const entry = JSON.parse(firstLine);
    if (entry?.type !== 'session' || typeof entry.id !== 'string') return null;
    return {
      sessionId: entry.id,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
    };
  } catch {
    return null;
  }
}

function extractUserPrompt(line: string): string | null {
  try {
    const entry = JSON.parse(line);
    if (entry?.type !== 'message') return null;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg || msg.role !== 'user') return null;
    const content = msg.content;
    if (Array.isArray(content)) {
      const text = (content as Array<Record<string, unknown>>).find(
        (b) => b.type === 'text' && typeof b.text === 'string',
      );
      if (text) return String(text.text).trim();
    } else if (typeof content === 'string') {
      return content.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function isNoisy(t: string): boolean {
  return /^\s*\[/.test(t) || /^\s*</.test(t) || t.trim().length < 5;
}

export const piAdapter: SessionDiscoveryAdapter = {
  provider: PROVIDER,

  isAvailable(): boolean {
    return existsSync(rootDir());
  },

  listSessions(opts: DiscoveryOptions): ExternalAgentSessionInfo[] {
    const root = rootDir();
    if (!existsSync(root)) return [];
    const cutoff = opts.maxAgeMs ? Date.now() - opts.maxAgeMs : 0;
    const sessions: ExternalAgentSessionInfo[] = [];

    let projectDirs: Array<{ name: string }>;
    try {
      projectDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return [];
    }

    for (const projDir of projectDirs) {
      const projPath = join(root, projDir.name);
      const decoded = decodeCwd(projDir.name);

      let files: string[];
      try {
        files = readdirSync(projPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = join(projPath, file);
        try {
          const stat = statSync(filePath);
          if (stat.size < MIN_FILE_BYTES) continue;
          if (cutoff && stat.mtimeMs < cutoff) continue;

          const content = readFileSync(filePath, 'utf-8');
          const header = parsePiHeader(content);
          if (!header) continue;
          const cwd = header.cwd || decoded;
          if (opts.cwd && opts.cwd !== cwd) continue;

          // First user prompt from head.
          const lines = content.split('\n');
          let firstPrompt = '';
          for (let li = 1; li < Math.min(lines.length, HEAD_LINES_SCAN); li++) {
            if (!lines[li].trim()) continue;
            const p = extractUserPrompt(lines[li]);
            if (p) {
              firstPrompt = p.slice(0, PROMPT_MAX);
              break;
            }
          }

          // Last + second-to-last user prompts from tail (for non-noisy summary).
          const tailStart = Math.max(0, content.length - TAIL_BYTES);
          const tailLines = content.slice(tailStart).split('\n');
          let lastUserMsg = '';
          let secondLastUserMsg = '';
          for (let li = tailLines.length - 1; li >= 0; li--) {
            const p = extractUserPrompt(tailLines[li]);
            if (!p) continue;
            if (!lastUserMsg) {
              lastUserMsg = p.slice(0, PROMPT_MAX);
            } else if (!secondLastUserMsg) {
              secondLastUserMsg = p.slice(0, PROMPT_MAX);
              break;
            }
          }

          let summary: string;
          if (lastUserMsg && !isNoisy(lastUserMsg)) summary = lastUserMsg.slice(0, SUMMARY_MAX);
          else if (secondLastUserMsg && !isNoisy(secondLastUserMsg))
            summary = secondLastUserMsg.slice(0, SUMMARY_MAX);
          else summary = (lastUserMsg || firstPrompt).slice(0, SUMMARY_MAX);

          sessions.push({
            provider: PROVIDER,
            sessionId: header.sessionId,
            summary,
            lastModified: stat.mtimeMs,
            fileSize: stat.size,
            firstPrompt: firstPrompt || lastUserMsg || undefined,
            cwd,
            transcriptPath: filePath,
          });
        } catch {
          /* skip unreadable files */
        }
      }
    }

    return sessions;
  },

  resolveTranscriptPath(sessionId: string): string | null {
    const root = rootDir();
    if (!existsSync(root)) return null;
    let projectDirs: string[];
    try {
      projectDirs = readdirSync(root);
    } catch {
      return null;
    }
    for (const dir of projectDirs) {
      const projPath = join(root, dir);
      let files: string[];
      try {
        files = readdirSync(projPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of files) {
        const candidate = join(projPath, file);
        try {
          const firstChunk = readFileSync(candidate, 'utf-8').slice(0, 4_096);
          const header = parsePiHeader(firstChunk);
          if (header?.sessionId === sessionId) return candidate;
        } catch {
          /* skip */
        }
      }
    }
    return null;
  },
};

export const __testing = { decodeCwd, parsePiHeader, extractUserPrompt, isNoisy };
