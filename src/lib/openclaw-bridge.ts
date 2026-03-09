/**
 * OpenClaw Bridge — Persistent gateway connection for channel operations + task execution
 *
 * Maintains a single long-lived WebSocket to the OpenClaw gateway for:
 *   1. Channel relay: notification delivery, approval routing, inbound message forwarding
 *   2. Task execution: session-multiplexed chat.send for adapter-delegated tasks
 *
 * Architecture after consolidation:
 *   Server → Relay → Agent Runner → OpenClawAdapter (thin wrapper)
 *                                         ↓ setBridge()
 *                                   OpenClawBridge (single WS) → local gateway
 *                                         ↑
 *                                   Channel relay (notifications/approvals)
 */

import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import {
  type GatewayConfig,
  type GatewayFrame,
  readGatewayConfig,
  parseGatewayFrame,
  matchesSessionKey,
  PROTOCOL_VERSION,
  CONNECT_TIMEOUT_MS,
} from './openclaw-gateway.js';
import type { TaskResult, TaskArtifact } from '../types.js';
import type { TaskOutputStream } from '../providers/base-adapter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/** Per-task session state for multiplexed execution */
interface TaskSession {
  sessionKey: string;
  outputText: string;
  artifacts: TaskArtifact[];
  metrics?: TaskResult['metrics'];
  lifecycleEnded: boolean;
  chatFinalReceived: boolean;
  finished: boolean;
  stream: TaskOutputStream;
  signal: AbortSignal;
  abortHandler: () => void;
  taskTimeout?: ReturnType<typeof setTimeout>;
  gracePeriodTimeout?: ReturnType<typeof setTimeout>;
  resolve: (result: TaskSessionResult) => void;
}

export interface TaskSessionResult {
  output: string;
  error?: string;
  artifacts?: TaskArtifact[];
  metrics?: TaskResult['metrics'];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000;
const TASK_REQUEST_TIMEOUT_MS = 120_000; // chat.send can take longer to respond
const APPROVAL_TIMEOUT_MS = 300_000; // 5 minutes
const RECONNECT_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export class OpenClawBridge extends EventEmitter {
  private ws: WebSocket | null = null;
  private gatewayConfig: GatewayConfig | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private pendingApprovals = new Map<string, PendingRequest>();
  private activeSessions = new Map<string, TaskSession>();
  private _connected = false;
  private _started = false;
  private _connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Default recipient for send (e.g., Telegram username, phone). Read from openclaw.json */
  private defaultRecipient: string | null = null;
  /** Telegram bot token, cached from config at start() */
  private telegramBotToken: string | null = null;

  get isConnected(): boolean {
    return this._connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  async start(): Promise<boolean> {
    if (this._started) return this._connected;

    const config = readGatewayConfig();
    if (!config) return false;

    this.gatewayConfig = config;
    this.defaultRecipient = config.defaultRecipient || null;
    this.telegramBotToken = this.readTelegramBotToken();
    this._started = true;
    try {
      await this.connect();
    } catch {
      // Reset so future start() calls can retry
      this._started = false;
    }
    if (!this._connected) {
      this._started = false;
    }
    return this._connected;
  }

  stop(): void {
    this._started = false;
    this._connected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Bridge stopped'));
      this.pendingRequests.delete(id);
    }

    for (const [id, pending] of this.pendingApprovals) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Bridge stopped'));
      this.pendingApprovals.delete(id);
    }

    // Fail all active task sessions
    this.failAllActiveSessions('Bridge stopped');

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    // Remove external EventEmitter listeners (e.g., 'inbound' from websocket-client)
    // to prevent leaks if the bridge is restarted after stop()
    this.removeAllListeners();
  }

  // ─── Gateway Connection ─────────────────────────────────────────

  private connect(): Promise<void> {
    if (!this.gatewayConfig) return Promise.resolve();
    if (this._connecting) return Promise.resolve();
    this._connecting = true;

    return new Promise((resolve) => {
      // Clean up old WebSocket handlers to prevent leaks on reconnection
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws = null;
      }

      const done = () => { this._connecting = false; resolve(); };

      const timeout = setTimeout(() => {
        console.warn('[openclaw-bridge] Connection timeout');
        if (this.ws) {
          this.ws.removeAllListeners();
          this.ws.close();
          this.ws = null;
        }
        done();
      }, CONNECT_TIMEOUT_MS);

      const ws = new WebSocket(this.gatewayConfig!.url);
      this.ws = ws;

      ws.on('message', (data) => {
        const frame = parseGatewayFrame(data);
        if (!frame) return;

        // Challenge → send connect
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
              auth: { token: this.gatewayConfig!.token },
              role: 'operator',
              scopes: ['operator.read', 'operator.write', 'operator.admin'],
            },
          }));
          return;
        }

        // Connect response
        if (frame.type === 'res' && frame.id === 'connect-1') {
          clearTimeout(timeout);
          if (frame.ok) {
            this._connected = true;
            console.log('[openclaw-bridge] Connected to gateway');
            this.emit('connected');
            done();
          } else {
            console.error('[openclaw-bridge] Handshake failed:', frame.error?.message);
            ws.close();
            done();
          }
          return;
        }

        // After connected — handle responses and events
        if (this._connected) {
          if (frame.type === 'res') {
            this.handleResponse(frame);
          } else if (frame.type === 'event') {
            this.handleEvent(frame);
          }
        }
      });

      ws.on('close', () => {
        const wasConnected = this._connected;
        this._connected = false;
        this.ws = null;
        if (wasConnected) {
          this.failAllActiveSessions('Gateway connection closed unexpectedly');
        }
        this.emit('disconnected');
        if (this._started) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        console.error('[openclaw-bridge] WebSocket error:', err.message);
        clearTimeout(timeout);
        ws.removeAllListeners();
        ws.close();
        this.ws = null;
        done();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this._started) {
        this.connect().catch(() => {});
      }
    }, RECONNECT_DELAY_MS);
  }

  // ─── Request/Response ───────────────────────────────────────────

  private sendRequest(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('OpenClaw gateway not connected'));
        return;
      }

      const id = randomUUID();
      const effectiveTimeout = timeoutMs ?? REQUEST_TIMEOUT_MS;
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, effectiveTimeout);

      this.pendingRequests.set(id, { resolve, reject, timeoutId });

      try {
        this.ws!.send(JSON.stringify({
          type: 'req',
          id,
          method,
          params,
        }));
      } catch (err) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleResponse(frame: GatewayFrame): void {
    if (!frame.id) return;
    const pending = this.pendingRequests.get(frame.id);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(frame.id);

    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(new Error(frame.error?.message || 'Request failed'));
    }
  }

  private handleEvent(frame: GatewayFrame): void {
    // Route agent and chat events to active task sessions
    if (frame.event === 'agent' || frame.event === 'chat') {
      this.routeTaskEvent(frame);
      return;
    }

    if (frame.event === 'approval.response') {
      // Direct approval response (if gateway supports it in the future)
      const approvalId = frame.payload?.approvalId as string;
      const response = frame.payload?.response as string;
      if (approvalId && response) {
        this.resolveApproval(approvalId, response);
      }
    } else if (frame.event === 'message.inbound') {
      const text = (frame.payload?.text as string) || '';

      // If there are pending approvals, treat inbound message as an approval response.
      // NOTE: This FIFO approach assumes serialized approvals. Concurrent approvals
      // using the fallback path (no bot token) may match responses to the wrong request.
      // The Telegram polling path (requestApprovalViaTelegram) avoids this issue.
      if (this.pendingApprovals.size > 0 && text.trim()) {
        if (this.pendingApprovals.size > 1) {
          console.warn(`[openclaw-bridge] ${this.pendingApprovals.size} concurrent approvals pending — FIFO matching may route response to wrong request`);
        }
        const [approvalId] = this.pendingApprovals.keys();
        this.resolveApproval(approvalId, text.trim());
        return;
      }

      // Otherwise forward as a regular inbound message
      this.emit('inbound', frame.payload);
    }

    // Ignore tick/health/presence/heartbeat silently
  }

  private resolveApproval(approvalId: string, response: string): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingApprovals.delete(approvalId);
      pending.resolve(response);
    }
    this.emit('approval-response', { approvalId, response });
  }

  // ─── Task Execution (Session Multiplexing) ─────────────────────

  /**
   * Execute a task by sending chat.send through the shared WebSocket connection.
   * Returns a Promise that resolves when the task completes (lifecycle.end + chat.final).
   */
  executeTask(
    sessionKey: string,
    message: string,
    stream: TaskOutputStream,
    signal: AbortSignal,
    timeout?: number,
  ): Promise<TaskSessionResult> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('OpenClaw gateway not connected'));
        return;
      }

      const session: TaskSession = {
        sessionKey,
        outputText: '',
        artifacts: [],
        metrics: undefined,
        lifecycleEnded: false,
        chatFinalReceived: false,
        finished: false,
        stream,
        signal,
        abortHandler: () => {},
        resolve,
      };

      // Abort handler
      session.abortHandler = () => {
        try {
          this.ws?.send(JSON.stringify({
            type: 'req',
            id: `abort-${randomUUID()}`,
            method: 'chat.abort',
            params: { sessionKey },
          }));
        } catch { /* ignore */ }
        this.finishSession(sessionKey, 'Task cancelled');
      };
      signal.addEventListener('abort', session.abortHandler);

      // Task-level timeout
      if (timeout) {
        session.taskTimeout = setTimeout(() => {
          this.finishSession(sessionKey, 'Task timed out');
        }, timeout);
      }

      this.activeSessions.set(sessionKey, session);

      // Send chat.send via the shared request mechanism
      const idempotencyKey = randomUUID();
      this.sendRequest('chat.send', {
        sessionKey,
        message,
        idempotencyKey,
      }, TASK_REQUEST_TIMEOUT_MS).then((payload) => {
        const p = payload as Record<string, unknown> | undefined;
        const runId = p?.runId as string | undefined;
        if (runId) {
          stream.status('running', 10, 'Task dispatched to agent');
        }
      }).catch((err) => {
        this.finishSession(sessionKey, `Gateway rejected task: ${err.message}`);
      });
    });
  }

  /**
   * Send a chat message to resume an existing session.
   * Simplified variant of executeTask without artifact tracking.
   */
  sendChatMessage(
    sessionKey: string,
    message: string,
    stream: TaskOutputStream,
    signal: AbortSignal,
  ): Promise<TaskSessionResult> {
    return this.executeTask(sessionKey, message, stream, signal);
  }

  /** Route agent/chat events to the correct TaskSession */
  private routeTaskEvent(frame: GatewayFrame): void {
    const p = frame.payload || {};

    // Find the matching session by sessionKey
    let session: TaskSession | undefined;
    for (const s of this.activeSessions.values()) {
      if (matchesSessionKey(p.sessionKey, s.sessionKey)) {
        session = s;
        break;
      }
    }
    if (!session || session.finished) return;

    if (frame.event === 'agent') {
      this.handleAgentEvent(session, p);
    } else if (frame.event === 'chat') {
      this.handleChatEvent(session, p);
    }
  }

  private handleAgentEvent(session: TaskSession, payload: Record<string, unknown>): void {
    const streamType = payload.stream as string;
    const eventData = payload.data as Record<string, unknown> | undefined;

    if (streamType === 'lifecycle') {
      const phase = eventData?.phase as string;
      if (phase === 'start') {
        session.stream.sessionInit(
          (payload.sessionKey as string) || session.sessionKey,
          (eventData?.model as string) || undefined,
        );
      } else if (phase === 'end') {
        // Extract usage metrics from lifecycle.end
        const usage = eventData?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const cost = (eventData?.total_cost_usd ?? eventData?.cost_usd) as number | undefined;
        const numTurns = eventData?.num_turns as number | undefined;
        const durationMs = eventData?.duration_ms as number | undefined;
        const model = eventData?.model as string | undefined;
        if (usage || cost !== undefined) {
          session.metrics = {
            inputTokens: usage?.input_tokens,
            outputTokens: usage?.output_tokens,
            totalCost: cost,
            numTurns,
            durationMs,
            model,
          };
        }
        session.lifecycleEnded = true;
        this.tryFinishAfterLifecycle(session);
      }
    } else if (streamType === 'assistant') {
      const delta = eventData?.delta as string || eventData?.text as string;
      if (delta) {
        session.outputText += delta;
        session.stream.text(delta);
      }
    } else if (streamType === 'tool_use') {
      const toolName = (eventData?.name as string) || (eventData?.toolName as string) || 'unknown';
      const toolInput = eventData?.input || eventData?.toolInput || {};
      session.stream.toolUse(toolName, toolInput);
    } else if (streamType === 'tool_result') {
      const toolName = (eventData?.name as string) || (eventData?.toolName as string) || 'unknown';
      const result = eventData?.result || eventData?.output || '';
      const success = eventData?.success !== false;
      session.stream.toolResult(toolName, result, success);
    } else if (streamType === 'file_change') {
      const filePath = eventData?.path as string || eventData?.file as string;
      const rawAction = (eventData?.type as string) || (eventData?.action as string) || 'modified';
      const action = (['created', 'modified', 'deleted'].includes(rawAction) ? rawAction : 'modified') as 'created' | 'modified' | 'deleted';
      if (filePath) {
        session.artifacts.push({ type: 'file', name: filePath, path: filePath, metadata: { action } });
        session.stream.fileChange(filePath, action);
      }
    }
  }

  private handleChatEvent(session: TaskSession, payload: Record<string, unknown>): void {
    const state = payload.state as string;

    if (state === 'final') {
      session.chatFinalReceived = true;
      // Extract final message content
      const message = payload.message as Record<string, unknown> | undefined;
      if (message) {
        const content = message.content as Array<{ type: string; text?: string }> | undefined;
        if (content) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              // Only add if not already captured via agent delta events
              if (!session.outputText.includes(block.text)) {
                session.outputText += block.text;
              }
            }
          }
        }
      }
      // Extract model/usage from chat.final if not yet captured
      if (!session.metrics) {
        const usage = payload.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const cost = (payload.total_cost_usd ?? payload.cost_usd) as number | undefined;
        const model = (payload.model ?? (payload.message as Record<string, unknown>)?.model) as string | undefined;
        if (usage || cost !== undefined || model) {
          session.metrics = {
            inputTokens: usage?.input_tokens,
            outputTokens: usage?.output_tokens,
            totalCost: cost,
            model,
          };
        }
      }
      // If lifecycle already ended, finish immediately
      if (session.lifecycleEnded) {
        this.finishSession(session.sessionKey);
      }
    }
  }

  /** Finish when both lifecycle.end and chat.final have been seen, or
   *  after a short grace period if only lifecycle.end arrived. */
  private tryFinishAfterLifecycle(session: TaskSession): void {
    if (session.chatFinalReceived) {
      this.finishSession(session.sessionKey);
    } else {
      // Grace period: if chat.final doesn't arrive within 500ms, finish anyway
      session.gracePeriodTimeout = setTimeout(() => {
        if (!session.finished) this.finishSession(session.sessionKey);
      }, 500);
    }
  }

  private finishSession(sessionKey: string, error?: string): void {
    const session = this.activeSessions.get(sessionKey);
    if (!session || session.finished) return;

    session.finished = true;
    session.signal.removeEventListener('abort', session.abortHandler);
    if (session.taskTimeout) clearTimeout(session.taskTimeout);
    if (session.gracePeriodTimeout) clearTimeout(session.gracePeriodTimeout);
    this.activeSessions.delete(sessionKey);

    session.resolve({
      output: session.outputText,
      error,
      artifacts: session.artifacts.length > 0 ? session.artifacts : undefined,
      metrics: session.metrics,
    });
  }

  /** Fail all active task sessions — called on WebSocket close before reconnect */
  private failAllActiveSessions(error: string): void {
    for (const sessionKey of [...this.activeSessions.keys()]) {
      this.finishSession(sessionKey, error);
    }
  }

  // ─── Public API (Channel Relay) ────────────────────────────────

  async sendNotification(notification: {
    type: string;
    projectId: string;
    summary: string;
    astroUrl?: string;
    to?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const prefix = this.getNotificationPrefix(notification.type);
    const msg = `${prefix} ${notification.summary}${notification.astroUrl ? `\n\n${notification.astroUrl}` : ''}`;
    const to = notification.to || this.defaultRecipient;

    if (!to) {
      throw new Error('No recipient configured for OpenClaw notifications (set "to" or defaultRecipient)');
    }

    await this.sendRequest('send', {
      to,
      message: msg,
      idempotencyKey: randomUUID(),
    });
  }

  async sendResponse(response: {
    text: string;
    channelId: string;
    threadId?: string;
    to?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const to = response.to || response.channelId || this.defaultRecipient;

    if (!to) {
      throw new Error('No recipient for OpenClaw response');
    }

    await this.sendRequest('send', {
      to,
      message: response.text,
      idempotencyKey: randomUUID(),
      ...(response.threadId ? { threadId: response.threadId } : {}),
    });
  }

  async requestApproval(opts: {
    approvalId: string;
    projectId: string;
    taskId: string;
    question: string;
    options?: string[];
    to?: string;
  }): Promise<string> {
    const to = opts.to || this.defaultRecipient;
    if (!to) {
      throw new Error('No recipient configured for OpenClaw approval request');
    }

    const options = opts.options ?? ['Yes', 'No'];

    const botToken = this.telegramBotToken;
    if (botToken) {
      return this.requestApprovalViaTelegram(botToken, to, opts.question, options);
    }

    // Fallback: send via gateway send method (no reply detection)
    const optionLines = options.map((o, i) => `  ${i + 1}. ${o}`).join('\n');
    const message = `[Approval Needed]\n\n${opts.question}\n\n${optionLines}\n\nReply with a number (1-${options.length}) or type your answer.`;

    await this.sendRequest('send', {
      to,
      message,
      idempotencyKey: opts.approvalId,
    });

    // Wait for the user's reply via inbound message
    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingApprovals.delete(opts.approvalId);
        reject(new Error(`Approval ${opts.approvalId} timed out after ${APPROVAL_TIMEOUT_MS / 1000}s`));
      }, APPROVAL_TIMEOUT_MS);

      this.pendingApprovals.set(opts.approvalId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutId,
      });
    });
  }

  private readTelegramBotToken(): string | null {
    try {
      const configPath = join(homedir(), '.openclaw', 'openclaw.json');
      if (!existsSync(configPath)) return null;
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return (raw?.channels?.telegram?.botToken as string) || null;
    } catch {
      return null;
    }
  }

  /**
   * Send approval via Telegram as a single poll.
   *
   * Sends one poll (no auto-close). Periodically calls stopPoll to check
   * for votes. If no votes on first check, re-sends the poll once.
   *
   * Text replies are NOT supported via this path because they conflict
   * with the OpenClaw agent session (the agent would also process the reply).
   */
  private async requestApprovalViaTelegram(
    botToken: string,
    chatId: string,
    question: string,
    options: string[],
  ): Promise<string> {
    let pollMessageId = await this.telegramSendPoll(botToken, chatId, question, options);
    if (!pollMessageId) throw new Error('Failed to send Telegram poll');

    const CHECK_INTERVAL_MS = 10_000;
    let resent = false;

    return new Promise<string>((resolve, reject) => {
      const overallTimeout = setTimeout(() => {
        clearInterval(timer);
        if (pollMessageId) {
          this.telegramStopPoll(botToken, chatId, pollMessageId).catch(() => {});
        }
        reject(new Error('Approval poll timed out'));
      }, APPROVAL_TIMEOUT_MS);

      const timer = setInterval(async () => {
        if (!pollMessageId) return;
        try {
          const result = await this.telegramStopPoll(botToken, chatId, pollMessageId);
          if (result && result.total_voter_count > 0) {
            clearInterval(timer);
            clearTimeout(overallTimeout);
            const winner = result.options.reduce((a, b) =>
              b.voter_count > a.voter_count ? b : a,
            );
            resolve(winner.text);
            return;
          }

          // No votes — poll is now closed. Re-send once.
          if (!resent) {
            resent = true;
            pollMessageId = await this.telegramSendPoll(botToken, chatId, question, options);
          } else {
            // Already resent — stop checking, wait for timeout
            clearInterval(timer);
          }
        } catch {
          // stopPoll failed — ignore
        }
      }, CHECK_INTERVAL_MS);
    });
  }

  private async telegramSendPoll(
    botToken: string,
    chatId: string,
    question: string,
    options: string[],
  ): Promise<number | null> {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendPoll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        question: `[Astro] ${question}`,
        options: JSON.stringify(options),
        is_anonymous: false,
      }),
    });
    const data = await resp.json() as { ok: boolean; result?: { message_id: number } };
    return data.ok ? data.result?.message_id ?? null : null;
  }

  // ─── Telegram Bot API Helpers ──────────────────────────────────────

  private async telegramStopPoll(
    botToken: string,
    chatId: string,
    messageId: number,
  ): Promise<{ total_voter_count: number; options: Array<{ text: string; voter_count: number }> } | null> {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/stopPoll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    const data = await resp.json() as { ok: boolean; result?: { total_voter_count: number; options: Array<{ text: string; voter_count: number }> } };
    return data.ok ? data.result ?? null : null;
  }

  private getNotificationPrefix(type: string): string {
    switch (type) {
      case 'task.completed': return '[Completed]';
      case 'task.failed': return '[Failed]';
      case 'approval.requested': return '[Approval Needed]';
      case 'branch.pruned': return '[Pruned]';
      default: return '[Astro]';
    }
  }
}
