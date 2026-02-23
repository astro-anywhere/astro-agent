/**
 * Base adapter interface for agent providers
 */

import type { Task, TaskResult, TaskStatus } from '../types.js';

export interface TaskOutputStream {
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  status: (status: TaskStatus, progress?: number, message?: string) => void;
  toolTrace: (toolName: string, toolInput?: unknown, toolResult?: unknown, success?: boolean) => void;
  /** Structured text output (bypasses stdout throttle) */
  text: (data: string) => void;
  /** Structured tool use event */
  toolUse: (toolName: string, toolInput: unknown) => void;
  /** Structured tool result event */
  toolResult: (toolName: string, result: unknown, success: boolean) => void;
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
  execute(task: Task, stream: TaskOutputStream, signal: AbortSignal): Promise<TaskResult>;

  /**
   * Get provider status/health
   */
  getStatus(): Promise<ProviderStatus>;
}

export interface ProviderStatus {
  available: boolean;
  version: string | null;
  activeTasks: number;
  maxTasks: number;
  lastError?: string;
}
