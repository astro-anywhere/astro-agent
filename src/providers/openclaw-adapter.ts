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

export class OpenClawAdapter implements ProviderAdapter {
  readonly type = 'openclaw';
  readonly name = 'OpenClaw';

  private activeTasks = 0;
  private maxTasks = 10;
  private lastError?: string;
  private gatewayConfig: GatewayConfig | null = null;

  async isAvailable(): Promise<boolean> {
    const config = this.readGatewayConfig();
    if (!config) return false;

    this.gatewayConfig = config;

    // Probe the gateway with a quick connect
    try {
      const ok = await this.probeGateway(config);
      return ok;
    } catch {
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
      const result = await this.runViaGateway(task, stream, signal);
      const isCancelled = signal.aborted || result.error === 'Task cancelled';
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
    const available = await this.isAvailable();
    return {
      available,
      version: null,
      activeTasks: this.activeTasks,
      maxTasks: this.maxTasks,
      lastError: this.lastError,
    };
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
      const timeout = setTimeout(() => {
        ws.close();
        resolve(false);
      }, 5000);

      const ws = new WebSocket(config.url);

      ws.on('message', (data) => {
        try {
          const frame = JSON.parse(String(data)) as GatewayFrame;
          if (frame.type === 'event' && frame.event === 'connect.challenge') {
            clearTimeout(timeout);
            ws.close();
            resolve(true);
          }
        } catch {
          // ignore
        }
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  // ─── Gateway Connection ──────────────────────────────────────────

  private connectToGateway(config: GatewayConfig): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Gateway connection timeout'));
      }, CONNECT_TIMEOUT_MS);

      const ws = new WebSocket(config.url);

      ws.on('message', (data) => {
        try {
          const frame = JSON.parse(String(data)) as GatewayFrame;

          // Step 1: Receive challenge, send connect
          if (frame.type === 'event' && frame.event === 'connect.challenge') {
            ws.send(JSON.stringify({
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
            if (frame.ok) {
              resolve(ws);
            } else {
              ws.close();
              reject(new Error(`Gateway handshake failed: ${frame.error?.message || 'unknown'}`));
            }
          }
        } catch {
          // ignore parse errors during handshake
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
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

      const finish = (error?: string) => {
        if (finished) return;
        finished = true;
        if (taskTimeout) clearTimeout(taskTimeout);
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
          setTimeout(() => { if (!finished) finish(); }, 500);
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

          // Filter to our session
          if (p.sessionKey !== `agent:main:${sessionKey}` && p.sessionKey !== sessionKey) {
            // Also check by runId
            if (runId && p.runId !== runId) return;
          }

          const streamType = p.stream as string;
          const eventData = p.data as Record<string, unknown> | undefined;

          if (streamType === 'lifecycle') {
            const phase = eventData?.phase as string;
            if (phase === 'start') {
              stream.sessionInit(
                (p.sessionKey as string) || sessionKey,
                undefined, // model comes from chat event
              );
            } else if (phase === 'end') {
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
          }

          return;
        }

        // Handle chat events (for final state + model info)
        if (frame.type === 'event' && frame.event === 'chat') {
          const p = frame.payload || {};

          // Filter to our session
          if (p.sessionKey !== `agent:main:${sessionKey}` && p.sessionKey !== sessionKey) {
            if (runId && p.runId !== runId) return;
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

      // Ensure signal listener and timeout are cleaned up when ws closes
      ws.on('close', () => {
        signal.removeEventListener('abort', abortHandler);
        if (taskTimeout) clearTimeout(taskTimeout);
      });
    });
  }
}
