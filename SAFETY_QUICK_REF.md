# Safety System - Quick Reference Card

## 🎯 The 4 Safety Tiers

| Tier | Icon | Git? | Uncommitted? | Parallel? | Action | User Prompt? |
|------|------|------|--------------|-----------|--------|--------------|
| **SAFE** | ✅ | Yes | No | - | Execute immediately | ❌ No |
| **GUARDED** | ⚠️ | Yes | Yes | - | Warn + Execute | ❌ No |
| **RISKY** | ⚠️⚠️ | No | - | No | Prompt for choice | ✅ Yes |
| **UNSAFE** | 🛑 | No | - | Yes | Block execution | ❌ No |

## 📋 Directory Resolution

| Input | Example | Resolves To | Notes |
|-------|---------|-------------|-------|
| Git URL | `https://github.com/user/repo` | `~/.astro/repos/<projectId>/` | Auto-clones |
| Absolute path | `/Users/alice/project` | `/Users/alice/project` | Uses as-is |
| Relative path | `./my-folder` | `<cwd>/my-folder` | Resolved to absolute |
| Empty/null | `undefined` | `process.cwd()` | Current working dir |

## 🔧 CLI Flags

| Flag | Effect | Risk Level | Use Case |
|------|--------|------------|----------|
| `--allow-non-git` | Skip RISKY prompts | ⚠️ Medium | CI/CD automation |
| `--sandbox` | Force sandbox mode | ✅ Safe | Experimentation |
| `--max-sandbox-size <mb>` | Set size limit | ✅ Safe | Large projects |
| None (default) | All safety checks | ✅ Safe | Normal use |

## 🎬 User Decision Options (RISKY Tier)

When non-git directory detected:

| Option | What Happens | Safety | Use When |
|--------|--------------|--------|----------|
| **1. Continue anyway** | Execute directly in folder | 🔴 Risky | You trust the task |
| **2. Initialize git** | Run `git init`, then execute | 🟢 Safe | Want version control |
| **3. Use sandbox** | Execute in isolated copy | 🟢 Safe | Want to review first |
| **4. Cancel** | Task doesn't run | 🟢 Safe | Changed your mind |

## 🏃 Execution Modes

### Normal Mode (Git Repo)
```
Working Directory → Create Worktree → Execute → PR → Cleanup
```
- Uses git worktree
- Changes on separate branch
- Can create PR

### Normal Mode (No Git)
```
Working Directory → Execute Directly → No Rollback
```
- ⚠️ Changes are permanent
- No version control
- No undo capability

### Sandbox Mode (Any)
```
Original → Copy to Sandbox → Execute → Review → Apply or Discard
```
- Original files untouched
- Safe experimentation
- Optional apply back

## 📊 Parallel Execution Rules

| Scenario | Allowed? | Reason |
|----------|----------|--------|
| 2+ tasks, **same git repo** | ✅ Yes | Separate worktrees/branches |
| 2+ tasks, **different dirs** | ✅ Yes | No conflict possible |
| 2+ tasks, **same non-git dir** | 🛑 No | File conflicts guaranteed |

## 🔍 Git Detection

Checks in order:
1. `.git/` directory exists?
2. `git rev-parse --git-dir` succeeds?
3. Has at least one commit?

If any fails → **Not a git repo**

## 📦 Sandbox Process

```
1. Check size (exclude: node_modules, .git, venv, etc.)
2. Size < limit? → Continue
3. Copy to ~/.astro/sandbox/<taskId>/
4. Execute in sandbox
5. Cleanup or copyBack()
```

**Size Calculation Excludes:**
- `node_modules/`
- `.git/`
- `venv/`, `.venv/`
- `build/`, `dist/`, `.next/`
- `__pycache__/`

## 🚨 Common Scenarios

### ✅ Scenario: Clean git repo
```bash
cd ~/my-project  # Has .git, clean state
# → SAFE tier
# → Executes immediately
# → Uses worktree
```

### ⚠️ Scenario: Uncommitted changes
```bash
cd ~/my-project  # Has .git
echo "test" >> file.txt  # Uncommitted change
# → GUARDED tier
# → Shows warning
# → Executes anyway
```

### ⚠️⚠️ Scenario: No git
```bash
cd ~/no-git-folder  # No .git
# → RISKY tier
# → User prompt appears
# → User chooses option 1-4
```

### 🛑 Scenario: Parallel in non-git
```bash
# Terminal 1:
cd ~/no-git && run task-1  # Running
# Terminal 2:
cd ~/no-git && run task-2  # Blocked!
# → UNSAFE tier
# → Task 2 fails immediately
```

### 📦 Scenario: Sandbox mode
```bash
npx @astro/agent start --sandbox
# → ALL tasks use sandbox
# → Original files safe
# → Review before applying
```

## 💡 Pro Tips

### Tip 1: Always Use Git
```bash
# Make any folder safe:
git init
git add .
git commit -m "Before AI"
# → Now SAFE tier
```

### Tip 2: Sandbox for Experiments
```bash
# Try risky changes safely:
npx @astro/agent start --sandbox --max-sandbox-size 500
# → Work on copy
# → Discard if bad
```

### Tip 3: Commit Before Running
```bash
# Protect uncommitted work:
git status  # Check state
git add . && git commit -m "Checkpoint"
# → GUARDED → SAFE
```

### Tip 4: Automation Mode
```bash
# CI/CD pipelines:
npx @astro/agent start --allow-non-git
# → No prompts
# → Faster execution
# → ⚠️ Use only in controlled environments
```

## 🐛 Troubleshooting

### "Directory too large for sandbox"
```bash
# Problem:
Directory size (500MB) exceeds limit (100MB)

# Solution:
npx @astro/agent start --sandbox --max-sandbox-size 600
```

### "Parallel execution blocked"
```bash
# Problem:
Multiple tasks in same non-git directory

# Solutions:
1. Wait: Let first task finish
2. Git: git init && git add . && git commit -m "Initial"
3. Different dir: Use separate folders
4. Sandbox: npx @astro/agent start --sandbox
```

### "Git not available"
```bash
# Problem:
Git command not found

# Solution:
brew install git     # macOS
apt install git      # Ubuntu
```

### "Not a git repository"
```bash
# Problem:
Directory has no .git folder

# Solution:
git init
git add .
git commit -m "Initial commit"
```

## 📝 Safety Checklist

Before running tasks:

- [ ] Is this a git repository?
- [ ] Are there uncommitted changes?
- [ ] Is another task running in this directory?
- [ ] Do I need sandbox mode for safety?
- [ ] Have I set appropriate CLI flags?

After running tasks:

- [ ] Review changes: `git diff`
- [ ] Check for unexpected modifications
- [ ] Commit if satisfied: `git add . && git commit -m "AI changes"`
- [ ] Create PR if needed

## 🎓 Learning Path

**Beginner:**
1. Always work in git repos (SAFE)
2. Commit before running tasks (avoid GUARDED)
3. Use default settings (no flags)

**Intermediate:**
4. Try sandbox mode (`--sandbox`)
5. Understand the 4 tiers
6. Handle RISKY prompts wisely

**Advanced:**
7. Use `--allow-non-git` for automation
8. Configure `--max-sandbox-size`
9. Manage parallel executions
10. Combine flags strategically

## 📞 Quick Decision Guide

**"Should I run this task?"**

```
Is it a git repo?
├─ Yes → Clean state?
│  ├─ Yes → ✅ GO (SAFE)
│  └─ No → ⚠️ COMMIT FIRST (becomes SAFE)
└─ No → Other tasks here?
   ├─ Yes → 🛑 WAIT OR MOVE (UNSAFE)
   └─ No → Make it safe:
      ├─ Run: git init (RISKY → SAFE)
      ├─ Use: --sandbox flag (RISKY → SAFE)
      └─ Or: Accept risk (RISKY → user choice)
```

---

**Remember:** When in doubt, use git + sandbox for maximum safety! 🛡️

