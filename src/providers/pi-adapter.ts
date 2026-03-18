/**
 * Pi provider adapter
 *
 * Executes tasks using the Pi coding agent (@mariozechner/pi-coding-agent)
 * via JSONL RPC communication over stdin/stdout.
 *
 * Maps Pi streaming events to Astro's TaskOutputStream and supports
 * multi-turn resume by preserving bridge instances with 10-minute TTL.
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
import { PiRpcBridge, type PiEvent } from '../lib/pi-rpc.js';
import { getProvider } from '../lib/providers.js';

// ---------------------------------------------------------------------------
// Session Preservation
// ---------------------------------------------------------------------------

interface PreservedSession {
  bridge: PiRpcBridge;
  taskId: string;
  workingDirectory?: string;
  originalWorkingDirectory?: string;
  createdAt: number;
}

/** TTL for preserved sessions (10 minutes) */
const SESSION_TTL_MS = 10 * 60 * 1000;

/** File-modifying tool names — emit fileChange events for these */
const FILE_TOOLS = new Set([
  'Write', 'Edit', 'Create', 'MultiEdit',
  'write', 'edit', 'create', 'multi_edit',
  'write_file', 'edit_file', 'create_file',
]);

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Interval for proactive session cleanup (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export class PiAdapter implements ProviderAdapter {
  readonly type = 'pi';
  readonly name = 'Pi';

  private activeTasks = 0;
  private maxTasks = 2;
  private lastError?: string;
  private piPath: string | null = null;

  /** Preserved sessions for multi-turn resume, keyed by taskId */
  private preservedSessions = new Map<string, PreservedSession>();

  /** Timer for proactive cleanup of expired sessions */
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Proactively clean up expired bridge processes every 5 minutes so they
    // don't accumulate if no new tasks arrive after a session expires.
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), CLEANUP_INTERVAL_MS);
    // Allow the Node.js process to exit even if this timer is still active.
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Stop the background cleanup timer and all preserved bridge processes. */
  destroy(): void {
    clearInterval(this.cleanupTimer);
    for (const session of this.preservedSessions.values()) {
      session.bridge.stop();
    }
    this.preservedSessions.clear();
  }

  async isAvailable(): Promise<boolean> {
    const provider = await getProvider('pi' as any);
    if (provider?.available) {
      this.piPath = provider.path;
      return true;
    }
    return false;
  }

  async execute(
    task: NormalizedTask,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<TaskResult> {
    if (!this.piPath) {
      const available = await this.isAvailable();
      if (!available) {
        return {
          taskId: task.id,
          status: 'failed',
          error: 'Pi not available',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      }
    }

    this.activeTasks++;
    const startedAt = new Date().toISOString();
    let bridge: PiRpcBridge | null = null;

    // Timeout support: abort the bridge if task.timeout is exceeded
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutAc = task.timeout ? new AbortController() : null;

    try {
      stream.status('running', 0, 'Starting Pi agent');

      bridge = new PiRpcBridge(this.piPath!);

      // Combine user abort signal with timeout signal
      if (timeoutAc && task.timeout) {
        timeoutTimer = setTimeout(() => timeoutAc.abort(), task.timeout);
        // If user aborts first, also trigger timeout controller
        signal.addEventListener('abort', () => timeoutAc.abort(), { once: true });
      }
      const effectiveSignal = timeoutAc?.signal ?? signal;

      bridge.start(effectiveSignal, task.workingDirectory, task.environment);

      // Configure model if specified
      if (task.model) {
        try {
          await bridge.setModel(task.model);
        } catch {
          // Non-fatal — Pi may not support setModel, continue with default
        }
      }

      let lastMetrics: TaskResult['metrics'] | undefined;
      let outputText = '';
      let toolCount = 0;

      // Track tool input by tool name for fileChange emission
      let lastToolInput: Record<string, unknown> | undefined;

      // Wire up event handler
      const eventHandler = (event: PiEvent) => {
        this.mapEventToStream(event, stream, bridge!);

        // Track tool input from tool_execution_start
        if (event.event === 'tool_execution_start') {
          lastToolInput = event.data.toolInput as Record<string, unknown> | undefined;
          toolCount++;
          const progress = Math.min(80, Math.round(20 * Math.log2(toolCount + 1)));
          stream.status('running', progress, `Tool: ${event.data.toolName}`);
        }

        // Emit fileChange for file-modifying tools
        if (event.event === 'tool_execution_end' && FILE_TOOLS.has(event.data.toolName)) {
          const input = lastToolInput ?? {};
          const path = (input.path || input.file_path || input.filePath || '') as string;
          if (path) {
            const action = event.data.toolName.toLowerCase().includes('create') ? 'created' : 'modified';
            stream.fileChange(path, action);
          }
        }

        // Accumulate text output
        if (event.event === 'message_update') {
          const delta = event.data?.delta || event.data?.text || '';
          if (delta) outputText += delta;
        }

        // Capture metrics from agent_end
        if (event.event === 'agent_end' && event.data) {
          lastMetrics = {
            inputTokens: event.data.usage?.input_tokens,
            outputTokens: event.data.usage?.output_tokens,
            totalCost: event.data.cost_usd,
            model: event.data.model,
            numTurns: event.data.num_turns,
            durationMs: event.data.duration_ms,
          };
        }
      };
      bridge.onEvent(eventHandler);

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

      // Send the prompt
      let response;
      try {
        response = await bridge.prompt(effectivePrompt);
      } finally {
        bridge.offEvent(eventHandler);
      }
      const succeeded = response.ok;

      // Preserve session for multi-turn resume
      if (succeeded) {
        this.cleanupExpiredSessions();
        this.preservedSessions.set(task.id, {
          bridge,
          taskId: task.id,
          workingDirectory: task.workingDirectory,
          createdAt: Date.now(),
        });
      } else {
        bridge.stop();
      }

      // Save metrics before summary
      const savedMetrics = lastMetrics;

      // Generate summary only for execution tasks
      let summary: ExecutionSummary | undefined;
      const isExecutionTask = !task.type || task.type === 'execution';
      if (isExecutionTask && succeeded) {
        try {
          stream.status('running', 85, 'Generating summary');
          summary = await this.generateSummary(task.id, task.workingDirectory);
        } catch (summaryError) {
          console.warn(`[pi] Task ${task.id}: summary generation failed:`, summaryError);
        }
      }

      return {
        taskId: task.id,
        status: succeeded ? 'completed' : 'failed',
        output: outputText,
        error: response.error?.message,
        startedAt,
        completedAt: new Date().toISOString(),
        metrics: savedMetrics,
        summary,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;

      // Clean up bridge on exception to prevent orphaned processes
      try { if (bridge?.isRunning) bridge.stop(); } catch (cleanupErr) { console.warn(`[pi] Bridge cleanup failed:`, cleanupErr); }

      if (signal.aborted || timeoutAc?.signal.aborted) {
        return {
          taskId: task.id,
          status: 'cancelled',
          error: timeoutAc?.signal.aborted && !signal.aborted ? 'Task timed out' : 'Task cancelled',
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
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  async getStatus(): Promise<ProviderStatus> {
    const available = await this.isAvailable();
    const provider = await getProvider('pi' as any);

    return {
      available,
      version: provider?.version ?? null,
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
    // Check abort before doing any work
    if (signal.aborted) {
      return { success: false, output: '', error: 'Resume aborted' };
    }

    const session = this.preservedSessions.get(taskId);
    if (!session || !session.bridge.isRunning || Date.now() - session.createdAt > SESSION_TTL_MS) {
      // Clean up an expired-but-still-running bridge to avoid resource leaks.
      if (session) {
        session.bridge.stop();
        this.preservedSessions.delete(taskId);
      }
      return { success: false, output: '', error: 'No active Pi session for this task' };
    }

    this.activeTasks++;
    try {
      let outputText = '';

      const eventHandler = (event: PiEvent) => {
        this.mapEventToStream(event, stream, session.bridge);
        if (event.event === 'message_update') {
          const delta = event.data?.delta || event.data?.text || '';
          if (delta) outputText += delta;
        }
      };
      session.bridge.onEvent(eventHandler);

      // Wire abort signal to stop the bridge if caller cancels
      const abortHandler = () => session.bridge.stop();
      signal.addEventListener('abort', abortHandler, { once: true });

      try {
        const response = await session.bridge.steer(message);

        // Update session timestamp
        session.createdAt = Date.now();

        return {
          success: response.ok,
          output: outputText,
          error: response.error?.message,
        };
      } finally {
        signal.removeEventListener('abort', abortHandler);
        session.bridge.offEvent(eventHandler);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;
      return { success: false, output: '', error: errorMsg };
    } finally {
      this.activeTasks--;
    }
  }

  async injectMessage(): Promise<boolean> {
    return false;
  }

  getTaskContext(taskId: string): { sessionId: string; workingDirectory: string; originalWorkingDirectory?: string } | null {
    const session = this.preservedSessions.get(taskId);
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      // Stop the bridge process before removing from the map to avoid orphaned processes.
      session.bridge.stop();
      this.preservedSessions.delete(taskId);
      return null;
    }
    return {
      sessionId: taskId, // Pi uses bridge instances, not session IDs
      workingDirectory: session.workingDirectory || '',
      originalWorkingDirectory: session.originalWorkingDirectory,
    };
  }

  setOriginalWorkingDirectory(taskId: string, originalDir: string): void {
    const session = this.preservedSessions.get(taskId);
    if (session) {
      session.originalWorkingDirectory = originalDir;
    }
  }

  // ─── Summary Generation ──────────────────────────────────────

  async generateSummary(taskId: string, workingDirectory?: string): Promise<ExecutionSummary | undefined> {
    const session = this.preservedSessions.get(taskId);
    if (!session?.bridge.isRunning) {
      return undefined;
    }

    const summaryAbort = new AbortController();
    const summaryTimeout = setTimeout(() => summaryAbort.abort(), SUMMARY_TIMEOUT_MS);

    try {
      const result = await this.resumeTask(
        taskId,
        SUMMARY_PROMPT,
        workingDirectory || session.workingDirectory || '',
        taskId,
        createNoopStream(),
        summaryAbort.signal,
      );

      if (!result.success || !result.output) {
        return undefined;
      }

      return parseSummaryResponse(result.output, `[pi] Task ${taskId}`);
    } finally {
      clearTimeout(summaryTimeout);
    }
  }

  // ─── Event Mapping ──────────────────────────────────────────────

  private mapEventToStream(event: PiEvent, stream: TaskOutputStream, bridge: PiRpcBridge): void {
    switch (event.event) {
      case 'agent_start':
        stream.sessionInit(randomSessionId(), undefined);
        break;

      case 'message_update': {
        const delta = event.data?.delta || event.data?.text || '';
        if (delta) stream.text(delta);
        break;
      }

      case 'tool_execution_start':
        stream.toolUse(event.data.toolName, event.data.toolInput);
        break;

      case 'tool_execution_end':
        stream.toolResult(
          event.data.toolName,
          event.data.result ?? '',
          event.data.success !== false,
        );
        break;

      case 'agent_end': {
        const data = event.data;
        if (data?.cost_usd !== undefined) {
          stream.status('running', 100, `Completed ($${data.cost_usd.toFixed(4)})`);
        } else {
          stream.status('running', 100, 'Completed');
        }
        break;
      }

      case 'extension_ui_request': {
        const { question, options, requestId } = event.data;
        // Await user response and route it back to Pi via extensionUiResponse
        stream.approvalRequest(
          question,
          options || ['yes', 'no'],
        ).then(response => {
          if (response.answered && bridge.isRunning) {
            bridge.sendCommand('extensionUiResponse', {
              requestId,
              answer: response.answer || response.message,
            }).catch(() => { /* Pi may not support this command — ignore */ });
          }
        }).catch(() => { /* ignore approval errors */ });
        break;
      }

      case 'auto_compaction_start':
        stream.status('running', undefined, 'Compacting context');
        break;

      default:
        break;
    }
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.preservedSessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        session.bridge.stop();
        this.preservedSessions.delete(key);
      }
    }
  }
}

function randomSessionId(): string {
  return `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
