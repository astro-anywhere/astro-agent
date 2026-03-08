/**
 * Setup command - runs device auth, detects providers, configures relay
 */

import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname as osHostname } from 'node:os';
import { config } from '../lib/config.js';
import { detectProviders, formatProvidersSummary } from '../lib/providers.js';
import { getMachineResources, formatResourceSummary } from '../lib/resources.js';
import { discoverRemoteHosts, formatDiscoveredHosts } from '../lib/ssh-discovery.js';
import { requestDeviceCode, pollForToken, registerMachine, DeviceAuthApiError } from '../lib/api-client.js';
import { detectLocalIP, checkRemoteNode, packAndInstall, sshExec } from '../lib/ssh-installer.js';
import type { ProviderType, DiscoveredHost } from '../types.js';

const execFile = promisify(execFileCb);

export interface SetupOptions {
  api?: string;
  relay?: string;
  hostname?: string;
  skipAuth?: boolean;
  nonInteractive?: boolean;
  withSshConfig?: boolean;
  autoStart?: boolean;
  installMcp?: boolean;
  returnInstalledHosts?: boolean;
  verbose?: boolean;
}

export interface SetupResult {
  installedHosts?: DiscoveredHost[];
}

export async function setupCommand(options: SetupOptions = {}): Promise<SetupResult> {
  const verbose = options.verbose ?? false;

  console.log(chalk.bold('\n🚀 Astro Agent Runner Setup\n'));

  // Reset config to defaults so setup always starts fresh
  config.reset();
  if (verbose) console.log(chalk.dim('Configuration reset to defaults.'));

  // Step 0: Initialize hardware-based machine ID
  if (verbose) console.log(chalk.dim('Generating stable machine identifier...'));
  const hwId = await config.initializeMachineId();
  if (verbose) {
    const hwSource = hwId.source === 'uuid' ? 'Hardware UUID' :
                     hwId.source === 'mac' ? 'MAC Address' : 'Random UUID';
    console.log(chalk.green(`✓ Machine ID: ${hwId.id.slice(0, 16)}... (from ${hwSource})`));
    console.log();
  }

  // Step 1: Detect machine resources
  const resourceSpinner = ora('Detecting machine resources...').start();
  let resources: Awaited<ReturnType<typeof getMachineResources>> | undefined;
  try {
    resources = await getMachineResources();
    resourceSpinner.succeed('Machine resources detected');
    if (verbose) {
      console.log(chalk.dim(formatResourceSummary(resources)));
    }
    console.log();
  } catch (error) {
    resourceSpinner.fail('Failed to detect machine resources');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }

  // Step 2: Detect installed providers
  const providerSpinner = ora('Detecting agent providers...').start();
  let detectedProviders: Awaited<ReturnType<typeof detectProviders>>;
  try {
    detectedProviders = await detectProviders();
    if (detectedProviders.length > 0) {
      const providerNames = detectedProviders.filter(p => p.available).map(p => p.name).join(', ');
      providerSpinner.succeed(`Found ${detectedProviders.length} agent provider(s)${providerNames ? `: ${providerNames}` : ''}`);
      if (verbose) console.log(chalk.dim(formatProvidersSummary(detectedProviders)));
    } else {
      providerSpinner.warn('No agent providers detected');
      console.log(chalk.yellow('  Install Claude Code or Codex to enable task execution'));
      console.log(chalk.dim('  Claude Code: https://claude.ai/code'));
      console.log(chalk.dim('  Codex: https://openai.com/codex'));
    }
    console.log();
  } catch {
    providerSpinner.fail('Failed to detect providers');
    detectedProviders = [];
  }

  // Step 2b: Detect GitHub CLI (gh) — needed for PR delivery mode
  const ghSpinner = ora('Checking GitHub CLI (gh)...').start();
  let ghAvailable = false;
  try {
    const { isGhAvailable } = await import('../lib/git-pr.js');
    ghAvailable = await isGhAvailable();
    if (ghAvailable) {
      ghSpinner.succeed('GitHub CLI (gh) authenticated');
    } else {
      ghSpinner.warn('GitHub CLI (gh) not found or not authenticated');
      console.log(chalk.yellow('  PR delivery mode requires gh. Attempting to install...'));
      const installed = await tryInstallGh(verbose);
      if (installed) {
        ghAvailable = await isGhAvailable();
        if (ghAvailable) {
          console.log(chalk.green('  ✓ gh installed and authenticated'));
        } else {
          console.log(chalk.yellow('  gh installed but not authenticated. Run: gh auth login'));
        }
      } else {
        console.log(chalk.dim('  Install manually: https://cli.github.com'));
        console.log(chalk.dim('  Without gh, tasks fall back to local branch merge (no PRs created)'));
      }
    }
    console.log();
  } catch {
    ghSpinner.info('GitHub CLI check skipped');
    console.log();
  }

  // Step 3: Discover SSH hosts (only if --with-ssh-config flag is set)
  let discoveredHosts: DiscoveredHost[] = [];
  if (options.withSshConfig) {
    const sshSpinner = ora('Discovering remote hosts...').start();
    try {
      discoveredHosts = await discoverRemoteHosts();
      if (discoveredHosts.length > 0) {
        sshSpinner.succeed(`Found ${discoveredHosts.length} remote host(s)`);
        if (verbose) console.log(chalk.dim(formatDiscoveredHosts(discoveredHosts)));
      } else {
        sshSpinner.info('No remote hosts discovered');
      }
      console.log();
    } catch {
      sshSpinner.fail('Failed to discover remote hosts');
      discoveredHosts = [];
    }
  }

  // Step 4a: Configure API URL
  // Priority: --api flag > env vars (ASTRO_SERVER_URL, VITE_API_BASE_URL, CLOUDFLARED_DOMAIN) > stored config
  const apiUrl = options.api ?? config.getApiUrl();
  config.setApiUrl(apiUrl);
  if (verbose) console.log(chalk.green(`✓ API server: ${apiUrl}\n`));

  // Step 4b: Configure relay URL
  // Priority: --relay flag > env vars (ASTRO_RELAY_URL, VITE_API_BASE_URL, CLOUDFLARED_DOMAIN) > stored config
  const relayUrl = options.relay ?? config.getRelayUrl();
  config.setRelayUrl(relayUrl);
  if (verbose) console.log(chalk.green(`✓ Relay server: ${relayUrl}\n`));

  // Step 5: Device authentication (if not skipped)
  if (!options.skipAuth) {
    console.log(chalk.bold('Device Authentication\n'));

    // Check if already authenticated
    const existingMachineId = config.getMachineId();
    const hasTokens = config.getAccessToken() && config.getRefreshToken();

    if (hasTokens && existingMachineId) {
      // Always re-authenticate to get fresh tokens (old ones may have expired)
      if (verbose) {
        console.log(chalk.dim(`  Previously authenticated as ${existingMachineId}, refreshing tokens...`));
        console.log();
      }
      await runDeviceAuthFlow(apiUrl, relayUrl, resources, detectedProviders, !!options.relay, hwId);
    } else if (!options.nonInteractive) {
      const { authenticate } = await inquirer.prompt<{ authenticate: boolean }>([
        {
          type: 'confirm',
          name: 'authenticate',
          message: 'Would you like to authenticate this device now?',
          default: true,
        },
      ]);

      if (authenticate) {
        await runDeviceAuthFlow(apiUrl, relayUrl, resources, detectedProviders, !!options.relay, hwId);
      }
    } else {
      console.log(chalk.yellow('Skipping authentication in non-interactive mode'));
      console.log(chalk.dim('Run setup again interactively to authenticate'));
      console.log();
    }
  }

  // Step 6: Claude SDK authentication
  if (!options.nonInteractive) {
    console.log(chalk.bold('Claude SDK Authentication\n'));

    const hasExistingToken = !!config.getClaudeOauthToken();
    const hasEnvToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

    if (hasEnvToken) {
      console.log(chalk.green('✓ Claude authentication detected via environment variable\n'));
    } else if (hasExistingToken) {
      console.log(chalk.green('✓ Claude OAuth token already configured\n'));
      const { reconfigure } = await inquirer.prompt<{ reconfigure: boolean }>([
        {
          type: 'confirm',
          name: 'reconfigure',
          message: 'Reconfigure Claude OAuth token?',
          default: false,
        },
      ]);
      if (reconfigure) {
        await setupClaudeOauthToken();
      }
    } else {
      // Check if `claude` CLI is already logged in (session-based OAuth)
      let claudeCliLoggedIn = false;
      try {
        const { stdout } = await execFile('claude', ['--version']);
        if (stdout) claudeCliLoggedIn = true;
      } catch {
        // claude CLI not available
      }

      if (claudeCliLoggedIn) {
        console.log(chalk.green('✓ Claude CLI detected — agent SDK will use existing CLI session\n'));
      } else {
        console.log(chalk.dim('The agent runner needs authentication to call the Claude API.'));
        console.log(chalk.dim('You can either:'));
        console.log(chalk.dim('  1. Run `claude login` to authenticate the CLI (recommended)'));
        console.log(chalk.dim('  2. Set ANTHROPIC_API_KEY environment variable'));
        console.log(chalk.dim('  3. Generate a long-lived token via `claude setup-token`\n'));
      }
    }
    console.log();
  }

  // Step 7: Save provider configuration
  const providerTypes = detectedProviders
    .filter((p) => p.available)
    .map((p) => p.type as ProviderType);
  config.setProviders(providerTypes);

  // Step 8: Offer to install on remote hosts (only if SSH discovery was enabled)
  if (options.withSshConfig && discoveredHosts.length > 0 && !options.nonInteractive) {
    console.log(chalk.bold('Remote Installation\n'));
    console.log(chalk.dim('  Navigate with ↑↓, press Enter to toggle, scroll down to Confirm or Skip.\n'));

    const selectedHosts = await selectHostsInteractive(discoveredHosts);

    if (selectedHosts.length > 0) {
      const installed = await installOnRemoteHosts(selectedHosts, discoveredHosts, apiUrl, relayUrl, verbose);
      // Save installed hosts to config for --launch-all reuse
      if (installed.length > 0) {
        config.setRemoteHosts(installed);
      }
    }
  }

  // Step 9: Configure auto-start (use flag instead of prompting)
  const autoStart = options.autoStart ?? false;
  config.setAutoStart(autoStart);

  if (autoStart) {
    console.log(chalk.green('✓ Auto-start enabled'));
    console.log(chalk.dim('  The agent will start automatically when you log in'));
    console.log(chalk.yellow('  Note: Auto-start setup is not yet implemented'));
  }

  // Step 10: Configure MCP for Claude Code integration (install by default if flag is set)
  let mcpConfigured = false;
  if (options.installMcp) {
    console.log();
    console.log(chalk.bold('Claude Code Integration\n'));
    console.log(chalk.dim('Configuring MCP bridge for Claude Code integration...\n'));
    mcpConfigured = await configureMcpForClaudeCode();
  }

  // Mark setup as complete
  config.completeSetup();

  // Summary
  console.log();
  console.log(chalk.bold.green('✓ Setup Complete!\n'));

  if (verbose) {
    console.log('Configuration saved to:', chalk.dim(config.getConfigPath()));
    console.log();
    console.log('Runner ID:', chalk.cyan(config.getRunnerId()));
    console.log('Machine ID:', chalk.cyan(config.getMachineId()));
    console.log('API URL:  ', chalk.cyan(config.getApiUrl()));
    console.log('Relay URL:', chalk.cyan(config.getRelayUrl()));
    console.log(
      'Auth:    ',
      config.getAccessToken() ? chalk.green('authenticated') : chalk.yellow('not configured'),
    );
    // Detect Claude auth: stored token > env var > CLI session
    let claudeAuthStatus: string;
    if (config.getClaudeOauthToken()) {
      claudeAuthStatus = chalk.green('OAuth token configured');
    } else if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
      claudeAuthStatus = chalk.green('env variable configured');
    } else {
      // Check if claude CLI is available (will use its session automatically)
      let hasCli = false;
      try {
        const { stdout } = await execFile(
          process.platform === 'win32' ? 'where' : 'which',
          ['claude'],
          { timeout: 3000 },
        );
        if (stdout.trim()) hasCli = true;
      } catch { /* not installed */ }
      claudeAuthStatus = hasCli
        ? chalk.green('CLI session (auto-detected)')
        : chalk.yellow('not configured — run `claude login` or set ANTHROPIC_API_KEY');
    }
    console.log('Claude:  ', claudeAuthStatus);
    console.log(
      'Providers:',
      providerTypes.length > 0 ? chalk.cyan(providerTypes.join(', ')) : chalk.yellow('none'),
    );
    console.log(
      'MCP:     ',
      mcpConfigured ? chalk.green('configured for Claude Code') : chalk.yellow('not configured'),
    );
    console.log();
  }
  console.log(chalk.bold('Next steps:'));
  console.log('  1. Start the agent runner:');
  console.log(chalk.cyan('     npx @astroanywhere/agent start'));
  console.log();
  console.log('  2. Or run in the foreground for testing:');
  console.log(chalk.cyan('     npx @astroanywhere/agent start --foreground'));
  console.log();

  if (mcpConfigured) {
    console.log('  3. In Claude Code, use these tools to connect to Astro:');
    console.log(chalk.cyan('     astro_attach("TASK-ID")  # Attach to a task'));
    console.log(chalk.cyan('     astro_status()           # Check connection status'));
    console.log(chalk.cyan('     astro_detach()           # Detach from task'));
    console.log();
  }

  // Return only hosts that were actually installed (not all discovered hosts)
  const storedHosts = config.getRemoteHosts();
  return { installedHosts: storedHosts };
}

// ============================================================================
// Claude SDK OAuth token setup
// ============================================================================

async function setupClaudeOauthToken(): Promise<void> {
  console.log();
  console.log(chalk.dim('This will run `claude setup-token` to generate a long-lived OAuth token.'));
  console.log(chalk.dim('You will need a Claude Pro/Max subscription.\n'));

  const spinner = ora('Running claude setup-token...').start();

  try {
    // Check if claude CLI is available
    const claudePath = await findClaudeBinary();
    if (!claudePath) {
      spinner.fail('Claude Code CLI not found');
      console.log(chalk.yellow('  Install Claude Code first: https://claude.ai/code'));
      console.log(chalk.dim('  Or manually set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY\n'));
      return;
    }

    spinner.stop();

    // Run `claude setup-token` interactively — it needs user input for the OAuth flow
    console.log(chalk.bold('  Running: claude setup-token\n'));

    const { execFileSync } = await import('node:child_process');
    const result = execFileSync(claudePath, ['setup-token'], {
      stdio: 'pipe',
      timeout: 120_000,
      encoding: 'utf-8',
    });

    // The output should contain the token — extract it
    // `claude setup-token` outputs the token to stdout
    const token = result.trim();

    if (token && token.length > 20) {
      config.setClaudeOauthToken(token);
      process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
      console.log(chalk.green('✓ Claude OAuth token saved'));
      console.log(chalk.dim('  Token will be used automatically when the agent starts'));
    } else {
      // setup-token is interactive, so piping stdout may not capture the token
      // Fall back to manual entry
      console.log(chalk.yellow('Could not capture token automatically.'));
      await promptForClaudeToken();
    }
  } catch (error) {
    spinner.stop();
    const msg = error instanceof Error ? error.message : String(error);

    // setup-token is interactive and needs a TTY — if piping fails, prompt manually
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      console.log(chalk.yellow('Claude Code CLI not found.'));
      console.log(chalk.dim('Install it from: https://claude.ai/code\n'));
    } else {
      console.log(chalk.yellow('Could not run `claude setup-token` automatically.'));
      console.log(chalk.dim(`  Error: ${msg}\n`));
    }

    console.log(chalk.dim('You can run it manually:'));
    console.log(chalk.cyan('  claude setup-token'));
    console.log(chalk.dim('Then paste the token here:\n'));

    await promptForClaudeToken();
  }
}

async function promptForClaudeToken(): Promise<void> {
  const { token } = await inquirer.prompt<{ token: string }>([
    {
      type: 'password',
      name: 'token',
      message: 'Paste your Claude OAuth token (or press Enter to skip):',
    },
  ]);

  if (token && token.trim().length > 10) {
    config.setClaudeOauthToken(token.trim());
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token.trim();
    console.log(chalk.green('✓ Claude OAuth token saved'));
  } else {
    console.log(chalk.yellow('Skipped — you can set it later via environment variable'));
  }
}

async function findClaudeBinary(): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      process.platform === 'win32' ? 'where' : 'which',
      ['claude'],
      { timeout: 5000 },
    );
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// Device auth flow (real backend)
// ============================================================================

async function runDeviceAuthFlow(
  apiUrl: string,
  _relayUrl: string,
  resources: Awaited<ReturnType<typeof getMachineResources>> | undefined,
  detectedProviders: Awaited<ReturnType<typeof detectProviders>>,
  relayExplicit = false,
  hwId: { id: string; source: 'uuid' | 'mac' | 'random' },
): Promise<void> {
  const hostname = resources?.hostname ?? osHostname();
  const platform = resources?.platform ?? process.platform;

  // Generate a stable machine name from hardware ID
  const { generateMachineName } = await import('../lib/hardware-id.js');
  const machineName = generateMachineName(hwId.id, hwId.source);

  // 1. Request device code
  const authSpinner = ora('Requesting device code...').start();
  let deviceAuth;
  try {
    deviceAuth = await requestDeviceCode(apiUrl, {
      hostname,
      platform,
    });
  } catch (err) {
    authSpinner.fail('Failed to request device code');
    if (err instanceof DeviceAuthApiError) {
      console.error(chalk.red(`  ${err.message}`));
      if (err.code === 'network') {
        console.log(chalk.dim(`  Is the backend running at ${apiUrl}?`));
        console.log(chalk.dim('  Start it with: npm run dev:backend'));
      }
    } else {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    }
    console.log();
    return;
  }

  // 2. Show verification URL and code
  authSpinner.info('Please authorize this device');
  console.log();
  console.log(chalk.bold('  Open this URL in your browser:'));
  console.log(chalk.cyan(`  ${deviceAuth.verificationUriComplete}`));
  console.log();
  console.log(chalk.bold('  Device code:'));
  console.log(chalk.yellow(`  ${deviceAuth.deviceCode}`));
  console.log();

  // 3. Try to auto-open in browser
  tryOpenUrl(deviceAuth.verificationUriComplete);

  // 4. Poll for authorization
  const pollSpinner = ora('Waiting for authorization...').start();
  let tokenResponse;
  try {
    tokenResponse = await pollForToken(
      apiUrl,
      deviceAuth.userCode,
      deviceAuth.interval,
      deviceAuth.expiresIn,
    );
  } catch (err) {
    if (err instanceof DeviceAuthApiError) {
      switch (err.code) {
        case 'denied':
          pollSpinner.fail('Authorization denied by user');
          break;
        case 'expired':
          pollSpinner.fail('Device code expired. Run setup again to retry.');
          break;
        case 'timeout':
          pollSpinner.fail('Timed out waiting for authorization');
          break;
        default:
          pollSpinner.fail(`Authorization failed: ${err.message}`);
      }
    } else {
      pollSpinner.fail('Authorization failed');
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    }
    console.log();
    return;
  }

  pollSpinner.succeed('Device authenticated successfully');

  // 5. Register machine
  const regSpinner = ora('Registering machine...').start();
  try {
    const providerTypes = detectedProviders
      .filter((p) => p.available)
      .map((p) => ({ type: p.type, name: p.name, version: p.version }));

    const regResponse = await registerMachine(apiUrl, tokenResponse.accessToken, {
      machineId: hwId.id, // Hardware-based stable ID — used as DB primary key
      hostname, // Actual network hostname (for display)
      name: machineName, // Stable name from hardware ID
      platform,
      providers: providerTypes,
      resources: resources ?? undefined,
      metadata: {
        hardwareId: hwId.id,
        hardwareIdSource: hwId.source,
      },
    });

    regSpinner.succeed(`Machine registered as "${regResponse.machineName}" (${regResponse.machineId})`);

    // 6. Save all tokens and IDs
    config.setAccessToken(regResponse.accessToken);
    config.setRefreshToken(regResponse.refreshToken);
    config.setWsToken(regResponse.wsToken);
    config.setMachineId(regResponse.machineId);

    // Update relay URL if the server provided one (but not if explicitly passed via --relay)
    if (regResponse.relayUrl && !relayExplicit) {
      config.setRelayUrl(regResponse.relayUrl);
    }

    // Add dispatch public key to trusted keys for signature verification.
    // Multiple keys are supported (e.g., from different browsers).
    if (regResponse.dispatchPublicKey) {
      config.addDispatchPublicKey(regResponse.dispatchPublicKey);
      const total = config.getDispatchPublicKeys().length;
      console.log(`[setup] Added dispatch public key (${total} trusted key${total === 1 ? '' : 's'} total)`);
    }

    console.log();
  } catch (err) {
    regSpinner.fail('Failed to register machine');
    if (err instanceof DeviceAuthApiError) {
      console.error(chalk.red(`  ${err.message}`));
    } else {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    }
    // Still save the access/refresh tokens from the auth step
    config.setAccessToken(tokenResponse.accessToken);
    config.setRefreshToken(tokenResponse.refreshToken);
    console.log();
  }
}

// ============================================================================
// Remote SSH install
// ============================================================================

async function installOnRemoteHosts(
  selectedHosts: string[],
  discoveredHosts: DiscoveredHost[],
  apiUrl: string,
  relayUrl: string,
  verbose = false,
): Promise<DiscoveredHost[]> {
  const installedHosts: DiscoveredHost[] = [];
  console.log();
  const localIP = detectLocalIP();
  // Build URLs that remote hosts can reach
  const remoteApiUrl = apiUrl.replace('localhost', localIP).replace('127.0.0.1', localIP);
  const remoteRelayUrl = relayUrl.replace('localhost', localIP).replace('127.0.0.1', localIP);

  for (const hostName of selectedHosts) {
    const host = discoveredHosts.find((h) => h.name === hostName);
    if (!host) continue;

    const spinner = ora(`Checking ${hostName}...`).start();

    // Always stop existing agent before reinstalling (fresh start with latest binary/config).
    // Matching the behavior of startRemoteAgents() — PRs #2/#3 found that pgrep-based
    // "already running" detection is unreliable (self-matches the SSH command process).
    spinner.text = `${hostName}: Stopping existing agent (if any)...`;
    await sshExec(host, 'pkill -f "[a]stro-agent start" 2>/dev/null || true').catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));

    spinner.text = `Checking Node.js on ${hostName}...`;

    // Check remote Node.js availability
    const nodeCheck = await checkRemoteNode(host);
    if (!nodeCheck.available) {
      spinner.fail(
        `${hostName}: Node.js ${nodeCheck.version ? `${nodeCheck.version} (need ≥18)` : 'not found'}`,
      );
      console.log(chalk.dim('  Install Node.js ≥ 18 on this host first'));
      continue;
    }

    spinner.text = `Installing on ${hostName}...`;

    // Get the local access token to register on behalf of remote hosts
    const localAccessToken = config.getAccessToken();

    if (!localAccessToken) {
      spinner.fail(`${hostName}: No auth tokens available. Authenticate locally first.`);
      continue;
    }

    try {
      // Register each remote host as a separate machine with its own ID
      spinner.text = `${hostName}: Registering machine...`;
      if (verbose) {
        console.log();
        console.log(chalk.dim(`[setup] Registering ${hostName} (${host.hostname}) at ${remoteApiUrl}`));
        console.log(chalk.dim(`[setup] Using access token: ${localAccessToken.slice(0, 20)}...`));
      }

      const regResponse = await registerMachine(remoteApiUrl, localAccessToken, {
        hostname: host.hostname,
        name: hostName,
        platform: 'linux',
        providers: [],
      });

      if (verbose) {
        console.log(chalk.dim(`[setup] ✓ Machine registered with ID: ${regResponse.machineId}`));
        console.log(chalk.dim(`[setup]   Access token: ${regResponse.accessToken.slice(0, 20)}...`));
        console.log(chalk.dim(`[setup]   Refresh token: ${regResponse.refreshToken.slice(0, 20)}...`));
        console.log(chalk.dim(`[setup]   WS token: ${regResponse.wsToken.slice(0, 20)}...`));
      }

      await packAndInstall(
        {
          host,
          apiUrl: remoteApiUrl,
          relayUrl: remoteRelayUrl,
          accessToken: regResponse.accessToken,
          refreshToken: regResponse.refreshToken,
          wsToken: regResponse.wsToken,
          machineId: regResponse.machineId,
        },
        (msg) => {
          spinner.text = `${hostName}: ${msg}`;
        },
      );
      spinner.succeed(`${hostName}: Installed and configured (${regResponse.machineId})`);
      installedHosts.push(host);
    } catch (err) {
      spinner.fail(`${hostName}: Installation failed`);
      console.error(chalk.red(`  ${err instanceof Error ? err.message : String(err)}`));
      if (verbose && err instanceof Error && err.stack) {
        console.error(chalk.dim(`[setup] Stack trace: ${err.stack}`));
      }
    }
  }
  console.log();
  return installedHosts;
}

// ============================================================================
// MCP Configuration for Claude Code
// ============================================================================

async function configureMcpForClaudeCode(): Promise<boolean> {
  const { getClaudeCodeMcpConfig, getClaudeCodeConfigPath } = await import('../mcp/server.js');
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');

  const configPath = getClaudeCodeConfigPath();
  const mcpConfig = getClaudeCodeMcpConfig();

  const spinner = ora('Configuring Claude Code MCP integration...').start();

  try {
    // Ensure the config directory exists
    await mkdir(dirname(configPath), { recursive: true });

    // Read existing config or start fresh
    let existingConfig: Record<string, unknown> = {};
    try {
      const content = await readFile(configPath, 'utf-8');
      existingConfig = JSON.parse(content);
    } catch {
      // File doesn't exist or invalid JSON - start fresh
    }

    // Merge configurations
    const mcpServers = (existingConfig.mcpServers as Record<string, unknown>) ?? {};
    const updatedConfig = {
      ...existingConfig,
      mcpServers: {
        ...mcpServers,
        ...mcpConfig.mcpServers,
      },
    };

    // Write updated config
    await writeFile(configPath, JSON.stringify(updatedConfig, null, 2));

    spinner.succeed('Claude Code MCP integration configured');
    console.log(chalk.dim(`  Config: ${configPath}`));
    console.log(chalk.dim('  Server: astro (npx @astroanywhere/agent mcp)'));
    console.log();

    return true;
  } catch (error) {
    spinner.fail('Failed to configure Claude Code MCP integration');
    console.error(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
    console.log();
    console.log(chalk.dim('You can manually add this to your Claude Code MCP config:'));
    console.log(chalk.cyan(JSON.stringify(mcpConfig, null, 2)));
    console.log();

    return false;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Interactive host selection using a list prompt with Enter-to-toggle.
 *
 * Shows all hosts with ◯/✓ markers. Pressing Enter on a host toggles it.
 * "Select all" toggles all hosts. "Confirm" and "Skip" at the bottom.
 * Cursor stays on the same position after each toggle.
 */
async function selectHostsInteractive(hosts: DiscoveredHost[]): Promise<string[]> {
  const selected = new Set<string>();
  const ACTION_SELECT_ALL = '__select_all__';
  const ACTION_CONFIRM = '__confirm__';
  const ACTION_SKIP = '__skip__';

  let cursorIndex = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Build choices with current selection state
    const choices: Array<{ name: string; value: string } | inquirer.Separator> = [];

    for (const h of hosts) {
      const marker = selected.has(h.name) ? chalk.green('✓') : chalk.dim('◯');
      const label = h.hostname !== h.name ? `${h.name} ${chalk.dim(`(${h.hostname})`)}` : h.name;
      const user = h.user ? chalk.dim(` [${h.user}]`) : '';
      choices.push({ name: `${marker} ${label}${user}`, value: h.name });
    }

    choices.push(new inquirer.Separator(chalk.dim('──────────────────')));

    const allSelected = hosts.every((h) => selected.has(h.name));
    const selectAllLabel = allSelected ? 'Deselect all' : 'Select all';
    choices.push({ name: chalk.cyan(`◉ ${selectAllLabel}`), value: ACTION_SELECT_ALL });

    choices.push(new inquirer.Separator(chalk.dim('──────────────────')));
    choices.push({ name: chalk.green(`✔ Confirm (${selected.size} selected)`), value: ACTION_CONFIRM });
    choices.push({ name: chalk.yellow('✘ Skip'), value: ACTION_SKIP });

    const { choice } = await inquirer.prompt<{ choice: string }>([
      {
        type: 'list',
        name: 'choice',
        message: `Select hosts to install on:`,
        choices,
        pageSize: choices.length,
        default: cursorIndex,
      },
    ]);

    if (choice === ACTION_CONFIRM) {
      return Array.from(selected);
    }

    if (choice === ACTION_SKIP) {
      return [];
    }

    if (choice === ACTION_SELECT_ALL) {
      if (allSelected) {
        selected.clear();
      } else {
        for (const h of hosts) selected.add(h.name);
      }
      // Keep cursor on Select all
      cursorIndex = hosts.length + 1; // +1 for separator
    } else {
      // Toggle host
      if (selected.has(choice)) {
        selected.delete(choice);
      } else {
        selected.add(choice);
      }
      // Keep cursor on the same host
      cursorIndex = hosts.findIndex((h) => h.name === choice);
    }
  }
}

/**
 * Attempt to install GitHub CLI (gh) via the system package manager.
 * Returns true if the binary is available after the attempt.
 */
async function tryInstallGh(verbose?: boolean): Promise<boolean> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      // macOS: try Homebrew
      if (verbose) console.log(chalk.dim('  Trying: brew install gh'));
      await execFile('brew', ['install', 'gh'], { timeout: 120_000 });
      return true;
    } else if (platform === 'linux') {
      // Linux: try common package managers in order
      for (const [cmd, args] of [
        ['conda', ['install', '-y', '-c', 'conda-forge', 'gh']],
        ['apt-get', ['install', '-y', 'gh']],
        ['dnf', ['install', '-y', 'gh']],
        ['yum', ['install', '-y', 'gh']],
      ] as const) {
        try {
          await execFile('which', [cmd], { timeout: 5_000 });
          if (verbose) console.log(chalk.dim(`  Trying: ${cmd} ${args.join(' ')}`));
          await execFile(cmd, [...args], { timeout: 120_000 });
          return true;
        } catch {
          continue;
        }
      }
    }
  } catch (err) {
    if (verbose) console.log(chalk.dim(`  Install failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  return false;
}

function tryOpenUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd, [url]).catch(() => {
    // Silently ignore — user can open manually
  });
}
