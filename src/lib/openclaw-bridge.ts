/**
 * OpenClaw Bridge — Persistent gateway connection for channel operations
 *
 * Unlike the per-task OpenClawAdapter (which creates a new connection per task),
 * the bridge maintains a single long-lived WebSocket to the OpenClaw gateway
 * for notification delivery, approval routing, and inbound message forwarding.
 *
 * This enables the relay-routed architecture:
 *   Server → Relay → Agent Runner (bridge) → OpenClaw Gateway → User channels
 */

import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GatewayConfig {
  port: number;
  token: string;
  url: string;
  defaultRecipient?: string;
}

interface GatewayFrame {
  type: 'event' | 'res';
  id?: string;
  event?: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 3;
const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
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

    const config = this.readGatewayConfig();
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

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    // Remove external EventEmitter listeners (e.g., 'inbound' from websocket-client)
    // to prevent leaks if the bridge is restarted after stop()
    this.removeAllListeners();
  }

  // ─── Gateway Config ─────────────────────────────────────────────

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

      // Read default notification recipient from astro-specific config
      const defaultRecipient = (raw?.astro?.notifyTo as string) || undefined;

      return { port, token, url: `ws://${host}:${port}`, defaultRecipient };
    } catch {
      return null;
    }
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
        let frame: GatewayFrame;
        try {
          frame = JSON.parse(String(data));
        } catch {
          return;
        }

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
              caps: [],
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
        this._connected = false;
        this.ws = null;
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

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('OpenClaw gateway not connected'));
        return;
      }

      const id = randomUUID();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);

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

  // ─── Public API ─────────────────────────────────────────────────

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
