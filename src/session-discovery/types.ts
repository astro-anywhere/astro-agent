/**
 * Session discovery types.
 *
 * An `ExternalAgentSessionInfo` is the normalized shape for a session
 * produced by any supported agent (Claude Code, Codex, Pi). Adapters walk
 * their on-disk session directories and emit these; callers treat them
 * uniformly.
 */

export type ExternalAgentProvider = 'claude' | 'codex' | 'pi';

export interface ExternalAgentSessionInfo {
  provider: ExternalAgentProvider;
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  /** Absolute path to the transcript file on this machine. */
  transcriptPath: string;
}

export interface DiscoveryOptions {
  /** Only include sessions modified within this many ms. */
  maxAgeMs?: number;
  /** If set, only include sessions whose cwd equals this absolute path. */
  cwd?: string;
}

export interface SessionDiscoveryAdapter {
  readonly provider: ExternalAgentProvider;
  /** Fast check: does the provider's session directory exist on this machine? */
  isAvailable(): boolean;
  /**
   * Walk the provider's on-disk sessions and emit normalized info.
   * Must not throw on individual file errors — skip and continue.
   */
  listSessions(opts: DiscoveryOptions): ExternalAgentSessionInfo[];
  /**
   * Resolve the absolute path to a given session's transcript file, or null
   * if the session no longer exists. Used by the import command.
   */
  resolveTranscriptPath(sessionId: string): string | null;
}
