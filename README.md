<h1 align="center">Astro Agent Runner</h1>
<p align="center">
  <strong>Connect your machines. Let AI do the work.</strong>
  <br />
  <br />
  <a href="https://www.npmjs.com/package/@astro/agent"><img src="https://img.shields.io/npm/v/@astro/agent?style=flat-square&color=0a0a1a&labelColor=0a0a1a&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@astro/agent"><img src="https://img.shields.io/npm/dm/@astro/agent?style=flat-square&color=0a0a1a&labelColor=0a0a1a&logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-0a0a1a?style=flat-square&labelColor=0a0a1a&logo=node.js&logoColor=white" alt="node version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@astro/agent?style=flat-square&color=0a0a1a&labelColor=0a0a1a" alt="license"></a>
  <br />
  <br />
  <a href="https://astroanywhere.com/landing/">Website</a>
  &nbsp;&middot;&nbsp;
  <a href="https://astroanywhere.com">Dashboard</a>
  &nbsp;&middot;&nbsp;
  <a href="#install">Get Started</a>
  <br />
  <br />
</p>

---

## What is Astro?

[**Astro**](https://astroanywhere.com/landing/) is mission control for the AI age. It turns ambitious goals into dependency graphs, dispatches tasks across your machines in parallel, and surfaces the decisions that need you.

You plan in the browser. Your machines do the work. The **Agent Runner** is the piece that runs on your machines — it receives tasks, executes AI agents (Claude, Codex), and streams results back.

> **Self-hosting** is on the roadmap. Currently Astro runs as a hosted service at [astroanywhere.com](https://astroanywhere.com).

## Prerequisites

Create an account at [astroanywhere.com](https://astroanywhere.com) &mdash; you'll need it to authenticate your machines.

## Install

```bash
npx @astro/agent launch
```

One command. It detects your AI providers, finds your SSH hosts, authenticates you, sets up everything, and starts listening for tasks.

No global install. `npx` fetches the latest version.

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

Your laptop and all remote hosts appear in Astro's **Environments** page. Dispatch tasks to any of them.

## What You Get with Astro Anywhere

| | Feature | |
|---|---|---|
| **Plan** | Describe a goal &rarr; Astro breaks it into a dependency graph | Graph, List, Timeline views |
| **Execute** | Dispatch to any machine &mdash; laptop, server, HPC | Parallel, isolated branches |
| **Monitor** | Real-time agent output, tool calls, file changes | Live streaming |
| **Decide** | Approve, reject, or redirect from any device | No terminal needed |
| **Ship** | PRs created automatically per task | Branch-per-task isolation |
| **Scale** | Multi-machine routing by load & capability | SSH config auto-discovery |

## What the Agent Runner Does

When you execute a task in Astro, it lands on one of your machines. The agent runner:

- Creates an isolated git branch for the task
- Runs Claude (or Codex) with your project's full context
- Streams progress back to the Astro UI in real time
- Commits changes, pushes the branch, and opens a PR

Multiple tasks run in parallel &mdash; each on its own branch, no conflicts.

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

`launch` reads your `~/.ssh/config`, discovers hosts, installs the agent runner over SSH, and starts them &mdash; all from your laptop.

To set up a single remote machine manually, SSH in and run:

```bash
npx @astro/agent launch --no-ssh-config
```

Astro picks the best available machine for each task based on load and capabilities.

## AI Providers

Auto-detected. No configuration needed if any of these are installed:

| Provider | How to Enable |
|---|---|
| **Claude SDK** | Run `astro-agent auth` or set `ANTHROPIC_API_KEY` |
| **Claude Code** | Install [Claude Code](https://claude.ai/code) |
| **Codex** | Install Codex CLI |

## MCP Integration

Use the agent runner as an MCP server inside Claude Code:

```bash
npx @astro/agent mcp
```

This gives Claude Code access to Astro tools &mdash; attach to tasks, send updates, check status.

## Configuration

Stored at `~/.config/astro-agent/config.json`. Most users never need to touch this.

| Setting | Default | Description |
|---|---|---|
| `maxTasks` | `4` | Max concurrent tasks |
| `logLevel` | `info` | Logging verbosity |
| `autoStart` | `false` | Start on login |

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (alternative to OAuth) |
| `ASTRO_MACHINE_NAME` | Custom machine name |
| `ASTRO_LOG_LEVEL` | Override log level |

---

<p align="center">
  <a href="https://astroanywhere.com/landing/">astroanywhere.com</a>
</p>
