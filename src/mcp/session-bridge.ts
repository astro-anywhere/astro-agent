/**
 * Session Bridge - WebSocket client for bridging Claude Code sessions to Astro
 *
 * Handles:
 * - Connection to Astro relay server
 * - Session attachment/detachment
 * - Streaming session events to Astro
 * - Automatic reconnection
 */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type {
  McpBridgeConfig,
  SessionAttachment,
  SessionAttachmentState,
  SessionEvent,
  SessionEventInput,
  SessionAttachMessage,
  SessionAttachAckMessage,
  SessionDetachMessage,
  SessionEventMessage,
  SessionRelayMessage,
} from './types.js';
import { DEFAULT_MCP_BRIDGE_CONFIG } from './types.js';

type SessionBridgeEventType =
  | 'connected'
  | 'disconnected'
  | 'attached'
  | 'detached'
  | 'error'
  | 'event_sent';

interface SessionBridgeEvent {
  type: SessionBridgeEventType;
  data?: unknown;
  error?: Error;
}

type SessionBridgeEventHandler = (event: SessionBridgeEvent) => void;

export class SessionBridge {
  private ws: WebSocket | null = null;
  private config: McpBridgeConfig;
  private attachment: SessionAttachment | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private shouldReconnect = false;
  private isConnecting = false;
  private eventHandler?: SessionBridgeEventHandler;
  private pendingAttach: {
    resolve: (value: boolean) => void;
    reject: (error: Error) => void;
    taskId: string;
  } | null = null;

  constructor(config: Partial<McpBridgeConfig> = {}) {
    this.config = { ...DEFAULT_MCP_BRIDGE_CONFIG, ...config };
  }

  /**
   * Set event handler for bridge events
   */
  onEvent(handler: SessionBridgeEventHandler): void {
    this.eventHandler = handler;
  }

  /**
   * Connect to the relay server
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = this.config.autoReconnect;

    return new Promise((resolve, reject) => {
      try {
        const headers: Record<string, string> = {
          'X-Machine-Id': this.config.machineId,
          'X-Session-Type': 'mcp-bridge',
        };
        if (this.config.wsToken) {
          headers['Authorization'] = `Bearer ${this.config.wsToken}`;
        }

        this.ws = new WebSocket(this.config.relayUrl, { headers });

        this.ws.on('open', () => {
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.emitEvent({ type: 'connected' });
          resolve();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
          this.handleClose(code, reason.toString());
        });

        this.ws.on('error', (error) => {
          this.isConnecting = false;
          this.emitEvent({ type: 'error', error: error as Error });
          if (this.reconnectAttempts === 0) {
            reject(error);
          }
        });
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the relay server
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.cleanup();

    if (this.attachment) {
      this.sendDetach('Client disconnect');
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.attachment = null;
  }

  /**
   * Attach the current session to an Astro task
   */
  async attach(taskId: string): Promise<boolean> {
    if (!this.isConnected()) {
      // Auto-connect if not connected
      await this.connect();
    }

    if (this.attachment?.taskId === taskId && this.attachment.state === 'attached') {
      // Already attached to this task
      return true;
    }

    // Detach from previous task if attached
    if (this.attachment && this.attachment.state === 'attached') {
      await this.detach();
    }

    const sessionId = `session-${randomUUID().slice(0, 8)}`;

    // Create pending attachment
    this.attachment = {
      taskId,
      sessionId,
      state: 'connecting',
      eventCount: 0,
    };

    // Send attach message and wait for acknowledgment
    return new Promise((resolve, reject) => {
      this.pendingAttach = { resolve, reject, taskId };

      const message: SessionAttachMessage = {
        type: 'session.attach',
        taskId,
        sessionId,
        machineId: this.config.machineId,
        timestamp: new Date(),
      };

      this.send(message);

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingAttach?.taskId === taskId) {
          this.pendingAttach = null;
          if (this.attachment) {
            this.attachment.state = 'error';
            this.attachment.error = 'Attachment timeout';
          }
          reject(new Error('Attachment timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Detach from the current task
   */
  async detach(): Promise<void> {
    if (!this.attachment) {
      return;
    }

    const eventCount = this.attachment.eventCount;
    this.sendDetach('User requested detach');

    this.emitEvent({
      type: 'detached',
      data: { taskId: this.attachment.taskId, eventCount },
    });

    this.attachment = null;
  }

  /**
   * Send a session event to Astro
   */
  sendEvent(event: SessionEventInput): boolean {
    if (!this.attachment || this.attachment.state !== 'attached') {
      return false;
    }

    const fullEvent: SessionEvent = {
      ...event,
      sessionId: this.attachment.sessionId,
      taskId: this.attachment.taskId,
      timestamp: new Date(),
    } as SessionEvent;

    const message: SessionEventMessage = {
      type: 'session.event',
      sessionId: this.attachment.sessionId,
      taskId: this.attachment.taskId,
      event: fullEvent,
      timestamp: new Date(),
    };

    const sent = this.send(message);
    if (sent) {
      this.attachment.eventCount++;
      this.emitEvent({ type: 'event_sent', data: event });
    }

    return sent;
  }

  /**
   * Get current attachment status
   */
  getStatus(): {
    state: SessionAttachmentState;
    taskId?: string;
    sessionId?: string;
    attachedAt?: Date;
    eventCount: number;
    relayConnected: boolean;
  } {
    return {
      state: this.attachment?.state ?? 'disconnected',
      taskId: this.attachment?.taskId,
      sessionId: this.attachment?.sessionId,
      attachedAt: this.attachment?.attachedAt,
      eventCount: this.attachment?.eventCount ?? 0,
      relayConnected: this.isConnected(),
    };
  }

  /**
   * Check if connected to relay
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Check if attached to a task
   */
  isAttached(): boolean {
    return this.attachment?.state === 'attached';
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<McpBridgeConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const message = JSON.parse(data.toString()) as SessionRelayMessage;
      this.routeMessage(message);
    } catch (error) {
      this.emitEvent({ type: 'error', error: error as Error });
    }
  }

  private routeMessage(message: SessionRelayMessage): void {
    switch (message.type) {
      case 'session.attach.ack':
        this.handleAttachAck(message);
        break;
      // Other message types can be handled here
    }
  }

  private handleAttachAck(message: SessionAttachAckMessage): void {
    if (!this.pendingAttach || this.pendingAttach.taskId !== message.taskId) {
      return;
    }

    const { resolve, reject } = this.pendingAttach;
    this.pendingAttach = null;

    if (message.success) {
      if (this.attachment) {
        this.attachment.state = 'attached';
        this.attachment.attachedAt = new Date();
      }
      this.emitEvent({
        type: 'attached',
        data: { taskId: message.taskId, sessionId: message.sessionId },
      });
      resolve(true);
    } else {
      if (this.attachment) {
        this.attachment.state = 'error';
        this.attachment.error = message.error ?? 'Attachment failed';
      }
      this.emitEvent({
        type: 'error',
        error: new Error(message.error ?? 'Attachment failed'),
      });
      reject(new Error(message.error ?? 'Attachment failed'));
    }
  }

  private handleClose(code: number, reason: string): void {
    this.cleanup();

    // Mark attachment as disconnected if it exists
    if (this.attachment) {
      this.attachment.state = 'disconnected';
    }

    this.emitEvent({ type: 'disconnected', data: { code, reason } });

    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private send(message: SessionRelayMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  private sendDetach(reason: string): void {
    if (!this.attachment) return;

    const message: SessionDetachMessage = {
      type: 'session.detach',
      sessionId: this.attachment.sessionId,
      reason,
      timestamp: new Date(),
    };
    this.send(message);
  }

  private scheduleReconnect(): void {
    const maxRetries = this.config.maxReconnectAttempts;
    if (maxRetries >= 0 && this.reconnectAttempts >= maxRetries) {
      return;
    }

    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const delay = Math.min(
      this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1) +
        Math.random() * 1000,
      60000 // Max 1 minute
    );

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch(() => {
        // Error already handled
      });
    }, delay);
  }

  private cleanup(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private emitEvent(event: SessionBridgeEvent): void {
    this.eventHandler?.(event);
  }
}
