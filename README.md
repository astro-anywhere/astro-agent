# Astro Agent Runner

> Connect your machines to [Astro](https://astroanywhere.com) and let AI execute your tasks.

## Prerequisites

Register an account at [astroanywhere.com](https://astroanywhere.com) before getting started.

> **Self-hosting:** Astro currently runs as a hosted service at astroanywhere.com. Local/self-hosted deployment is on the roadmap.

## Install

```bash
npx @astro/agent launch
```

One command. It detects your AI providers, finds your SSH hosts, authenticates you, sets up everything, and starts listening for tasks.

No global install needed. `npx` fetches the latest version.

## What Happens

```
$ npx @astro/agent launch

  Detecting providers... claude-sdk, claude-code
  Discovering SSH hosts... found 3: lab-gpu, hpc-login, aws-dev

  To authenticate, open this URL in your browser:

    https://astroanywhere.com/device?code=ABCD-1234

  Waiting for approval...
  ✓ Authenticated as you@example.com
  ✓ Machine "my_laptop" registered

  Installing on remote hosts...
  ✓ lab-gpu: installed and started
  ✓ hpc-login: installed and started
  ✓ aws-dev: installed and started

  Remote agents: 3 running, 0 failed
  ✓ Connected to relay

  Ready. Listening for tasks...
```

After this, your laptop and all your remote machines show up in Astro's **Environments** page. Dispatch tasks to any of them from the UI.

## What You Can Do on Astro Anywhere

Once your machines are connected, [astroanywhere.com](https://astroanywhere.com) gives you:

- **Plan** — Describe a goal, Astro breaks it into a dependency graph of tasks
- **Execute** — Dispatch tasks to any registered machine (laptop, server, HPC cluster)
- **Monitor** — Watch agent output stream in real time, see tool calls and file changes
- **Decide** — Approve, reject, or redirect when agents need human judgment
- **Branch per task** — Every task runs on its own git branch, PRs created automatically
- **Multi-machine** — Tasks route to the best available machine by load and capability
- **MCP tools** — Agents can query plans, create sub-tasks, and ask you questions mid-execution

## What the Agent Runner Does

When you execute a task in Astro, it lands on one of your machines. The agent runner:

- Creates an isolated git branch for the task
- Runs Claude (or Codex) with your project's full context
- Streams progress back to the Astro UI in real time
- Commits changes, pushes the branch, and opens a PR

Multiple tasks run in parallel — each on its own branch, no conflicts.

Your API keys stay on your machine. Astro never sees them.

## Commands

```bash
# First time — set up everything and start
npx @astro/agent launch

# Local only, skip SSH host discovery
npx @astro/agent launch --no-ssh-config

# Start (already set up)
npx @astro/agent start -f

# Stop
npx @astro/agent stop

# Check what's running
npx @astro/agent status

# Set up Claude authentication
npx @astro/agent auth

# View or change settings
npx @astro/agent config --show
npx @astro/agent config --set maxTasks=8
```

## Remote Machines

`launch` reads your `~/.ssh/config`, discovers hosts, installs the agent runner over SSH, and starts them — all from your laptop.

To set up a single remote machine manually, SSH in and run:

```bash
npx @astro/agent launch --no-ssh-config
```

Astro picks the best available machine for each task based on load and capabilities.

## AI Providers

Auto-detected. No configuration needed if any of these are installed:

| Provider | How to Enable |
|----------|---------------|
| **Claude SDK** | Run `astro-agent auth` or set `ANTHROPIC_API_KEY` |
| **Claude Code** | Install [Claude Code](https://claude.ai/code) |
| **Codex** | Install Codex CLI |

## MCP Integration

Use the agent runner as an MCP server inside Claude Code:

```bash
npx @astro/agent mcp
```

This gives Claude Code access to Astro tools — attach to tasks, send updates, check status.

## Configuration

Stored at `~/.config/astro-agent/config.json`. Most users never need to touch this.

| Setting | Default | Description |
|---------|---------|-------------|
| `maxTasks` | 4 | Max concurrent tasks |
| `logLevel` | `info` | Logging verbosity |
| `autoStart` | false | Start on login |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key (alternative to OAuth) |
| `ASTRO_MACHINE_NAME` | Custom machine name |
| `ASTRO_LOG_LEVEL` | Override log level |
