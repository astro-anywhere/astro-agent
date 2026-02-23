/**
 * Types for the Astro MCP Bridge
 *
 * This MCP server allows existing Claude Code sessions to connect to Astro
 * and link their activity to specific tasks.
 */

// ============================================================================
// Session State Types
// ============================================================================

/** State of an MCP session attachment */
export type SessionAttachmentState = 'disconnected' | 'connecting' | 'attached' | 'error';

/** Session attachment information */
export interface SessionAttachment {
  /** Task identifier in Astro (e.g., "RES-13") */
  taskId: string;
  /** Unique session ID for this attachment */
  sessionId: string;
  /** Current state of the attachment */
  state: SessionAttachmentState;
  /** When the session was attached */
  attachedAt?: Date;
  /** Error message if state is 'error' */
  error?: string;
  /** Number of events sent to Astro */
  eventCount: number;
}

/** Session event types that can be sent to Astro */
export type SessionEventType =
  | 'tool_call'
  | 'tool_result'
  | 'file_change'
  | 'message'
  | 'error';

/** Base session event */
export interface BaseSessionEvent {
  type: SessionEventType;
  timestamp: Date;
  sessionId: string;
  taskId: string;
}

/** Tool call event from Claude Code */
export interface ToolCallEvent extends BaseSessionEvent {
  type: 'tool_call';
  toolName: string;
  toolInput: unknown;
}

/** Tool result event from Claude Code */
export interface ToolResultEvent extends BaseSessionEvent {
  type: 'tool_result';
  toolName: string;
  toolResult: unknown;
  success: boolean;
  duration?: number;
}

/** File change event */
export interface FileChangeEvent extends BaseSessionEvent {
  type: 'file_change';
  path: string;
  action: 'created' | 'modified' | 'deleted';
  linesAdded?: number;
  linesRemoved?: number;
  diff?: string;
}

/** Message event (user or assistant messages) */
export interface MessageEvent extends BaseSessionEvent {
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
}

/** Error event */
export interface ErrorEvent extends BaseSessionEvent {
  type: 'error';
  error: string;
  stack?: string;
}

/** Union of all session event types */
export type SessionEvent =
  | ToolCallEvent
  | ToolResultEvent
  | FileChangeEvent
  | MessageEvent
  | ErrorEvent;

// ============================================================================
// Session Event Input Types (without auto-populated fields)
// ============================================================================

/** Input for creating a message event */
export interface MessageEventInput {
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
}

/** Input for creating an error event */
export interface ErrorEventInput {
  type: 'error';
  error: string;
  stack?: string;
}

/** Input for creating a tool call event */
export interface ToolCallEventInput {
  type: 'tool_call';
  toolName: string;
  toolInput: unknown;
}

/** Input for creating a tool result event */
export interface ToolResultEventInput {
  type: 'tool_result';
  toolName: string;
  toolResult: unknown;
  success: boolean;
  duration?: number;
}

/** Input for creating a file change event */
export interface FileChangeEventInput {
  type: 'file_change';
  path: string;
  action: 'created' | 'modified' | 'deleted';
  linesAdded?: number;
  linesRemoved?: number;
  diff?: string;
}

/** Union of all session event input types (without sessionId, taskId, timestamp) */
export type SessionEventInput =
  | MessageEventInput
  | ErrorEventInput
  | ToolCallEventInput
  | ToolResultEventInput
  | FileChangeEventInput;

// ============================================================================
// MCP Tool Input Types
// ============================================================================

/** Input for astro_attach tool */
export interface AttachInput {
  /** Task identifier to attach to (e.g., "RES-13") */
  taskId: string;
}

/** Input for astro_send tool */
export interface SendInput {
  /** Message or event to send to Astro */
  message: string;
  /** Optional event type */
  eventType?: SessionEventType;
}

// ============================================================================
// MCP Tool Response Types
// ============================================================================

/** Base response for MCP tools */
export interface McpToolResponse {
  success: boolean;
  message: string;
}

/** Response from astro_attach */
export interface AttachResponse extends McpToolResponse {
  sessionId?: string;
  taskId?: string;
}

/** Response from astro_detach */
export interface DetachResponse extends McpToolResponse {
  eventsSent?: number;
}

/** Response from astro_status */
export interface StatusResponse extends McpToolResponse {
  state: SessionAttachmentState;
  taskId?: string;
  sessionId?: string;
  attachedAt?: string;
  eventCount?: number;
  relayConnected?: boolean;
}

/** Response from astro_send */
export interface SendResponse extends McpToolResponse {
  eventId?: string;
}

// ============================================================================
// WebSocket Message Types (for relay communication)
// ============================================================================

/** Session attach request to relay */
export interface SessionAttachMessage {
  type: 'session.attach';
  taskId: string;
  sessionId: string;
  machineId: string;
  timestamp: Date;
}

/** Session attach acknowledgment from relay */
export interface SessionAttachAckMessage {
  type: 'session.attach.ack';
  taskId: string;
  sessionId: string;
  success: boolean;
  error?: string;
  timestamp: Date;
}

/** Session detach message */
export interface SessionDetachMessage {
  type: 'session.detach';
  sessionId: string;
  reason?: string;
  timestamp: Date;
}

/** Session event message (sent to relay) */
export interface SessionEventMessage {
  type: 'session.event';
  sessionId: string;
  taskId: string;
  event: SessionEvent;
  timestamp: Date;
}

/** Union of session-related WebSocket messages */
export type SessionRelayMessage =
  | SessionAttachMessage
  | SessionAttachAckMessage
  | SessionDetachMessage
  | SessionEventMessage;

// ============================================================================
// Configuration Types
// ============================================================================

/** MCP Bridge configuration */
export interface McpBridgeConfig {
  /** Relay server WebSocket URL */
  relayUrl: string;
  /** Machine ID for authentication */
  machineId: string;
  /** WebSocket authentication token */
  wsToken?: string;
  /** Auto-reconnect on disconnect */
  autoReconnect: boolean;
  /** Reconnect delay in milliseconds */
  reconnectDelay: number;
  /** Maximum reconnect attempts (-1 for infinite) */
  maxReconnectAttempts: number;
}

/** Default MCP Bridge configuration */
export const DEFAULT_MCP_BRIDGE_CONFIG: McpBridgeConfig = {
  relayUrl: 'ws://localhost:3002',
  machineId: '',
  wsToken: undefined,
  autoReconnect: true,
  reconnectDelay: 1000,
  maxReconnectAttempts: -1,
};
