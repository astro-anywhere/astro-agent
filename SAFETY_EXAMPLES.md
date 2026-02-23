# Safety Guardrails - Usage Examples

## Quick Start

### Example 1: Safe Execution (Git Repo)
```bash
# Setup
cd ~/my-project
git init
git add .
git commit -m "Initial commit"

# Start agent
npx @astro/agent start

# Task executes immediately - no prompt needed ✅
```

### Example 2: Risky Execution (No Git)
```bash
# Setup
mkdir ~/new-project
cd ~/new-project
echo "test" > file.txt

# Start agent
npx @astro/agent start

# Task triggers safety prompt:
```

```
⚠️  NO GIT REPOSITORY DETECTED

AI agents may modify or delete files without version control.
You will NOT be able to revert changes if something goes wrong.

Recommendations:
  1. Initialize git: cd ~/new-project && git init
  2. Use --sandbox mode to work on a copy
  3. Ensure you have backups of important files

Choose an option:
┌─────────────────────────────────────────────────────────┐
│ 1. Continue anyway                                       │
│    Execute in non-git directory at your own risk        │
│                                                          │
│ 2. Initialize git first                                 │
│    Create git repository before execution               │
│                                                          │
│ 3. Use sandbox mode                                     │
│    Work on a copy, review changes before applying       │
│                                                          │
│ 4. Cancel task                                          │
│    Do not execute this task                             │
└─────────────────────────────────────────────────────────┘
```

### Example 3: Parallel Execution Blocked
```bash
# Terminal 1
cd ~/no-git-folder
npx @astro/agent start

# Task 1 starts (user confirms "Continue anyway")

# Terminal 2 (same machine)
# Task 2 is dispatched to same directory
```

```
🛑 PARALLEL EXECUTION BLOCKED

Multiple agents cannot run in the same non-git directory.
This would cause file conflicts and potential data loss.

Active tasks in this directory: 1

Solutions:
  1. Wait for other tasks to complete
  2. Initialize git in this directory
  3. Use a different working directory
  4. Enable --sandbox-mode to execute in isolation
```

### Example 4: Automatic Sandbox Mode
```bash
# Always use sandbox - no prompts
npx @astro/agent start --sandbox

# All tasks execute in isolated copies
# Original files never touched
```

### Example 5: Automation Mode
```bash
# Skip safety prompts (for CI/CD)
npx @astro/agent start --allow-non-git

# Warning: This bypasses user confirmation!
# Only use in automated environments where you control the workload
```

### Example 6: Large Directory Warning
```bash
# Directory with 500MB of files
npx @astro/agent start --sandbox

# Error:
```

```
Directory size (500.0MB) exceeds sandbox limit (100.0MB).
Use --max-sandbox-size to increase or exclude large directories.
```

```bash
# Solution: Increase limit
npx @astro/agent start --sandbox --max-sandbox-size 600
```

## Real-World Scenarios

### Scenario 1: Code Review Agent
```bash
# Safe approach - work on a branch
cd ~/project
git checkout -b ai-review
npx @astro/agent start

# Agent makes changes on the branch
# Review changes: git diff main
# Merge if good: git merge ai-review
```

### Scenario 2: Exploratory Refactoring
```bash
# Use sandbox to experiment safely
npx @astro/agent start --sandbox

# Agent refactors code in sandbox
# Review changes in ~/.astro/sandbox/<task-id>/
# If good, agent can copy back (or user can manually apply)
```

### Scenario 3: Production Hotfix
```bash
# Working on production code - want extra safety
cd ~/production-app
git status  # Ensure clean state
npx @astro/agent start

# Safety tier: SAFE ✅
# Task executes with full git protection
# All changes tracked, revertable
```

### Scenario 4: Jupyter Notebook Analysis
```bash
# Notebooks directory without git
cd ~/notebooks
npx @astro/agent start

# Safety prompt appears
# Option 2: Initialize git
# Agent runs: git init && git add . && git commit -m "Initial"
# Then executes task safely
```

### Scenario 5: Data Science Pipeline
```bash
# Large data folder (200MB)
cd ~/data-analysis
npx @astro/agent start --sandbox --max-sandbox-size 250

# Sandbox mode copies only code files
# Excludes: data/, .git/, venv/, __pycache__/
# Agent processes data in isolated environment
```

## CLI Flag Combinations

### Development Mode
```bash
# Paranoid mode - sandbox everything
npx @astro/agent start --sandbox --max-sandbox-size 500
```

### Production Mode
```bash
# Strict mode - require git, no unsafe operations
npx @astro/agent start
# Default settings ensure safety
```

### CI/CD Mode
```bash
# Automated mode - skip prompts, trust workload
npx @astro/agent start --allow-non-git
```

### Debug Mode
```bash
# Preserve worktrees and sandboxes for inspection
npx @astro/agent start --preserve-worktrees --sandbox
# Worktrees: ~/.astro/worktrees/<repo>/<task-id>/
# Sandboxes: ~/.astro/sandbox/<task-id>/
```

## Advanced Patterns

### Pattern 1: Pre-execution Git Check
```bash
#!/bin/bash
# check-git.sh

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repo - initializing..."
  git init
  git add .
  git commit -m "Initial commit (automated)"
fi

npx @astro/agent start
```

### Pattern 2: Sandbox Review Workflow
```bash
#!/bin/bash
# sandbox-review.sh

# Start agent in sandbox
npx @astro/agent start --sandbox &
AGENT_PID=$!

# Wait for task completion
wait $AGENT_PID

# Find sandbox directory
SANDBOX_DIR=$(ls -t ~/.astro/sandbox | head -1)

# Review changes
echo "Reviewing changes in: $SANDBOX_DIR"
diff -r . ~/.astro/sandbox/$SANDBOX_DIR

# Prompt user
read -p "Apply changes? (y/n) " -n 1 -r
if [[ $REPLY =~ ^[Yy]$ ]]; then
  rsync -av --exclude='.git' ~/.astro/sandbox/$SANDBOX_DIR/ .
  echo "Changes applied!"
fi
```

### Pattern 3: Multi-Project Safe Execution
```bash
#!/bin/bash
# safe-multi-exec.sh

PROJECTS=(~/proj1 ~/proj2 ~/proj3)

for PROJ in "${PROJECTS[@]}"; do
  cd "$PROJ"

  # Ensure git repo
  if ! git rev-parse --git-dir > /dev/null 2>&1; then
    git init && git add . && git commit -m "Initial"
  fi

  # Start agent
  npx @astro/agent start --foreground
done
```

## Troubleshooting Examples

### Problem: "Directory too large for sandbox"
```bash
# Check directory size
du -sh .
# 350M

# Solution 1: Increase limit
npx @astro/agent start --sandbox --max-sandbox-size 400

# Solution 2: Clean up large folders first
rm -rf node_modules dist build
npm install  # Reinstall after if needed
```

### Problem: "Parallel execution blocked"
```bash
# Check active tasks
ps aux | grep astro-agent

# Solution 1: Wait
# Let current task finish

# Solution 2: Initialize git
git init && git add . && git commit -m "Initial"

# Solution 3: Use different directory
mkdir ~/task-workspace
cd ~/task-workspace
# Run task here instead
```

### Problem: "Git not available"
```bash
# Check git
which git
# (empty)

# Install git
# macOS:
brew install git

# Ubuntu/Debian:
sudo apt install git

# Verify
git --version
```

## Safety Decision Matrix

| Scenario | Git Repo | Uncommitted | Parallel | Safety Tier | Action |
|----------|----------|-------------|----------|-------------|--------|
| Fresh git repo | ✅ | ❌ | ❌ | SAFE | Execute |
| Git with changes | ✅ | ✅ | ❌ | GUARDED | Warn + Execute |
| No git | ❌ | N/A | ❌ | RISKY | Prompt user |
| No git + parallel | ❌ | N/A | ✅ | UNSAFE | Block |

## Best Practices

1. **Always use git repositories for important work**
   ```bash
   git init && git add . && git commit -m "Before AI"
   ```

2. **Commit before running agents**
   ```bash
   git status  # Check clean state
   git add . && git commit -m "Pre-agent checkpoint"
   ```

3. **Use branches for experimental changes**
   ```bash
   git checkout -b ai-experiment
   npx @astro/agent start
   ```

4. **Use sandbox for untrusted tasks**
   ```bash
   npx @astro/agent start --sandbox
   ```

5. **Review changes before committing**
   ```bash
   git diff  # After agent completes
   git add -p  # Stage changes interactively
   ```

---

**Pro Tip**: Combine git + sandbox for maximum safety:
```bash
# 1. Ensure git repo
git init && git add . && git commit -m "Initial"

# 2. Run in sandbox
npx @astro/agent start --sandbox

# 3. Review sandbox changes
diff -r . ~/.astro/sandbox/<task-id>

# 4. Apply and commit
# (manual copy or agent copyBack)
git add . && git commit -m "AI changes (reviewed)"
```
