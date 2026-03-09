/**
 * Setup command - runs device auth, detects providers, configures relay
 */

import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname as osHostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.js';
import { detectProviders } from '../lib/providers.js';
import { getMachineResources, formatResourceSummary } from '../lib/resources.js';
import { discoverRemoteHosts } from '../lib/ssh-discovery.js';
import { requestDeviceCode, pollForToken, registerMachine, DeviceAuthApiError } from '../lib/api-client.js';
import {
  detectLocalIP, checkRemoteNode, packAndInstall, sshExec,
  hasControlMaster, establishControlMaster, teardownControlMaster,
} from '../lib/ssh-installer.js';
import {
  formatInstallErrorBox,
  formatAgentDetectionBox,
  formatGhStatusLine,
  formatSshDiscoveryBox,
  formatSetupSummaryBox,
  formatSectionHeader,
  type InstallErrorInfo,
} from '../lib/display.js';
import type { ProviderType, DiscoveredHost } from '../types.js';

const execFile = promisify(execFileCb);

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
  const providerSpinner = ora('Detecting AI agents...').start();
  let detectedProviders: Awaited<ReturnType<typeof detectProviders>>;
  try {
    detectedProviders = await detectProviders();
    const available = detectedProviders.filter(p => p.available);
    if (available.length > 0) {
      providerSpinner.succeed(`Found ${available.length} AI agent(s)`);
    } else {
      providerSpinner.warn('No AI agents detected');
    }
    console.log();
    console.log(formatAgentDetectionBox(detectedProviders));
    console.log();
  } catch {
    providerSpinner.fail('Failed to detect AI agents');
    detectedProviders = [];
  }

  // Step 2b: Detect GitHub CLI (gh) — needed for PR delivery mode
  const ghSpinner = ora('Checking GitHub CLI (gh)...').start();
  let ghAvailable = false;
  let ghStatus: 'authenticated' | 'installed' | 'not_installed' = 'not_installed';
  try {
    const { isGhAvailable } = await import('../lib/git-pr.js');
    // First check: is gh installed at all?
    let ghInstalled = false;
    try {
      await execFile('which', ['gh'], { timeout: 5_000 });
      ghInstalled = true;
    } catch { /* not in PATH */ }

    if (ghInstalled) {
      // gh exists — check if authenticated
      ghAvailable = await isGhAvailable();
      if (ghAvailable) {
        ghStatus = 'authenticated';
        ghSpinner.succeed('GitHub CLI (gh) ready');
      } else {
        ghStatus = 'installed';
        ghSpinner.warn('GitHub CLI (gh) not authenticated');
        console.log(chalk.yellow('  Run `gh auth login` to enable PR creation'));
      }
    } else {
      ghSpinner.info('GitHub CLI (gh) not installed');
      // macOS: attempt auto-install via brew
      if (process.platform === 'darwin') {
        console.log(chalk.yellow('  Attempting to install gh via Homebrew...'));
        const installed = await tryInstallGh(verbose);
        if (installed) {
          ghAvailable = await isGhAvailable();
          ghStatus = ghAvailable ? 'authenticated' : 'installed';
          if (ghAvailable) {
            console.log(chalk.green('  ✓ gh installed and authenticated'));
          } else {
            console.log(chalk.green('  ✓ gh installed'));
            console.log(chalk.yellow('  Run `gh auth login` to enable PR creation'));
          }
        } else {
          showGhInstallRecommendation();
        }
      } else {
        showGhInstallRecommendation();
      }
    }
    console.log(formatGhStatusLine(ghStatus));
    console.log();
  } catch {
    ghSpinner.info('GitHub CLI check skipped');
    console.log();
  }

  // Step 3: Discover SSH hosts (only if --with-ssh-config flag is set)
  let discoveredHosts: DiscoveredHost[] = [];
  if (options.withSshConfig) {
    console.log(formatSectionHeader('SSH Discovery'));
    console.log();
    const sshSpinner = ora('Discovering remote hosts...').start();
    try {
      discoveredHosts = await discoverRemoteHosts({ verbose });
      if (discoveredHosts.length > 0) {
        sshSpinner.succeed(`Found ${discoveredHosts.length} remote host(s)`);
        console.log();
        console.log(formatSshDiscoveryBox(discoveredHosts));
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
      // Check if `claude` CLI is available on this machine
      let claudeDetected = false;
      try {
        const { stdout } = await execFile('claude', ['--version']);
        if (stdout) claudeDetected = true;
      } catch {
        // claude CLI not available
      }

      if (claudeDetected) {
        // Claude is installed but no explicit token is configured.
        // The CLI's keychain session is NOT reliable in agent/background contexts:
        // on Mac, the keychain is only accessible in the user's GUI session, so
        // tasks fail with "Not logged in · Please run /login" when the agent runs
        // headlessly or is invoked from a non-GUI context (SSH, background process).
        console.log(chalk.yellow('  Claude CLI is installed, but no Claude auth token is configured.\n'));
        console.log(chalk.dim('  The CLI\'s keychain session may not be accessible when the agent'));
        console.log(chalk.dim('  runs as a background process. This causes tasks to fail with'));
        console.log(chalk.dim('  "Not logged in · Please run /login" even though you are logged in.\n'));
        console.log(chalk.bold('  Recommended: generate a Claude auth token to ensure reliable auth.\n'));

        if (!options.nonInteractive) {
          const { setupToken } = await inquirer.prompt<{ setupToken: boolean }>([
            {
              type: 'confirm',
              name: 'setupToken',
              message: 'Set up a Claude auth token now? (strongly recommended)',
              default: true,
            },
          ]);
          if (setupToken) {
            await setupClaudeOauthToken();
          } else {
            console.log(chalk.dim('  You can set it up later: run `claude setup-token` and set'));
            console.log(chalk.dim('  CLAUDE_CODE_OAUTH_TOKEN in the agent environment,'));
            console.log(chalk.dim('  or set ANTHROPIC_API_KEY.\n'));
          }
        } else {
          console.log(chalk.dim('  Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN,'));
          console.log(chalk.dim('  or set ANTHROPIC_API_KEY in the agent environment.\n'));
        }
      } else {
        console.log(chalk.dim('The agent runner needs authentication to call the Claude API.'));
        console.log(chalk.dim('You can either:'));
        console.log(chalk.dim('  1. Install Claude Code and run `claude login` (then re-run setup to configure a cloud token)'));
        console.log(chalk.dim('  2. Set ANTHROPIC_API_KEY environment variable'));
        console.log(chalk.dim('  3. Set CLAUDE_CODE_OAUTH_TOKEN (generate via `claude setup-token`)\n'));
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

  // Summary model card
  const version = await getVersion();
  const hostname = resources?.hostname ?? osHostname();
  const platform = resources?.platform ?? process.platform;
  const arch = resources?.arch ?? process.arch;

  console.log();
  console.log(chalk.bold.green('✓ Setup Complete!\n'));
  console.log(formatSetupSummaryBox({
    hostname,
    platform,
    arch,
    version,
    runnerId: config.getRunnerId(),
    providers: detectedProviders,
    ghStatus,
    sshHosts: discoveredHosts,
    resources,
    authenticated: !!config.getAccessToken(),
  }));
  console.log();

  if (verbose) {
    console.log(chalk.dim(`  Config: ${config.getConfigPath()}`));
    console.log(chalk.dim(`  API:    ${config.getApiUrl()}`));
    console.log(chalk.dim(`  Relay:  ${config.getRelayUrl()}`));
    console.log();
  }

  console.log(chalk.bold('  Next steps:'));
  console.log('    1. Start the agent runner:');
  console.log(chalk.cyan('       npx @astroanywhere/agent start'));
  console.log();
  console.log('    2. Or run in the foreground for testing:');
  console.log(chalk.cyan('       npx @astroanywhere/agent start --foreground'));
  console.log();

  if (mcpConfigured) {
    console.log('    3. In Claude Code, use these tools to connect to Astro:');
    console.log(chalk.cyan('       astro_attach("TASK-ID")  # Attach to a task'));
    console.log(chalk.cyan('       astro_status()           # Check connection status'));
    console.log(chalk.cyan('       astro_detach()           # Detach from task'));
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
    // Save the access token from the auth step (refresh token is only
    // issued during successful registration, so it may be empty here)
    config.setAccessToken(tokenResponse.accessToken);
    if (tokenResponse.refreshToken) {
      config.setRefreshToken(tokenResponse.refreshToken);
    }
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
  const installErrors: InstallErrorInfo[] = [];
  const controlMasterHosts: DiscoveredHost[] = []; // track hosts with active CM sessions
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
    try {
      await sshExec(host, 'pkill -f "[a]stro-agent start" 2>/dev/null || true');
    } catch (err) {
      // SSH connection failed — check if this is a 2FA/interactive auth issue.
      // BatchMode=yes causes SSH to fail when the host requires keyboard-interactive
      // auth (Duo push, OTP). We detect this and offer a ControlMaster session.
      const errObj = err as { message?: string; stderr?: string };
      const errMsg = errObj.message ?? String(err);
      const errStderr = errObj.stderr ?? '';
      const errAll = `${errMsg}\n${errStderr}`;

      // Detect 2FA: 'keyboard-interactive' in either message or stderr.
      // Don't match plain 'password' — that fires on "Permission denied
      // (publickey,password)" which is a key failure, not 2FA.
      const is2FA = errAll.includes('keyboard-interactive');

      // Check if a ControlMaster session already exists (from a prior run)
      const hasMaster = await hasControlMaster(host);

      if (is2FA && !hasMaster) {
        spinner.warn(`${hostName}: Requires interactive authentication (2FA/Duo)`);
        console.log();
        console.log(chalk.yellow(`  ${hostName} requires two-factor authentication.`));
        console.log(chalk.dim('  Astro can open an interactive SSH session for you to authenticate.'));
        console.log(chalk.dim('  Once authenticated, all subsequent commands will reuse the session.'));
        console.log();

        const { authenticate } = await inquirer.prompt<{ authenticate: boolean }>([{
          type: 'confirm',
          name: 'authenticate',
          message: `Authenticate to ${hostName} interactively?`,
          default: true,
        }]);

        if (authenticate) {
          console.log(chalk.dim(`\n  Opening SSH connection to ${hostName}...`));
          console.log(chalk.dim('  Complete the authentication prompt below.\n'));

          const established = await establishControlMaster(host);

          if (established) {
            controlMasterHosts.push(host);
            console.log(chalk.green(`\n  Session established for ${hostName}.`));
          } else {
            spinner.fail(`${hostName}: Authentication failed`);
            installErrors.push({
              host: hostName,
              hostname: host.hostname,
              user: host.user,
              error: 'Interactive authentication failed or was cancelled',
              reason: 'needs_2fa',
            });
            continue;
          }
        } else {
          spinner.fail(`${hostName}: Skipped (requires 2FA)`);
          installErrors.push({
            host: hostName,
            hostname: host.hostname,
            user: host.user,
            error: 'Host requires two-factor authentication',
            reason: 'needs_2fa',
          });
          continue;
        }
      } else if (!hasMaster) {
        const reason = errMsg.includes('Permission denied') ? 'permission_denied' : 'ssh_failed';
        spinner.fail(`${hostName}: SSH connection failed`);
        installErrors.push({
          host: hostName,
          hostname: host.hostname,
          user: host.user,
          error: errMsg,
          reason,
        });
        continue;
      }
      // hasMaster=true or just established — retry pkill through the session
      spinner.start(`${hostName}: Stopping existing agent (if any)...`);
      try {
        await sshExec(host, 'pkill -f "[a]stro-agent start" 2>/dev/null || true');
      } catch {
        // Non-critical — pkill may fail if no agent is running
      }
    }
    await new Promise((r) => setTimeout(r, 1000));

    spinner.text = `Checking Node.js on ${hostName}...`;

    // Check remote Node.js availability (now supports HPC module systems)
    let nodeCheck: { available: boolean; version: string | null; method?: string };
    try {
      nodeCheck = await checkRemoteNode(host);
    } catch (err) {
      spinner.fail(`${hostName}: Could not check Node.js`);
      installErrors.push({
        host: hostName,
        hostname: host.hostname,
        user: host.user,
        error: err instanceof Error ? err.message : String(err),
        reason: 'ssh_failed',
      });
      continue;
    }

    if (!nodeCheck.available) {
      const reason = nodeCheck.version ? 'node_too_old' : 'node_not_found';
      spinner.fail(
        `${hostName}: Node.js ${nodeCheck.version ? `${nodeCheck.version} (need ≥18)` : 'not found'}`,
      );
      installErrors.push({
        host: hostName,
        hostname: host.hostname,
        user: host.user,
        error: nodeCheck.version ? `Node.js ${nodeCheck.version} is too old` : 'Node.js not found',
        reason,
        nodeVersion: nodeCheck.version,
      });
      continue;
    }

    if (verbose && nodeCheck.method) {
      console.log(chalk.dim(`  [setup] Node.js found via: ${nodeCheck.method}`));
    }

    spinner.text = `Installing on ${hostName}...`;

    // Get the local access token to register on behalf of remote hosts
    const localAccessToken = config.getAccessToken();

    if (!localAccessToken) {
      spinner.fail(`${hostName}: No auth tokens available. Authenticate locally first.`);
      installErrors.push({
        host: hostName,
        hostname: host.hostname,
        user: host.user,
        error: 'No authentication tokens available',
        reason: 'install_failed',
      });
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
      const errMsg = err instanceof Error ? err.message : String(err);
      installErrors.push({
        host: hostName,
        hostname: host.hostname,
        user: host.user,
        error: errMsg,
        reason: 'install_failed',
      });
      if (verbose && err instanceof Error && err.stack) {
        console.error(chalk.dim(`[setup] Stack trace: ${err.stack}`));
      }
      // Clean up ControlMaster immediately on failure to avoid socket leak
      if (controlMasterHosts.includes(host)) {
        await teardownControlMaster(host).catch(() => {});
      }
    }
  }

  // Clean up all ControlMaster sessions we established during this run
  for (const cmHost of controlMasterHosts) {
    await teardownControlMaster(cmHost).catch(() => {});
  }

  // Show error summary box if there were failures
  if (installErrors.length > 0) {
    console.log();
    console.log(formatInstallErrorBox(installErrors));
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
 * Shows all hosts with circle/check markers. Pressing Enter on a host toggles it.
 * "Select all" toggles all hosts. "Confirm" and "Skip" at the bottom.
 * Cursor stays on the same position after each toggle.
 *
 * This uses `type: 'list'` (not `checkbox`) so that Enter toggles — the standard
 * checkbox behavior (Space to toggle, Enter to confirm) confuses users who expect
 * Enter to select. See commit 7b421e5 for the original rationale.
 */
async function selectHostsInteractive(hosts: DiscoveredHost[]): Promise<string[]> {
  const selected = new Set<string>();
  const ACTION_SELECT_ALL = '__select_all__';
  const ACTION_CONFIRM = '__confirm__';
  const ACTION_SKIP = '__skip__';

  let cursorIndex = 0;

  while (true) {
    // Build choices with current selection state
    const choices: Array<{ name: string; value: string } | inquirer.Separator> = [];

    for (const h of hosts) {
      const marker = selected.has(h.name) ? chalk.green('\u2713') : chalk.dim('\u25CB');
      const label = h.hostname !== h.name ? `${h.name} ${chalk.dim(`(${h.hostname})`)}` : h.name;
      const user = h.user ? chalk.dim(` [${h.user}]`) : '';
      choices.push({ name: `${marker} ${label}${user}`, value: h.name });
    }

    choices.push(new inquirer.Separator(chalk.dim('\u2500'.repeat(30))));

    const allSelected = hosts.every((h) => selected.has(h.name));
    const selectAllLabel = allSelected ? 'Deselect all' : 'Select all';
    choices.push({ name: chalk.cyan(`\u25C9 ${selectAllLabel}`), value: ACTION_SELECT_ALL });

    choices.push(new inquirer.Separator(chalk.dim('\u2500'.repeat(30))));
    choices.push({ name: chalk.green(`\u2714 Confirm (${selected.size} selected)`), value: ACTION_CONFIRM });
    choices.push({ name: chalk.yellow('\u2718 Skip'), value: ACTION_SKIP });

    const { choice } = await inquirer.prompt<{ choice: string }>([
      {
        type: 'list',
        name: 'choice',
        message: 'Select hosts to install Astro Agent on:',
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
 * Returns true if the `gh` binary is available after the attempt.
 */
function showGhInstallRecommendation(): void {
  const B = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
  const W = 62;
  const line = (s: string) => {
    const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
    return `  ${chalk.cyan(B.v)} ${s}${' '.repeat(Math.max(0, W - visible.length))} ${chalk.cyan(B.v)}`;
  };
  console.log();
  console.log(`  ${chalk.cyan(B.tl + B.h.repeat(W + 2) + B.tr)}`);
  console.log(line(chalk.cyan.bold('GitHub CLI (gh) — optional, recommended')));
  console.log(line(''));
  console.log(line(`Astro works great without gh! It can edit files,`));
  console.log(line(`run tasks, and merge branches — all locally.`));
  console.log(line(''));
  console.log(line(`To also create GitHub PRs automatically, install gh:`));
  console.log(line(''));
  console.log(line(`  ${chalk.white('macOS')}   ${chalk.dim('brew install gh')}`));
  console.log(line(`  ${chalk.white('Linux')}   ${chalk.dim('https://cli.github.com')}`));
  console.log(line(`  ${chalk.white('Then')}    ${chalk.dim('gh auth login')}`));
  console.log(`  ${chalk.cyan(B.bl + B.h.repeat(W + 2) + B.br)}`);
  console.log();
}

/**
 * Attempt to install GitHub CLI (gh) via Homebrew on macOS.
 * Linux distros require adding GitHub's apt/dnf repo first, which is too
 * fragile to automate — we show manual instructions instead.
 */
async function tryInstallGh(verbose?: boolean): Promise<boolean> {
  if (process.platform !== 'darwin') return false;

  // macOS: try Homebrew
  try {
    await execFile('which', ['brew'], { timeout: 5_000 });
  } catch {
    if (verbose) console.log(chalk.dim('  Homebrew not found, skipping auto-install'));
    return false;
  }

  try {
    if (verbose) console.log(chalk.dim('  Trying: brew install gh'));
    await execFile('brew', ['install', 'gh'], { timeout: 120_000 });
    // Verify gh is now in PATH
    await execFile('which', ['gh'], { timeout: 5_000 });
    return true;
  } catch (err) {
    if (verbose) console.log(chalk.dim(`  brew install gh failed: ${err instanceof Error ? err.message : String(err)}`));
    return false;
  }
}

function tryOpenUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd, [url]).catch(() => {
    // Silently ignore — user can open manually
  });
}
