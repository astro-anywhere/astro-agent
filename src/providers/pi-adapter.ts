/**
 * Pi provider adapter
 *
 * Executes tasks using the Pi coding agent (@mariozechner/pi-coding-agent)
 * via the official TypeScript SDK (in-process, no subprocess).
 *
 * Supports multi-turn resume by preserving AgentSession instances with a
 * 10-minute TTL.
 */

import type { TaskResult, ExecutionSummary } from '../types.js';
import {
  type ProviderAdapter,
  type NormalizedTask,
  type TaskOutputStream,
  type ProviderStatus,
  SUMMARY_PROMPT,
  SUMMARY_TIMEOUT_MS,
  parseSummaryResponse,
  createNoopStream,
} from './base-adapter.js';
import type { AgentSession } from '@mariozechner/pi-coding-agent';

// ---------------------------------------------------------------------------
// Session Preservation
// ---------------------------------------------------------------------------

interface PreservedSession {
  session: AgentSession;
  taskId: string;
  workingDirectory?: string;
  originalWorkingDirectory?: string;
  createdAt: number;
}

/** TTL for preserved sessions (10 minutes) */
const SESSION_TTL_MS = 10 * 60 * 1000;

/** Interval for proactive session cleanup (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** File-modifying tool names — emit fileChange events for these */
const FILE_TOOLS = new Set([
  'Write', 'Edit', 'Create', 'MultiEdit',
  'write', 'edit', 'create', 'multi_edit',
  'write_file', 'edit_file', 'create_file',
]);

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PiAdapter implements ProviderAdapter {
  readonly type = 'pi';
  readonly name = 'Pi';

  private activeTasks = 0;
  private maxTasks = 2;
  private lastError?: string;

  /** Preserved sessions for multi-turn resume, keyed by taskId */
  private preservedSessions = new Map<string, PreservedSession>();

  /** Timer for proactive cleanup of expired sessions */
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    for (const session of this.preservedSessions.values()) {
      session.session.abort().catch(() => {});
    }
    this.preservedSessions.clear();
  }

  async isAvailable(): Promise<boolean> {
    try {
      await import('@mariozechner/pi-coding-agent');
      return true;
    } catch {
      return false;
    }
  }

  async execute(
    task: NormalizedTask,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<TaskResult> {
    const startedAt = new Date().toISOString();
    this.activeTasks++;

    try {
      const { createAgentSession, SessionManager } = await import('@mariozechner/pi-coding-agent');

      stream.status('running', 0, 'Starting Pi agent');

      const { session } = await createAgentSession({
        cwd: task.workingDirectory,
        sessionManager: SessionManager.inMemory(),
      });

      // Build prompt
      let effectivePrompt = task.systemPrompt
        ? `${task.systemPrompt}\n\n---\n\n${task.prompt}`
        : task.prompt;

      if (task.messages && task.messages.length > 0) {
        const conversationContext = task.messages
          .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
          .join('\n\n');
        effectivePrompt = `${conversationContext}\n\nHuman: ${effectivePrompt}`;
      }

      let outputText = '';
      let toolCount = 0;
      let lastToolArgs: Record<string, unknown> | undefined;
      let agentFailed = false;

      const modelStr = session.model
        ? `${(session.model as any).provider ?? 'unknown'}/${(session.model as any).id ?? 'unknown'}`
        : undefined;

      const unsubscribe = session.subscribe((event) => {
        switch (event.type) {
          case 'agent_start':
            stream.sessionInit(
              `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              modelStr,
            );
            break;

          case 'message_update': {
            const msgEvent = (event as any).assistantMessageEvent;
            if (!msgEvent) break;

            switch (msgEvent.type) {
              case 'text_delta': {
                const delta: string = msgEvent.delta ?? '';
                if (delta) {
                  outputText += delta;
                  stream.text(delta);
                }
                break;
              }
              case 'thinking_delta': {
                const delta: string = msgEvent.delta ?? '';
                if (delta) {
                  stream.text(delta);
                }
                break;
              }
              case 'error': {
                const errMsg = msgEvent.error?.errorMessage ?? 'Unknown Pi error';
                stream.text(`\n[Pi error] ${errMsg}\n`);
                break;
              }
              // text_start, text_end, thinking_start, thinking_end, toolcall_*,
              // start, done — no action needed (covered by other events)
            }
            break;
          }

          case 'tool_execution_start': {
            const ev = event as any;
            lastToolArgs = ev.args;
            toolCount++;
            stream.toolUse(ev.toolName, ev.args, ev.toolCallId);
            stream.status('running', Math.min(80, Math.round(20 * Math.log2(toolCount + 1))), `Tool: ${ev.toolName}`);
            break;
          }

          case 'tool_execution_update': {
            // Partial/streaming tool output (e.g., bash stdout in real time)
            const ev = event as any;
            const partial = ev.partialResult;
            if (partial != null) {
              const text = typeof partial === 'string' ? partial : JSON.stringify(partial);
              if (text) stream.text(text);
            }
            break;
          }

          case 'tool_execution_end': {
            const ev = event as any;
            const resultText = typeof ev.result === 'string'
              ? ev.result
              : JSON.stringify(ev.result ?? '');
            stream.toolResult(ev.toolName, resultText, !ev.isError, ev.toolCallId);

            if (FILE_TOOLS.has(ev.toolName)) {
              const args = lastToolArgs ?? {};
              const filePath = (args.path || args.file_path || args.filePath || '') as string;
              if (filePath) {
                const action = ev.toolName.toLowerCase().includes('create') ? 'created' : 'modified';
                stream.fileChange(filePath, action);
              }
            }
            break;
          }

          case 'agent_end':
            stream.status('running', 100, 'Completed');
            break;

          case 'auto_compaction_start':
            stream.status('running', undefined, 'Compacting context');
            break;

          case 'auto_compaction_end': {
            const ev = event as any;
            if (ev.aborted || ev.errorMessage) {
              stream.status('running', undefined, `Compaction ${ev.aborted ? 'aborted' : 'failed'}`);
            }
            break;
          }

          case 'auto_retry_start': {
            const ev = event as any;
            stream.status('running', undefined, `Retrying (attempt ${ev.attempt}/${ev.maxAttempts})`);
            break;
          }

          case 'auto_retry_end': {
            const ev = event as any;
            if (!ev.success) {
              stream.text(`\n[Pi] Retry failed: ${ev.finalError ?? 'unknown error'}\n`);
            }
            break;
          }
        }
      });

      const abortHandler = () => { session.abort().catch(() => {}); };
      signal.addEventListener('abort', abortHandler, { once: true });

      try {
        await session.prompt(effectivePrompt);
      } catch (err) {
        agentFailed = true;
        throw err;
      } finally {
        signal.removeEventListener('abort', abortHandler);
        unsubscribe();
      }

      // Collect metrics from session stats
      const stats = session.getSessionStats();
      const model = session.model as any;
      const metrics: TaskResult['metrics'] = {
        inputTokens: stats.tokens?.input,
        outputTokens: stats.tokens?.output,
        totalCost: stats.cost,
        model: model ? `${model.provider ?? ''}/${model.id ?? ''}` : undefined,
        numTurns: stats.assistantMessages,
      };

      // Preserve session for multi-turn resume
      if (!agentFailed && !signal.aborted) {
        this.cleanupExpiredSessions();
        this.preservedSessions.set(task.id, {
          session,
          taskId: task.id,
          workingDirectory: task.workingDirectory,
          createdAt: Date.now(),
        });
      }

      // Generate summary for execution tasks
      let summary: ExecutionSummary | undefined;
      const isExecutionTask = !task.type || task.type === 'execution';
      if (isExecutionTask && !agentFailed && !signal.aborted) {
        try {
          stream.status('running', 85, 'Generating summary');
          summary = await this.generateSummary(task.id, task.workingDirectory);
        } catch (summaryError) {
          console.warn(`[pi] Task ${task.id}: summary generation failed:`, summaryError);
        }
      }

      return {
        taskId: task.id,
        status: signal.aborted ? 'cancelled' : 'completed',
        output: outputText,
        startedAt,
        completedAt: new Date().toISOString(),
        metrics,
        summary,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;

      if (signal.aborted) {
        return {
          taskId: task.id,
          status: 'cancelled',
          error: 'Task cancelled',
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }

      return {
        taskId: task.id,
        status: 'failed',
        error: errorMsg,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } finally {
      this.activeTasks--;
    }
  }

  async getStatus(): Promise<ProviderStatus> {
    const available = await this.isAvailable();
    return {
      available,
      version: null,
      activeTasks: this.activeTasks,
      maxTasks: this.maxTasks,
      lastError: this.lastError,
    };
  }

  // ─── Multi-Turn Resume ─────────────────────────────────────────

  async resumeTask(
    taskId: string,
    message: string,
    _workingDirectory: string,
    _sessionId: string,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    if (signal.aborted) {
      return { success: false, output: '', error: 'Resume aborted' };
    }

    const preserved = this.preservedSessions.get(taskId);
    if (!preserved || Date.now() - preserved.createdAt > SESSION_TTL_MS) {
      if (preserved) this.preservedSessions.delete(taskId);
      return { success: false, output: '', error: 'No active Pi session for this task' };
    }

    this.activeTasks++;
    try {
      const { session } = preserved;
      let outputText = '';

      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_update') {
          const msgEvent = (event as any).assistantMessageEvent;
          if (msgEvent?.type === 'text_delta') {
            const delta: string = msgEvent.delta ?? '';
            if (delta) {
              outputText += delta;
              stream.text(delta);
            }
          }
        }
      });

      const abortHandler = () => { session.abort().catch(() => {}); };
      signal.addEventListener('abort', abortHandler, { once: true });

      let failed = false;
      try {
        await session.prompt(message, { streamingBehavior: 'followUp' });
        preserved.createdAt = Date.now();
      } catch (err) {
        failed = true;
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.lastError = errorMsg;
        return { success: false, output: outputText, error: errorMsg };
      } finally {
        signal.removeEventListener('abort', abortHandler);
        unsubscribe();
      }

      return { success: !failed, output: outputText };
    } finally {
      this.activeTasks--;
    }
  }

  async injectMessage(): Promise<boolean> {
    return false;
  }

  getTaskContext(taskId: string): { sessionId: string; workingDirectory: string; originalWorkingDirectory?: string } | null {
    const preserved = this.preservedSessions.get(taskId);
    if (!preserved) return null;
    if (Date.now() - preserved.createdAt > SESSION_TTL_MS) {
      this.preservedSessions.delete(taskId);
      return null;
    }
    return {
      sessionId: taskId,
      workingDirectory: preserved.workingDirectory || '',
      originalWorkingDirectory: preserved.originalWorkingDirectory,
    };
  }

  setOriginalWorkingDirectory(taskId: string, originalDir: string): void {
    const preserved = this.preservedSessions.get(taskId);
    if (preserved) {
      preserved.originalWorkingDirectory = originalDir;
    }
  }

  // ─── Summary Generation ──────────────────────────────────────

  async generateSummary(taskId: string, workingDirectory?: string): Promise<ExecutionSummary | undefined> {
    const preserved = this.preservedSessions.get(taskId);
    if (!preserved) return undefined;

    const summaryAbort = new AbortController();
    const summaryTimeout = setTimeout(() => {
      console.warn(`[pi] Task ${taskId}: summary generation timed out after ${SUMMARY_TIMEOUT_MS}ms`);
      summaryAbort.abort();
    }, SUMMARY_TIMEOUT_MS);

    try {
      const result = await this.resumeTask(
        taskId,
        SUMMARY_PROMPT,
        workingDirectory || preserved.workingDirectory || '',
        taskId,
        createNoopStream(),
        summaryAbort.signal,
      );

      if (!result.success || !result.output) return undefined;
      return parseSummaryResponse(result.output, `[pi] Task ${taskId}`);
    } finally {
      clearTimeout(summaryTimeout);
    }
  }

  // ─── Session Cleanup ─────────────────────────────────────────

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [key, preserved] of this.preservedSessions) {
      if (now - preserved.createdAt > SESSION_TTL_MS) {
        preserved.session.abort().catch(() => {});
        this.preservedSessions.delete(key);
      }
    }
  }
}
