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

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PiAdapter implements ProviderAdapter {
  readonly type = 'pi';
  readonly name = 'Pi';

  private activeTasks = 0;
  private maxTasks = 2;
  private lastError?: string;
  private piPath: string | null = null;

  /** Preserved sessions for multi-turn resume, keyed by taskId */
  private preservedSessions = new Map<string, PreservedSession>();

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

    try {
      stream.status('running', 0, 'Starting Pi agent');

      const bridge = new PiRpcBridge(this.piPath!);
      bridge.start(signal, task.workingDirectory);

      let lastMetrics: TaskResult['metrics'] | undefined;
      let outputText = '';

      // Wire up event handler
      const eventHandler = (event: PiEvent) => {
        this.mapEventToStream(event, stream);

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
      const response = await bridge.prompt(effectivePrompt);
      const succeeded = response.ok;

      bridge.offEvent(eventHandler);

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

      // Generate summary for execution tasks
      let summary: ExecutionSummary | undefined;
      const isExecutionTask = !task.type || task.type === 'execution';
      if (isExecutionTask && succeeded) {
        try {
          stream.status('running', 80, 'Generating summary');
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
    _signal: AbortSignal,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const session = this.preservedSessions.get(taskId);
    if (!session || !session.bridge.isRunning) {
      return { success: false, output: '', error: 'No active Pi session for this task' };
    }

    this.activeTasks++;
    try {
      let outputText = '';

      const eventHandler = (event: PiEvent) => {
        this.mapEventToStream(event, stream);
        if (event.event === 'message_update') {
          const delta = event.data?.delta || event.data?.text || '';
          if (delta) outputText += delta;
        }
      };
      session.bridge.onEvent(eventHandler);

      const response = await session.bridge.steer(message);
      session.bridge.offEvent(eventHandler);

      // Update session timestamp
      session.createdAt = Date.now();

      return {
        success: response.ok,
        output: outputText,
        error: response.error?.message,
      };
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
    if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
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

  private mapEventToStream(event: PiEvent, stream: TaskOutputStream): void {
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

      case 'extension_ui_request':
        // Map to approval request — fire and forget since we can't await in event handler
        stream.approvalRequest(
          event.data.question,
          event.data.options || ['yes', 'no'],
        ).catch(() => { /* ignore */ });
        break;

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
