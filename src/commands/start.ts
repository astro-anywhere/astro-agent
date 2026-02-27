/**
 * Start command - starts the agent runner
 */

import chalk from 'chalk';
import ora from 'ora';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync } from 'node:fs';
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
import type { RunnerEvent, Task, RepoSetupRequestMessage, RepoDetectRequestMessage, BranchListRequestMessage, GitInitRequestMessage } from '../types.js';

interface StartOptions {
  foreground?: boolean;
  relay?: string;
  maxTasks?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  preserveWorktrees?: boolean;
  allowNonGit?: boolean;
  useSandbox?: boolean;
  maxSandboxSize?: number;
  verbose?: boolean;
}

const execFileAsync = promisify(execFile);

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

/**
 * Kill any existing agent-runner processes before starting a new one.
 * Prevents accumulation of stale instances competing for the same WebSocket connection.
 */
async function killExistingProcesses(): Promise<void> {
  const myPid = process.pid;
  let pids: string[] = [];

  // Check PID file first
  const pidFile = join(homedir(), '.astro', 'agent-runner.pid');
  try {
    const pidContent = readFileSync(pidFile, 'utf-8').trim();
    if (/^\d+$/.test(pidContent) && pidContent !== String(myPid)) {
      pids.push(pidContent);
    }
    try { unlinkSync(pidFile); } catch { /* ignore */ }
  } catch {
    // No PID file
  }

  // Also find via pgrep to catch orphaned processes without PID files
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-f', 'astro-agent.*start'], {
        timeout: 5000,
      });
      const found = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line) && line !== String(myPid));
      for (const pid of found) {
        if (!pids.includes(pid)) pids.push(pid);
      }
    } catch {
      // No processes found (pgrep exits 1 when no match)
    }
  } else {
    try {
      const { stdout } = await execFileAsync(
        'wmic',
        ['process', 'where', "commandline like '%astro-agent%start%'", 'get', 'processid'],
        { timeout: 5000 },
      );
      const found = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line) && line !== String(myPid));
      for (const pid of found) {
        if (!pids.includes(pid)) pids.push(pid);
      }
    } catch {
      // No processes found
    }
  }

  if (pids.length > 0) {
    console.log(chalk.yellow(`Found ${pids.length} existing agent-runner process(es): ${pids.join(', ')}`));
    console.log(chalk.yellow('Stopping them before relaunch...'));

    for (const pid of pids) {
      try {
        process.kill(parseInt(pid, 10), 'SIGTERM');
        console.log(chalk.dim(`  Stopped PID ${pid}`));
      } catch {
        // Already dead or permission denied — ignore
      }
    }

    // Wait for processes to exit cleanly
    await new Promise((r) => setTimeout(r, 1500));
    console.log();
  }
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
      console.log(chalk.red('Setup failed. Run manually: npx @astroanywhere/agent@latest launch'));
      process.exit(1);
    }
  }

  // Initialize hardware-based machine ID if not set
  await config.initializeMachineId();

  // Get configuration
  const runnerId = config.getRunnerId();
  const machineId = config.getMachineId();
  const relayUrl = options.relay ?? config.getRelayUrl();
  const maxTasks = options.maxTasks ?? 20;
  const logLevel = options.logLevel ?? config.getLogLevel();

  // Kill any existing agent-runner processes to prevent stale instances accumulating
  await killExistingProcesses();

  // Background mode: spawn detached process
  if (!options.foreground) {
    console.log(chalk.bold('Starting Astro Agent Runner in background...\n'));

    const scriptPath = process.argv[1];
    const args = ['start', '--foreground'];

    if (options.relay) args.push('--relay', options.relay);
    if (options.maxTasks) args.push('--max-tasks', String(options.maxTasks));
    if (options.logLevel) args.push('--log-level', options.logLevel);
    if (options.preserveWorktrees) args.push('--preserve-worktrees');

    // Create log directory and open log file for appending
    const logDir = join(homedir(), '.astro', 'logs');
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, 'agent-runner.log');
    const logFd = openSync(logFile, 'a');

    const child = spawn(process.execPath, [scriptPath!, ...args], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });

    child.unref();
    closeSync(logFd);

    // Write PID file for stop command
    const pidDir = join(homedir(), '.astro');
    mkdirSync(pidDir, { recursive: true });
    const pidFile = join(pidDir, 'agent-runner.pid');
    if (child.pid) {
      writeFileSync(pidFile, String(child.pid));
    }

    console.log(chalk.green('✓ Agent runner started in background'));
    console.log(chalk.dim(`  PID: ${child.pid}`));
    console.log(chalk.dim(`  Runner ID: ${runnerId}`));
    console.log();
    console.log('To view logs:');
    console.log(chalk.cyan('  npx @astroanywhere/agent logs'));
    console.log();
    console.log('To stop:');
    console.log(chalk.cyan('  npx @astroanywhere/agent stop'));

    return;
  }

  // Foreground mode: run directly
  const verbose = options.verbose ?? false;

  console.log(chalk.bold('\n🤖 Astro Agent Runner\n'));

  const version = await getVersion();
  if (verbose) {
    console.log(chalk.dim(`Version: ${version}`));
    console.log(chalk.dim(`Runner ID: ${runnerId}`));
    console.log(chalk.dim(`Machine ID: ${machineId}`));
    console.log(chalk.dim(`Relay: ${relayUrl}`));
    console.log(chalk.dim(`Max concurrent tasks: ${maxTasks}`));
    console.log(chalk.dim(`Log level: ${logLevel}`));
    console.log();
  }

  // Set Claude OAuth token if configured (from `claude setup-token`)
  const claudeOauthToken = config.getClaudeOauthToken();
  if (claudeOauthToken && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = claudeOauthToken;
    if (verbose) console.log(chalk.dim('Using stored Claude OAuth token'));
  }

  // Detect resources
  const resourceSpinner = ora('Detecting machine resources...').start();
  let resources;
  try {
    resources = await getMachineResources();
    resourceSpinner.succeed('Machine resources detected');
    if (verbose) {
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

  // Create task executor first (needed for callback closures)
  // wsClient will be assigned after construction
  // eslint-disable-next-line prefer-const -- reassigned on line 530 after wsClient creation
  let taskExecutor: TaskExecutor;

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
    onTaskDispatch: (task: Task) => {
      taskExecutor.submitTask(task).catch((error) => {
        log('error', `Failed to submit task ${task.id}: ${error.message}`, logLevel);
      });
    },
    onTaskCancel: (taskId: string) => {
      taskExecutor.cancelTask(taskId);
    },
    onTaskCleanup: (taskId: string, branchName?: string) => {
      taskExecutor.cleanupTask(taskId, branchName).catch((error) => {
        log('error', `Failed to cleanup task ${taskId}: ${error instanceof Error ? error.message : String(error)}`, logLevel);
      });
    },
    onTaskSafetyDecision: (taskId: string, decision: 'proceed' | 'init-git' | 'sandbox' | 'cancel') => {
      log('info', `Safety decision for task ${taskId}: ${decision}`, logLevel);
      taskExecutor.handleSafetyDecision(taskId, decision).catch((error) => {
        log('error', `Failed to handle safety decision for task ${taskId}: ${error.message}`, logLevel);
      });
    },
    onTaskSteer: (taskId: string, message: string, action?: string, interrupt?: boolean) => {
      log('info', `Received steer for task ${taskId}: "${message.slice(0, 100)}"${action ? ` (action: ${action})` : ''}${interrupt ? ' (interrupt)' : ''}`, logLevel);
      taskExecutor.steerTask(taskId, message, interrupt ?? false).then((result) => {
        wsClient.sendSteerAck(taskId, result.accepted, result.reason, interrupt);
        log('info', `Steer ack for task ${taskId}: accepted=${result.accepted}${result.reason ? ` reason=${result.reason}` : ''}${interrupt ? ' (interrupt)' : ''}`, logLevel);
      }).catch((err) => {
        log('error', `Steer failed for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`, logLevel);
        wsClient.sendSteerAck(taskId, false, 'Internal error');
      });
    },
    onFileList: (path: string, correlationId: string) => {
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
    },
    onDirectoryList: (path: string, correlationId: string) => {
      log('debug', `Directory list request for path: ${path || '~'}`, logLevel);
      try {
        const resolvedPath = path === '~' || !path ? homedir() : path;
        const homeDir = homedir();

        if (!existsSync(resolvedPath)) {
          wsClient.sendDirectoryListResponse(correlationId, resolvedPath, [], 'Directory does not exist', homeDir);
          return;
        }

        const stat = statSync(resolvedPath);
        if (!stat.isDirectory()) {
          wsClient.sendDirectoryListResponse(correlationId, resolvedPath, [], 'Not a directory', homeDir);
          return;
        }

        const dirents = readdirSync(resolvedPath, { withFileTypes: true });
        const entries = dirents
          .filter(d => !d.name.startsWith('.'))
          .map(d => {
            const fullPath = join(resolvedPath, d.name);
            let isDirectory = d.isDirectory();
            let isSymlink = d.isSymbolicLink();
            // Resolve symlinks to check if they point to directories
            if (isSymlink) {
              try {
                const realStat = statSync(fullPath);
                isDirectory = realStat.isDirectory();
              } catch {
                // Broken symlink
              }
            }
            return { name: d.name, path: fullPath, isDirectory, isSymlink };
          })
          .filter(e => e.isDirectory)
          .sort((a, b) => a.name.localeCompare(b.name));

        wsClient.sendDirectoryListResponse(correlationId, resolvedPath, entries, undefined, homeDir);
        log('debug', `Sent ${entries.length} directories for path: ${resolvedPath}`, logLevel);
      } catch (error) {
        log('warn', `Failed to list directories in ${path}: ${error instanceof Error ? error.message : String(error)}`, logLevel);
        wsClient.sendDirectoryListResponse(correlationId, path || '~', [], `Failed: ${error instanceof Error ? error.message : String(error)}`, homedir());
      }
    },
    onCreateDirectory: (parentPath: string, name: string, correlationId: string) => {
      log('debug', `Create directory request: ${name} in ${parentPath}`, logLevel);
      try {
        const resolvedParent = parentPath === '~' || !parentPath ? homedir() : parentPath;

        if (!existsSync(resolvedParent)) {
          wsClient.sendCreateDirectoryResponse(correlationId, false, undefined, 'Parent directory does not exist');
          return;
        }

        const parentStat = statSync(resolvedParent);
        if (!parentStat.isDirectory()) {
          wsClient.sendCreateDirectoryResponse(correlationId, false, undefined, 'Parent path is not a directory');
          return;
        }

        const fullPath = join(resolvedParent, name);

        if (existsSync(fullPath)) {
          wsClient.sendCreateDirectoryResponse(correlationId, false, undefined, 'A file or directory with that name already exists');
          return;
        }

        mkdirSync(fullPath);
        wsClient.sendCreateDirectoryResponse(correlationId, true, fullPath);
        log('debug', `Created directory: ${fullPath}`, logLevel);
      } catch (error) {
        log('warn', `Failed to create directory ${name} in ${parentPath}: ${error instanceof Error ? error.message : String(error)}`, logLevel);
        wsClient.sendCreateDirectoryResponse(correlationId, false, undefined, `Failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    onSlashCommands: (correlationId: string, workingDirectory?: string) => {
      log('debug', `Slash commands request for dir: ${workingDirectory || '(global)'}`, logLevel);
      try {
        const commands = scanSlashCommands(workingDirectory);
        wsClient.sendSlashCommandsResponse(correlationId, commands);
        log('debug', `Sent ${commands.length} slash commands`, logLevel);
      } catch (error) {
        log('warn', `Failed to scan slash commands: ${error instanceof Error ? error.message : String(error)}`, logLevel);
        wsClient.sendSlashCommandsResponse(correlationId, []);
      }
    },
    onRepoSetup: (payload: RepoSetupRequestMessage['payload']) => {
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
    },
    onRepoDetect: (payload: RepoDetectRequestMessage['payload']) => {
      const { correlationId, path: dirPath } = payload;
      log('info', `Repo detect request: path=${dirPath}`, logLevel);
      try {
        if (!existsSync(dirPath)) {
          wsClient.sendRepoDetectResponse(correlationId, {
            exists: false,
            isGit: false,
            remoteType: 'none',
            suggestedDeliveryMode: 'branch',
          });
          return;
        }

        // Check if it's a git repo
        let isGit = false;
        try {
          execFileSync('git', ['-C', dirPath, 'rev-parse', '--is-inside-work-tree'], {
            encoding: 'utf-8',
            timeout: 5_000,
            stdio: 'pipe',
          });
          isGit = true;
        } catch {
          // Not a git repo
        }

        if (!isGit) {
          // Compute directory size for non-git directories
          let dirSizeMB: number | null = null;
          try {
            const duOutput = execFileSync('du', ['-sk', dirPath], {
              encoding: 'utf-8',
              timeout: 10_000,
              stdio: 'pipe',
            });
            const kb = parseInt(duOutput.trim().split(/\s+/)[0], 10);
            if (!isNaN(kb)) {
              dirSizeMB = Math.round((kb / 1024) * 100) / 100;
            }
          } catch {
            // Non-fatal
          }

          wsClient.sendRepoDetectResponse(correlationId, {
            exists: true,
            isGit: false,
            remoteType: 'none',
            suggestedDeliveryMode: 'direct',
            dirSizeMB,
          });
          return;
        }

        // Get remote URL
        let remoteUrl: string | undefined;
        try {
          const url = execFileSync('git', ['-C', dirPath, 'remote', 'get-url', 'origin'], {
            encoding: 'utf-8',
            timeout: 5_000,
            stdio: 'pipe',
          }).trim();
          if (url) remoteUrl = url;
        } catch {
          // No remote
        }

        // Get current branch
        let currentBranch = 'main';
        try {
          const branch = execFileSync('git', ['-C', dirPath, 'symbolic-ref', '--short', 'HEAD'], {
            encoding: 'utf-8',
            timeout: 5_000,
            stdio: 'pipe',
          }).trim();
          if (branch) currentBranch = branch;
        } catch {
          // Default to 'main'
        }
        const baseBranch = currentBranch;

        // Detect dirty state
        let isDirty = false;
        let dirtyDetails: { staged: number; unstaged: number; untracked: number } | undefined;
        try {
          const porcelain = execFileSync('git', ['-C', dirPath, 'status', '--porcelain'], {
            encoding: 'utf-8',
            timeout: 10_000,
            stdio: 'pipe',
          });
          if (porcelain.trim()) {
            isDirty = true;
            let staged = 0, unstaged = 0, untracked = 0;
            for (const line of porcelain.trim().split('\n')) {
              if (!line) continue;
              const x = line[0]; // index (staging area)
              const y = line[1]; // worktree
              if (x === '?' && y === '?') {
                untracked++;
              } else {
                if (x && x !== ' ' && x !== '?') staged++;
                if (y && y !== ' ' && y !== '?') unstaged++;
              }
            }
            dirtyDetails = { staged, unstaged, untracked };
          }
        } catch {
          // Non-fatal
        }

        // Detect remote type
        const detectRemoteType = (url: string | undefined): 'github' | 'gitlab' | 'bitbucket' | 'generic' | 'none' => {
          if (!url) return 'none';
          const lower = url.toLowerCase();
          if (lower.includes('github.com')) return 'github';
          if (lower.includes('gitlab.com') || lower.includes('gitlab.')) return 'gitlab';
          if (lower.includes('bitbucket.org') || lower.includes('bitbucket.')) return 'bitbucket';
          if (lower.startsWith('git@') || lower.startsWith('http') || lower.startsWith('ssh://')) return 'generic';
          return 'none';
        };

        const remoteType = detectRemoteType(remoteUrl);
        let suggestedDeliveryMode: 'pr' | 'push' | 'branch' | 'direct' = 'branch';
        switch (remoteType) {
          case 'github':
          case 'gitlab':
          case 'bitbucket':
            suggestedDeliveryMode = 'pr';
            break;
          case 'generic':
            suggestedDeliveryMode = 'push';
            break;
          case 'none':
          default:
            suggestedDeliveryMode = 'branch';
            break;
        }

        wsClient.sendRepoDetectResponse(correlationId, {
          exists: true,
          isGit: true,
          remoteUrl,
          remoteType,
          baseBranch,
          currentBranch,
          isDirty,
          dirtyDetails,
          suggestedDeliveryMode,
        });
        log('info', `Repo detect result: isGit=true remote=${remoteType} branch=${currentBranch} dirty=${isDirty}`, logLevel);
      } catch (error) {
        log('error', `Repo detect failed: ${error instanceof Error ? error.message : String(error)}`, logLevel);
        wsClient.sendRepoDetectResponse(correlationId, {
          exists: false,
          isGit: false,
          remoteType: 'none',
          suggestedDeliveryMode: 'branch',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    onBranchList: (payload: BranchListRequestMessage['payload']) => {
      const { correlationId, path: dirPath } = payload;
      log('info', `Branch list request: path=${dirPath}`, logLevel);
      try {
        if (!existsSync(dirPath)) {
          wsClient.sendBranchListResponse(correlationId, {
            branches: [],
            error: 'Directory does not exist',
          });
          return;
        }

        // Get current branch
        let currentBranch = '';
        try {
          currentBranch = execFileSync('git', ['-C', dirPath, 'symbolic-ref', '--short', 'HEAD'], {
            encoding: 'utf-8',
            timeout: 5_000,
            stdio: 'pipe',
          }).trim();
        } catch {
          // Detached HEAD or not a git repo
        }

        // Get default branch (via origin/HEAD)
        let defaultBranch = '';
        try {
          const ref = execFileSync('git', ['-C', dirPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
            encoding: 'utf-8',
            timeout: 5_000,
            stdio: 'pipe',
          }).trim();
          const parts = ref.split('/');
          defaultBranch = parts[parts.length - 1];
        } catch {
          // Try fallback: check if origin/main or origin/master exist
          try {
            const remoteBranches = execFileSync('git', ['-C', dirPath, 'branch', '-r', '--list', 'origin/main', 'origin/master'], {
              encoding: 'utf-8',
              timeout: 5_000,
              stdio: 'pipe',
            }).trim();
            if (remoteBranches.includes('origin/main')) defaultBranch = 'main';
            else if (remoteBranches.includes('origin/master')) defaultBranch = 'master';
          } catch {
            defaultBranch = 'main';
          }
        }

        // Collect local branches
        const localBranchNames = new Set<string>();
        try {
          const localOutput = execFileSync('git', ['-C', dirPath, 'branch', '--format=%(refname:short)'], {
            encoding: 'utf-8',
            timeout: 10_000,
            stdio: 'pipe',
          });
          for (const line of localOutput.trim().split('\n')) {
            const name = line.trim();
            if (name) localBranchNames.add(name);
          }
        } catch {
          // Fallback: no local branches
        }

        // Collect remote branches
        const remoteBranchNames = new Set<string>();
        try {
          const remoteOutput = execFileSync('git', ['-C', dirPath, 'branch', '-r', '--format=%(refname:short)'], {
            encoding: 'utf-8',
            timeout: 10_000,
            stdio: 'pipe',
          });
          for (const line of remoteOutput.trim().split('\n')) {
            const name = line.trim();
            // Skip origin/HEAD
            if (name && !name.endsWith('/HEAD')) {
              // Strip origin/ prefix
              const stripped = name.replace(/^origin\//, '');
              if (stripped) remoteBranchNames.add(stripped);
            }
          }
        } catch {
          // Fallback: no remote branches
        }

        // Merge into a combined list
        const allNames = new Set([...localBranchNames, ...remoteBranchNames]);
        const branches = Array.from(allNames).map((name) => ({
          name,
          isRemote: remoteBranchNames.has(name),
          isCurrent: name === currentBranch,
          isDefault: name === defaultBranch,
        }));

        wsClient.sendBranchListResponse(correlationId, {
          branches,
          defaultBranch: defaultBranch || undefined,
        });
        log('info', `Branch list result: ${branches.length} branches, default=${defaultBranch}`, logLevel);
      } catch (error) {
        log('error', `Branch list failed: ${error instanceof Error ? error.message : String(error)}`, logLevel);
        wsClient.sendBranchListResponse(correlationId, {
          branches: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    onGitInit: (payload: GitInitRequestMessage['payload']) => {
      const { correlationId, workingDirectory, projectName } = payload;
      log('info', `Git init request: dir=${workingDirectory}`, logLevel);
      try {
        // Initialize git, create .gitignore, initial commit
        execFileSync('git', ['init'], { cwd: workingDirectory, stdio: 'pipe', timeout: 10_000 });
        execFileSync('git', ['config', 'user.name', 'Astro Agent'], { cwd: workingDirectory, stdio: 'pipe', timeout: 5_000 });
        execFileSync('git', ['config', 'user.email', 'agent@astro.local'], { cwd: workingDirectory, stdio: 'pipe', timeout: 5_000 });

        // Generate basic .gitignore if missing
        const gitignorePath = join(workingDirectory, '.gitignore');
        if (!existsSync(gitignorePath)) {
          writeFileSync(gitignorePath, 'node_modules/\n.env\n.DS_Store\n*.log\n');
        }

        // Initial commit
        try {
          execFileSync('git', ['add', '-A'], { cwd: workingDirectory, stdio: 'pipe', timeout: 10_000 });
          execFileSync('git', ['commit', '-m', `Initial commit for ${projectName}`, '--allow-empty'], {
            cwd: workingDirectory,
            stdio: 'pipe',
            timeout: 10_000,
          });
        } catch {
          // Non-fatal: might be empty directory
        }

        // Get file tree after init
        let fileTree: string[] = [];
        try {
          const output = execFileSync('git', ['ls-files'], {
            cwd: workingDirectory,
            encoding: 'utf-8',
            timeout: 10_000,
            maxBuffer: 5 * 1024 * 1024,
          });
          fileTree = output.trim().split('\n').filter(Boolean);
        } catch {
          // Non-fatal
        }

        wsClient.sendGitInitResponse(correlationId, {
          success: true,
          workingDirectory,
          fileTree,
        });
        log('info', `Git init result: success=true files=${fileTree.length}`, logLevel);
      } catch (error) {
        log('error', `Git init failed: ${error instanceof Error ? error.message : String(error)}`, logLevel);
        wsClient.sendGitInitResponse(correlationId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    onSessionsList: (correlationId: string, maxAgeMs?: number) => {
      log('debug', `Sessions list request received (maxAge=${maxAgeMs ?? 'all'})`, logLevel);
      try {
        const claudeDir = join(homedir(), '.claude', 'projects');
        if (!existsSync(claudeDir)) {
          wsClient.sendSessionsListResponse(correlationId, []);
          return;
        }

        // Cutoff timestamp: only include files modified after this time
        const cutoff = maxAgeMs ? Date.now() - maxAgeMs : 0;

        const sessions: import('../types.js').ClaudeCodeSessionInfo[] = [];
        const projectDirs = readdirSync(claudeDir, { withFileTypes: true })
          .filter(d => d.isDirectory());

        for (const projDir of projectDirs) {
          const projPath = join(claudeDir, projDir.name);
          const cwd = projDir.name.replace(/^-/, '/').replace(/-/g, '/');

          let jsonlFiles: string[];
          try {
            jsonlFiles = readdirSync(projPath).filter(f => f.endsWith('.jsonl'));
          } catch { continue; }

          for (const file of jsonlFiles) {
            const sessionId = file.replace('.jsonl', '');
            const filePath = join(projPath, file);
            try {
              const stat = statSync(filePath);
              // Skip tiny files (likely empty sessions)
              if (stat.size < 100) continue;
              // Skip files older than cutoff (fast mtime check, no content read)
              if (cutoff && stat.mtimeMs < cutoff) continue;

              // Extract metadata from head + last user messages from tail
              const content = readFileSync(filePath, 'utf-8');
              let firstPrompt = '';
              let lastUserMsg = '';
              let secondLastUserMsg = '';
              let gitBranch = '';
              let customTitle = '';

              // Helper: extract user text from entry (any text, no filtering)
              const getUserText = (entry: Record<string, unknown>): string | null => {
                if (entry.type !== 'user' || !(entry.message as Record<string, unknown>)?.content) return null;
                const msg = entry.message as Record<string, unknown>;
                const textContent = Array.isArray(msg.content)
                  ? (msg.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text || ''
                  : String(msg.content);
                return textContent.trim() || null;
              };

              // Read first ~10 lines for metadata + first prompt
              const lines = content.split('\n');
              for (let li = 0; li < Math.min(lines.length, 10); li++) {
                if (!lines[li].trim()) continue;
                try {
                  const entry = JSON.parse(lines[li]);
                  if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch;
                  if (entry.customTitle) customTitle = entry.customTitle;
                  if (!firstPrompt) {
                    const text = getUserText(entry);
                    if (text) firstPrompt = text.slice(0, 200);
                  }
                } catch { /* skip */ }
              }

              // Read last ~16KB to find last two user messages
              const tailStart = Math.max(0, content.length - 16384);
              const tailLines = content.slice(tailStart).split('\n');
              for (let li = tailLines.length - 1; li >= 0; li--) {
                if (!tailLines[li].trim()) continue;
                try {
                  const entry = JSON.parse(tailLines[li]);
                  const text = getUserText(entry);
                  if (text) {
                    if (!lastUserMsg) { lastUserMsg = text.slice(0, 200); }
                    else if (!secondLastUserMsg) { secondLastUserMsg = text.slice(0, 200); break; }
                  }
                } catch { /* skip */ }
              }

              // Summary: use second-to-last user msg if last is noisy, else last, else first
              const isNoisy = (t: string) => /^\s*\[/.test(t) || /^\s*</.test(t) || t.trim().length < 5;
              let summary = '';
              if (lastUserMsg && !isNoisy(lastUserMsg)) {
                summary = lastUserMsg.slice(0, 100);
              } else if (secondLastUserMsg && !isNoisy(secondLastUserMsg)) {
                summary = secondLastUserMsg.slice(0, 100);
              } else {
                summary = (lastUserMsg || firstPrompt).slice(0, 100);
              }

              sessions.push({
                sessionId,
                summary,
                lastModified: stat.mtimeMs,
                fileSize: stat.size,
                customTitle,
                firstPrompt: firstPrompt || lastUserMsg,
                gitBranch,
                cwd,
              });
            } catch { /* skip unreadable files */ }
          }
        }

        // Sort by lastModified descending, limit to 50 most recent
        sessions.sort((a, b) => b.lastModified - a.lastModified);
        const result = sessions.slice(0, 50);

        wsClient.sendSessionsListResponse(correlationId, result);
        log('debug', `Sent ${result.length} sessions (scanned with cutoff)`, logLevel);
      } catch (error) {
        log('warn', `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`, logLevel);
        wsClient.sendSessionsListResponse(correlationId, [], error instanceof Error ? error.message : String(error));
      }
    },
  });

  // Extract HPC capability from detected providers (avoids re-detecting at query time)
  const hpcCapability = providers.find(p => p.hpcCapability)?.hpcCapability ?? null;

  // Create task executor
  taskExecutor = new TaskExecutor({
    wsClient,
    maxConcurrentTasks: maxTasks,
    preserveWorktrees: options.preserveWorktrees,
    allowNonGit: options.allowNonGit,
    useSandbox: options.useSandbox,
    maxSandboxSize: options.maxSandboxSize,
    hpcCapability,
  });

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

      // Remove PID file
      const pidFile = join(homedir(), '.astro', 'agent-runner.pid');
      try { unlinkSync(pidFile); } catch { /* ignore */ }
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
