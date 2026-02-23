/**
 * Start command - starts the agent runner
 */

import chalk from 'chalk';
import ora from 'ora';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../lib/config.js';
import { detectProviders } from '../lib/providers.js';
import { getMachineResources, formatResourceSummary } from '../lib/resources.js';
import { WebSocketClient } from '../lib/websocket-client.js';
import { TaskExecutor } from '../lib/task-executor.js';
import { localRepoSetup } from '../lib/repo-utils.js';
import { executionStrategyRegistry } from '../execution/index.js';
import type { RunnerEvent, Task, RepoSetupRequestMessage } from '../types.js';

interface StartOptions {
  foreground?: boolean;
  relay?: string;
  maxTasks?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  preserveWorktrees?: boolean;
  allowNonGit?: boolean;
  useSandbox?: boolean;
  maxSandboxSize?: number;
}

// Get package version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function getVersion(): Promise<string> {
  try {
    const packageJson = await import(join(__dirname, '../../package.json'), {
      with: { type: 'json' },
    });
    return packageJson.default.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

/**
 * Scan ~/.claude/skills/ and {workdir}/.claude/skills/ for SKILL.md files.
 * Parse YAML frontmatter to extract name and description.
 */
function scanSlashCommands(workingDirectory?: string): Array<{ name: string; description: string }> {
  const commands: Array<{ name: string; description: string }> = [];
  const seen = new Set<string>();

  const skillDirs: string[] = [
    join(homedir(), '.claude', 'skills'),
  ];
  if (workingDirectory) {
    skillDirs.push(join(workingDirectory, '.claude', 'skills'));
  }

  for (const skillsDir of skillDirs) {
    if (!existsSync(skillsDir)) continue;

    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = join(skillsDir, entry.name, 'SKILL.md');
        if (!existsSync(skillFile)) continue;

        try {
          const content = readFileSync(skillFile, 'utf-8');
          // Parse YAML frontmatter (between --- markers)
          const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (!fmMatch) continue;

          const fm = fmMatch[1];
          const nameMatch = fm.match(/^name:\s*(.+)$/m);
          const descMatch = fm.match(/^description:\s*(.+)$/m);

          const name = nameMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || entry.name;
          const description = descMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || '';

          const cmdName = `/${name}`;
          if (!seen.has(cmdName)) {
            seen.add(cmdName);
            commands.push({ name: cmdName, description });
          }
        } catch {
          // Skip unreadable skill files
        }
      }
    } catch {
      // Skip unreadable skill directories
    }
  }

  return commands;
}

export async function startCommand(options: StartOptions = {}): Promise<void> {
  // Auto-run setup if not completed
  if (!config.isSetupComplete()) {
    console.log(chalk.yellow('Setup has not been completed. Running setup automatically...\n'));
    const { setupCommand } = await import('./setup.js');
    await setupCommand({
      relay: options.relay,
      skipAuth: true,
      nonInteractive: true,
      withSshConfig: true,
    });
    if (!config.isSetupComplete()) {
      console.log(chalk.red('Setup failed. Run manually: npx @astro/agent setup'));
      process.exit(1);
    }
  }

  // Initialize hardware-based machine ID if not set
  await config.initializeMachineId();

  // Get configuration
  const runnerId = config.getRunnerId();
  const machineId = config.getMachineId();
  const relayUrl = options.relay ?? config.getRelayUrl();
  const maxTasks = options.maxTasks ?? 4;
  const logLevel = options.logLevel ?? config.getLogLevel();

  // Background mode: spawn detached process
  if (!options.foreground) {
    console.log(chalk.bold('Starting Astro Agent Runner in background...\n'));

    const scriptPath = process.argv[1];
    const args = ['start', '--foreground'];

    if (options.relay) args.push('--relay', options.relay);
    if (options.maxTasks) args.push('--max-tasks', String(options.maxTasks));
    if (options.logLevel) args.push('--log-level', options.logLevel);
    if (options.preserveWorktrees) args.push('--preserve-worktrees');

    const child = spawn(process.execPath, [scriptPath!, ...args], {
      detached: true,
      stdio: 'ignore',
    });

    child.unref();

    console.log(chalk.green('✓ Agent runner started in background'));
    console.log(chalk.dim(`  PID: ${child.pid}`));
    console.log(chalk.dim(`  Runner ID: ${runnerId}`));
    console.log();
    console.log('To view logs:');
    console.log(chalk.cyan('  npx @astro/agent logs'));
    console.log();
    console.log('To stop:');
    console.log(chalk.cyan('  npx @astro/agent stop'));

    return;
  }

  // Foreground mode: run directly
  console.log(chalk.bold('\n🤖 Astro Agent Runner\n'));

  const version = await getVersion();
  console.log(chalk.dim(`Version: ${version}`));
  console.log(chalk.dim(`Runner ID: ${runnerId}`));
  console.log(chalk.dim(`Machine ID: ${machineId}`));
  console.log(chalk.dim(`Relay: ${relayUrl}`));
  console.log(chalk.dim(`Max concurrent tasks: ${maxTasks}`));
  console.log(chalk.dim(`Log level: ${logLevel}`));
  console.log();

  // Set Claude OAuth token if configured (from `claude setup-token`)
  const claudeOauthToken = config.getClaudeOauthToken();
  if (claudeOauthToken && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = claudeOauthToken;
    console.log(chalk.dim('Using stored Claude OAuth token'));
  }
  console.log();

  // Detect resources
  const resourceSpinner = ora('Detecting machine resources...').start();
  let resources;
  try {
    resources = await getMachineResources();
    resourceSpinner.succeed('Machine resources detected');
    if (logLevel === 'debug') {
      console.log(chalk.dim(formatResourceSummary(resources)));
    }
  } catch (error) {
    resourceSpinner.fail('Failed to detect resources');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }

  // Detect providers
  const providerSpinner = ora('Detecting agent providers...').start();
  let providers: Awaited<ReturnType<typeof detectProviders>> = [];
  try {
    providers = await detectProviders();
    if (providers.length > 0) {
      providerSpinner.succeed(`Found ${providers.length} provider(s): ${providers.map((p) => p.name).join(', ')}`);
    } else {
      providerSpinner.warn('No providers available');
    }
  } catch {
    providerSpinner.fail('Failed to detect providers');
    providers = [];
  }

  // Detect execution strategies
  const strategySpinner = ora('Detecting execution strategies...').start();
  let executionStrategies: Awaited<ReturnType<typeof executionStrategyRegistry.detectAll>> = [];
  try {
    executionStrategies = await executionStrategyRegistry.detectAll();
    const available = executionStrategies.filter((s) => s.available);
    if (available.length > 0) {
      strategySpinner.succeed(
        `Found ${available.length} execution strategy(s): ${available.map((s) => s.name).join(', ')}`,
      );
    } else {
      strategySpinner.warn('No execution strategies detected (direct always available)');
    }
  } catch {
    strategySpinner.fail('Failed to detect execution strategies');
    executionStrategies = [];
  }

  console.log();

  // Create WebSocket client
  const connectSpinner = ora('Connecting to relay server...').start();

  const wsClient = new WebSocketClient({
    runnerId,
    machineId,
    providers,
    executionStrategies: executionStrategies.filter((s) => s.available),
    version,
    wsToken: config.getWsToken(),
    config: {
      relayUrl,
      maxConcurrentTasks: maxTasks,
      logLevel,
    },
    onEvent: (event) => handleEvent(event, logLevel),
  });

  // Create task executor
  const taskExecutor = new TaskExecutor({
    wsClient,
    maxConcurrentTasks: maxTasks,
    preserveWorktrees: options.preserveWorktrees,
    allowNonGit: options.allowNonGit,
    useSandbox: options.useSandbox,
    maxSandboxSize: options.maxSandboxSize,
  });

  // Set up task handlers
  wsClient['onTaskDispatch'] = (task: Task) => {
    taskExecutor.submitTask(task).catch((error) => {
      log('error', `Failed to submit task ${task.id}: ${error.message}`, logLevel);
    });
  };

  wsClient['onTaskCancel'] = (taskId: string) => {
    taskExecutor.cancelTask(taskId);
  };

  wsClient['onTaskSafetyDecision'] = (taskId: string, decision: 'proceed' | 'init-git' | 'sandbox' | 'cancel') => {
    log('info', `Safety decision for task ${taskId}: ${decision}`, logLevel);
    taskExecutor.handleSafetyDecision(taskId, decision).catch((error) => {
      log('error', `Failed to handle safety decision for task ${taskId}: ${error.message}`, logLevel);
    });
  };

  wsClient['onTaskSteer'] = (taskId: string, message: string, action?: string, interrupt?: boolean) => {
    log('info', `Received steer for task ${taskId}: "${message.slice(0, 100)}"${action ? ` (action: ${action})` : ''}${interrupt ? ' (interrupt)' : ''}`, logLevel);
    taskExecutor.steerTask(taskId, message, interrupt ?? false).then((result) => {
      wsClient.sendSteerAck(taskId, result.accepted, result.reason, interrupt);
      log('info', `Steer ack for task ${taskId}: accepted=${result.accepted}${result.reason ? ` reason=${result.reason}` : ''}${interrupt ? ' (interrupt)' : ''}`, logLevel);
    }).catch((err) => {
      log('error', `Steer failed for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`, logLevel);
      wsClient.sendSteerAck(taskId, false, 'Internal error');
    });
  };

  wsClient['onFileList'] = (path: string, correlationId: string) => {
    log('debug', `File list request for path: ${path || '(cwd)'}`, logLevel);
    try {
      const cwd = path || process.cwd();
      if (!existsSync(cwd)) {
        log('debug', `Directory does not exist: ${cwd}`, logLevel);
        wsClient.sendFileListResponse(correlationId, []);
        return;
      }
      // Check if directory is a git repo before trying git ls-files
      try {
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
          cwd,
          encoding: 'utf-8',
          timeout: 5000,
          stdio: 'pipe',
        });
      } catch {
        log('debug', `Not a git repo, returning empty file list: ${cwd}`, logLevel);
        wsClient.sendFileListResponse(correlationId, []);
        return;
      }
      const output = execFileSync('git', ['ls-files'], {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      const files = output.trim().split('\n').filter(Boolean);
      wsClient.sendFileListResponse(correlationId, files);
      log('debug', `Sent ${files.length} files for path: ${cwd}`, logLevel);
    } catch (error) {
      log('warn', `Failed to list files in ${path}: ${error instanceof Error ? error.message : String(error)}`, logLevel);
      wsClient.sendFileListResponse(correlationId, []);
    }
  };

  wsClient['onSlashCommands'] = (correlationId: string, workingDirectory?: string) => {
    log('debug', `Slash commands request for dir: ${workingDirectory || '(global)'}`, logLevel);
    try {
      const commands = scanSlashCommands(workingDirectory);
      wsClient.sendSlashCommandsResponse(correlationId, commands);
      log('debug', `Sent ${commands.length} slash commands`, logLevel);
    } catch (error) {
      log('warn', `Failed to scan slash commands: ${error instanceof Error ? error.message : String(error)}`, logLevel);
      wsClient.sendSlashCommandsResponse(correlationId, []);
    }
  };

  wsClient['onRepoSetup'] = (payload: RepoSetupRequestMessage['payload']) => {
    const { correlationId, projectId, workingDirectory, repository } = payload;
    log('info', `Repo setup request: dir=${workingDirectory || '(none)'} repo=${repository || '(none)'}`, logLevel);
    try {
      const result = localRepoSetup({ workingDirectory, repository, projectId });
      wsClient.sendRepoSetupResponse(correlationId, result);
      log('info', `Repo setup result: success=${result.success} files=${result.fileTree?.length ?? 0}`, logLevel);
    } catch (error) {
      log('error', `Repo setup failed: ${error instanceof Error ? error.message : String(error)}`, logLevel);
      wsClient.sendRepoSetupResponse(correlationId, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Handle graceful shutdown
  let isShuttingDown = false;

  const shutdown = (signal: string) => {
    if (isShuttingDown) {
      // Second signal: force exit immediately
      console.log('\nForce exit.');
      process.exit(1);
    }
    isShuttingDown = true;

    console.log();
    log('info', `Received ${signal}, shutting down...`, logLevel);

    // Force exit after 3 seconds if graceful shutdown hangs
    setTimeout(() => {
      log('warn', 'Graceful shutdown timed out, forcing exit', logLevel);
      process.exit(1);
    }, 3000).unref();

    try {
      // Cancel all running tasks
      const counts = taskExecutor.getTaskCounts();
      if (counts.running > 0 || counts.queued > 0) {
        log('info', `Cancelling ${counts.running} running and ${counts.queued} queued tasks`, logLevel);
        taskExecutor.cancelAll();
      }

      // Disconnect WebSocket
      wsClient.disconnect();
    } catch {
      // Ignore errors during shutdown
    }

    log('info', 'Shutdown complete', logLevel);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Connect to relay
  try {
    await wsClient.connect();
    connectSpinner.succeed('Connected to relay server');
    config.updateLastConnected();
  } catch (error) {
    connectSpinner.fail('Failed to connect to relay server');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    console.log();
    console.log(chalk.yellow('The agent will continue trying to reconnect...'));
    console.log(chalk.dim('Press Ctrl+C to stop'));
    console.log();

    // Still try to reconnect
    wsClient.connect().catch(() => {
      // Reconnection handled internally
    });
  }

  console.log();
  console.log(chalk.green('Agent runner is active'));
  console.log(chalk.dim('Waiting for tasks...'));
  console.log(chalk.dim('Press Ctrl+C to stop'));
  console.log();

  // Keep process alive
  await new Promise(() => {
    // Never resolves - keeps the process running
  });
}

function handleEvent(event: RunnerEvent, logLevel: string): void {
  switch (event.type) {
    case 'connected':
      log('info', 'Connected to relay server', logLevel);
      break;
    case 'disconnected':
      log('warn', `Disconnected from relay: ${event.reason}`, logLevel);
      break;
    case 'reconnecting':
      log('info', `Reconnecting (attempt ${event.attempt})...`, logLevel);
      break;
    case 'task_received':
      log('info', `Received task: ${event.task.id}`, logLevel);
      log('debug', `  Provider: ${event.task.provider}`, logLevel);
      log('debug', `  Prompt: ${event.task.prompt.slice(0, 100)}...`, logLevel);
      break;
    case 'task_started':
      log('info', `Started task: ${event.taskId}`, logLevel);
      break;
    case 'task_completed':
      log('info', `Completed task: ${event.result.taskId} (${event.result.status})`, logLevel);
      if (event.result.error) {
        log('info', `  Error: ${event.result.error}`, logLevel);
      }
      break;
    case 'task_cancelled':
      log('info', `Cancelled task: ${event.taskId}`, logLevel);
      break;
    case 'error':
      log('error', `Error: ${event.error.message}`, logLevel);
      break;
  }
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, configLevel: string): void {
  const levels = ['debug', 'info', 'warn', 'error'];
  const levelIndex = levels.indexOf(level);
  const configLevelIndex = levels.indexOf(configLevel);

  if (levelIndex < configLevelIndex) {
    return;
  }

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}]`;

  switch (level) {
    case 'debug':
      console.log(chalk.dim(`${prefix} ${message}`));
      break;
    case 'info':
      console.log(`${prefix} ${message}`);
      break;
    case 'warn':
      console.log(chalk.yellow(`${prefix} ${message}`));
      break;
    case 'error':
      console.error(chalk.red(`${prefix} ${message}`));
      break;
  }
}
