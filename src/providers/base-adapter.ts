/**
 * Base adapter interface for agent providers
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Task, TaskResult, TaskStatus, ExecutionSummary } from '../types.js';

/**
 * A task that has been normalized by the executor — workingDirectory is always
 * resolved (auto-provisioned if needed) before being passed to adapters.
 */
export type NormalizedTask = Task & { workingDirectory: string };

export interface TaskOutputStream {
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  status: (status: TaskStatus, progress?: number, message?: string) => void;
  toolTrace: (toolName: string, toolInput?: unknown, toolResult?: unknown, success?: boolean) => void;
  /** Structured text output (bypasses stdout throttle) */
  text: (data: string) => void;
  /** Structured tool use event */
  toolUse: (toolName: string, toolInput: unknown, toolUseId?: string) => void;
  /** Structured tool result event */
  toolResult: (toolName: string, result: unknown, success: boolean, toolUseId?: string) => void;
  /** Structured file change event */
  fileChange: (path: string, action: 'created' | 'modified' | 'deleted', linesAdded?: number, linesRemoved?: number, diff?: string) => void;
  /** Structured session init event */
  sessionInit: (sessionId: string, model?: string) => void;
  /** Request user approval/decision - returns a promise that resolves with user's answers */
  approvalRequest: (question: string, options: string[]) => Promise<{ answered: boolean; answer?: string; message?: string }>;
}

export interface ProviderAdapter {
  /**
   * Provider type identifier
   */
  readonly type: string;

  /**
   * Provider display name
   */
  readonly name: string;

  /**
   * Check if the provider is available and ready
   */
  isAvailable(): Promise<boolean>;

  /**
   * Execute a task using this provider
   */
  execute(task: NormalizedTask, stream: TaskOutputStream, signal: AbortSignal): Promise<TaskResult>;

  /**
   * Get provider status/health
   */
  getStatus(): Promise<ProviderStatus>;

  /**
   * Generate a structured execution summary by resuming the completed session.
   * The resumed session has full context of the work just performed, enabling
   * high-quality summaries without re-reading files or logs.
   *
   * Optional — adapters that don't support session resume can omit this.
   */
  generateSummary?(taskId: string, workingDirectory?: string): Promise<ExecutionSummary | undefined>;

  /**
   * Get session context for a completed/active task (for resume support).
   * Optional — only adapters that support session persistence implement this.
   */
  getTaskContext?(taskId: string): { sessionId: string; workingDirectory?: string; originalWorkingDirectory?: string } | null;

  /**
   * Set the original (pre-worktree) working directory on a session.
   * Called by the task executor after workspace preparation so the adapter
   * can fall back to the project directory when the worktree is cleaned up.
   * Optional — only adapters that support session persistence implement this.
   */
  setOriginalWorkingDirectory?(taskId: string, originalDir: string): void;

  /**
   * Resume a completed session for post-completion follow-up.
   * Optional — only adapters that support session persistence implement this.
   */
  resumeTask?(
    taskId: string,
    message: string,
    workingDirectory: string,
    sessionId: string,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<{ success: boolean; output: string; error?: string }>;

  /**
   * Inject a message into a running session (mid-execution steering).
   * Optional — only adapters that support live steering implement this.
   */
  injectMessage?(taskId: string, content: string, interrupt?: boolean): Promise<boolean>;
}

/**
 * Shared summary prompt used by all adapters to generate structured execution summaries.
 * Sent as a follow-up turn to the same session, so the agent has full context.
 *
 * Intentionally domain-agnostic — works for coding tasks, research analyses,
 * data processing, and any other task type Astro supports.
 */
export const SUMMARY_PROMPT = `Produce a structured JSON summary of the work you just completed. Respond with ONLY a JSON object (no markdown fences, no extra text) matching this exact schema:

{
  "status": "success" | "partial" | "failure",
  "workCompleted": "1-2 sentence summary of what was accomplished",
  "executiveSummary": "1-2 paragraph executive summary: what was done, the approach taken, key decisions, and any trade-offs. Write in a clear, professional tone.",
  "keyFindings": ["2-5 concise bullet points of key outcomes or observations (under 100 chars each)"],
  "filesChanged": ["list of file paths that were created, modified, or deleted, or empty array if none"],
  "followUps": ["suggested follow-up actions if any, or empty array"],
  "prUrl": "full URL of the pull request if one was created, or null",
  "prNumber": 123 or null,
  "branchName": "git branch name if one was used, or null"
}`;

/** Timeout for summary generation (30 seconds) */
export const SUMMARY_TIMEOUT_MS = 30_000;

/**
 * Create a no-op TaskOutputStream for internal use (e.g., summary generation).
 * All stream methods are silent; approvalRequest returns { answered: false }.
 */
export function createNoopStream(): TaskOutputStream {
  return {
    stdout: () => {},
    stderr: () => {},
    status: () => {},
    toolTrace: () => {},
    text: () => {},
    toolUse: () => {},
    toolResult: () => {},
    fileChange: () => {},
    sessionInit: () => {},
    approvalRequest: () => Promise.resolve({ answered: false }),
  };
}

/**
 * Parse a summary JSON response, stripping markdown code fences if present.
 * Returns undefined if the text is empty or not valid JSON.
 */
export function parseSummaryResponse(text: string, logPrefix: string): ExecutionSummary | undefined {
  if (!text) {
    console.warn(`${logPrefix}: no text output from summary generation`);
    return undefined;
  }

  let jsonText = text.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Extract first JSON object if surrounded by other text
  const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonText = jsonMatch[0];
  }

  try {
    const parsed = JSON.parse(jsonText) as ExecutionSummary;
    if (!parsed.executiveSummary) {
      console.warn(`${logPrefix}: summary generated but executiveSummary is missing. Keys: ${Object.keys(parsed).join(', ')}`);
    }
    return parsed;
  } catch {
    console.warn(`${logPrefix}: summary text was not valid JSON. Text: ${jsonText.slice(0, 300)}`);
    return undefined;
  }
}

export interface ProviderStatus {
  available: boolean;
  version: string | null;
  activeTasks: number;
  maxTasks: number;
  lastError?: string;
}

/**
 * Resolve the path to the approval MCP server script (compiled JS).
 * Used by Codex and OpenCode adapters to spawn the server as a subprocess.
 */
export function getApprovalServerPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // From dist/providers/base-adapter.js → dist/mcp/approval-server.js
  return join(dirname(thisFile), '..', 'mcp', 'approval-server.js');
}
