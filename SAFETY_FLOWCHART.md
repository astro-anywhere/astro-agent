# Safety System - Visual Flowchart

## Main Decision Flow

```
                           ┌─────────────────────┐
                           │   Task Received     │
                           └──────────┬──────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────┐
                    │  Resolve Working Directory      │
                    │                                 │
                    │  • Git URL? → Clone it          │
                    │  • Path given? → Use it         │
                    │  • Empty? → Use cwd             │
                    └──────────┬──────────────────────┘
                               │
                               ▼
                    ┌─────────────────────────────────┐
                    │     CLI Flags Check              │
                    └──────────┬──────────────────────┘
                               │
                ┌──────────────┼──────────────┐
                │              │              │
                ▼              ▼              ▼
         --allow-non-git?  --sandbox?    (default)
                │              │              │
                │              │              │
                ▼              │              ▼
          Skip prompts         │        ┌──────────────┐
          (risky!)             │        │ Safety Check │
                │              │        └──────┬───────┘
                │              │               │
                │              │         ┌─────┴─────┐
                │              │         │           │
                │              │         ▼           ▼
                │              │     Is Git?      Is Git?
                │              │      YES          NO
                │              │         │           │
                └──────────────┼─────────┤           │
                               │         │           │
                               │         ▼           ▼
                               │   Uncommitted?  Parallel?
                               │    /      \      /      \
                               │  YES      NO   YES      NO
                               │   │        │    │        │
                               │   ▼        ▼    ▼        ▼
                               │ GUARDED  SAFE UNSAFE  RISKY
                               │   │        │    │        │
                               │   │        │    │        │
                               └───┼────────┼────┼────────┤
                                   │        │    │        │
                                   ▼        │    │        ▼
                              ┌─────────┐   │    │   ┌──────────┐
                              │  Warn   │   │    │   │  Prompt  │
                              │Execute  │   │    │   │   User   │
                              └────┬────┘   │    │   └────┬─────┘
                                   │        │    │        │
                                   │        │    │        ▼
                                   │        │    │   ┌──────────┐
                                   │        │    │   │ Decision │
                                   │        │    │   └────┬─────┘
                                   │        │    │        │
                                   │        │    │   ┌────┴─────┬────────┬────────┐
                                   │        │    │   │          │        │        │
                                   │        │    │   ▼          ▼        ▼        ▼
                                   │        │    │ Continue  Init Git Sandbox  Cancel
                                   │        │    │   │          │        │        │
                                   │        │    │   │          │        │        ▼
                                   │        │    │   │          │        │      Exit
                                   │        │    │   │          │        │
                                   │        │    │   │          ▼        │
                                   │        │    │   │      ┌────────┐   │
                                   │        │    │   │      │git init│   │
                                   │        │    │   │      └───┬────┘   │
                                   │        │    │   │          │        │
                                   ├────────┼────┼───┴──────────┘        │
                                   │        │    │                       │
                                   │        │    ▼                       ▼
                                   │        │  Block                 Sandbox
                                   │        │  Exit                   Mode
                                   │        │                           │
                                   ├────────┴───────────────────────────┤
                                   │                                    │
                                   ▼                                    ▼
                        ┌──────────────────────┐        ┌──────────────────────┐
                        │   Normal Execution   │        │  Sandbox Execution   │
                        │                      │        │                      │
                        │  • Git? Worktree     │        │  • Copy to sandbox   │
                        │  • No Git? Direct    │        │  • Execute isolated  │
                        │  • Track directory   │        │  • Cleanup/copyback  │
                        └──────────┬───────────┘        └──────────┬───────────┘
                                   │                               │
                                   └───────────┬───────────────────┘
                                               │
                                               ▼
                                    ┌─────────────────────┐
                                    │  Untrack Directory  │
                                    └─────────────────────┘
```

## Safety Tier Details

```
┌────────────────────────────────────────────────────────────────┐
│                          SAFE ✅                                │
├────────────────────────────────────────────────────────────────┤
│  Conditions:                                                    │
│    ✓ Git repository exists                                     │
│    ✓ Has at least one commit                                   │
│    ✓ Working tree is clean (no uncommitted changes)            │
│                                                                 │
│  Action: Execute immediately in git worktree                   │
│                                                                 │
│  User Experience:                                               │
│    • No prompts                                                │
│    • Task starts right away                                    │
│    • All changes on separate branch                            │
│    • Optional PR creation                                      │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│                        GUARDED ⚠️                               │
├────────────────────────────────────────────────────────────────┤
│  Conditions:                                                    │
│    ✓ Git repository exists                                     │
│    ⚠ Has uncommitted changes                                   │
│                                                                 │
│  Action: Warn user, then execute                               │
│                                                                 │
│  Warning:                                                       │
│    ┌────────────────────────────────────────────┐              │
│    │ ⚠️  UNCOMMITTED CHANGES DETECTED           │              │
│    │                                             │              │
│    │ The agent may modify, stage, or commit     │              │
│    │ these changes.                             │              │
│    │                                             │              │
│    │ Recommendation: Commit or stash first.     │              │
│    └────────────────────────────────────────────┘              │
│                                                                 │
│  User Experience:                                               │
│    • Warning shown                                             │
│    • Task executes automatically (not blocked)                 │
│    • User should review changes carefully                      │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│                         RISKY ⚠️⚠️                              │
├────────────────────────────────────────────────────────────────┤
│  Conditions:                                                    │
│    ✗ Not a git repository                                      │
│    ✓ No other tasks running in this directory                  │
│                                                                 │
│  Action: Prompt user for decision                              │
│                                                                 │
│  Prompt:                                                        │
│    ┌────────────────────────────────────────────┐              │
│    │ ⚠️  NO GIT REPOSITORY DETECTED             │              │
│    │                                             │              │
│    │ AI agents may modify or delete files       │              │
│    │ without version control.                   │              │
│    │                                             │              │
│    │ Options:                                    │              │
│    │  1. Continue anyway (risky)                │              │
│    │  2. Initialize git first                   │              │
│    │  3. Use sandbox mode                       │              │
│    │  4. Cancel task                            │              │
│    └────────────────────────────────────────────┘              │
│                                                                 │
│  User Experience:                                               │
│    • Task pauses                                               │
│    • User must choose                                          │
│    • 60 second timeout                                         │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│                        UNSAFE 🛑                                │
├────────────────────────────────────────────────────────────────┤
│  Conditions:                                                    │
│    ✗ Not a git repository                                      │
│    ✗ Other task(s) already running in this directory           │
│                                                                 │
│  Action: Block execution immediately                           │
│                                                                 │
│  Error:                                                         │
│    ┌────────────────────────────────────────────┐              │
│    │ 🛑 PARALLEL EXECUTION BLOCKED               │              │
│    │                                             │              │
│    │ Multiple agents cannot run in the same     │              │
│    │ non-git directory. This would cause file   │              │
│    │ conflicts and potential data loss.         │              │
│    │                                             │              │
│    │ Active tasks: 1                            │              │
│    │                                             │              │
│    │ Solutions:                                  │              │
│    │  • Wait for other tasks to complete        │              │
│    │  • Initialize git                          │              │
│    │  • Use different directory                 │              │
│    │  • Enable --sandbox mode                   │              │
│    └────────────────────────────────────────────┘              │
│                                                                 │
│  User Experience:                                               │
│    • Task fails immediately                                    │
│    • No execution occurs                                       │
│    • Error logged                                              │
└────────────────────────────────────────────────────────────────┘
```

## Directory Resolution Flow

```
                    Task.workingDirectory
                            │
                ┌───────────┼───────────┐
                │           │           │
                ▼           ▼           ▼
         Git URL?      Path given?   Empty?
         (https://)    (exists?)      (null)
                │           │           │
                ▼           │           ▼
         ┌──────────┐       │      process.cwd()
         │  Clone   │       │           │
         │   to     │       │           │
         │ ~/.astro/│       │           │
         │   repos/ │       │           │
         │ projectId│       │           │
         └────┬─────┘       │           │
              │             │           │
              ▼             ▼           ▼
         ~/.astro/     As specified    Current
         repos/        /path/to/dir    working
         proj-123/                     directory
              │             │           │
              └─────────────┼───────────┘
                            │
                            ▼
                    Resolved Path
                            │
                            ▼
                    Safety Check
```

## Sandbox Flow

```
              Sandbox Mode Triggered
                       │
                       ▼
         ┌─────────────────────────┐
         │  Calculate Dir Size     │
         │  (exclude large dirs)   │
         └────────┬────────────────┘
                  │
        ┌─────────┴─────────┐
        │                   │
        ▼                   ▼
    Size OK?            Too Large?
    (< limit)           (> limit)
        │                   │
        ▼                   ▼
    Continue           Error:
        │              "Directory too
        │              large, increase
        ▼              --max-sandbox-size"
┌──────────────────┐         │
│  Copy Directory  │         ▼
│                  │       Exit
│  From: workdir   │
│  To: ~/.astro/   │
│      sandbox/    │
│      taskId/     │
│                  │
│  Exclude:        │
│    node_modules  │
│    .git          │
│    venv          │
│    build         │
│    dist          │
│    __pycache__   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Execute Task    │
│  in Sandbox      │
│                  │
│  workdir =       │
│  ~/.astro/       │
│  sandbox/taskId/ │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Completion      │
└────────┬─────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
Cleanup    Copy Back?
(delete)   (optional)
    │         │
    │         ▼
    │    ┌─────────────┐
    │    │ rsync back  │
    │    │ to original │
    │    │ (user conf) │
    │    └──────┬──────┘
    │           │
    └───────────┴──────► End
```

## Parallel Execution Tracking

```
                    Task 1 Starts
                         │
                         ▼
              ┌──────────────────────┐
              │  Track Directory     │
              │                      │
              │  tasksByDirectory[   │
              │    "/path/to/dir"    │
              │  ] = { "task-1" }    │
              └──────────┬───────────┘
                         │
                         ▼
                    Task 1 Running
                         │
                         │     Task 2 Starts
                         │          │
                         │          ▼
                         │    Same Directory?
                         │          │
                    ┌────┴────┬─────┴─────┐
                    │         │           │
                    ▼         ▼           ▼
                  SAME     DIFFERENT    SAME
                  + Git    (any type)   + No Git
                    │         │           │
                    ▼         ▼           ▼
                 ALLOWED   ALLOWED     BLOCKED
                    │         │           │
                    ▼         ▼           ▼
            Create Worktree  Track    Send Error
            (branch-2)     Separate   Exit Task
                    │       Entry
                    │         │
                    └────┬────┘
                         │
                         ▼
              Both Tasks Running
                         │
                  ┌──────┴──────┐
                  │             │
             Task 1 Done   Task 2 Done
                  │             │
                  ▼             ▼
              Untrack       Untrack
                  │             │
                  └──────┬──────┘
                         │
                         ▼
              tasksByDirectory[
                "/path/to/dir"
              ] = {}  (empty)
```

## CLI Flags Impact

```
               Start Command
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
   (no flags)  --allow-non-git  --sandbox
        │            │            │
        ▼            ▼            ▼
    ┌─────────┐  ┌──────────┐  ┌──────────┐
    │ Normal  │  │  Risky   │  │  Force   │
    │ Safety  │  │  Mode    │  │  Sandbox │
    │ Checks  │  │          │  │          │
    └────┬────┘  └────┬─────┘  └────┬─────┘
         │            │             │
         ▼            ▼             ▼
    All tiers   Skip RISKY     All tasks
    active      prompts        in sandbox
         │            │             │
         │            ▼             │
         │      Still blocks        │
         │      UNSAFE tier         │
         │            │             │
         └────────────┴─────────────┘
                      │
                      ▼
                 Task Execution
```

## Complete Example Flows

### Example 1: First-Time Git Repo

```
User creates new project:
  $ mkdir ~/my-app
  $ cd ~/my-app
  $ git init
  $ touch README.md
  $ git add .
  $ git commit -m "Initial"

Task dispatched:
  workingDirectory: "/Users/alice/my-app"

Flow:
  1. resolveWorkingDirectory() → "/Users/alice/my-app"
  2. isGitRepo() → true ✅
  3. hasUncommittedChanges() → false ✅
  4. activeTasksInDir → 0 ✅
  5. tier = SAFE
  6. trackTaskDirectory()
  7. createWorktree() → ~/.astro/worktrees/my-app/task-123/
  8. Execute in worktree
  9. Cleanup
  10. untrackTaskDirectory()

Result: ✅ Executes smoothly
```

### Example 2: Non-Git with User Choice

```
User has existing folder:
  $ ls ~/old-project
  file1.txt  file2.txt  data/

Task dispatched:
  workingDirectory: "/Users/alice/old-project"

Flow:
  1. resolveWorkingDirectory() → "/Users/alice/old-project"
  2. isGitRepo() → false ❌
  3. activeTasksInDir → 0
  4. tier = RISKY
  5. sendSafetyPrompt() → UI shows options
  6. User chooses: "Initialize git"
  7. initializeGit():
     - git init
     - git add .
     - git commit -m "Initial"
  8. trackTaskDirectory()
  9. createWorktree() → Now works! (git exists)
  10. Execute in worktree
  11. Cleanup
  12. untrackTaskDirectory()

Result: ✅ User made it safe
```

### Example 3: Parallel Block

```
Task 1 running:
  workingDirectory: "/tmp/no-git"
  tier: RISKY (user chose "Continue anyway")
  tasksByDirectory["/tmp/no-git"] = { "task-1" }

Task 2 dispatched:
  workingDirectory: "/tmp/no-git"

Flow:
  1. resolveWorkingDirectory() → "/tmp/no-git"
  2. isGitRepo() → false ❌
  3. activeTasksInDir → 1 ❌
  4. tier = UNSAFE
  5. sendTaskResult(status='failed', error='BLOCKED')
  6. Exit

Result: 🛑 Task 2 blocked
```

