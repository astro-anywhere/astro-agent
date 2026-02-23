/**
 * Status command - shows current agent runner status
 */

import chalk from 'chalk';
import { config } from '../lib/config.js';
import { detectProviders, formatProvidersSummary } from '../lib/providers.js';
import { getMachineResources, formatResourceSummary } from '../lib/resources.js';

export async function statusCommand(): Promise<void> {
  console.log(chalk.bold('\n📊 Astro Agent Runner Status\n'));

  // Configuration status
  console.log(chalk.bold('Configuration:'));
  if (config.isSetupComplete()) {
    console.log(chalk.green('  ✓ Setup complete'));
  } else {
    console.log(chalk.yellow('  ✗ Setup not complete'));
    console.log(chalk.dim('    Run: npx @astro/agent setup'));
  }

  console.log(`  Runner ID: ${chalk.cyan(config.getRunnerId())}`);
  console.log(`  Machine ID: ${chalk.cyan(config.getMachineId())}`);
  console.log(`  Relay URL: ${chalk.cyan(config.getRelayUrl())}`);
  console.log(`  Auto-start: ${config.getAutoStart() ? chalk.green('enabled') : chalk.dim('disabled')}`);
  console.log(`  Log level: ${chalk.cyan(config.getLogLevel())}`);

  const lastConnected = config.getLastConnected();
  if (lastConnected) {
    console.log(`  Last connected: ${chalk.dim(lastConnected)}`);
  }

  console.log(`  Config file: ${chalk.dim(config.getConfigPath())}`);
  console.log();

  // Machine resources
  console.log(chalk.bold('Machine Resources:'));
  try {
    const resources = await getMachineResources();
    console.log(chalk.dim(formatResourceSummary(resources).split('\n').map(l => '  ' + l).join('\n')));
  } catch {
    console.log(chalk.red('  Failed to detect resources'));
  }
  console.log();

  // Provider status
  console.log(chalk.bold('Agent Providers:'));
  try {
    const providers = await detectProviders();
    if (providers.length > 0) {
      const summary = formatProvidersSummary(providers);
      console.log(summary.split('\n').slice(2).map(l => '  ' + l).join('\n'));
    } else {
      console.log(chalk.yellow('  No providers detected'));
      console.log(chalk.dim('  Install Claude Code or Codex to enable task execution'));
    }
  } catch {
    console.log(chalk.red('  Failed to detect providers'));
  }
  console.log();

  // Connection status (would need IPC to check actual running process)
  console.log(chalk.bold('Connection:'));
  console.log(chalk.dim('  Status check requires running agent'));
  console.log(chalk.dim('  Run: npx @astro/agent start --foreground'));
  console.log();
}
