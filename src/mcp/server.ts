/**
 * Astro MCP Server
 *
 * This MCP server allows existing Claude Code sessions to connect to Astro
 * and link their activity to specific tasks. It uses the stdio transport
 * to communicate with Claude Code.
 *
 * Tools provided:
 * - astro_attach: Attach session to an Astro task
 * - astro_detach: Detach from the current task
 * - astro_status: Check attachment status
 * - astro_send: Send a message/event to Astro
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { SessionBridge } from './session-bridge.js';
import { ToolHandlers, toolDefinitions } from './tools.js';
import type { McpBridgeConfig } from './types.js';
import { config as appConfig } from '../lib/config.js';

export interface McpServerOptions {
  /** Override relay URL (defaults to config) */
  relayUrl?: string;
  /** Override machine ID (defaults to config) */
  machineId?: string;
  /** Override WS token (defaults to config) */
  wsToken?: string;
  /** Log level for console output */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Create and run the Astro MCP server
 */
export async function runMcpServer(options: McpServerOptions = {}): Promise<void> {
  const logLevel = options.logLevel ?? 'info';

  const log = (level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]) => {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    if (levels[level] >= levels[logLevel]) {
      console.error(`[astro-mcp] [${level}]`, ...args);
    }
  };

  // Get configuration from stored config or options
  const bridgeConfig: Partial<McpBridgeConfig> = {
    relayUrl: options.relayUrl ?? appConfig.getRelayUrl(),
    machineId: options.machineId ?? appConfig.getMachineId(),
    wsToken: options.wsToken ?? appConfig.getWsToken(),
    autoReconnect: true,
  };

  log('info', 'Starting Astro MCP server...');
  log('debug', 'Config:', {
    relayUrl: bridgeConfig.relayUrl,
    machineId: bridgeConfig.machineId,
    hasWsToken: !!bridgeConfig.wsToken,
  });

  // Create session bridge
  const bridge = new SessionBridge(bridgeConfig);

  // Set up bridge event logging
  bridge.onEvent((event) => {
    switch (event.type) {
      case 'connected':
        log('info', 'Connected to Astro relay');
        break;
      case 'disconnected':
        log('info', 'Disconnected from Astro relay:', event.data);
        break;
      case 'attached':
        log('info', 'Attached to task:', event.data);
        break;
      case 'detached':
        log('info', 'Detached from task:', event.data);
        break;
      case 'event_sent':
        log('debug', 'Event sent:', event.data);
        break;
      case 'error':
        log('error', 'Bridge error:', event.error?.message);
        break;
    }
  });

  // Create tool handlers
  const toolHandlers = new ToolHandlers(bridge);

  // Create MCP server
  const server = new Server(
    {
      name: 'astro-mcp-bridge',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle ListTools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: toolDefinitions,
    };
  });

  // Handle CallTool request
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    log('debug', `Tool called: ${name}`, args);

    try {
      const result = await toolHandlers.handleToolCall(name, args ?? {});

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      log('error', `Tool ${name} error:`, error);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              message: `Error: ${error instanceof Error ? error.message : String(error)}`,
            }),
          },
        ],
        isError: true,
      };
    }
  });

  // Handle graceful shutdown
  const cleanup = () => {
    log('info', 'Shutting down...');
    bridge.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Start the server using stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('info', 'Astro MCP server started on stdio');
}

/**
 * Get Claude Code MCP configuration for this server
 */
export function getClaudeCodeMcpConfig(options: { execPath?: string } = {}): {
  mcpServers: {
    astro: {
      command: string;
      args: string[];
    };
  };
} {
  // Default to using npx to run the CLI
  const command = options.execPath ?? 'npx';
  const args = options.execPath ? ['mcp'] : ['@astro/agent', 'mcp'];

  return {
    mcpServers: {
      astro: {
        command,
        args,
      },
    },
  };
}

/**
 * Get the path to Claude Code's MCP configuration file
 */
export function getClaudeCodeConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return `${home}/.claude/mcp_servers.json`;
}
