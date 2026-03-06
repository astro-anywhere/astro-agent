/**
 * OpenClaw provider adapter — Gateway WebSocket mode
 *
 * Connects to the local OpenClaw gateway via WebSocket and dispatches tasks
 * using `chat.send`. Each task gets its own session key for isolation.
 *
 * Gateway discovery:
 *   1. Read ~/.openclaw/openclaw.json for gateway port + auth token
 *   2. Probe ws://127.0.0.1:{port} for connect.challenge
 *   3. Handshake with client.id='gateway-client', mode='backend'
 *
 * Execution flow:
 *   chat.send({ sessionKey, message, idempotencyKey })
 *   → gateway streams `agent` + `chat` events over WebSocket
 *   → adapter translates to TaskOutputStream calls
 *   → returns TaskResult on session completion
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Task, TaskResult, TaskArtifact } from '../types.js';
import type { ProviderAdapter, TaskOutputStream, ProviderStatus } from './base-adapter.js';

// ---------------------------------------------------------------------------
// Types — OpenClaw Gateway Protocol v3
// ---------------------------------------------------------------------------

interface GatewayConfig {
  port: number;
  token: string;
  url: string;
}

interface GatewayFrame {
  type: 'event' | 'res';
  id?: string;
  event?: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
  seq?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 3;
const CONNECT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Preserved session info for multi-turn resume */
interface PreservedSession {
  sessionKey: string;
  taskId: string;
  workingDirectory?: string;
  createdAt: number;
}

/** TTL for preserved sessions (30 minutes) */
const SESSION_TTL_MS = 30 * 60 * 1000;

export class OpenClawAdapter implements ProviderAdapter {
  readonly type = 'openclaw';
  readonly name = 'OpenClaw';

  private activeTasks = 0;
  private maxTasks = 10;
  private lastError?: string;
  private gatewayConfig: GatewayConfig | null = null;
  private lastAvailableCheck: { available: boolean; at: number } | null = null;

  /** Preserved sessions for multi-turn resume, keyed by taskId */
  private preservedSessions = new Map<string, PreservedSession>();

  async isAvailable(): Promise<boolean> {
    const config = this.readGatewayConfig();
    if (!config) return false;

    this.gatewayConfig = config;

    // Probe the gateway with a quick connect
    try {
      const ok = await this.probeGateway(config);
      this.lastAvailableCheck = { available: ok, at: Date.now() };
      return ok;
    } catch {
      this.lastAvailableCheck = { available: false, at: Date.now() };
      return false;
    }
  }

  async execute(task: Task, stream: TaskOutputStream, signal: AbortSignal): Promise<TaskResult> {
    if (!this.gatewayConfig) {
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
      stream.status('running', 0, 'Connecting to OpenClaw gateway');
      const sessionKey = `astro:task:${task.id}`;
      const result = await this.runViaGateway(task, stream, signal);
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

      return {
        taskId: task.id,
        status: isCancelled ? 'cancelled' : result.error ? 'failed' : 'completed',
        output: result.output,
        error: result.error,
        startedAt,
        completedAt: new Date().toISOString(),
        artifacts: result.artifacts,
        metrics: result.metrics,
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
    // Use cached availability if checked within the last 30 seconds to avoid
    // opening a new WebSocket probe on every status poll
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
   * The OpenClaw gateway preserves session history per sessionKey.
   */
  async resumeTask(
    taskId: string,
    message: string,
    _workingDirectory: string,
    sessionId: string,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    if (!this.gatewayConfig) {
      // Attempt availability check as fallback (mirrors execute() pattern)
      const available = await this.isAvailable();
      if (!available || !this.gatewayConfig) {
        return { success: false, output: '', error: 'OpenClaw gateway not available' };
      }
    }

    // Use the preserved session key, or construct one from the original taskId (keyed by taskId)
    const session = this.preservedSessions.get(taskId);
    const sessionKey = session?.sessionKey || `astro:task:${sessionId}`;

    this.activeTasks++;
    let ws: WebSocket | undefined;
    try {
      ws = await this.connectToGateway(this.gatewayConfig);
      stream.status('running', 5, 'Resuming OpenClaw session');

      // sendChatMessage() registers ws error/close handlers before sending,
      // so it owns cleanup (calls ws.close() in its finish() helper)
      const result = await this.sendChatMessage(ws, sessionKey, message, stream, signal);
      ws = undefined;

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
      ws?.close();
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;
      return { success: false, output: '', error: errorMsg };
    } finally {
      this.activeTasks--;
    }
  }

  /**
   * Mid-execution message injection is not supported for OpenClaw gateway.
   * The gateway processes one chat.send at a time per session.
   */
  async injectMessage(_taskId: string, _content: string, _interrupt?: boolean): Promise<boolean> {
    return false;
  }

  /**
   * Get preserved session context for a task (used by task executor for resume routing).
   */
  getTaskContext(taskId: string): { sessionId: string; workingDirectory: string } | null {
    const session = this.preservedSessions.get(taskId);
    if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.preservedSessions.delete(taskId);
      return null;
    }
    return {
      sessionId: session.sessionKey,
      workingDirectory: session.workingDirectory || '',
    };
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.preservedSessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        this.preservedSessions.delete(key);
      }
    }
  }

  // ─── Gateway Config Discovery ────────────────────────────────────

  private readGatewayConfig(): GatewayConfig | null {
    try {
      const configPath = join(homedir(), '.openclaw', 'openclaw.json');
      if (!existsSync(configPath)) return null;

      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      const port = raw?.gateway?.port as number | undefined;
      if (!port) return null;

      const token = (raw?.gateway?.auth?.token as string) || '';
      const bind = (raw?.gateway?.bind as string) || '127.0.0.1';
      const host = bind === 'loopback' || bind === '127.0.0.1' ? '127.0.0.1' : bind;

      return {
        port,
        token,
        url: `ws://${host}:${port}`,
      };
    } catch {
      return null;
    }
  }

  // ─── Gateway Probe ───────────────────────────────────────────────

  private probeGateway(config: GatewayConfig): Promise<boolean> {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (val: boolean) => { if (!resolved) { resolved = true; resolve(val); } };

      let ws: WebSocket | undefined;
      const timeout = setTimeout(() => {
        ws?.close();
        done(false);
      }, 5000);

      ws = new WebSocket(config.url);

      ws.on('message', (data) => {
        try {
          const frame = JSON.parse(String(data)) as GatewayFrame;
          if (frame.type === 'event' && frame.event === 'connect.challenge') {
            clearTimeout(timeout);
            ws!.close();
            done(true);
          }
        } catch {
          // ignore
        }
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        done(false);
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        done(false);
      });
    });
  }

  // ─── Gateway Connection ──────────────────────────────────────────

  private connectToGateway(config: GatewayConfig): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket | undefined;
      const timeout = setTimeout(() => {
        ws?.close();
        reject(new Error('Gateway connection timeout'));
      }, CONNECT_TIMEOUT_MS);

      ws = new WebSocket(config.url);

      const handshakeHandler = (data: Buffer) => {
        try {
          const frame = JSON.parse(String(data)) as GatewayFrame;

          // Step 1: Receive challenge, send connect
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

          // Step 2: Receive connect response
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
        } catch {
          // ignore parse errors during handshake
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

  // ─── Task Execution via Gateway ──────────────────────────────────

  private async runViaGateway(
    task: Task,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<{
    output: string;
    error?: string;
    artifacts?: TaskArtifact[];
    metrics?: TaskResult['metrics'];
  }> {
    const ws = await this.connectToGateway(this.gatewayConfig!);
    stream.status('running', 5, 'Connected to gateway');

    return new Promise((resolve) => {

      const sessionKey = `astro:task:${task.id}`;
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
        ws.close();
        resolve({
          output: outputText,
          error,
          artifacts: artifacts.length > 0 ? artifacts : undefined,
          metrics: lastMetrics,
        });
      };

      /** Finish when both lifecycle.end and chat.final have been seen, or
       *  after a short grace period if only lifecycle.end arrived. */
      const tryFinishAfterLifecycle = () => {
        if (chatFinalReceived) {
          finish();
        } else {
          // Grace period: if chat.final doesn't arrive within 500ms, finish anyway
          gracePeriodTimeout = setTimeout(() => { if (!finished) finish(); }, 500);
        }
      };

      // Handle abort
      const abortHandler = () => {
        if (runId) {
          // Try to abort the chat
          try {
            ws.send(JSON.stringify({
              type: 'req',
              id: 'abort-1',
              method: 'chat.abort',
              params: { sessionKey },
            }));
          } catch {
            // ignore
          }
        }
        finish('Task cancelled');
      };
      signal.addEventListener('abort', abortHandler);

      // Handle timeout
      let taskTimeout: ReturnType<typeof setTimeout> | undefined;
      if (task.timeout) {
        taskTimeout = setTimeout(() => {
          finish('Task timed out');
        }, task.timeout);
      }

      // Handle incoming events
      ws.on('message', (data) => {
        if (finished) return;

        let frame: GatewayFrame;
        try {
          frame = JSON.parse(String(data));
        } catch {
          return;
        }

        // Handle chat.send response
        if (frame.type === 'res' && frame.id === 'chat-send-1') {
          if (frame.ok) {
            runId = frame.payload?.runId as string;
            stream.status('running', 10, 'Task dispatched to agent');
          } else {
            finish(`Gateway rejected task: ${frame.error?.message || 'unknown'}`);
          }
          return;
        }

        // Handle agent events
        if (frame.type === 'event' && frame.event === 'agent') {
          const p = frame.payload || {};

          // Filter to our session — gateway prepends 'agent:main:' to sessionKey
          if (p.sessionKey !== `agent:main:${sessionKey}` && p.sessionKey !== sessionKey) {
            return;
          }

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
              // Extract usage metrics from lifecycle.end if available
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

        // Handle chat events (for final state + model info)
        if (frame.type === 'event' && frame.event === 'chat') {
          const p = frame.payload || {};

          // Filter to our session — gateway prepends 'agent:main:' to sessionKey
          if (p.sessionKey !== `agent:main:${sessionKey}` && p.sessionKey !== sessionKey) {
            return;
          }

          const state = p.state as string;

          if (state === 'final') {
            chatFinalReceived = true;
            // Extract final message content
            const message = p.message as Record<string, unknown> | undefined;
            if (message) {
              const content = message.content as Array<{ type: string; text?: string }> | undefined;
              if (content) {
                for (const block of content) {
                  if (block.type === 'text' && block.text) {
                    // Only add if not already captured via agent delta events
                    if (!outputText.includes(block.text)) {
                      outputText += block.text;
                    }
                  }
                }
              }
            }
            // Extract model/usage from chat.final if not yet captured
            if (!lastMetrics) {
              const usage = p.usage as { input_tokens?: number; output_tokens?: number } | undefined;
              const cost = (p.total_cost_usd ?? p.cost_usd) as number | undefined;
              const model = (p.model ?? message?.model) as string | undefined;
              if (usage || cost !== undefined || model) {
                lastMetrics = {
                  inputTokens: usage?.input_tokens,
                  outputTokens: usage?.output_tokens,
                  totalCost: cost,
                  model,
                };
              }
            }
            // If lifecycle already ended, finish immediately
            if (lifecycleEnded) finish();
          }

          return;
        }

        // Handle tick/health/presence (ignore)
        if (frame.type === 'event') {
          const ignoredEvents = ['tick', 'health', 'presence', 'heartbeat'];
          if (frame.event && ignoredEvents.includes(frame.event)) return;
        }
      });

      ws.on('close', () => {
        if (!finished) {
          finish('Gateway connection closed unexpectedly');
        }
      });

      ws.on('error', (err) => {
        if (!finished) {
          finish(`Gateway WebSocket error: ${err.message}`);
        }
      });

      // Build the prompt
      const effectivePrompt = task.systemPrompt
        ? `${task.systemPrompt}\n\n---\n\n${task.prompt}`
        : task.prompt;

      // Send chat.send
      try {
        ws.send(JSON.stringify({
          type: 'req',
          id: 'chat-send-1',
          method: 'chat.send',
          params: {
            sessionKey,
            message: effectivePrompt,
            idempotencyKey,
          },
        }));
      } catch (err) {
        finish(`Failed to send chat.send: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Note: signal listener and timeout cleanup is handled in finish()
    });
  }

  // ─── Reusable Chat Message Sender (for resume) ────────────────────

  /**
   * Send a chat message to an already-connected gateway WebSocket.
   * Used by resumeTask() to continue a conversation on the same sessionKey.
   */
  private sendChatMessage(
    ws: WebSocket,
    sessionKey: string,
    message: string,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<{ output: string; error?: string }> {
    return new Promise((resolve) => {
      const idempotencyKey = randomUUID();
      let outputText = '';
      let finished = false;
      let lifecycleEnded = false;
      let chatFinalReceived = false;
      let gracePeriodTimeout: ReturnType<typeof setTimeout> | undefined;

      const finish = (error?: string) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abortHandler);
        if (gracePeriodTimeout) clearTimeout(gracePeriodTimeout);
        ws.close();
        resolve({ output: outputText, error });
      };

      const tryFinishAfterLifecycle = () => {
        if (chatFinalReceived) {
          finish();
        } else {
          gracePeriodTimeout = setTimeout(() => { if (!finished) finish(); }, 500);
        }
      };

      const abortHandler = () => {
        try {
          ws.send(JSON.stringify({
            type: 'req',
            id: 'abort-resume',
            method: 'chat.abort',
            params: { sessionKey },
          }));
        } catch { /* ignore */ }
        finish('Task cancelled');
      };
      signal.addEventListener('abort', abortHandler);

      ws.on('message', (data) => {
        if (finished) return;

        let frame: GatewayFrame;
        try {
          frame = JSON.parse(String(data));
        } catch { return; }

        if (frame.type === 'res' && frame.id === 'chat-resume-1') {
          if (!frame.ok) {
            finish(`Gateway rejected resume: ${frame.error?.message || 'unknown'}`);
          }
          return;
        }

        if (frame.type === 'event' && frame.event === 'agent') {
          const p = frame.payload || {};
          if (p.sessionKey !== `agent:main:${sessionKey}` && p.sessionKey !== sessionKey) return;

          const streamType = p.stream as string;
          const eventData = p.data as Record<string, unknown> | undefined;

          if (streamType === 'lifecycle') {
            const phase = eventData?.phase as string;
            if (phase === 'end') {
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
            const toolName = (eventData?.name as string) || 'unknown';
            stream.toolUse(toolName, eventData?.input || {});
          } else if (streamType === 'tool_result') {
            const toolName = (eventData?.name as string) || 'unknown';
            stream.toolResult(toolName, eventData?.result || '', eventData?.success !== false);
          } else if (streamType === 'file_change') {
            const filePath = eventData?.path as string || eventData?.file as string;
            if (filePath) {
              const rawAction = (eventData?.type as string) || 'modified';
              const action = (['created', 'modified', 'deleted'].includes(rawAction) ? rawAction : 'modified') as 'created' | 'modified' | 'deleted';
              stream.fileChange(filePath, action);
            }
          }
          return;
        }

        if (frame.type === 'event' && frame.event === 'chat') {
          const p = frame.payload || {};
          if (p.sessionKey !== `agent:main:${sessionKey}` && p.sessionKey !== sessionKey) return;
          if ((p.state as string) === 'final') {
            chatFinalReceived = true;
            if (lifecycleEnded) finish();
          }
          return;
        }
      });

      ws.on('close', () => { if (!finished) finish('Gateway connection closed'); });
      ws.on('error', (err) => { if (!finished) finish(`Gateway error: ${err.message}`); });

      // Send the resume message
      try {
        ws.send(JSON.stringify({
          type: 'req',
          id: 'chat-resume-1',
          method: 'chat.send',
          params: {
            sessionKey,
            message,
            idempotencyKey,
          },
        }));
      } catch (err) {
        finish(`Failed to send chat.send: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
}
