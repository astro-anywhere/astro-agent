/**
 * Tests for WORKSPACE_V2.md section 13 scenarios:
 *
 * 1. Two projects sharing the same git directory (worktrees don't interfere)
 * 2. Two projects sharing the same non-git directory (copy worktrees don't interfere)
 * 3. CLAUDE.md from project root accessible in worktree (untracked)
 * 4. CLAUDE.md already tracked by git (appears automatically in worktree)
 * 5. ensureClaudeMdInWorktree when no CLAUDE.md exists (no-op)
 * 6. Git + no remote -> branch-only delivery
 * 7. Git + generic remote (local bare path) -> branch delivery
 *
 * These tests use REAL git repos in temporary directories. Only the
 * worktree-include and worktree-setup modules are mocked because they
 * depend on astro config files that won't exist in the test repos.
 */

import { describe, it, expect, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mock worktree-include and worktree-setup (they depend on project-specific
// config files that won't exist in our ephemeral test repos).
// ---------------------------------------------------------------------------
vi.mock('../src/lib/worktree-include.js', () => ({
  applyWorktreeInclude: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/lib/worktree-setup.js', () => ({
  runSetupScript: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------
import {
  createWorktree,
  ensureClaudeMdInWorktree,
} from '../src/lib/worktree.js'
import { createCopyWorktree } from '../src/lib/copy-worktree.js'
import { ensureAgentDir } from '../../server/lib/repo-setup.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Directories created during tests -- cleaned up in afterAll. */
const tmpDirs: string[] = []

/**
 * Create a real git repository with:
 *  - one initial commit containing `hello.txt`
 *  - a bare remote set as `origin`
 *  - `main` branch pushed to origin
 */
function createTestGitRepo(): { repoDir: string; bareDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), 'astro-shared-test-repo-'))
  const bareDir = mkdtempSync(join(tmpdir(), 'astro-shared-test-bare-'))
  tmpDirs.push(repoDir, bareDir)

  execFileSync('git', ['init', '--bare'], { cwd: bareDir })
  execFileSync('git', ['init'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], {
    cwd: repoDir,
  })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir })
  execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir })

  writeFileSync(join(repoDir, 'hello.txt'), 'hello world\n')
  execFileSync('git', ['add', '.'], { cwd: repoDir })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir })

  return { repoDir, bareDir }
}

/**
 * Create a real git repository with NO remote.
 */
function createTestGitRepoNoRemote(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'astro-noremote-test-'))
  tmpDirs.push(repoDir)

  execFileSync('git', ['init'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], {
    cwd: repoDir,
  })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir })

  writeFileSync(join(repoDir, 'hello.txt'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repoDir })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir })

  return repoDir
}

// ---------------------------------------------------------------------------
// Cleanup all temp dirs after the suite
// ---------------------------------------------------------------------------
afterAll(async () => {
  for (const dir of tmpDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

// ===========================================================================
// Test suites
// ===========================================================================

describe(
  'Two projects sharing the same git directory',
  { timeout: 30_000 },
  () => {
    it('both create worktrees and they do not interfere', async () => {
      const { repoDir } = createTestGitRepo()

      // Project A creates a worktree
      const resultA = await createWorktree({
        workingDirectory: repoDir,
        taskId: 'project-a-task',
      })

      // Project B creates a worktree in the SAME repo
      const resultB = await createWorktree({
        workingDirectory: repoDir,
        taskId: 'project-b-task',
      })

      expect(resultA).not.toBeNull()
      expect(resultB).not.toBeNull()

      const setupA = resultA!
      const setupB = resultB!

      // Worktree paths must be different
      expect(setupA.workingDirectory).not.toBe(setupB.workingDirectory)

      // Both directories must exist
      expect(existsSync(setupA.workingDirectory)).toBe(true)
      expect(existsSync(setupB.workingDirectory)).toBe(true)

      // Both must contain the committed file
      expect(
        existsSync(join(setupA.workingDirectory, 'hello.txt')),
      ).toBe(true)
      expect(
        existsSync(join(setupB.workingDirectory, 'hello.txt')),
      ).toBe(true)

      // Branch names must be different
      expect(setupA.branchName).not.toBe(setupB.branchName)
      expect(setupA.branchName).toBe('astro/project-a-task')
      expect(setupB.branchName).toBe('astro/project-b-task')

      // Cleanup both worktrees
      await setupA.cleanup()
      await setupB.cleanup()

      expect(existsSync(setupA.workingDirectory)).toBe(false)
      expect(existsSync(setupB.workingDirectory)).toBe(false)
    })
  },
)

describe(
  'Two projects sharing the same non-git directory',
  { timeout: 30_000 },
  () => {
    it('both create copy worktrees and they do not interfere', async () => {
      // Create a plain (non-git) project directory with some files
      const projectDir = mkdtempSync(
        join(tmpdir(), 'astro-shared-nongit-'),
      )
      tmpDirs.push(projectDir)

      writeFileSync(join(projectDir, 'data.csv'), 'a,b,c\n1,2,3\n')
      mkdirSync(join(projectDir, 'src'))
      writeFileSync(join(projectDir, 'src', 'main.py'), 'print("hello")\n')

      // Project A creates a copy worktree
      const resultA = await createCopyWorktree(
        projectDir,
        '.astro',
        'proj-a-task',
      )

      // Project B creates a copy worktree in the SAME directory
      const resultB = await createCopyWorktree(
        projectDir,
        '.astro',
        'proj-b-task',
      )

      // Paths must be different
      expect(resultA.worktreePath).not.toBe(resultB.worktreePath)

      // Both directories must exist
      expect(existsSync(resultA.worktreePath)).toBe(true)
      expect(existsSync(resultB.worktreePath)).toBe(true)

      // Both must contain the project files
      expect(
        existsSync(join(resultA.worktreePath, 'data.csv')),
      ).toBe(true)
      expect(
        existsSync(join(resultA.worktreePath, 'src', 'main.py')),
      ).toBe(true)
      expect(
        existsSync(join(resultB.worktreePath, 'data.csv')),
      ).toBe(true)
      expect(
        existsSync(join(resultB.worktreePath, 'src', 'main.py')),
      ).toBe(true)

      // Content must match
      expect(readFileSync(join(resultA.worktreePath, 'data.csv'), 'utf-8')).toBe(
        'a,b,c\n1,2,3\n',
      )
      expect(readFileSync(join(resultB.worktreePath, 'src', 'main.py'), 'utf-8')).toBe(
        'print("hello")\n',
      )

      // Cleanup both
      await resultA.cleanup()
      await resultB.cleanup()

      expect(existsSync(resultA.worktreePath)).toBe(false)
      expect(existsSync(resultB.worktreePath)).toBe(false)
    })
  },
)

describe(
  'CLAUDE.md in worktree (untracked)',
  { timeout: 30_000 },
  () => {
    it('copies untracked CLAUDE.md into the worktree', async () => {
      const { repoDir } = createTestGitRepo()

      // Create CLAUDE.md in the repo root but do NOT git add it
      writeFileSync(
        join(repoDir, 'CLAUDE.md'),
        '# Project Instructions\nDo great things.\n',
      )

      const result = await createWorktree({
        workingDirectory: repoDir,
        taskId: 'claude-md-untracked-task',
      })

      expect(result).not.toBeNull()
      const setup = result!

      // CLAUDE.md should exist in the worktree (copied by ensureClaudeMdInWorktree)
      const claudeMdPath = join(setup.workingDirectory, 'CLAUDE.md')
      expect(existsSync(claudeMdPath)).toBe(true)
      expect(readFileSync(claudeMdPath, 'utf-8')).toBe(
        '# Project Instructions\nDo great things.\n',
      )

      await setup.cleanup()
    })
  },
)

describe(
  'CLAUDE.md in worktree (tracked)',
  { timeout: 30_000 },
  () => {
    it('tracked CLAUDE.md appears automatically in the worktree', async () => {
      const { repoDir } = createTestGitRepo()

      // Create CLAUDE.md, git add, and commit it
      writeFileSync(
        join(repoDir, 'CLAUDE.md'),
        '# Tracked Instructions\nThis is tracked.\n',
      )
      execFileSync('git', ['add', 'CLAUDE.md'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Add CLAUDE.md'], {
        cwd: repoDir,
      })
      execFileSync('git', ['push', 'origin', 'main'], { cwd: repoDir })

      const result = await createWorktree({
        workingDirectory: repoDir,
        taskId: 'claude-md-tracked-task',
      })

      expect(result).not.toBeNull()
      const setup = result!

      // CLAUDE.md should be present (tracked by git, so it's in the worktree automatically)
      const claudeMdPath = join(setup.workingDirectory, 'CLAUDE.md')
      expect(existsSync(claudeMdPath)).toBe(true)
      expect(readFileSync(claudeMdPath, 'utf-8')).toBe(
        '# Tracked Instructions\nThis is tracked.\n',
      )

      await setup.cleanup()
    })
  },
)

describe(
  'ensureClaudeMdInWorktree edge cases',
  { timeout: 30_000 },
  () => {
    it('does nothing when no CLAUDE.md exists in the source repo', async () => {
      const { repoDir } = createTestGitRepo()

      // Create a dummy worktree directory (simulate an existing worktree)
      const dummyWorktree = mkdtempSync(
        join(tmpdir(), 'astro-dummy-wt-'),
      )
      tmpDirs.push(dummyWorktree)

      // Ensure there is no CLAUDE.md in the repo
      expect(existsSync(join(repoDir, 'CLAUDE.md'))).toBe(false)

      // Should not throw
      await ensureClaudeMdInWorktree(repoDir, dummyWorktree)

      // Should not create CLAUDE.md in the worktree
      expect(existsSync(join(dummyWorktree, 'CLAUDE.md'))).toBe(false)
    })
  },
)

describe(
  'Git remote variants: no remote -> branch-only delivery',
  { timeout: 30_000 },
  () => {
    it('produces remoteType=none and deliveryMode=branch when there is no remote', () => {
      const repoDir = createTestGitRepoNoRemote()

      // ensureAgentDir writes config.json with auto-detected settings
      ensureAgentDir(repoDir)

      const configPath = join(repoDir, '.astro', 'config.json')
      expect(existsSync(configPath)).toBe(true)

      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(config.remoteType).toBe('none')
      expect(config.deliveryMode).toBe('branch')
    })
  },
)

describe(
  'Git remote variants: local bare remote -> branch delivery',
  { timeout: 30_000 },
  () => {
    it('produces deliveryMode=branch for a local bare path remote (not a URL)', () => {
      const { repoDir } = createTestGitRepo()

      // The remote "origin" points to a local bare directory path (not a URL).
      // detectRemoteType will see a local path (not starting with git@, http, or ssh://)
      // and return 'none', so deliveryMode should be 'branch'.
      ensureAgentDir(repoDir)

      const configPath = join(repoDir, '.astro', 'config.json')
      expect(existsSync(configPath)).toBe(true)

      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      // A local bare path doesn't match any URL pattern, so remoteType is 'none'
      expect(config.remoteType).toBe('none')
      expect(config.deliveryMode).toBe('branch')
      expect(config.baseBranch).toBe('main')
      expect(config.branchPrefix).toBe('astro/')
    })
  },
)
