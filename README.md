<h1 align="center">Astro Agent Runner</h1>
<p align="center">
  <strong>Connect your machines. Let AI do the work.</strong>
  <br />
  <br />
  <a href="https://www.npmjs.com/package/@astroanywhere/agent"><img src="https://img.shields.io/npm/v/@astroanywhere/agent?style=flat-square&color=0a0a1a&labelColor=0a0a1a&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@astroanywhere/agent"><img src="https://img.shields.io/npm/dm/@astroanywhere/agent?style=flat-square&color=0a0a1a&labelColor=0a0a1a&logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-0a0a1a?style=flat-square&labelColor=0a0a1a&logo=node.js&logoColor=white" alt="node version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-BSL--1.1-0a0a1a?style=flat-square&labelColor=0a0a1a" alt="license"></a>
  <br />
  <br />
  <a href="https://astroanywhere.com/landing/">Website</a>
  &nbsp;&middot;&nbsp;
  <a href="#quick-start">Get Started</a>
  <br />
  <br />
</p>

---

## What is Astro?

[**Astro**](https://astroanywhere.com/landing/) is an orchestrator for AI coding agents. It takes a complex goal, decomposes it into a dependency graph of tasks, and executes them **in parallel** across your machines &mdash; your laptop, GPU servers, HPC clusters, cloud VMs.

Mission control lives in the browser. Your machines do the work. The **Agent Runner** is the piece that runs on each machine &mdash; it receives tasks, runs AI agents, and streams results back.

> **Self-hosting** is on the roadmap. Currently Astro runs as a hosted service at [astroanywhere.com](https://astroanywhere.com).

---

## Quick Start

### Step 1 &mdash; Register

Create an account at [astroanywhere.com](https://astroanywhere.com).

### Step 2 &mdash; Install

Install at least one AI coding agent:

```bash
npm i -g @anthropic-ai/claude-code   # Claude Code
npm i -g @openai/codex                # Codex
npm i -g openclaw                     # OpenClaw
bun i -g opencode                     # OpenCode
```

Optionally install [GitHub CLI](https://cli.github.com/) (`gh`) for automatic PR creation &mdash; recommended but not required.

Then launch the agent runner:

```bash
npx @astroanywhere/agent@latest launch
```

One command. It detects your AI agents, discovers your machine hardware, finds your SSH hosts, authenticates you, and starts listening for tasks. No global install &mdash; `npx` fetches the latest version.

### Step 3 &mdash; Start Building

Open the [Astro Dashboard](https://astroanywhere.com), create a project, and describe what you want to build. Try one of these to get started:

- **"Add dark mode support to my React app"** &mdash; a single focused task
- **"Build a REST API with auth, CRUD endpoints, and tests"** &mdash; Astro decomposes this into parallel tasks
- **"Refactor the data layer to use a repository pattern"** &mdash; multi-step refactoring across files

Or jump straight in and describe your own goal. Astro will generate a plan, show you the dependency graph, and execute across your machines.

### What You'll See

```
$ npx @astroanywhere/agent@latest launch

  Astro Agent Runner v0.2.1

  +--------------------------------------------------------------+
  |  my-macbook (this device)                                    |
  |  Apple Silicon - darwin/arm64 - v0.2.1                       |
  |                                                              |
  |  Hardware                                                    |
  |    CPU   Apple M3 Max (16 cores)                             |
  |    RAM   128 GB (98 GB available)                            |
  |    GPU   Apple M3 Max (48 GB)                                |
  |                                                              |
  |  AI Agents                                                   |
  |    > claude-code v1.0.22 - model: sonnet-4                   |
  |    > codex v0.1.2                                            |
  |    > openclaw v0.3.1                                         |
  |    > opencode v0.2.0                                         |
  |                                                              |
  |  Runner: a1b2c3d4                                            |
  +--------------------------------------------------------------+

  Discovering SSH hosts... found 2: hpc-login, dev-vm

  To authenticate, open this URL in your browser:

    https://astroanywhere.com/device?code=ABCD-1234

  Waiting for approval...
  > Authenticated as you@example.com
  > Machine "my-macbook" registered

  Installing on remote hosts...

  +------------------------------------------------+
  |  [*] hpc-login (running)                       |
  |  user@hpc.university.edu                       |
  |  linux/x86_64 - 128 cores - 1024 GB RAM        |
  |    NVIDIA A100 (80 GB) x4                      |
  |                                                |
  |  AI Agents                                     |
  |    > claude-code v1.0.22                       |
  |    > openclaw v0.3.1                           |
  +------------------------------------------------+

  +------------------------------------------------+
  |  [*] dev-vm (running)                          |
  |  ubuntu@10.0.1.50                              |
  |  linux/x86_64 - 8 cores - 32 GB RAM            |
  |                                                |
  |  AI Agents                                     |
  |    > codex v0.1.2                              |
  |    > opencode v0.2.0                           |
  +------------------------------------------------+

  Remote agents: 2 running, 0 failed
  > Connected to relay

  Ready. Listening for tasks...
```

Your laptop and all remote hosts appear in the [Astro Dashboard](https://astroanywhere.com). Dispatch tasks to any of them.

### Remote Machines via SSH

`launch` reads your `~/.ssh/config`, discovers reachable hosts, installs the agent runner over SSH, and starts them &mdash; all from your laptop. To set up a single remote machine manually:

```bash
ssh user@remote-host
npx @astroanywhere/agent@latest launch --no-ssh-config
```

Astro picks the best available machine for each task based on load and capabilities.

---

## Key Features

### 1. Planning &amp; Parallel Execution

Describe what you want to build. Astro decomposes your goal into a **dependency graph** (DAG) of tasks, then executes them in parallel across your machines &mdash; respecting the dependency order automatically.

A complex feature that would take hours of serial work gets broken into independent subtasks. Tasks without dependencies run simultaneously on separate git branches. Dependent tasks wait only for their upstream inputs, not for unrelated work to finish.

```mermaid
%%{init: {
  'theme': 'base',
  'themeVariables': {
    'primaryColor': '#e8e0d8',
    'primaryBorderColor': '#b8a99a',
    'primaryTextColor': '#3d3a37',
    'lineColor': '#9a918a',
    'textColor': '#3d3a37',
    'fontSize': '14px',
    'fontFamily': 'Palatino, Palatino Linotype, Georgia, serif',
    'edgeLabelBackground': '#f7f4f0'
  },
  'flowchart': {
    'nodeSpacing': 20,
    'rankSpacing': 40,
    'padding': 16,
    'htmlLabels': true,
    'curve': 'basis'
  }
}}%%
flowchart LR
    classDef warm fill:#f0ebe4,stroke:#b8a99a,stroke-width:2px,color:#3d3a37
    classDef mist fill:#dce4ec,stroke:#9ab0c4,stroke-width:2px,color:#3d3a37
    classDef sage fill:#dde5d9,stroke:#a3b89a,stroke-width:2px,color:#3d3a37

    Goal["Describe<br/>your goal"]:::warm
    Plan["Plan<br/>DAG"]:::warm
    Goal --> Plan

    Plan --> T1["Task A"]:::mist
    Plan --> T2["Task B"]:::mist
    Plan --> T3["Task C"]:::mist

    T1 --> T4["Task D"]:::mist
    T2 --> T4
    T3 --> T5["Task E"]:::mist
    T4 --> Done["Done"]:::sage
    T5 --> Done

    linkStyle default stroke:#9a918a,stroke-width:2px
```

> **Tasks A, B, C run in parallel.** Task D waits for A + B. Task E waits for C.
> Total time = **longest path**, not sum of all tasks.

### 2. Supporting Mainstream AI Agents

Astro works with the AI coding agents you already use. Install any supported agent &mdash; Astro detects it at startup and dispatches tasks automatically.

| Agent | Install | Website |
|---|---|---|
| **Claude Code** | `npm i -g @anthropic-ai/claude-code` | [anthropic.com/claude-code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) |
| **Codex** | `npm i -g @openai/codex` | [github.com/openai/codex](https://github.com/openai/codex) |
| **OpenClaw** | `npm i -g openclaw` | [github.com/openclaw-ai/openclaw](https://github.com/openclaw-ai/openclaw) |
| **OpenCode** | `bun i -g opencode` | [github.com/opencode-ai/opencode](https://github.com/opencode-ai/opencode) |

All agents get full project context injection, real-time output streaming, and session preservation for multi-turn resume. Your API keys stay on your machine &mdash; Astro never sees them.

### 3. GitHub-Native Workflow

Every task runs on its own **git worktree** &mdash; a real, isolated branch with no conflicts. When the agent finishes, the runner commits the changes, pushes the branch, and opens a pull request automatically.

```mermaid
%%{init: {
  'theme': 'base',
  'themeVariables': {
    'primaryColor': '#e8e0d8',
    'primaryBorderColor': '#b8a99a',
    'primaryTextColor': '#3d3a37',
    'lineColor': '#9a918a',
    'textColor': '#3d3a37',
    'fontSize': '14px',
    'fontFamily': 'Palatino, Palatino Linotype, Georgia, serif',
    'edgeLabelBackground': '#f7f4f0'
  },
  'flowchart': {
    'nodeSpacing': 20,
    'rankSpacing': 40,
    'padding': 16,
    'htmlLabels': true,
    'curve': 'basis'
  }
}}%%
flowchart LR
    classDef warm fill:#f0ebe4,stroke:#b8a99a,stroke-width:2px,color:#3d3a37
    classDef mist fill:#dce4ec,stroke:#9ab0c4,stroke-width:2px,color:#3d3a37
    classDef sage fill:#dde5d9,stroke:#a3b89a,stroke-width:2px,color:#3d3a37

    WT["Create<br/>worktree"]:::warm --> Run["AI agent<br/>executes"]:::mist --> Commit["Commit &amp;<br/>push"]:::mist --> PR["Submit<br/>PR"]:::sage

    linkStyle default stroke:#9a918a,stroke-width:2px
```

No merge conflicts between parallel tasks. Each branch is isolated. Review and merge at your own pace.

### 4. Mission Control &amp; Full Observability

The [Astro Dashboard](https://astroanywhere.com) gives you full visibility into every agent session, tool execution, and file change across all your projects and machines:

- **Observe** &mdash; see the full dialogue of AI agents, every tool call, every file diff, in real time
- **Steer** &mdash; send guidance or redirect agents mid-execution
- **Decide** &mdash; approve, reject, or rerun from any device &mdash; no terminal needed
- **Scale** &mdash; multi-machine routing by load and capability

---

## Architecture

```mermaid
%%{init: {
  'theme': 'base',
  'themeVariables': {
    'primaryColor': '#e8e0d8',
    'primaryBorderColor': '#b8a99a',
    'primaryTextColor': '#3d3a37',
    'lineColor': '#9a918a',
    'textColor': '#3d3a37',
    'fontSize': '16px',
    'fontFamily': 'Palatino, Palatino Linotype, Georgia, serif',
    'edgeLabelBackground': '#f7f4f0'
  },
  'flowchart': {
    'nodeSpacing': 20,
    'rankSpacing': 40,
    'padding': 16,
    'htmlLabels': true,
    'curve': 'basis'
  }
}}%%
flowchart TB
    classDef server fill:#f0ebe4,stroke:#b8a99a,stroke-width:2px,color:#3d3a37
    classDef mist fill:#dce4ec,stroke:#9ab0c4,stroke-width:2px,color:#3d3a37
    classDef rose fill:#eaddd8,stroke:#c4a99c,stroke-width:2px,color:#3d3a37

    Server["<b>Astro Server</b> &nbsp; <i>astroanywhere.com</i><br/>Plan &rarr; Tasks &rarr; Dispatch"]:::server

    Server -- "dispatch tasks" --> runner
    runner -. "report progress" .-> Server

    subgraph runner["Agent Runner &mdash; this repo"]
        A1["Claude Code"]:::mist ~~~ A2["Codex"]:::mist ~~~ A3["OpenClaw"]:::mist ~~~ A4["OpenCode"]:::mist
    end

    runner -- "deploy jobs" --> compute
    compute -. "results" .-> runner

    subgraph compute["Compute Backends"]
        C1["Docker"]:::rose ~~~ C2["Slurm"]:::rose ~~~ C3["K8s"]:::rose ~~~ C4["SSH"]:::rose
    end

    style runner fill:#f7f4f0,stroke:#b8a99a,stroke-width:2px,color:#3d3a37
    style compute fill:#f5eeea,stroke:#c4a99c,stroke-width:2px,color:#3d3a37

    linkStyle 0 stroke:#9a918a,stroke-width:3px
    linkStyle 1 stroke:#9a918a,stroke-width:2px,stroke-dasharray:6
    linkStyle 2 stroke:#9a918a,stroke-width:3px
    linkStyle 3 stroke:#9a918a,stroke-width:2px,stroke-dasharray:6
```

> **Astro Server** generates plans, breaks them into tasks, and dispatches to agent runners. Each **Agent Runner** (this repo) selects an AI agent, deploys jobs to compute backends, and streams progress back to the server.

---

---

<p align="center">
  <a href="https://astroanywhere.com/landing/">astroanywhere.com</a>
</p>
