# CLAUDE.md — Astro Agent Runner

This file provides guidance to Claude Code when working with this repository.

## Project Overview

**@astroanywhere/agent** is the CLI agent runner for the Astro platform. It runs on user machines (local, SSH remote, HPC clusters) and executes tasks dispatched from the Astro server via WebSocket relay.

## Build & Test

```bash
npm run build          # TypeScript compilation
npm test               # Vitest (all tests)
npx tsc --noEmit       # Type check only
```

## Architecture

### Provider Adapters

Provider adapters run on user machines and bridge CLI tool output to Astro's streaming protocol:

- `src/providers/claude-code-adapter.ts` — Claude Code CLI
- `src/providers/codex-adapter.ts` — OpenAI Codex CLI (JSONL stream)
- `src/providers/openclaw-adapter.ts` — OpenClaw CLI
- `src/providers/opencode-adapter.ts` — OpenCode CLI

Each adapter implements `TaskOutputStream` (toolUse, toolResult, text, sessionInit, etc.) and extracts usage metrics (tokens, cost, model, turns) from the CLI's output format.

**Important:** Token/usage metric extraction belongs in the agent-runner adapters, NOT in the Astro server. The Astro server only receives already-parsed events via the relay — it never sees raw CLI output.

### Remote Agent Management

**Always kill and relaunch.** Both `setup` and `launch`/`start` commands unconditionally stop existing agents before reinstalling or restarting. Never use `pgrep` to check if an agent is "already running" and skip — this detection is unreliable because `pgrep -f "astro-agent start"` self-matches the SSH command process that runs the check (PRs #2, #3, #11).

```
# CORRECT — always stop + fresh start
pkill -f "[a]stro-agent start" 2>/dev/null || true
sleep 1
# proceed with install/start

# WRONG — do NOT add "skip if running" guards
# pgrep + skip leads to false positives from SSH self-matching
```

### Safety Warnings

Safety warning messages in `src/lib/workdir-safety.ts` must NOT contain emoji characters. The Astro frontend renders warnings with CSS styling (icons, borders, layout). Embedded emoji (`🛑`, `⚠️`) duplicates the CSS icons and causes inconsistent display.

### Key Directories

```
src/
├── commands/          # CLI commands (setup, start, stop, logs, status, mcp, plan)
├── providers/         # Provider adapters (claude-code, codex, openclaw, opencode)
├── lib/               # Core libraries (config, ssh-installer, ssh-discovery, providers, resources)
└── types.ts           # Shared types (ProviderType, DiscoveredHost, Task, etc.)
tests/                 # Vitest test files
```

### Data Directory

Agent runners store data in `~/.astro/`:
- `~/.astro/config.json` — Agent runner configuration
- `~/.astro/logs/agent-runner.log` — Background mode log output
- `~/.astro/agent-runner.pid` — PID file for stop command

## Code Patterns

- Provider adapters parse streaming output line-by-line via `handleStreamLine()`
- Use `sshExec(host, command)` for remote SSH operations
- Background processes redirect stdout/stderr to `~/.astro/logs/agent-runner.log`
- The `[a]stro-agent` bracket trick in pkill/pgrep prevents the pattern from matching itself
