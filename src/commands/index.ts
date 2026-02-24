/**
 * CLI commands index
 */

export { setupCommand, type SetupOptions, type SetupResult } from './setup.js';
export { startCommand } from './start.js';
export { statusCommand } from './status.js';
export { stopCommand } from './stop.js';
export { mcpCommand } from './mcp.js';
export {
  planListCommand,
  planShowCommand,
  planGraphCommand,
  type PlanListOptions,
  type PlanShowOptions,
  type PlanGraphOptions,
} from './plan.js';
