#!/usr/bin/env node

/**
 * Astro Agent Runner CLI
 *
 * Lightweight agent runner for local, remote, and HPC environments.
 * Connects to the Astro relay server to receive and execute tasks.
 *
 * Usage:
 *   npx @astroanywhere/agent setup     - Initial setup and configuration
 *   npx @astroanywhere/agent start     - Start the agent runner
 *   npx @astroanywhere/agent stop      - Stop running agent
 *   npx @astroanywhere/agent status    - Show current status
 */

import { Command } from 'commander';
import { setupCommand, startCommand, statusCommand, stopCommand, mcpCommand } from './commands/index.js';

const program = new Command();

program
  .name('astro-agent')
  .description('Astro Agent Runner - Execute tasks from the Astro planning platform')
  .version('0.1.0');

// Setup command
program
  .command('setup')
  .description('Run initial setup: detect providers, authenticate, configure relay')
  .option('--api <url>', 'API server URL')
  .option('--relay <url>', 'Custom relay server URL')
  .option('--hostname <hostname>', 'Machine hostname (defaults to system hostname)')
  .option('--skip-auth', 'Skip device authentication')
  .option('--non-interactive', 'Run in non-interactive mode')
  .option('--with-ssh-config', 'Discover and configure remote hosts from SSH config')
  .option('--auto-start', 'Enable auto-start on login')
  .option('--install-mcp', 'Install MCP integration for Claude Code')
  .option('--verbose', 'Show detailed debug output')
  .action(async (options) => {
    try {
      await setupCommand({
        api: options.api,
        relay: options.relay,

        hostname: options.hostname,
        skipAuth: options.skipAuth,
        nonInteractive: options.nonInteractive,
        withSshConfig: options.withSshConfig,
        autoStart: options.autoStart,
        installMcp: options.installMcp,
        verbose: options.verbose,
      });
    } catch (error) {
      console.error('Setup failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Start command
program
  .command('start')
  .description('Start the agent runner')
  .option('-f, --foreground', 'Run in foreground (default: background)')
  .option('--relay <url>', 'Override relay server URL')
  .option('--max-tasks <number>', 'Maximum concurrent tasks', parseInt)
  .option('--log-level <level>', 'Log level: debug, info, warn, error')
  .option('--preserve-worktrees', 'Preserve worktrees after task completion (for debugging)')
  .option('--allow-non-git', 'Allow execution in non-git directories without prompting')
  .option('--sandbox', 'Always use sandbox mode (work on copies)')
  .option('--max-sandbox-size <mb>', 'Maximum sandbox size in MB (default: 100)', parseInt)
  .option('--verbose', 'Show detailed debug output')
  .action(async (options) => {
    try {
      await startCommand({
        foreground: options.foreground,
        relay: options.relay,
        maxTasks: options.maxTasks,
        logLevel: options.logLevel,
        preserveWorktrees: options.preserveWorktrees,
        allowNonGit: options.allowNonGit,
        useSandbox: options.sandbox,
        maxSandboxSize: options.maxSandboxSize ? options.maxSandboxSize * 1024 * 1024 : undefined,
        verbose: options.verbose,
      });
    } catch (error) {
      console.error('Start failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Connect command (alias for start --foreground)
program
  .command('connect')
  .description('Connect to relay server in foreground (alias for start --foreground)')
  .option('--relay <url>', 'Override relay server URL')
  .option('--max-tasks <number>', 'Maximum concurrent tasks', parseInt)
  .option('--log-level <level>', 'Log level: debug, info, warn, error')
  .option('--preserve-worktrees', 'Preserve worktrees after task completion (for debugging)')
  .option('--allow-non-git', 'Allow execution in non-git directories without prompting')
  .option('--sandbox', 'Always use sandbox mode (work on copies)')
  .option('--max-sandbox-size <mb>', 'Maximum sandbox size in MB (default: 100)', parseInt)
  .option('--verbose', 'Show detailed debug output')
  .action(async (options) => {
    try {
      await startCommand({
        foreground: true,
        relay: options.relay,
        maxTasks: options.maxTasks,
        logLevel: options.logLevel,
        preserveWorktrees: options.preserveWorktrees,
        allowNonGit: options.allowNonGit,
        useSandbox: options.sandbox,
        maxSandboxSize: options.maxSandboxSize ? options.maxSandboxSize * 1024 * 1024 : undefined,
        verbose: options.verbose,
      });
    } catch (error) {
      console.error('Connect failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Stop command
program
  .command('stop')
  .description('Stop the running agent')
  .action(async () => {
    try {
      await stopCommand();
    } catch (error) {
      console.error('Stop failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Show agent runner status')
  .action(async () => {
    try {
      await statusCommand();
    } catch (error) {
      console.error('Status check failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Auth command (set Claude OAuth token)
program
  .command('auth')
  .description('Set Claude OAuth token for agent SDK authentication')
  .option('--token <token>', 'Set token directly (from `claude setup-token` output)')
  .option('--clear', 'Clear stored token')
  .action(async (options) => {
    const { config } = await import('./lib/config.js');
    const chalk = (await import('chalk')).default;

    if (options.clear) {
      config.clearClaudeOauthToken();
      console.log(chalk.green('✓ Claude OAuth token cleared'));
      return;
    }

    if (options.token) {
      config.setClaudeOauthToken(options.token);
      console.log(chalk.green('✓ Claude OAuth token saved'));
      console.log(chalk.dim('  Token will be used automatically when the agent starts'));
      return;
    }

    // Interactive: prompt for token
    const inquirer = (await import('inquirer')).default;
    console.log(chalk.bold('\nClaude SDK Authentication\n'));
    console.log(chalk.dim('Generate a long-lived token by running:'));
    console.log(chalk.cyan('  claude setup-token\n'));
    console.log(chalk.dim('Then paste the token below:\n'));

    const { token } = await inquirer.prompt<{ token: string }>([
      {
        type: 'password',
        name: 'token',
        message: 'Paste your Claude OAuth token:',
      },
    ]);

    if (token && token.trim().length > 10) {
      config.setClaudeOauthToken(token.trim());
      console.log(chalk.green('\n✓ Claude OAuth token saved'));
      console.log(chalk.dim('  Restart the agent runner to apply'));
    } else {
      console.log(chalk.yellow('No token provided'));
    }
  });

// Config command (show/edit config)
program
  .command('config')
  .description('Show or modify configuration')
  .option('--show', 'Show current configuration')
  .option('--reset', 'Reset configuration to defaults')
  .option('--set <key=value>', 'Set a configuration value')
  .option('--import <file>', 'Import configuration from a JSON file')
  .action(async (options) => {
    const { config } = await import('./lib/config.js');

    if (options.reset) {
      config.reset();
      console.log('Configuration reset to defaults.');
      return;
    }

    if (options.import) {
      const { readFileSync } = await import('node:fs');
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(readFileSync(options.import, 'utf-8'));
      } catch (err) {
        console.error(`Failed to read config file: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      if (data.apiUrl) config.setApiUrl(data.apiUrl as string);
      if (data.relayUrl) config.setRelayUrl(data.relayUrl as string);
      if (data.accessToken) config.setAccessToken(data.accessToken as string);
      if (data.refreshToken) config.setRefreshToken(data.refreshToken as string);
      if (data.wsToken) config.setWsToken(data.wsToken as string);
      if (data.machineId) config.setMachineId(data.machineId as string);
      if (data.claudeOauthToken) config.setClaudeOauthToken(data.claudeOauthToken as string);
      if (data.logLevel) config.setLogLevel(data.logLevel as 'debug' | 'info' | 'warn' | 'error');
      if (data.autoStart !== undefined) config.setAutoStart(data.autoStart as boolean);
      config.completeSetup();
      console.log('Configuration imported successfully.');
      return;
    }

    if (options.set) {
      const [key, value] = options.set.split('=');
      if (!key || value === undefined) {
        console.error('Invalid format. Use: --set key=value');
        process.exit(1);
      }

      switch (key) {
        case 'api':
        case 'apiUrl':
          config.setApiUrl(value);
          console.log(`Set API URL to: ${value}`);
          break;
        case 'relay':
        case 'relayUrl':
          config.setRelayUrl(value);
          console.log(`Set relay URL to: ${value}`);
          break;
        case 'accessToken':
          config.setAccessToken(value);
          console.log('Set access token');
          break;
        case 'refreshToken':
          config.setRefreshToken(value);
          console.log('Set refresh token');
          break;
        case 'wsToken':
          config.setWsToken(value);
          console.log('Set WebSocket token');
          break;
        case 'machineId':
          config.setMachineId(value);
          console.log(`Set machine ID to: ${value}`);
          break;
        case 'logLevel':
          if (!['debug', 'info', 'warn', 'error'].includes(value)) {
            console.error('Invalid log level. Use: debug, info, warn, error');
            process.exit(1);
          }
          config.setLogLevel(value as 'debug' | 'info' | 'warn' | 'error');
          console.log(`Set log level to: ${value}`);
          break;
        case 'claudeOauthToken':
          config.setClaudeOauthToken(value);
          console.log('Set Claude OAuth token');
          break;
        case 'autoStart':
          config.setAutoStart(value === 'true');
          console.log(`Set auto-start to: ${value}`);
          break;
        default:
          console.error(`Unknown configuration key: ${key}`);
          console.log('Available keys: apiUrl, relayUrl, accessToken, refreshToken, wsToken, claudeOauthToken, machineId, logLevel, autoStart');
          process.exit(1);
      }
      return;
    }

    // Show configuration (default)
    const currentConfig = config.getConfig();
    console.log('\nCurrent Configuration:\n');
    console.log(`  Runner ID:    ${currentConfig.runnerId || '(not set)'}`);
    console.log(`  Machine ID:   ${currentConfig.machineId || '(not set)'}`);
    console.log(`  API URL:      ${currentConfig.apiUrl}`);
    console.log(`  Relay URL:    ${currentConfig.relayUrl}`);
    console.log(`  Auto-start:   ${currentConfig.autoStart}`);
    console.log(`  Log level:    ${currentConfig.logLevel}`);
    console.log(`  Providers:    ${currentConfig.providers.length > 0 ? currentConfig.providers.join(', ') : '(none)'}`);
    console.log(`  Access token: ${currentConfig.accessToken ? 'configured' : 'not configured'}`);
    console.log(`  WS token:     ${currentConfig.wsToken ? 'configured' : 'not configured'}`);
    // Detect Claude auth status
    const { execFile: execFileCbCli } = await import('node:child_process');
    const { promisify: promisifyCli } = await import('node:util');
    const execFileCli = promisifyCli(execFileCbCli);
    let claudeStatus = 'not configured';
    if (config.getClaudeOauthToken()) {
      claudeStatus = 'OAuth token configured';
    } else if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
      claudeStatus = 'env variable configured';
    } else {
      try {
        const { stdout } = await execFileCli(
          process.platform === 'win32' ? 'where' : 'which',
          ['claude'],
          { timeout: 3000 },
        );
        if (stdout.trim()) claudeStatus = 'CLI session (auto-detected)';
      } catch { /* not installed */ }
    }
    console.log(`  Claude auth:  ${claudeStatus}`);
    console.log(`\n  Config file: ${config.getConfigPath()}`);
    console.log();
  });

// Providers command (list detected providers)
program
  .command('providers')
  .description('List detected agent providers')
  .action(async () => {
    const { detectProviders, formatProvidersSummary } = await import('./lib/providers.js');

    console.log('\nDetecting agent providers...\n');
    const providers = await detectProviders();
    console.log(formatProvidersSummary(providers));
    console.log();
  });

// Resources command (show machine resources)
program
  .command('resources')
  .description('Show machine resources (CPU, memory, GPU)')
  .action(async () => {
    const { getMachineResources, formatResourceSummary } = await import('./lib/resources.js');

    console.log('\nDetecting machine resources...\n');
    const resources = await getMachineResources();
    console.log(formatResourceSummary(resources));
    console.log();
  });

// Hosts command (discover SSH hosts)
program
  .command('hosts')
  .description('Discover remote hosts from SSH config')
  .action(async () => {
    const { discoverRemoteHosts, formatDiscoveredHosts } = await import('./lib/ssh-discovery.js');

    console.log('\nDiscovering remote hosts...\n');
    const hosts = await discoverRemoteHosts();
    console.log(formatDiscoveredHosts(hosts));
  });

// Launch command (setup + start in one step)
program
  .command('launch')
  .description('Setup (if needed) and start the agent runner in one step')
  .option('--api <url>', 'API server URL')
  .option('--relay <url>', 'Override relay server URL')
  .option('--hostname <hostname>', 'Machine hostname')
  .option('--skip-auth', 'Skip device authentication')
  .option('--max-tasks <number>', 'Maximum concurrent tasks', parseInt)
  .option('--log-level <level>', 'Log level: debug, info, warn, error')
  .option('--force-setup', 'Force re-run setup even if already configured')
  .option('--preserve-worktrees', 'Preserve worktrees after task completion')
  .option('--allow-non-git', 'Allow execution in non-git directories without prompting')
  .option('--sandbox', 'Always use sandbox mode')
  .option('--max-sandbox-size <mb>', 'Maximum sandbox size in MB (default: 100)', parseInt)
  .option('--no-ssh-config', 'Skip SSH host discovery (enabled by default)')
  .option('--no-launch-all', 'Skip starting agents on remote hosts (enabled by default)')
  .option('--verbose', 'Show detailed debug output')
  .action(async (options) => {
    try {
      const { config } = await import('./lib/config.js');
      const chalk = (await import('chalk')).default;

      // SSH config discovery and launch-all are ON by default; --no-ssh-config / --no-launch-all disable them
      const withSshConfig = options.sshConfig !== false;
      const launchAll = options.launchAll !== false && withSshConfig;

      let remoteHosts: import('./types.js').DiscoveredHost[] = [];

      if (options.forceSetup || !config.isSetupComplete()) {
        const result = await setupCommand({
          api: options.api,
          relay: options.relay,
          hostname: options.hostname,
          skipAuth: options.skipAuth,
          withSshConfig,
          returnInstalledHosts: launchAll,
          verbose: options.verbose,
        });
        if (launchAll && result.installedHosts) {
          remoteHosts = result.installedHosts;
        }
      } else if (launchAll) {
        // Setup already complete — read stored remote hosts
        remoteHosts = config.getRemoteHosts();
        if (remoteHosts.length === 0) {
          console.log(chalk.yellow('\nNo remote hosts configured. Run with --force-setup to discover SSH hosts.\n'));
        }
      }

      // Start remote agents before starting local
      if (launchAll && remoteHosts.length > 0) {
        const { startRemoteAgents } = await import('./lib/ssh-installer.js');

        console.log(chalk.bold(`\nStarting agents on ${remoteHosts.length} remote host(s)...\n`));

        const results = await startRemoteAgents(
          remoteHosts,
          {
            maxTasks: options.maxTasks,
            logLevel: options.logLevel,
            preserveWorktrees: options.preserveWorktrees,
          },
          options.verbose ? (host, msg) => console.log(chalk.dim(`  [${host}] ${msg}`)) : () => {},
        );

        // Report results
        for (const r of results) {
          if (r.success) {
            const tag = r.alreadyRunning ? 'already running' : 'started';
            console.log(chalk.green(`  ✓ ${r.host.name}: ${tag}`));
          } else {
            console.log(chalk.red(`  ✗ ${r.host.name}: ${r.message}`));
          }
        }

        const ok = results.filter((r) => r.success).length;
        const fail = results.filter((r) => !r.success).length;
        console.log(chalk.dim(`\n  Remote agents: ${ok} running, ${fail} failed\n`));
      }

      // Start local agent
      await startCommand({
        foreground: true,
        relay: options.relay,
        maxTasks: options.maxTasks,
        logLevel: options.logLevel,
        preserveWorktrees: options.preserveWorktrees,
        allowNonGit: options.allowNonGit,
        useSandbox: options.sandbox,
        maxSandboxSize: options.maxSandboxSize ? options.maxSandboxSize * 1024 * 1024 : undefined,
        verbose: options.verbose,
      });
    } catch (error) {
      console.error('Launch failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// MCP command (start MCP server for Claude Code integration)
program
  .command('mcp')
  .description('Start MCP server for Claude Code integration (stdio mode)')
  .option('--relay <url>', 'Override relay server URL')
  .option('--log-level <level>', 'Log level: debug, info, warn, error', 'info')
  .action(async (options) => {
    try {
      await mcpCommand({
        relay: options.relay,
        logLevel: options.logLevel,
      });
    } catch (error) {
      console.error('MCP server error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Parse arguments
program.parse();
