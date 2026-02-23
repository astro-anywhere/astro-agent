/**
 * MCP command - starts the Astro MCP server for Claude Code integration
 */

import { runMcpServer } from '../mcp/server.js';

export interface McpCommandOptions {
  relay?: string;
  logLevel?: string;
}

/**
 * Start the MCP server for Claude Code integration
 *
 * This command starts an MCP server that communicates via stdio.
 * Claude Code will spawn this process and communicate with it to
 * provide the astro_attach, astro_detach, astro_status, and astro_send tools.
 */
export async function mcpCommand(options: McpCommandOptions = {}): Promise<void> {
  const logLevel = (options.logLevel ?? 'info') as 'debug' | 'info' | 'warn' | 'error';

  await runMcpServer({
    relayUrl: options.relay,
    logLevel,
  });
}
