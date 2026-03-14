/**
 * OpenClaw provider adapter — Thin wrapper delegating to OpenClawBridge
 *
 * When a bridge is injected via setBridge(), task execution goes through
 * the bridge's shared WebSocket connection (session-multiplexed).
 * Falls back to standalone connections when no bridge is available.
 *
 * The HTTP llm-task path (runLlmTask) remains in the adapter since it
 * uses a separate HTTP POST, not the WebSocket.
 */

import { randomUUID } from 'node:crypto';
import type { Task, TaskResult, TaskArtifact, ExecutionSummary } from '../types.js';
import { type ProviderAdapter, type NormalizedTask, type TaskOutputStream, type ProviderStatus, SUMMARY_PROMPT, SUMMARY_TIMEOUT_MS, parseSummaryResponse, createNoopStream } from './base-adapter.js';
import type { OpenClawBridge, TaskSessionResult } from '../lib/openclaw-bridge.js';
import {
  type GatewayConfig,
  readGatewayConfig,
  probeGateway,
  parseGatewayFrame,
  makeSessionKey,
  matchesSessionKey,
  PROTOCOL_VERSION,
  CONNECT_TIMEOUT_MS,
} from '../lib/openclaw-gateway.js';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for preserved sessions (10 minutes) */
const SESSION_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Preserved session info for multi-turn resume */
interface PreservedSession {
  sessionKey: string;
  taskId: string;
  workingDirectory?: string;
  /** Original project directory (before worktree), for fallback when worktree is cleaned up */
  originalWorkingDirectory?: string;
  createdAt: number;
}

export class OpenClawAdapter implements ProviderAdapter {
  readonly type = 'openclaw';
  readonly name = 'OpenClaw';

  private activeTasks = 0;
  private maxTasks = 10;
  private lastError?: string;
  private gatewayConfig: GatewayConfig | null = null;
  private lastAvailableCheck: { available: boolean; at: number } | null = null;
  private bridge: OpenClawBridge | null = null;

  /** Preserved sessions for multi-turn resume, keyed by taskId */
  private preservedSessions = new Map<string, PreservedSession>();

  // ─── Bridge Injection ───────────────────────────────────────────

  /**
   * Inject the shared bridge for task execution.
   * Called by task-executor when the bridge becomes available.
   */
  setBridge(bridge: OpenClawBridge): void {
    this.bridge = bridge;
  }

  // ─── Availability ───────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    // If bridge is connected, we're available
    if (this.bridge?.isConnected) {
      this.lastAvailableCheck = { available: true, at: Date.now() };
      return true;
    }

    const config = readGatewayConfig();
    if (!config) return false;

    this.gatewayConfig = config;

    // Probe the gateway with a quick connect
    try {
      const ok = await probeGateway(config.url);
      this.lastAvailableCheck = { available: ok, at: Date.now() };
      return ok;
    } catch {
      this.lastAvailableCheck = { available: false, at: Date.now() };
      return false;
    }
  }

  // ─── Task Execution ─────────────────────────────────────────────

  async execute(task: NormalizedTask, stream: TaskOutputStream, signal: AbortSignal): Promise<TaskResult> {
    // Ensure we have config or bridge
    if (!this.bridge?.isConnected && !this.gatewayConfig) {
      const available = await this.isAvailable();
      if (!available) {
        return {
          taskId: task.id,
          status: 'failed',
          error: 'OpenClaw gateway not available',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      }
    }

    this.activeTasks++;
    const startedAt = new Date().toISOString();

    try {
      // For plan generation with outputFormat, use the llm-task HTTP endpoint
      if (task.type === 'plan' && task.outputFormat) {
        try {
          const result = await this.runLlmTask(task, stream, signal);
          return {
            taskId: task.id,
            status: result.error ? 'failed' : 'completed',
            output: result.output,
            error: result.error,
            startedAt,
            completedAt: new Date().toISOString(),
            metrics: result.metrics,
          };
        } catch (err) {
          // Fall through to agent mode
          console.warn('[openclaw] llm-task failed, falling back to agent mode:', err);
        }
      }

      stream.status('running', 0, 'Connecting to OpenClaw gateway');
      const sessionKey = makeSessionKey(task.id);

      // Build the prompt
      let effectivePrompt = task.systemPrompt
        ? `${task.systemPrompt}\n\n---\n\n${task.prompt}`
        : task.prompt;

      // Prepend conversation history if available
      if (task.messages && task.messages.length > 0) {
        const conversationContext = task.messages
          .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
          .join('\n\n');
        effectivePrompt = `${conversationContext}\n\nHuman: ${effectivePrompt}`;
      }

      let result: TaskSessionResult;

      if (this.bridge?.isConnected) {
        // Bridge-backed execution (shared WebSocket)
        stream.status('running', 5, 'Connected to gateway');
        result = await this.bridge.executeTask(
          sessionKey, effectivePrompt, stream, signal, task.timeout,
        );
      } else {
        // Fallback: standalone connection
        result = await this.runViaStandaloneConnection(
          sessionKey, effectivePrompt, stream, signal, task.timeout,
        );
      }

      const isCancelled = signal.aborted || result.error === 'Task cancelled';

      // Preserve session for multi-turn resume (unless cancelled/failed)
      if (!isCancelled && !result.error) {
        this.cleanupExpiredSessions();
        this.preservedSessions.set(task.id, {
          sessionKey,
          taskId: task.id,
          workingDirectory: task.workingDirectory,
          createdAt: Date.now(),
        });
      }

      // Generate structured summary for execution tasks via session resume
      let summary: ExecutionSummary | undefined;
      const isExecutionTask = !task.type || task.type === 'execution';
      const succeeded = !isCancelled && !result.error;
      if (isExecutionTask && succeeded) {
        try {
          stream.status('running', 80, 'Generating summary');
          summary = await this.generateSummary(task.id, task.workingDirectory);
          if (summary) {
            console.log(`[openclaw] Task ${task.id}: summary generated — status=${summary.status}, keyFindings=${summary.keyFindings?.length ?? 0}`);
          } else {
            console.warn(`[openclaw] Task ${task.id}: summary generation returned undefined`);
          }
        } catch (summaryError) {
          console.warn(`[openclaw] Task ${task.id}: summary generation failed:`, summaryError);
        }
      }

      return {
        taskId: task.id,
        status: isCancelled ? 'cancelled' : result.error ? 'failed' : 'completed',
        output: result.output,
        error: result.error,
        startedAt,
        completedAt: new Date().toISOString(),
        artifacts: result.artifacts,
        metrics: result.metrics,
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
    // Use cached availability if checked within the last 30 seconds
    let available: boolean;
    if (this.lastAvailableCheck && Date.now() - this.lastAvailableCheck.at < 30_000) {
      available = this.lastAvailableCheck.available;
    } else {
      available = await this.isAvailable();
    }
    return {
      available,
      version: null,
      activeTasks: this.activeTasks,
      maxTasks: this.maxTasks,
      lastError: this.lastError,
    };
  }

  // ─── Multi-Turn Resume ─────────────────────────────────────────

  /**
   * Resume a completed session by sending another chat.send to the same sessionKey.
   */
  async resumeTask(
    taskId: string,
    message: string,
    _workingDirectory: string,
    sessionId: string,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    // Use the preserved session key, or resolve from the provider sessionId
    const session = this.preservedSessions.get(taskId);
    const sessionKey = session?.sessionKey || this.resolveSessionKey(sessionId);

    this.activeTasks++;
    try {
      let result: TaskSessionResult;

      if (this.bridge?.isConnected) {
        stream.status('running', 5, 'Resuming OpenClaw session');
        result = await this.bridge.sendChatMessage(sessionKey, message, stream, signal);
      } else {
        // Fallback: standalone connection for resume
        if (!this.gatewayConfig) {
          const available = await this.isAvailable();
          if (!available || !this.gatewayConfig) {
            return { success: false, output: '', error: 'OpenClaw gateway not available' };
          }
        }
        stream.status('running', 5, 'Resuming OpenClaw session');
        result = await this.runViaStandaloneConnection(
          sessionKey, message, stream, signal,
        );
      }

      // Update preserved session timestamp
      if (session) {
        session.createdAt = Date.now();
      }

      return {
        success: !result.error,
        output: result.output,
        error: result.error,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;
      return { success: false, output: '', error: errorMsg };
    } finally {
      this.activeTasks--;
    }
  }

  /**
   * Mid-execution message injection is not supported for OpenClaw gateway.
   */
  async injectMessage(): Promise<boolean> {
    return false;
  }

  /**
   * Get preserved session context for a task (used by task executor for resume routing).
   */
  getTaskContext(taskId: string): { sessionId: string; workingDirectory: string; originalWorkingDirectory?: string } | null {
    this.cleanupExpiredSessions();
    const session = this.preservedSessions.get(taskId);
    if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.preservedSessions.delete(taskId);
      return null;
    }
    return {
      sessionId: session.sessionKey,
      workingDirectory: session.workingDirectory || '',
      originalWorkingDirectory: session.originalWorkingDirectory,
    };
  }

  /**
   * Set the original (pre-worktree) working directory on a session.
   * Called by the task executor after workspace preparation so the adapter
   * can fall back to it when the worktree is cleaned up.
   */
  setOriginalWorkingDirectory(taskId: string, originalDir: string): void {
    const session = this.preservedSessions.get(taskId);
    if (session) {
      session.originalWorkingDirectory = originalDir;
    }
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.preservedSessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        this.preservedSessions.delete(key);
      }
    }
  }

  // ─── Summary Generation ──────────────────────────────────────

  /**
   * Generate a structured execution summary by resuming the completed OpenClaw session.
   */
  async generateSummary(taskId: string, workingDirectory?: string): Promise<ExecutionSummary | undefined> {
    const session = this.preservedSessions.get(taskId);
    if (!session?.sessionKey) {
      console.log(`[openclaw] No session to resume for summary (task ${taskId})`);
      return undefined;
    }

    if (!this.bridge?.isConnected && !this.gatewayConfig) {
      const available = await this.isAvailable();
      if (!available) {
        console.warn(`[openclaw] Gateway not available for summary generation (task ${taskId})`);
        return undefined;
      }
    }

    const summaryAbort = new AbortController();
    const summaryTimeout = setTimeout(() => summaryAbort.abort(), SUMMARY_TIMEOUT_MS);

    try {
      const result = await this.resumeTask(
        taskId,
        SUMMARY_PROMPT,
        workingDirectory || session.workingDirectory || '',
        session.sessionKey,
        createNoopStream(),
        summaryAbort.signal,
      );

      if (!result.success || !result.output) {
        console.warn(`[openclaw] Task ${taskId}: summary resume failed — success=${result.success}, error=${result.error}`);
        return undefined;
      }

      return parseSummaryResponse(result.output, `[openclaw] Task ${taskId}`);
    } finally {
      clearTimeout(summaryTimeout);
    }
  }

  /**
   * Resolve a provider session ID to a valid OpenClaw session key.
   */
  private resolveSessionKey(sessionId: string): string {
    if (sessionId.startsWith('astro:task:')) return sessionId;
    const stripped = sessionId.replace(/^agent:main:/, '');
    if (stripped.startsWith('astro:task:')) return stripped;
    return `astro:task:${sessionId}`;
  }

  // ─── Standalone Connection (Fallback) ──────────────────────────

  /**
   * Execute via a standalone WebSocket connection when no bridge is available.
   * This preserves backward compatibility for cases where the bridge isn't wired.
   */
  private async runViaStandaloneConnection(
    sessionKey: string,
    message: string,
    stream: TaskOutputStream,
    signal: AbortSignal,
    timeout?: number,
  ): Promise<TaskSessionResult> {
    const config = this.gatewayConfig;
    if (!config) {
      throw new Error('Gateway config not available');
    }

    const ws = await this.connectToGateway(config);
    stream.status('running', 5, 'Connected to gateway');

    return new Promise((resolve) => {
      const idempotencyKey = randomUUID();
      const artifacts: TaskArtifact[] = [];
      let outputText = '';
      let lastMetrics: TaskResult['metrics'] | undefined;
      let runId: string | undefined;
      let finished = false;
      let lifecycleEnded = false;
      let chatFinalReceived = false;
      let gracePeriodTimeout: ReturnType<typeof setTimeout> | undefined;

      const finish = (error?: string) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abortHandler);
        if (taskTimeout) clearTimeout(taskTimeout);
        if (gracePeriodTimeout) clearTimeout(gracePeriodTimeout);
        ws.removeAllListeners();
        ws.close();
        resolve({
          output: outputText,
          error,
          artifacts: artifacts.length > 0 ? artifacts : undefined,
          metrics: lastMetrics,
        });
      };

      const tryFinishAfterLifecycle = () => {
        if (chatFinalReceived) {
          finish();
        } else {
          gracePeriodTimeout = setTimeout(() => { if (!finished) finish(); }, 500);
        }
      };

      const abortHandler = () => {
        if (runId) {
          try {
            ws.send(JSON.stringify({
              type: 'req',
              id: 'abort-1',
              method: 'chat.abort',
              params: { sessionKey },
            }));
          } catch { /* ignore */ }
        }
        finish('Task cancelled');
      };
      signal.addEventListener('abort', abortHandler);

      let taskTimeout: ReturnType<typeof setTimeout> | undefined;
      if (timeout) {
        taskTimeout = setTimeout(() => { finish('Task timed out'); }, timeout);
      }

      ws.on('message', (data) => {
        if (finished) return;
        const frame = parseGatewayFrame(data);
        if (!frame) return;

        if (frame.type === 'res' && frame.id === 'chat-send-1') {
          if (frame.ok) {
            runId = frame.payload?.runId as string;
            stream.status('running', 10, 'Task dispatched to agent');
          } else {
            finish(`Gateway rejected task: ${frame.error?.message || 'unknown'}`);
          }
          return;
        }

        if (frame.type === 'event' && frame.event === 'agent') {
          const p = frame.payload || {};
          if (!matchesSessionKey(p.sessionKey, sessionKey)) return;

          const streamType = p.stream as string;
          const eventData = p.data as Record<string, unknown> | undefined;

          if (streamType === 'lifecycle') {
            const phase = eventData?.phase as string;
            if (phase === 'start') {
              stream.sessionInit(
                (p.sessionKey as string) || sessionKey,
                (eventData?.model as string) || undefined,
              );
            } else if (phase === 'end') {
              const usage = eventData?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
              const cost = (eventData?.total_cost_usd ?? eventData?.cost_usd) as number | undefined;
              const numTurns = eventData?.num_turns as number | undefined;
              const durationMs = eventData?.duration_ms as number | undefined;
              const model = eventData?.model as string | undefined;
              if (usage || cost !== undefined) {
                lastMetrics = {
                  inputTokens: usage?.input_tokens,
                  outputTokens: usage?.output_tokens,
                  totalCost: cost,
                  numTurns,
                  durationMs,
                  model,
                };
              }
              lifecycleEnded = true;
              tryFinishAfterLifecycle();
            }
          } else if (streamType === 'assistant') {
            const delta = eventData?.delta as string || eventData?.text as string;
            if (delta) {
              outputText += delta;
              stream.text(delta);
            }
          } else if (streamType === 'tool_use') {
            const toolName = (eventData?.name as string) || (eventData?.toolName as string) || 'unknown';
            const toolInput = eventData?.input || eventData?.toolInput || {};
            stream.toolUse(toolName, toolInput);
          } else if (streamType === 'tool_result') {
            const toolName = (eventData?.name as string) || (eventData?.toolName as string) || 'unknown';
            const result = eventData?.result || eventData?.output || '';
            const success = eventData?.success !== false;
            stream.toolResult(toolName, result, success);
          } else if (streamType === 'file_change') {
            const filePath = eventData?.path as string || eventData?.file as string;
            const rawAction = (eventData?.type as string) || (eventData?.action as string) || 'modified';
            const action = (['created', 'modified', 'deleted'].includes(rawAction) ? rawAction : 'modified') as 'created' | 'modified' | 'deleted';
            if (filePath) {
              artifacts.push({ type: 'file', name: filePath, path: filePath, metadata: { action } });
              stream.fileChange(filePath, action);
            }
          }
          return;
        }

        if (frame.type === 'event' && frame.event === 'chat') {
          const p = frame.payload || {};
          if (!matchesSessionKey(p.sessionKey, sessionKey)) return;

          if ((p.state as string) === 'final') {
            chatFinalReceived = true;
            const chatMessage = p.message as Record<string, unknown> | undefined;
            if (chatMessage) {
              const content = chatMessage.content as Array<{ type: string; text?: string }> | undefined;
              if (content) {
                for (const block of content) {
                  if (block.type === 'text' && block.text && !outputText.includes(block.text)) {
                    outputText += block.text;
                  }
                }
              }
            }
            if (!lastMetrics) {
              const usage = p.usage as { input_tokens?: number; output_tokens?: number } | undefined;
              const cost = (p.total_cost_usd ?? p.cost_usd) as number | undefined;
              const model = (p.model ?? (p.message as Record<string, unknown>)?.model) as string | undefined;
              if (usage || cost !== undefined || model) {
                lastMetrics = {
                  inputTokens: usage?.input_tokens,
                  outputTokens: usage?.output_tokens,
                  totalCost: cost,
                  model,
                };
              }
            }
            if (lifecycleEnded) finish();
          }
          return;
        }
      });

      ws.on('close', () => { if (!finished) finish('Gateway connection closed unexpectedly'); });
      ws.on('error', (err) => { if (!finished) finish(`Gateway WebSocket error: ${err.message}`); });

      try {
        ws.send(JSON.stringify({
          type: 'req',
          id: 'chat-send-1',
          method: 'chat.send',
          params: { sessionKey, message, idempotencyKey },
        }));
      } catch (err) {
        finish(`Failed to send chat.send: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  /**
   * Connect to gateway with full handshake (standalone fallback).
   */
  private connectToGateway(config: GatewayConfig): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws: WebSocket = new WebSocket(config.url);
      const timeout = setTimeout(() => {
        ws.removeAllListeners();
        ws.close();
        reject(new Error('Gateway connection timeout'));
      }, CONNECT_TIMEOUT_MS);

      const handshakeHandler = (data: Buffer) => {
        const frame = parseGatewayFrame(data);
        if (!frame) return;

        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          ws!.send(JSON.stringify({
            type: 'req',
            id: 'connect-1',
            method: 'connect',
            params: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: {
                id: 'gateway-client',
                version: 'dev',
                platform: process.platform,
                mode: 'backend',
              },
              caps: ['tool-events'],
              auth: { token: config.token },
              role: 'operator',
              scopes: ['operator.read', 'operator.write'],
            },
          }));
        }

        if (frame.type === 'res' && frame.id === 'connect-1') {
          clearTimeout(timeout);
          ws!.removeListener('message', handshakeHandler);
          ws!.removeListener('error', errorHandler);
          if (frame.ok) {
            resolve(ws!);
          } else {
            ws!.close();
            reject(new Error(`Gateway handshake failed: ${frame.error?.message || 'unknown'}`));
          }
        }
      };

      const errorHandler = (err: Error) => {
        clearTimeout(timeout);
        ws?.removeListener('message', handshakeHandler);
        reject(err);
      };

      ws.on('message', handshakeHandler);
      ws.on('error', errorHandler);
    });
  }

  // ─── LLM Task (Structured JSON via HTTP) ──────────────────────────

  /**
   * Use the Gateway's HTTP `POST /tools/invoke` endpoint for structured JSON
   * plan generation.
   */
  private async runLlmTask(
    task: Task,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<{
    output: string;
    error?: string;
    metrics?: TaskResult['metrics'];
  }> {
    const config = this.gatewayConfig || readGatewayConfig();
    if (!config) {
      throw new Error('Gateway config not available');
    }

    // Derive HTTP URL from the WebSocket URL (same host:port)
    const httpUrl = config.url.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
    const invokeUrl = `${httpUrl}/tools/invoke`;

    const effectivePrompt = task.systemPrompt
      ? `${task.systemPrompt}\n\n---\n\n${task.prompt}`
      : task.prompt;

    stream.status('running', 0, 'Generating structured plan via llm-task');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.token) {
      headers['Authorization'] = `Bearer ${config.token}`;
    }

    const body = JSON.stringify({
      tool: 'llm-task',
      action: 'json',
      args: {
        prompt: effectivePrompt,
        schema: task.outputFormat!.schema,
        ...(task.model ? { model: task.model } : {}),
      },
    });

    const response = await fetch(invokeUrl, {
      method: 'POST',
      headers,
      body,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`llm-task HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json() as {
      ok?: boolean;
      result?: unknown;
      error?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      cost_usd?: number;
      model?: string;
    };

    if (result.error || result.ok === false) {
      return {
        output: '',
        error: result.error || 'llm-task returned failure',
      };
    }

    const outputJson = typeof result.result === 'string'
      ? result.result
      : JSON.stringify(result.result);

    stream.text(outputJson);

    return {
      output: outputJson,
      metrics: (result.usage || result.cost_usd !== undefined) ? {
        inputTokens: result.usage?.input_tokens,
        outputTokens: result.usage?.output_tokens,
        totalCost: result.cost_usd,
        model: result.model,
      } : undefined,
    };
  }
}
