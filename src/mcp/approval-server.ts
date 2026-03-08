#!/usr/bin/env node
/**
 * Minimal MCP server that provides ONLY the `ask_user_question` tool.
 *
 * Used by non-Claude adapters (Codex, OpenCode) to let agents ask the user
 * clarifying questions during task execution. The tool posts to the Astro
 * server's dynamic approval endpoint and blocks until the user answers.
 *
 * Environment variables:
 *   ASTRO_SERVER_URL   — Astro API base URL (default: http://localhost:3001)
 *   ASTRO_EXECUTION_ID — Current execution/task ID (required for routing)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const serverUrl = process.env.ASTRO_SERVER_URL || 'http://localhost:3001';
const executionId = process.env.ASTRO_EXECUTION_ID || '';

const server = new Server(
  { name: 'astro-approval', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ask_user_question',
      description:
        'Ask the user a clarifying question before proceeding. ' +
        'Execution pauses until the user selects one of the provided options. ' +
        'Use this when multiple approaches are valid and the decision depends on user preference.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask the user.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of 2-5 option strings the user can choose from.',
          },
        },
        required: ['question', 'options'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== 'ask_user_question') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const { question, options } = args as { question: string; options: string[] };

  if (!question || typeof question !== 'string') {
    return {
      content: [{ type: 'text', text: 'question must be a non-empty string' }],
      isError: true,
    };
  }
  if (!Array.isArray(options) || options.length < 2 || options.length > 5) {
    return {
      content: [{ type: 'text', text: 'options must be an array of 2-5 strings' }],
      isError: true,
    };
  }
  if (!executionId) {
    return {
      content: [{ type: 'text', text: 'ASTRO_EXECUTION_ID not set — cannot route approval' }],
      isError: true,
    };
  }

  try {
    const response = await fetch(`${serverUrl}/api/dispatch/request-dynamic-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionId, question, options }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      return {
        content: [{ type: 'text', text: `Approval request failed: ${(error as Record<string, string>).error || response.status}` }],
        isError: true,
      };
    }

    const result = await response.json() as { selectedOption: string };
    return {
      content: [{ type: 'text', text: `User selected: ${result.selectedOption}` }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
