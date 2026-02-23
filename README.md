# Astro Agent Runner

> The worker process that executes AI tasks for the Astro platform.

The Agent Runner is the **only component that talks to AI** (Claude) and executes code changes. The Astro backend sends it task instructions via WebSocket relay, and it does the actual work — writing code, running tests, creating pull requests — then streams results back.

## How It Fits In

```
Astro Backend (:3001)          Relay (:3002)            Agent Runner
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────┐
│ HTTP API + DB    │    │ WebSocket Hub    │    │ AI Execution Engine  │
│                  │    │                  │    │                      │
│ Validates input  │───►│ Routes tasks to  │───►│ Creates worktree     │
│ Builds prompts   │    │ best machine     │    │ Runs Claude/Codex    │
│ Broadcasts SSE   │◄───│ Forwards results │◄───│ Streams output       │
│                  │    │                  │    │ Creates PR           │
└──────────────────┘    └──────────────────┘    └──────────────────────┘
                                                        │
                                                        ▼
                                                 User's filesystem
                                                 ~/.astro/worktrees/
                                                 ~/.astro/repos/
```

**Key principle:** AI credentials never leave the machine. The agent runner holds the Claude API key locally. The Astro server never sees it.

## Installation

```bash
# From npm (when published)
npm install -g @astro/agent

# Or from source
git clone git@github.com:fuxialexander/astro-agent.git
cd astro-agent
npm install
npm run build
```

The CLI binary is `astro-agent`.

> **Monorepo usage:** This repo is also included as a git submodule at `packages/agent-runner` in the main Astro repo. `npm run dev` in the monorepo starts it automatically.

## Quick Start

### Local Development (automatic)

```bash
# From monorepo root — starts frontend + backend + relay + agent runner
npm run dev
```

The agent runner subprocess connects to `ws://localhost:3002` automatically.

### Manual Start

```bash
# Start in foreground (recommended for development)
astro-agent start --foreground --relay ws://localhost:3002

# Start in background (daemon mode)
astro-agent start

# Check status
astro-agent status

# Stop
astro-agent stop
```

### First-Time Setup (remote machines)

```bash
# Interactive setup: detect providers, authenticate via device code flow
astro-agent setup --relay wss://your-server.com:3002

# Or with explicit options
astro-agent setup --api https://your-server.com --relay wss://your-server.com:3002 --type remote
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `setup` | First-time configuration: detect providers, device auth |
| `start` | Start the agent runner (`-f` for foreground) |
| `stop` | Stop the running agent |
| `status` | Show config, resources, providers, connection status |
| `auth` | Set Claude OAuth token |
| `config` | Show/modify configuration (`--show`, `--reset`, `--set key=value`) |
| `providers` | List detected AI providers |
| `resources` | Show CPU, memory, GPU information |
| `hosts` | Discover remote hosts from SSH config |
| `mcp` | Start MCP server for Claude Code integration |

## Task Execution Lifecycle

When the agent runner receives a task from the relay:

```
1. SAFETY CHECK
   checkWorkdirSafety(dir)
   ├── SAFE     → proceed (git repo, clean state)
   ├── GUARDED  → warn, proceed (git repo, uncommitted changes)
   ├── RISKY    → ask user via WebSocket (non-git directory)
   └── UNSAFE   → block (non-git + parallel execution)

2. WORKSPACE PREPARATION
   resolveWorkingDirectory()
   ├── Git URL → clone to ~/.astro/repos/{projectId}/
   ├── Local path → use as-is
   └── Empty → process.cwd()

3. WORKTREE CREATION
   createWorktree(taskId, workingDir)
   ├── Parse porcelain output for lingering worktrees
   ├── Delete remote branch if exists
   ├── Fetch latest from origin
   ├── Create: git worktree add -b astro/{taskId}
   ├── Apply .astro/include/ files
   └── Run .astro/.setup script if exists

4. AI EXECUTION
   adapter.execute(task, stream, signal)
   ├── Claude SDK (query API with tools)
   ├── Claude Code CLI (subprocess)
   └── Codex CLI (subprocess)

5. COMPLETION
   ├── Auto-commit if agent didn't commit
   ├── Check branch has commits ahead of base
   ├── Push branch + create PR via gh
   └── Cleanup worktree (keep branch if PR exists)
```

## AI Providers

Three provider adapters, all implementing the same interface:

| Provider | How It Works | Max Concurrent |
|----------|-------------|----------------|
| **Claude SDK** | `@anthropic-ai/claude-agent-sdk` query API | 4 |
| **Claude Code** | Spawns `claude` CLI subprocess | 1 |
| **Codex** | Spawns `codex exec` subprocess | 1 |

### Claude SDK Adapter (primary)

- Structured streaming via `query()` API
- HPC context injection (detects SLURM, adds cluster info to prompt)
- Approval interception (`AskUserQuestion` tool → routes to user via WebSocket)
- Mid-execution steering via `Query.interrupt()` + `Query.streamInput()`
- Post-completion resume via `resumeTask()`
- MCP server loading for tool access
- Session preservation (10-minute TTL)

## Execution Strategies

Strategies control **where** commands run. Orthogonal to providers (which control **what** AI reasons about).

| Strategy | Sync/Async | Where Commands Run | Agent Runner Location |
|----------|-----------|-------------------|-----------------------|
| **Direct** | Sync | Same machine | On the machine |
| **Docker** | Sync | Container on same machine | On the machine |
| **SLURM** | Async | HPC compute nodes | Login node |
| **K8s Exec** | Sync | Existing K8s pod | Machine with kubectl |
| **SkyPilot** | Async | Cloud VM | Machine with sky CLI |

## Git Worktree Management

Each task gets its own worktree so:
- Multiple tasks run in parallel on the same repo
- Each task's changes are isolated on its own branch
- No merge conflicts during concurrent execution
- Each branch becomes a PR

```
~/.astro/
├── repos/{projectId}/              # Cloned repositories
├── worktrees/{repoName}/{taskId}/  # Isolated worktrees (one per task)
└── logs/                           # Execution logs
```

## Configuration

Config stored in `~/.config/astro-agent/config.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `relayUrl` | `ws://localhost:3002` | Relay WebSocket URL |
| `apiUrl` | `http://localhost:3001` | Backend API URL |
| `maxTasks` | 4 | Max concurrent tasks |
| `logLevel` | `info` | Log level (debug/info/warn/error) |
| `autoStart` | false | Start on login |
| `providers` | Auto-detected | Available AI providers |

## MCP Integration

The agent runner can act as an MCP server for Claude Code sessions:

```bash
astro-agent mcp
```

Provides 4 tools:
- `astro_attach` — Link Claude Code session to an Astro task
- `astro_detach` — Unlink session
- `astro_status` — Check task attachment
- `astro_send` — Send events to Astro

## WebSocket Protocol

The agent runner communicates with the relay using JSON messages with a `type` field.

**Sends (→ relay):** `register`, `heartbeat`, `task_status`, `task_text`, `task_tool_use`, `task_tool_result`, `task_file_change`, `task_session_init`, `task_result`, `task_approval_request`

**Receives (← relay):** `registered`, `task_dispatch`, `task_cancel`, `task_steer`, `task_approval_response`, `task_safety_decision`, `config_update`, `file_list_request`, `repo_setup_request`

## Project Structure

```
packages/agent-runner/src/
├── cli.ts                          # CLI entry point (commander)
├── index.ts                        # Public API exports
├── types.ts                        # Type definitions
├── commands/                       # CLI commands (setup, start, stop, status, etc.)
├── lib/
│   ├── task-executor.ts            # Task queue + lifecycle management
│   ├── websocket-client.ts         # WebSocket client + auto-reconnect
│   ├── worktree.ts                 # Git worktree creation + cleanup
│   ├── git-pr.ts                   # Branch push + PR creation
│   ├── workdir-safety.ts           # Safety tier system
│   ├── repo-utils.ts               # Repository clone + file tree
│   ├── prompt-templates.ts         # AI prompt builders
│   ├── repo-context.ts             # Repository context reading
│   ├── config.ts                   # Configuration management
│   ├── providers.ts                # Provider detection
│   └── resources.ts                # CPU/memory/GPU detection
├── providers/
│   ├── claude-sdk-adapter.ts       # Claude SDK integration
│   ├── claude-code-adapter.ts      # Claude CLI subprocess
│   └── codex-adapter.ts            # Codex CLI subprocess
├── execution/
│   ├── direct-strategy.ts          # Local process execution
│   ├── docker-strategy.ts          # Docker container execution
│   ├── slurm-strategy.ts           # SLURM job submission
│   ├── kubernetes-exec-strategy.ts # K8s pod execution
│   └── skypilot-strategy.ts        # Cloud VM (experimental)
└── mcp/
    ├── server.ts                   # MCP server setup
    └── tools.ts                    # Tool definitions
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ASTRO_SERVER_URL` | Backend API URL |
| `ASTRO_RELAY_URL` | Relay WebSocket URL |
| `ASTRO_AUTH_TOKEN` | Authentication token |
| `ASTRO_MACHINE_NAME` | Friendly machine name |
| `ASTRO_LOG_LEVEL` | Log level override |
| `ASTRO_EXECUTION_ID` | Current execution ID (set during task runs) |
| `ASTRO_PROJECT_ID` | Current project ID (set during task runs) |
| `ASTRO_TASK_ID` | Current task ID (set during task runs) |
