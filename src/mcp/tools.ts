/**
 * MCP Tools for Astro Session Bridge
 *
 * Provides tools that Claude Code can use to:
 * - astro_attach: Attach the current session to an Astro task
 * - astro_detach: Detach from the current task
 * - astro_status: Check the current attachment status
 * - astro_send: Send a message/event to Astro
 */

import { z } from 'zod';
import type { SessionBridge } from './session-bridge.js';
import type {
  AttachResponse,
  DetachResponse,
  StatusResponse,
  SendResponse,
  SessionEventType,
  SessionEventInput,
} from './types.js';

// ============================================================================
// Tool Schemas
// ============================================================================

/** Schema for astro_attach tool input */
export const attachSchema = z.object({
  taskId: z.string().describe('Task identifier to attach to (e.g., "RES-13", "PROJ-42")'),
});

/** Schema for astro_detach tool input */
export const detachSchema = z.object({});

/** Schema for astro_status tool input */
export const statusSchema = z.object({});

/** Schema for astro_send tool input */
export const sendSchema = z.object({
  message: z.string().describe('Message or event content to send to Astro'),
  eventType: z
    .enum(['tool_call', 'tool_result', 'file_change', 'message', 'error'])
    .optional()
    .describe('Optional event type (default: message)'),
});

// ============================================================================
// Tool Definitions
// ============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'astro_attach',
    description:
      'Attach this Claude Code session to an Astro task. Once attached, your activity ' +
      '(tool calls, file changes, messages) will be streamed to Astro for monitoring. ' +
      'The task must already exist in Astro. Example: astro_attach("RES-13")',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task identifier to attach to (e.g., "RES-13", "PROJ-42")',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'astro_detach',
    description:
      'Detach from the currently attached Astro task. ' +
      'After detaching, session activity will no longer be streamed to Astro.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'astro_status',
    description:
      'Check the current Astro attachment status. ' +
      'Returns whether a session is attached, which task it is attached to, ' +
      'and how many events have been sent.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'astro_send',
    description:
      'Send a message or event to the attached Astro task. ' +
      'This can be used to send progress updates, status messages, or custom events. ' +
      'Requires an active attachment.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Message or event content to send to Astro',
        },
        eventType: {
          type: 'string',
          enum: ['tool_call', 'tool_result', 'file_change', 'message', 'error'],
          description: 'Optional event type (default: message)',
        },
      },
      required: ['message'],
    },
  },
];

// ============================================================================
// Tool Handlers
// ============================================================================

export class ToolHandlers {
  constructor(private bridge: SessionBridge) {}

  /**
   * Handle astro_attach tool call
   */
  async attach(input: z.infer<typeof attachSchema>): Promise<AttachResponse> {
    try {
      const success = await this.bridge.attach(input.taskId);
      const status = this.bridge.getStatus();

      if (success) {
        return {
          success: true,
          message: `Successfully attached to task ${input.taskId}`,
          sessionId: status.sessionId,
          taskId: input.taskId,
        };
      } else {
        return {
          success: false,
          message: `Failed to attach to task ${input.taskId}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Error attaching to task: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Handle astro_detach tool call
   */
  async detach(): Promise<DetachResponse> {
    try {
      const status = this.bridge.getStatus();
      const eventCount = status.eventCount;

      await this.bridge.detach();

      return {
        success: true,
        message: 'Successfully detached from Astro task',
        eventsSent: eventCount,
      };
    } catch (error) {
      return {
        success: false,
        message: `Error detaching: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Handle astro_status tool call
   */
  status(): StatusResponse {
    const bridgeStatus = this.bridge.getStatus();

    return {
      success: true,
      message: bridgeStatus.state === 'attached'
        ? `Attached to task ${bridgeStatus.taskId}`
        : bridgeStatus.state === 'disconnected'
          ? 'Not attached to any task'
          : `State: ${bridgeStatus.state}`,
      state: bridgeStatus.state,
      taskId: bridgeStatus.taskId,
      sessionId: bridgeStatus.sessionId,
      attachedAt: bridgeStatus.attachedAt?.toISOString(),
      eventCount: bridgeStatus.eventCount,
      relayConnected: bridgeStatus.relayConnected,
    };
  }

  /**
   * Handle astro_send tool call
   */
  send(input: z.infer<typeof sendSchema>): SendResponse {
    if (!this.bridge.isAttached()) {
      return {
        success: false,
        message: 'Not attached to any task. Use astro_attach first.',
      };
    }

    const eventType: SessionEventType = input.eventType ?? 'message';

    // Create the appropriate event based on type
    let event: SessionEventInput;
    switch (eventType) {
      case 'message':
        event = {
          type: 'message',
          role: 'assistant',
          content: input.message,
        };
        break;
      case 'error':
        event = {
          type: 'error',
          error: input.message,
        };
        break;
      default:
        // For other event types, send as a generic message
        event = {
          type: 'message',
          role: 'assistant',
          content: `[${eventType}] ${input.message}`,
        };
    }

    const sent = this.bridge.sendEvent(event);

    if (sent) {
      return {
        success: true,
        message: 'Event sent to Astro',
        eventId: `evt-${Date.now()}`,
      };
    } else {
      return {
        success: false,
        message: 'Failed to send event. Check connection status.',
      };
    }
  }

  /**
   * Handle tool call by name
   */
  async handleToolCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<AttachResponse | DetachResponse | StatusResponse | SendResponse> {
    switch (name) {
      case 'astro_attach':
        return this.attach(attachSchema.parse(args));
      case 'astro_detach':
        return this.detach();
      case 'astro_status':
        return this.status();
      case 'astro_send':
        return this.send(sendSchema.parse(args));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
