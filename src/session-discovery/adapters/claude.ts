/**
 * Claude Code session discovery adapter.
 *
 * Walks `~/.claude/projects/<cwd-encoded>/*.jsonl`, where the directory name
 * is the cwd with leading `/` and internal `/` characters replaced by `-`.
 * Each .jsonl file is a session; metadata is extracted from head + tail
 * slices without reading the entire file.
 *
 * Lifted from the prior inline implementation in `commands/start.ts` and
 * preserved verbatim for behavior parity.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  DiscoveryOptions,
  ExternalAgentSessionInfo,
  SessionDiscoveryAdapter,
} from '../types.js';

const PROVIDER = 'claude' as const;
const HEAD_LINES = 10;
const TAIL_BYTES = 16_384;
const SUMMARY_MAX = 100;
const PROMPT_MAX = 200;
const MIN_FILE_BYTES = 100;

function rootDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Decode a Claude project directory name back to an absolute cwd path. */
function decodeCwd(dirName: string): string {
  return dirName.replace(/^-/, '/').replace(/-/g, '/');
}

/** Encode a cwd back to a Claude project directory name (inverse of decode). */
function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function getUserText(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'user' || !(entry.message as Record<string, unknown>)?.content) return null;
  const msg = entry.message as Record<string, unknown>;
  const textContent = Array.isArray(msg.content)
    ? (msg.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text || ''
    : String(msg.content);
  return textContent.trim() || null;
}

function isNoisy(t: string): boolean {
  return /^\s*\[/.test(t) || /^\s*</.test(t) || t.trim().length < 5;
}

function extractMetadata(content: string): {
  firstPrompt: string;
  lastUserMsg: string;
  secondLastUserMsg: string;
  gitBranch: string;
  customTitle: string;
} {
  let firstPrompt = '';
  let lastUserMsg = '';
  let secondLastUserMsg = '';
  let gitBranch = '';
  let customTitle = '';

  const lines = content.split('\n');
  for (let li = 0; li < Math.min(lines.length, HEAD_LINES); li++) {
    if (!lines[li].trim()) continue;
    try {
      const entry = JSON.parse(lines[li]);
      if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch;
      if (entry.customTitle) customTitle = entry.customTitle;
      if (!firstPrompt) {
        const text = getUserText(entry);
        if (text) firstPrompt = text.slice(0, PROMPT_MAX);
      }
    } catch {
      /* skip */
    }
  }

  const tailStart = Math.max(0, content.length - TAIL_BYTES);
  const tailLines = content.slice(tailStart).split('\n');
  for (let li = tailLines.length - 1; li >= 0; li--) {
    if (!tailLines[li].trim()) continue;
    try {
      const entry = JSON.parse(tailLines[li]);
      const text = getUserText(entry);
      if (text) {
        if (!lastUserMsg) {
          lastUserMsg = text.slice(0, PROMPT_MAX);
        } else if (!secondLastUserMsg) {
          secondLastUserMsg = text.slice(0, PROMPT_MAX);
          break;
        }
      }
    } catch {
      /* skip */
    }
  }

  return { firstPrompt, lastUserMsg, secondLastUserMsg, gitBranch, customTitle };
}

export const claudeAdapter: SessionDiscoveryAdapter = {
  provider: PROVIDER,

  isAvailable(): boolean {
    return existsSync(rootDir());
  },

  listSessions(opts: DiscoveryOptions): ExternalAgentSessionInfo[] {
    const claudeDir = rootDir();
    if (!existsSync(claudeDir)) return [];

    const cutoff = opts.maxAgeMs ? Date.now() - opts.maxAgeMs : 0;
    const sessions: ExternalAgentSessionInfo[] = [];

    let projectDirs: Array<{ name: string }>;
    try {
      projectDirs = readdirSync(claudeDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return [];
    }

    for (const projDir of projectDirs) {
      const projPath = join(claudeDir, projDir.name);
      const cwd = decodeCwd(projDir.name);
      if (opts.cwd && opts.cwd !== cwd) continue;

      let jsonlFiles: string[];
      try {
        jsonlFiles = readdirSync(projPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of jsonlFiles) {
        const sessionId = file.replace('.jsonl', '');
        const filePath = join(projPath, file);
        try {
          const stat = statSync(filePath);
          if (stat.size < MIN_FILE_BYTES) continue;
          if (cutoff && stat.mtimeMs < cutoff) continue;

          const content = readFileSync(filePath, 'utf-8');
          const { firstPrompt, lastUserMsg, secondLastUserMsg, gitBranch, customTitle } =
            extractMetadata(content);

          let summary = '';
          if (lastUserMsg && !isNoisy(lastUserMsg)) summary = lastUserMsg.slice(0, SUMMARY_MAX);
          else if (secondLastUserMsg && !isNoisy(secondLastUserMsg))
            summary = secondLastUserMsg.slice(0, SUMMARY_MAX);
          else summary = (lastUserMsg || firstPrompt).slice(0, SUMMARY_MAX);

          sessions.push({
            provider: PROVIDER,
            sessionId,
            summary,
            lastModified: stat.mtimeMs,
            fileSize: stat.size,
            customTitle: customTitle || undefined,
            firstPrompt: firstPrompt || lastUserMsg || undefined,
            gitBranch: gitBranch || undefined,
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
    const claudeDir = rootDir();
    if (!existsSync(claudeDir)) return null;
    let projectDirs: string[];
    try {
      projectDirs = readdirSync(claudeDir);
    } catch {
      return null;
    }
    for (const dir of projectDirs) {
      const candidate = join(claudeDir, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  },
};

// Exported for tests and cross-adapter reuse.
export const __testing = { decodeCwd, encodeCwd, extractMetadata, isNoisy };
