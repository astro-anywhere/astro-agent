# Safety System - Complete Scenario Guide

## Overview

The safety system handles multiple factors:
1. **Working Directory Source** (specified path, git URL, or default)
2. **Git Status** (git repo vs non-git directory)
3. **Execution Mode** (normal vs sandbox)
4. **Parallel Tasks** (single vs multiple in same directory)
5. **Uncommitted Changes** (clean vs dirty git state)

## Decision Tree

```
Task Received
    ↓
Resolve Working Directory
    ↓
    ├─ Git URL provided? → Clone to ~/.astro/repos/<projectId>/
    ├─ Path provided? → Use as-is
    └─ Nothing provided? → Use process.cwd()
    ↓
Check Safety Tier
    ↓
    ├─ Is git repo?
    │   ├─ Yes → Has uncommitted changes?
    │   │   ├─ Yes → GUARDED (warn + execute)
    │   │   └─ No → SAFE (execute)
    │   └─ No → Check parallel tasks
    │       ├─ Other tasks in same dir? → UNSAFE (block)
    │       └─ No parallel tasks? → RISKY (prompt user)
    ↓
Handle Based on Tier
    ↓
Execute (with or without sandbox)
```

---

## Scenario Matrix

| # | Dir Type | Dir Specified | Git Status | Parallel | Sandbox | Safety Tier | Workflow |
|---|----------|---------------|------------|----------|---------|-------------|----------|
| 1 | Local | ✅ Yes | ✅ Git + Clean | ❌ No | ❌ No | SAFE | A |
| 2 | Local | ✅ Yes | ✅ Git + Dirty | ❌ No | ❌ No | GUARDED | B |
| 3 | Local | ✅ Yes | ❌ No Git | ❌ No | ❌ No | RISKY | C |
| 4 | Local | ✅ Yes | ❌ No Git | ✅ Yes | ❌ No | UNSAFE | D |
| 5 | Local | ✅ Yes | ❌ No Git | ❌ No | ✅ Yes | RISKY → Sandbox | E |
| 6 | Local | ❌ No (cwd) | ✅ Git + Clean | ❌ No | ❌ No | SAFE | A |
| 7 | Local | ❌ No (cwd) | ❌ No Git | ❌ No | ❌ No | RISKY | C |
| 8 | Git URL | ✅ Yes | ✅ Git (cloned) | ❌ No | ❌ No | SAFE | F |
| 9 | Empty Project | ❌ No | ❌ Created new | ❌ No | ❌ No | SAFE | G |
| 10 | Any | Any | Any | ❌ No | ✅ Yes (--sandbox) | SAFE | E |

---

## Detailed Scenario Workflows

### Workflow A: SAFE - Git Repo, Clean State
**Scenario 1, 6**

```yaml
Input:
  workingDirectory: "/Users/alice/my-project"  # or cwd if not specified

Checks:
  ✅ Is git repo: true
  ✅ Has commits: true
  ✅ Uncommitted changes: false
  ✅ Parallel tasks: 0

Result: SAFE ✅

Flow:
  1. resolveWorkingDirectory("/Users/alice/my-project")
     → returns "/Users/alice/my-project"

  2. performSafetyCheck()
     → isGitRepo = true
     → hasUncommittedChanges = false
     → activeTasksInDir = 0
     → tier = SAFE

  3. trackTaskDirectory()
     → tasksByDirectory["/Users/alice/my-project"] = { taskId }

  4. executeTask(sandbox=false)
     → createWorktree()
       → git worktree add ~/.astro/worktrees/my-project/taskId
     → Execute in worktree
     → Commit changes to branch
     → Attempt PR creation
     → Cleanup worktree

  5. untrackTaskDirectory()
     → tasksByDirectory["/Users/alice/my-project"] = {}
```

**User sees:**
- No prompt
- Task executes immediately
- All changes on git branch
- Optional PR created

---

### Workflow B: GUARDED - Git Repo, Uncommitted Changes
**Scenario 2**

```yaml
Input:
  workingDirectory: "/Users/alice/my-project"

Checks:
  ✅ Is git repo: true
  ✅ Has commits: true
  ⚠️  Uncommitted changes: true  # <-- Different from A
  ✅ Parallel tasks: 0

Result: GUARDED ⚠️

Flow:
  1. resolveWorkingDirectory("/Users/alice/my-project")
     → returns "/Users/alice/my-project"

  2. performSafetyCheck()
     → isGitRepo = true
     → hasUncommittedChanges = true  # <-- Detected
     → activeTasksInDir = 0
     → tier = GUARDED

  3. sendTaskStatus(warning):
     ⚠️  UNCOMMITTED CHANGES DETECTED

     The working directory has uncommitted changes.
     The agent may modify, stage, or commit these changes.

     Recommendation: Commit or stash changes before proceeding.

  4. trackTaskDirectory()

  5. executeTask(sandbox=false)
     → Same as Workflow A, but may interact with uncommitted files

  6. untrackTaskDirectory()
```

**User sees:**
- Warning message
- Task executes automatically (not blocked)
- Should review changes carefully

---

### Workflow C: RISKY - Non-Git Directory
**Scenario 3, 7**

```yaml
Input:
  workingDirectory: "/Users/alice/no-git-folder"  # or cwd if not specified

Checks:
  ❌ Is git repo: false
  ❌ Parallel tasks: 0

Result: RISKY ⚠️⚠️

Flow:
  1. resolveWorkingDirectory("/Users/alice/no-git-folder")
     → returns "/Users/alice/no-git-folder"

  2. performSafetyCheck()
     → isGitRepo = false
     → activeTasksInDir = 0
     → tier = RISKY

  3. requestSafetyDecision()
     → sendSafetyPrompt() via WebSocket

     Prompt shown to user:
     ┌──────────────────────────────────────────────────┐
     │ ⚠️  NO GIT REPOSITORY DETECTED                   │
     │                                                   │
     │ AI agents may modify or delete files without     │
     │ version control. You will NOT be able to revert  │
     │ changes if something goes wrong.                 │
     │                                                   │
     │ Options:                                          │
     │ 1. Continue anyway (at your own risk)            │
     │ 2. Initialize git first                          │
     │ 3. Use sandbox mode                              │
     │ 4. Cancel task                                   │
     └──────────────────────────────────────────────────┘

  4. Wait for user decision...

  5a. If user chooses "Continue anyway":
      → trackTaskDirectory()
      → executeTask(sandbox=false)
        → NO worktree (not a git repo)
        → Execute directly in directory
        → Changes are permanent, no rollback!
      → untrackTaskDirectory()

  5b. If user chooses "Initialize git":
      → initializeGit()
        → git init
        → git add .
        → git commit -m "Initial commit"
      → trackTaskDirectory()
      → executeTask(sandbox=false)
        → NOW has git, so createWorktree() works
      → untrackTaskDirectory()

  5c. If user chooses "Sandbox mode":
      → trackTaskDirectory()
      → executeTask(sandbox=true)
        → See Workflow E
      → untrackTaskDirectory()

  5d. If user chooses "Cancel":
      → sendTaskResult(status='cancelled')
      → [Task never executes]
```

**User sees:**
- Safety prompt with 4 options
- Must make explicit decision
- Clear warning about risks

---

### Workflow D: UNSAFE - Non-Git + Parallel Tasks
**Scenario 4**

```yaml
Input:
  workingDirectory: "/Users/alice/no-git-folder"

Checks:
  ❌ Is git repo: false
  ❌ Parallel tasks: 1  # <-- Another task already running here!

Result: UNSAFE 🛑 (BLOCKED)

Flow:
  1. resolveWorkingDirectory("/Users/alice/no-git-folder")
     → returns "/Users/alice/no-git-folder"

  2. performSafetyCheck()
     → isGitRepo = false
     → activeTasksInDir = 1  # <-- Task already tracked
     → tier = UNSAFE

  3. sendTaskResult(status='failed'):
     🛑 PARALLEL EXECUTION BLOCKED

     Multiple agents cannot run in the same non-git directory.
     This would cause file conflicts and potential data loss.

     Active tasks in this directory: 1

     Solutions:
       1. Wait for other tasks to complete
       2. Initialize git in this directory
       3. Use a different working directory
       4. Enable --sandbox-mode to execute in isolation

  4. [Task terminates immediately - never executes]
```

**User sees:**
- Immediate block message
- Task fails without executing
- Must wait or fix the issue

---

### Workflow E: Sandbox Mode (Any Safety Tier)
**Scenario 5, 10**

```yaml
Input:
  workingDirectory: "/Users/alice/any-folder"
  useSandbox: true  # --sandbox flag OR user chose option 3

Checks:
  (Safety checks still run, but sandbox overrides execution mode)

Result: Executes in isolated sandbox

Flow:
  1. resolveWorkingDirectory("/Users/alice/any-folder")
     → returns "/Users/alice/any-folder"

  2. Safety checks...
     → May prompt user if RISKY
     → User chooses "Sandbox mode" (or --sandbox flag set)

  3. createSandbox():
     → Check directory size:
       getDirectorySize("/Users/alice/any-folder")
       → Excludes: node_modules, .git, venv, build, dist
       → Size: 45MB

     → If size > maxSandboxSize (100MB):
       ✗ Error: "Directory too large for sandbox"
       → User must increase --max-sandbox-size

     → Copy to sandbox:
       cp -r /Users/alice/any-folder ~/.astro/sandbox/taskId
       → Excludes: node_modules, .git, venv, __pycache__

  4. executeTask(sandbox=true):
     workingDirectory = "~/.astro/sandbox/taskId"

     → Execute in sandbox
     → All changes confined to sandbox
     → Original directory UNTOUCHED

  5. Completion:
     → sandbox.cleanup() removes sandbox
     → OR sandbox.copyBack() applies changes to original
       (requires user confirmation)
```

**User sees:**
- "Creating sandbox..." message
- Task executes in isolation
- Original files safe
- Optional: Review diff before applying changes back

---

### Workflow F: Git URL (Clone + Execute)
**Scenario 8**

```yaml
Input:
  workingDirectory: "https://github.com/user/repo.git"
  projectId: "proj-123"

Checks:
  (URL detected, triggers clone)

Flow:
  1. resolveWorkingDirectory("https://github.com/user/repo.git", "proj-123")
     → Detects git URL (starts with https://, http://, or git@)
     → Clone location: ~/.astro/repos/proj-123/

     → If already cloned:
       git fetch --all  # Update
     → Else:
       git clone https://github.com/user/repo.git ~/.astro/repos/proj-123/

     → returns "~/.astro/repos/proj-123/"

  2. performSafetyCheck("~/.astro/repos/proj-123/")
     → isGitRepo = true  # Always true after clone
     → hasUncommittedChanges = false  # Fresh clone
     → activeTasksInDir = 0
     → tier = SAFE

  3. executeTask(sandbox=false)
     → createWorktree()
     → Execute in worktree
     → Same as Workflow A
```

**User sees:**
- Clone progress (if first time)
- "Fetching latest..." (if already cloned)
- Then normal SAFE execution

---

### Workflow G: Empty Project (Create New Directory)
**Scenario 9**

```yaml
Input:
  workingDirectory: undefined  # Not specified
  repository: undefined        # Not specified
  projectId: "proj-123"

Checks:
  (No directory + no repo = create fresh project)

Flow:
  1. resolveWorkingDirectory(undefined, "proj-123")
     → No value provided
     → returns process.cwd()  # Usually ~/.astro/ or current dir

  2. localRepoSetup() on server creates:
     mkdir ~/.astro/projects/proj-123/
     git init
     git config user.name "Astro Agent"
     git config user.email "agent@astro.local"

  3. Task dispatched with:
     workingDirectory: "~/.astro/projects/proj-123/"

  4. performSafetyCheck("~/.astro/projects/proj-123/")
     → isGitRepo = true  # Created with git init
     → hasUncommittedChanges = false  # Fresh repo
     → activeTasksInDir = 0
     → tier = SAFE

  5. executeTask(sandbox=false)
     → createWorktree()
       → Error: "Git repository has no commits"
       → Worktree creation requires at least one commit

     → Fallback: Execute directly (no worktree)
       → Agent creates files
       → Agent commits initial work
       → Future tasks can use worktrees
```

**User sees:**
- Clean new project directory created
- First task executes without worktree
- Subsequent tasks use worktrees normally

---

## CLI Flag Impact

### Default Mode (No Flags)
```bash
npx @astro/agent start
```
- All safety checks active
- Prompts for RISKY operations
- Blocks UNSAFE operations
- Uses worktrees for git repos

### --allow-non-git Flag
```bash
npx @astro/agent start --allow-non-git
```
- Skips RISKY prompts
- Still tracks parallel tasks
- Still blocks UNSAFE operations
- **Warning**: No user confirmation for non-git directories!

### --sandbox Flag
```bash
npx @astro/agent start --sandbox
```
- Forces sandbox mode for ALL tasks
- Ignores safety tier (always safe)
- Requires directory size < maxSandboxSize
- Original files never touched

### --max-sandbox-size Flag
```bash
npx @astro/agent start --sandbox --max-sandbox-size 500
```
- Increases sandbox size limit to 500MB
- Only applies when --sandbox is set
- Useful for larger projects

### Combined Flags
```bash
npx @astro/agent start --sandbox --max-sandbox-size 500 --preserve-worktrees
```
- Sandbox mode (isolated execution)
- 500MB size limit
- Preserves worktrees after completion (for debugging)

---

## Special Cases

### Case 1: Directory Becomes Git Mid-Execution
```yaml
Initial State:
  /project → no git (RISKY tier)

During Execution:
  User runs: git init

Current Behavior:
  Task continues in non-git mode (decision already made)

Future Behavior (potential enhancement):
  Re-check git status periodically
  Upgrade to SAFE tier mid-execution
```

### Case 2: Sandbox + Git Repo
```yaml
Input:
  workingDirectory: /Users/alice/git-project  # Has .git
  useSandbox: true

Flow:
  1. Safety check: SAFE tier (git repo)
  2. But sandbox flag set → Force sandbox anyway
  3. createSandbox() skips .git folder
  4. Sandbox has NO .git → works as plain directory
  5. Execute in sandbox

Result:
  Even git repos can use sandbox for extra isolation
```

### Case 3: Git URL + Sandbox
```yaml
Input:
  workingDirectory: https://github.com/user/repo.git
  useSandbox: true

Flow:
  1. Clone to ~/.astro/repos/proj-123/
  2. Copy to ~/.astro/sandbox/taskId/ (excluding .git)
  3. Execute in sandbox

Result:
  Repo is cloned but execution happens in sandbox copy
```

### Case 4: Multiple Tasks, Different Directories
```yaml
Task 1:
  workingDirectory: /Users/alice/project-a
  → Executes normally

Task 2:
  workingDirectory: /Users/alice/project-b
  → Executes normally (different dir)

Parallel Tracking:
  tasksByDirectory["/Users/alice/project-a"] = { task1 }
  tasksByDirectory["/Users/alice/project-b"] = { task2 }

Result: Both allowed (different directories)
```

### Case 5: Multiple Tasks, Same Git Repo
```yaml
Task 1:
  workingDirectory: /Users/alice/git-project
  → Creates worktree: ~/.astro/worktrees/git-project/task1/

Task 2:
  workingDirectory: /Users/alice/git-project
  → Creates worktree: ~/.astro/worktrees/git-project/task2/

Result:
  Both allowed (git handles conflicts via separate worktrees)
  Each task works on separate branch
```

---

## Summary Table

| Workflow | Input | Git | Uncommitted | Parallel | Sandbox | User Action | Execution |
|----------|-------|-----|-------------|----------|---------|-------------|-----------|
| A | Path | ✅ | ❌ | ❌ | ❌ | None | Worktree |
| B | Path | ✅ | ✅ | ❌ | ❌ | Warning | Worktree |
| C | Path | ❌ | N/A | ❌ | ❌ | Choose option | Direct or Init |
| D | Path | ❌ | N/A | ✅ | ❌ | Task blocked | None |
| E | Any | Any | Any | ❌ | ✅ | None or Choose | Sandbox |
| F | Git URL | ✅ | ❌ | ❌ | ❌ | None | Clone → Worktree |
| G | Empty | ✅ | ❌ | ❌ | ❌ | None | Direct (no commits) |

---

## Key Takeaways

1. **Git repos are always safe** (unless uncommitted changes)
2. **Non-git dirs require user decision** (unless --allow-non-git)
3. **Parallel tasks blocked in non-git** (prevents file conflicts)
4. **Sandbox mode works everywhere** (ultimate safety)
5. **Git URLs auto-clone** (then treated as local git repo)
6. **Empty projects auto-created with git** (safe by default)

