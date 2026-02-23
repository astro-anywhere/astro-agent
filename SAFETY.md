# Agent Runner Safety Guardrails

This document describes the comprehensive safety system implemented to prevent data loss when agents execute tasks in user directories.

## Overview

The safety system prevents accidental file deletion or corruption by:
1. **Detecting git vs non-git directories**
2. **Blocking parallel execution in non-git directories**
3. **Warning about uncommitted changes**
4. **Providing sandbox mode for isolated execution**
5. **Requiring explicit user confirmation for risky operations**

## Safety Tiers

### SAFE (✅)
- **Condition**: Git repository with clean working tree
- **Action**: Execute normally
- **Risk**: Minimal - all changes are version controlled

### GUARDED (⚠️)
- **Condition**: Git repository with uncommitted changes
- **Action**: Warn user but allow execution
- **Warning**: "Uncommitted changes detected. The agent may modify, stage, or commit these changes."
- **Risk**: Low - git allows reverting, but uncommitted work might be affected

### RISKY (⚠️⚠️)
- **Condition**: Non-git directory, no parallel tasks
- **Action**: Require user confirmation
- **Warning**: "NO GIT REPOSITORY DETECTED. AI agents may modify or delete files without version control."
- **Options**:
  - ✅ Continue anyway (at your own risk)
  - 🔧 Initialize git first
  - 📦 Use sandbox mode
  - ❌ Cancel task
- **Risk**: High - no version control, changes cannot be reverted

### UNSAFE (🛑)
- **Condition**: Non-git directory with parallel tasks running
- **Action**: Block execution immediately
- **Block Reason**: "Multiple agents cannot run in the same non-git directory. This would cause file conflicts and potential data loss."
- **Risk**: Extreme - file conflicts, race conditions, data corruption

## User Decision Flow

When a RISKY operation is detected:

```
┌─────────────────────────────────────────┐
│  ⚠️  NO GIT REPOSITORY DETECTED         │
│                                          │
│  AI agents may modify or delete files   │
│  without version control.                │
│                                          │
│  Options:                                │
│  1. Continue anyway (risky)              │
│  2. Initialize git first (safe)          │
│  3. Use sandbox mode (isolated)          │
│  4. Cancel task                          │
└─────────────────────────────────────────┘
```

### Option 1: Continue Anyway
- Executes directly in the non-git directory
- No rollback capability
- User assumes all risk

### Option 2: Initialize Git
- Runs `git init` in the directory
- Creates initial commit with current files
- Then executes task normally
- All changes will be version controlled

### Option 3: Sandbox Mode
- Copies directory to `~/.astro/sandbox/<taskId>/`
- Executes task in isolated copy
- Skips large directories (node_modules, .git, venv, etc.)
- After completion: user reviews changes before applying back
- Original directory remains untouched

### Option 4: Cancel
- Immediately cancels the task
- No execution occurs

## CLI Flags

### `--allow-non-git`
Skip the safety prompt for non-git directories. Useful for automation or when you trust the workload.

```bash
npx @astro/agent start --allow-non-git
```

**⚠️ Warning**: This bypasses user confirmation. Only use if you understand the risks.

### `--sandbox`
Always execute in sandbox mode, regardless of git status.

```bash
npx @astro/agent start --sandbox
```

**Benefits**:
- Zero risk to original files
- Safe for experimentation
- Review all changes before applying

**Limitations**:
- Requires copying files (slower)
- Limited by `--max-sandbox-size`

### `--max-sandbox-size <mb>`
Set maximum directory size for sandbox mode (default: 100MB).

```bash
npx @astro/agent start --sandbox --max-sandbox-size 200
```

Directories larger than this limit cannot use sandbox mode.

## Parallel Execution Safety

The system tracks active tasks per directory:

```typescript
tasksByDirectory: Map<workdir, Set<taskIds>>
```

**Rules**:
- ✅ Multiple tasks in same **git directory**: ALLOWED
- ✅ Multiple tasks in **different directories**: ALLOWED
- 🛑 Multiple tasks in same **non-git directory**: BLOCKED

**Why?**
- Git repositories handle concurrent changes through branches/worktrees
- Non-git directories have no conflict resolution mechanism
- Parallel file modifications cause race conditions and corruption

## Implementation Details

### Safety Check Flow

```typescript
submitTask(task)
  ↓
resolveWorkingDirectory(task.workingDirectory)
  ↓
performSafetyCheck(workdir)
  ↓
checkWorkdirSafety(workdir, activeTasksInDir, gitAvailable)
  ↓
[UNSAFE] → Block with error
[RISKY]  → requestSafetyDecision() → wait for user
[GUARDED] → Warn and continue
[SAFE]    → Continue
  ↓
trackTaskDirectory(task)
  ↓
executeTask(task, useSandbox)
```

### Directory Tracking

Tasks are tracked per directory:

```typescript
// Add task to directory tracking
trackTaskDirectory(task: Task): void {
  const tasks = this.tasksByDirectory.get(task.workingDirectory) || new Set();
  tasks.add(task.id);
  this.tasksByDirectory.set(task.workingDirectory, tasks);
}

// Remove task from directory tracking
untrackTaskDirectory(task: Task): void {
  const tasks = this.tasksByDirectory.get(task.workingDirectory);
  if (tasks) {
    tasks.delete(task.id);
    if (tasks.size === 0) {
      this.tasksByDirectory.delete(task.workingDirectory);
    }
  }
}
```

### Sandbox Implementation

1. **Check size**: `getDirectorySize(workdir)` excludes large folders
2. **Create copy**: `cp` with filter (skip node_modules, .git, etc.)
3. **Execute**: Agent works in `~/.astro/sandbox/<taskId>/`
4. **Cleanup**: `sandbox.cleanup()` removes temporary files
5. **Optional**: `sandbox.copyBack()` applies changes to original

## Git Requirement for Worktrees

The worktree system **requires** git to be initialized:

```typescript
// worktree.ts
const gitRoot = await getGitRoot(workingDirectory);
if (!gitRoot) {
  throw new Error('Not a git repository. Initialize git first.');
}
```

**Why?**
- Worktrees are a git feature for parallel work
- Without git, worktree creation fails
- Safety system ensures git is initialized before reaching this point

## WebSocket Protocol

### Safety Prompt (Agent → Server → UI)

```json
{
  "type": "task_safety_prompt",
  "timestamp": "2026-02-17T12:00:00Z",
  "payload": {
    "taskId": "task-123",
    "safetyTier": "risky",
    "warning": "⚠️  NO GIT REPOSITORY DETECTED\n\n...",
    "options": [
      { "id": "proceed", "label": "Continue anyway", "description": "..." },
      { "id": "init-git", "label": "Initialize git first", "description": "..." },
      { "id": "sandbox", "label": "Use sandbox mode", "description": "..." },
      { "id": "cancel", "label": "Cancel task", "description": "..." }
    ]
  }
}
```

### Safety Decision (UI → Server → Agent)

```json
{
  "type": "task_safety_decision",
  "timestamp": "2026-02-17T12:00:05Z",
  "payload": {
    "taskId": "task-123",
    "decision": "sandbox",
    "sandboxMode": true
  }
}
```

## Best Practices

### For Users

1. **Use git repositories**: Always work in version-controlled directories
2. **Commit regularly**: Keep working tree clean before running agents
3. **Enable sandbox for experiments**: Use `--sandbox` for risky operations
4. **Review changes**: Check git diff after agent execution

### For Developers

1. **Test safety checks**: Verify all four tiers work correctly
2. **Handle timeouts**: Safety prompts have 60s timeout
3. **Clean up directories**: Always call `untrackTaskDirectory()` in finally blocks
4. **Respect user decisions**: Never bypass safety checks silently

## Testing

### Test SAFE tier
```bash
cd /tmp/test-repo
git init
git add . && git commit -m "Initial"
# Execute task → should proceed immediately
```

### Test GUARDED tier
```bash
cd /tmp/test-repo
echo "change" >> file.txt
# Execute task → should warn about uncommitted changes
```

### Test RISKY tier
```bash
mkdir /tmp/no-git
cd /tmp/no-git
# Execute task → should prompt for safety decision
```

### Test UNSAFE tier
```bash
mkdir /tmp/no-git
cd /tmp/no-git
# Start task-1 (proceeds after user confirmation)
# Start task-2 → should be blocked immediately
```

### Test sandbox mode
```bash
npx @astro/agent start --sandbox
# All tasks execute in sandbox, original files untouched
```

## Future Enhancements

- [ ] File change diff preview before sandbox.copyBack()
- [ ] Automatic git stash before execution
- [ ] Per-project safety preferences (stored in .astro/config)
- [ ] Sandbox size estimation before execution
- [ ] Rollback button for completed tasks
- [ ] Safety audit log (all decisions tracked)

## Troubleshooting

### "Git not available"
```bash
# Install git
brew install git  # macOS
apt install git   # Ubuntu/Debian
```

### "Directory too large for sandbox"
```bash
# Increase limit or exclude directories
npx @astro/agent start --sandbox --max-sandbox-size 500
```

### "Parallel execution blocked"
```bash
# Wait for other task to complete, or:
# 1. Initialize git: git init && git add . && git commit -m "Initial"
# 2. Use different directory
```

### "Safety prompt not showing"
Check server logs and WebSocket connection. The prompt is sent via:
```
Agent → WS → Relay → WS → Server → SSE → UI
```

---

**Last Updated**: 2026-02-17
**Version**: 1.0.0
