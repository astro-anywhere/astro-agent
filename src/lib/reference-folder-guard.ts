/**
 * Reference-folder write-guard helpers.
 *
 * When a task session mounts one or more `reference` additional folders, the
 * agent-runner enforces read-only access at the Claude Agent SDK permission
 * layer via `canUseTool`. This module contains the small, pure helpers that
 * back that enforcement so they're easy to unit-test without pulling in the
 * SDK:
 *
 *   • `tokenizeShellArgs` — quote/backslash-aware shell tokenizer
 *   • `extractPathsForWriteCheck` — pulls candidate paths out of a tool input
 *   • `buildReferenceFolderDenyHook` — returns a decision function usable
 *     inside a `canUseTool` callback
 *
 * The SDK surfaces a deny decision to the agent as a failed tool_result on
 * its own, so the hook only has to return `{ denied: true, message }`.
 */

import { isPathUnderReferenceMount } from './additional-folders.js';

/** Tools that can mutate filesystem state and therefore must be guarded. */
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * Tokenize a shell command into argument-like chunks while respecting quoted
 * strings and backslash-escaped whitespace. Not a full POSIX parser — just
 * enough to keep quoted paths like `rm "/mnt/ref folder/file"` intact so the
 * reference-mount guard can't be bypassed by wrapping a path in quotes.
 *
 * Supported:
 *   • Single quotes: 'path with space' → literal contents
 *   • Double quotes: "path with space" → literal contents (no escape expansion)
 *   • Backslash-escaped whitespace: foo\ bar → "foo bar"
 *   • Unquoted runs split on whitespace
 *
 * Unsupported (acceptable for a defense-in-depth check): variable expansion,
 * command substitution, `$'...'` ANSI-C quoting.
 */
export function tokenizeShellArgs(cmd: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  let hasContent = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      buf += c;
      hasContent = true;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; hasContent = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) {
      // Backslash-escaped next char (commonly a space): include literally.
      buf += cmd[i + 1];
      hasContent = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      if (hasContent) { out.push(buf); buf = ''; hasContent = false; }
      continue;
    }
    buf += c;
    hasContent = true;
  }
  if (hasContent) out.push(buf);
  return out;
}

/**
 * Extract candidate filesystem paths from a tool input. Returns every path
 * that should be checked against the reference-mount guard. Covers the
 * built-in Edit/Write/NotebookEdit/MultiEdit inputs and best-effort Bash
 * parsing (quote-aware tokenizer).
 */
export function extractPathsForWriteCheck(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const paths: string[] = [];
  const pushIfString = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) paths.push(v);
  };

  if (
    toolName === 'Edit' ||
    toolName === 'Write' ||
    toolName === 'NotebookEdit' ||
    toolName === 'MultiEdit'
  ) {
    pushIfString((input as { file_path?: unknown }).file_path);
    pushIfString((input as { notebook_path?: unknown }).notebook_path);
    pushIfString((input as { path?: unknown }).path);
    const edits = (input as { edits?: unknown }).edits;
    if (Array.isArray(edits)) {
      for (const e of edits) {
        if (e && typeof e === 'object') {
          pushIfString((e as { file_path?: unknown }).file_path);
        }
      }
    }
    return paths;
  }

  if (toolName === 'Bash' || toolName === 'bash') {
    const cmd = (input as { command?: unknown }).command;
    if (typeof cmd === 'string') {
      for (const t of tokenizeShellArgs(cmd)) {
        if (t.startsWith('/') || t.startsWith('./') || t.startsWith('../') || t.startsWith('~/')) {
          paths.push(t);
        }
      }
    }
  }
  return paths;
}

export interface ReferenceFolderDenyResult {
  denied: boolean;
  message?: string;
}

/**
 * Build a decision function suitable for use inside the Claude Agent SDK's
 * `canUseTool` callback. Returns `undefined` when there are no reference
 * mounts so the caller can skip installing the wrapper entirely.
 */
export function buildReferenceFolderDenyHook(
  referenceMountPaths: readonly string[],
): ((toolName: string, input: Record<string, unknown>) => ReferenceFolderDenyResult) | undefined {
  if (referenceMountPaths.length === 0) return undefined;

  return (toolName: string, input: Record<string, unknown>): ReferenceFolderDenyResult => {
    if (!WRITE_TOOLS.has(toolName) && toolName !== 'Bash' && toolName !== 'bash') {
      return { denied: false };
    }

    const candidates = extractPathsForWriteCheck(toolName, input);
    for (const p of candidates) {
      if (isPathUnderReferenceMount(p, referenceMountPaths)) {
        const message =
          `Denied: ${toolName} targets a read-only reference folder (${p}). ` +
          `Reference folders are mounted read-only and cannot be modified.`;
        return { denied: true, message };
      }
    }
    return { denied: false };
  };
}
