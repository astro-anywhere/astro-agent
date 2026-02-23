/**
 * Working directory pipeline tests
 *
 * Verifies that workingDirectory is correctly preserved through the full
 * project creation pipeline:
 *
 *   1. Agent-runner localRepoSetup() — handles non-existent, non-git, and git dirs
 *   2. Server setupProjectRepo() — creates dirs, detects git, returns source info
 *   3. Dispatch schema — workingDirectory field passes validation and propagates
 *   4. Task type — workingDirectory is present on the final Task object
 *
 * These are CLI-only unit tests: no running server, no browser, real tmp dirs.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Agent-runner repo utilities ─────────────────────────────────────────
import {
  localRepoSetup,
  isGitRepo,
  getFileTree,
  getGitRemoteUrl,
} from '../src/lib/repo-utils.js'

// ── Server repo setup ───────────────────────────────────────────────────
import { setupProjectRepo } from '../../server/lib/repo-setup.js'

// ── Agent-runner Task type ──────────────────────────────────────────────
import type { Task } from '../src/types.js'

// ── Dispatch schema (reproduced from server/routes/dispatch.ts) ─────────
const dispatchTaskSchema = z.object({
  nodeId: z.string().min(1).max(100),
  projectId: z.string().min(1).max(100),
  title: z.string().min(1).max(1000),
  description: z.string().min(1).max(50000),
  workingDirectory: z.string().max(1000).refine(
    (path) => !path.includes('..'),
    { message: 'Path traversal not allowed' },
  ).optional(),
  deliveryMode: z.enum(['pr', 'push', 'branch', 'copy', 'direct']).optional(),
  worktreeStrategy: z.enum(['copy', 'reference', 'direct']).optional(),
  remoteType: z.enum(['github', 'gitlab', 'bitbucket', 'generic', 'none']).optional(),
  agentDir: z.string().max(100).optional(),
})

// ── Temp directory tracking ─────────────────────────────────────────────
const tmpDirs: string[] = []

afterAll(async () => {
  for (const dir of tmpDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch { /* best-effort cleanup */ }
  }
})

/** Create a temp directory and track it for cleanup. */
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `astro-workdir-${prefix}-`))
  tmpDirs.push(dir)
  return dir
}

/** Create a temp git repo with an initial commit. */
function createTestGitRepo(opts?: { withRemote?: boolean; withFiles?: Record<string, string> }): {
  repoDir: string
  bareDir?: string
} {
  const repoDir = makeTmpDir('repo')

  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' })

  // Write extra files if requested
  if (opts?.withFiles) {
    for (const [name, content] of Object.entries(opts.withFiles)) {
      const filePath = join(repoDir, name)
      mkdirSync(join(filePath, '..'), { recursive: true })
      writeFileSync(filePath, content)
    }
  }

  writeFileSync(join(repoDir, 'hello.txt'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'pipe' })

  if (opts?.withRemote) {
    const bareDir = makeTmpDir('bare')
    execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' })
    execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir, stdio: 'pipe' })
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir, stdio: 'pipe' })
    return { repoDir, bareDir }
  }

  return { repoDir }
}

// ===========================================================================
// A. Agent-runner localRepoSetup — working directory handling
// ===========================================================================

describe('A. Agent-runner localRepoSetup', { timeout: 15_000 }, () => {
  it('A1. Creates non-existent directory and returns success + needsGitInit', () => {
    const parentDir = makeTmpDir('parent')
    const targetDir = join(parentDir, 'new-project')

    // Directory does NOT exist yet
    expect(existsSync(targetDir)).toBe(false)

    const result = localRepoSetup({ workingDirectory: targetDir })

    expect(result.success).toBe(true)
    expect(result.workingDirectory).toBe(targetDir)
    expect(result.needsGitInit).toBe(true)
    expect(result.fileTree).toEqual([])
    // Directory should now exist
    expect(existsSync(targetDir)).toBe(true)
  })

  it('A2. Handles existing non-git directory (returns needsGitInit + keyFiles)', () => {
    const dir = makeTmpDir('nongit')
    writeFileSync(join(dir, 'script.py'), 'print("hello")')
    writeFileSync(join(dir, 'README.md'), '# My Project')

    const result = localRepoSetup({ workingDirectory: dir })

    expect(result.success).toBe(true)
    expect(result.workingDirectory).toBe(dir)
    expect(result.needsGitInit).toBe(true)
    expect(result.fileTree).toEqual([])
    // Should read key files even for non-git dirs
    expect(result.keyFiles).toBeDefined()
    expect(result.keyFiles?.readmeMd).toContain('My Project')
  })

  it('A3. Handles existing git directory (returns fileTree + repo)', () => {
    const { repoDir } = createTestGitRepo({
      withFiles: { 'README.md': '# Test Repo' },
    })

    const result = localRepoSetup({ workingDirectory: repoDir })

    expect(result.success).toBe(true)
    expect(result.workingDirectory).toBe(repoDir)
    expect(result.needsGitInit).toBeUndefined()
    expect(result.fileTree).toBeDefined()
    expect(result.fileTree!.length).toBeGreaterThan(0)
    expect(result.fileTree).toContain('hello.txt')
    expect(result.keyFiles?.readmeMd).toContain('Test Repo')
  })

  it('A4. Detects git remote URL for repos with origin', () => {
    const { repoDir, bareDir } = createTestGitRepo({ withRemote: true })

    const result = localRepoSetup({ workingDirectory: repoDir })

    expect(result.success).toBe(true)
    expect(result.repository).toBe(bareDir)
  })

  it('A5. Returns error when only repository URL provided without workingDirectory', () => {
    const result = localRepoSetup({ repository: 'git@github.com:user/repo.git' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Working directory required')
  })

  it('A6. No workingDirectory + no repository requires projectId', () => {
    const result = localRepoSetup({})

    expect(result.success).toBe(false)
    expect(result.error).toContain('Project ID is required')
  })
})

// ===========================================================================
// B. Server setupProjectRepo — working directory handling
// ===========================================================================

describe('B. Server setupProjectRepo', { timeout: 15_000 }, () => {
  it('B1. Existing non-git directory returns needsGitInit + direct delivery', () => {
    const dir = makeTmpDir('server-nongit')
    writeFileSync(join(dir, 'data.csv'), 'a,b,c\n1,2,3')

    const result = setupProjectRepo({
      projectId: 'proj-b1',
      projectName: 'Non-Git Project',
      workingDirectory: dir,
    })

    expect(result.workingDirectory).toBe(dir)
    expect(result.needsGitInit).toBe(true)
    expect(result.deliveryMode).toBe('direct')
    expect(result.source?.isGit).toBe(false)
    expect(result.source?.remoteType).toBe('none')
  })

  it('B2. Non-existent directory is created with git init', () => {
    const parentDir = makeTmpDir('server-parent')
    const targetDir = join(parentDir, 'brand-new')

    expect(existsSync(targetDir)).toBe(false)

    const result = setupProjectRepo({
      projectId: 'proj-b2',
      projectName: 'Brand New',
      workingDirectory: targetDir,
    })

    expect(result.workingDirectory).toBe(targetDir)
    expect(existsSync(targetDir)).toBe(true)
    // Server creates git repo for non-existent dirs (unlike agent-runner)
    expect(isGitRepo(targetDir)).toBe(true)
    expect(result.source?.isGit).toBe(true)
    expect(result.agentDir).toBe('.astro')
  })

  it('B3. Existing git repo returns correct source + delivery mode', () => {
    const { repoDir } = createTestGitRepo()

    const result = setupProjectRepo({
      projectId: 'proj-b3',
      projectName: 'Git Project',
      workingDirectory: repoDir,
    })

    expect(result.workingDirectory).toBe(repoDir)
    expect(result.needsGitInit).toBeUndefined()
    expect(result.source?.isGit).toBe(true)
    expect(result.deliveryMode).toBe('branch') // local-only repo → branch
    expect(result.agentDir).toBe('.astro')
    expect(result.fileTree.length).toBeGreaterThan(0)
  })

  it('B4. workingDirectory is always preserved in result', () => {
    // Test all three cases return the correct workingDirectory
    const gitDir = createTestGitRepo().repoDir
    const nonGitDir = makeTmpDir('nongit-b4')
    writeFileSync(join(nonGitDir, 'file.txt'), 'content')
    const parentDir = makeTmpDir('parent-b4')
    const newDir = join(parentDir, 'new-dir')

    const results = [
      setupProjectRepo({ projectId: 'p1', projectName: 'P1', workingDirectory: gitDir }),
      setupProjectRepo({ projectId: 'p2', projectName: 'P2', workingDirectory: nonGitDir }),
      setupProjectRepo({ projectId: 'p3', projectName: 'P3', workingDirectory: newDir }),
    ]

    expect(results[0].workingDirectory).toBe(gitDir)
    expect(results[1].workingDirectory).toBe(nonGitDir)
    expect(results[2].workingDirectory).toBe(newDir)
  })
})

// ===========================================================================
// C. Dispatch schema — workingDirectory preservation
// ===========================================================================

describe('C. Dispatch schema workingDirectory', () => {
  it('C1. workingDirectory passes through dispatch validation', () => {
    const body = {
      nodeId: 'node-1',
      projectId: 'proj-1',
      title: 'Test task',
      description: 'A test task',
      workingDirectory: '/tmp/my-project',
    }

    const result = dispatchTaskSchema.safeParse(body)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.workingDirectory).toBe('/tmp/my-project')
    }
  })

  it('C2. Dispatch body without workingDirectory still validates (optional)', () => {
    const body = {
      nodeId: 'node-1',
      projectId: 'proj-1',
      title: 'Test task',
      description: 'A test task',
    }

    const result = dispatchTaskSchema.safeParse(body)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.workingDirectory).toBeUndefined()
    }
  })

  it('C3. Path traversal in workingDirectory is rejected', () => {
    const body = {
      nodeId: 'node-1',
      projectId: 'proj-1',
      title: 'Test task',
      description: 'A test task',
      workingDirectory: '/tmp/../etc/passwd',
    }

    const result = dispatchTaskSchema.safeParse(body)
    expect(result.success).toBe(false)
  })

  it('C4. Long absolute paths are accepted', () => {
    const body = {
      nodeId: 'node-1',
      projectId: 'proj-1',
      title: 'Test task',
      description: 'A test task',
      workingDirectory: '/home/user/projects/my-company/my-team/feature-branch/submodule',
    }

    const result = dispatchTaskSchema.safeParse(body)
    expect(result.success).toBe(true)
  })
})

// ===========================================================================
// D. Full pipeline: repo setup → dispatch schema → Task type
// ===========================================================================

describe('D. Full pipeline round-trips', { timeout: 15_000 }, () => {
  it('D1. Git repo → setupProjectRepo → dispatch → Task preserves workingDirectory', () => {
    const { repoDir } = createTestGitRepo()

    // Step 1: Server repo setup
    const repoResult = setupProjectRepo({
      projectId: 'proj-d1',
      projectName: 'Pipeline Test',
      workingDirectory: repoDir,
    })

    // Step 2: Build dispatch body (simulates frontend)
    const dispatchBody = {
      nodeId: 'node-d1',
      projectId: 'proj-d1',
      title: 'Implement feature',
      description: 'Build the feature',
      workingDirectory: repoResult.workingDirectory,
      deliveryMode: repoResult.deliveryMode ?? 'branch' as const,
      agentDir: repoResult.agentDir ?? '.astro',
    }

    // Step 3: Validate through dispatch schema
    const validated = dispatchTaskSchema.safeParse(dispatchBody)
    expect(validated.success).toBe(true)
    if (!validated.success) return

    // Step 4: Build Task (simulates relay dispatch to agent-runner)
    const task: Task = {
      id: `exec-${validated.data.nodeId}-${Date.now()}`,
      projectId: validated.data.projectId,
      planNodeId: validated.data.nodeId,
      provider: 'claude-code',
      prompt: validated.data.description,
      workingDirectory: validated.data.workingDirectory!,
      createdAt: new Date().toISOString(),
      deliveryMode: validated.data.deliveryMode,
      agentDir: validated.data.agentDir,
    }

    // Step 5: Verify the workingDirectory survived the full pipeline
    expect(task.workingDirectory).toBe(repoDir)
    expect(task.deliveryMode).toBe('branch')
    expect(task.agentDir).toBe('.astro')
  })

  it('D2. Non-git dir → setupProjectRepo → dispatch → Task (direct mode)', () => {
    const dir = makeTmpDir('pipeline-nongit')
    writeFileSync(join(dir, 'analysis.py'), 'import pandas as pd')

    // Step 1: Server repo setup detects non-git
    const repoResult = setupProjectRepo({
      projectId: 'proj-d2',
      projectName: 'Analysis Project',
      workingDirectory: dir,
    })

    expect(repoResult.needsGitInit).toBe(true)
    expect(repoResult.deliveryMode).toBe('direct')

    // Step 2: Build dispatch body
    const dispatchBody = {
      nodeId: 'node-d2',
      projectId: 'proj-d2',
      title: 'Run analysis',
      description: 'Process the data',
      workingDirectory: repoResult.workingDirectory,
      deliveryMode: repoResult.deliveryMode ?? 'direct' as const,
    }

    // Step 3: Validate
    const validated = dispatchTaskSchema.safeParse(dispatchBody)
    expect(validated.success).toBe(true)
    if (!validated.success) return

    // Step 4: Build Task
    const task: Task = {
      id: 'exec-d2',
      projectId: validated.data.projectId,
      planNodeId: validated.data.nodeId,
      provider: 'claude-code',
      prompt: validated.data.description,
      workingDirectory: validated.data.workingDirectory!,
      createdAt: new Date().toISOString(),
      deliveryMode: validated.data.deliveryMode,
    }

    expect(task.workingDirectory).toBe(dir)
    expect(task.deliveryMode).toBe('direct')
  })

  it('D3. Non-existent dir → agent-runner localRepoSetup → dispatch → Task', () => {
    const parentDir = makeTmpDir('pipeline-new')
    const targetDir = join(parentDir, 'my-new-project')

    // Step 1: Agent-runner creates the directory
    const localResult = localRepoSetup({ workingDirectory: targetDir })

    expect(localResult.success).toBe(true)
    expect(localResult.workingDirectory).toBe(targetDir)
    expect(localResult.needsGitInit).toBe(true)
    expect(existsSync(targetDir)).toBe(true)

    // Step 2: Build dispatch body with agent-runner result
    const dispatchBody = {
      nodeId: 'node-d3',
      projectId: 'proj-d3',
      title: 'Setup project',
      description: 'Initialize the project structure',
      workingDirectory: localResult.workingDirectory,
      deliveryMode: 'direct' as const, // non-git → direct
    }

    // Step 3: Validate
    const validated = dispatchTaskSchema.safeParse(dispatchBody)
    expect(validated.success).toBe(true)
    if (!validated.success) return

    // Step 4: Build Task
    const task: Task = {
      id: 'exec-d3',
      projectId: validated.data.projectId,
      planNodeId: validated.data.nodeId,
      provider: 'claude-code',
      prompt: validated.data.description,
      workingDirectory: validated.data.workingDirectory!,
      createdAt: new Date().toISOString(),
      deliveryMode: validated.data.deliveryMode,
    }

    expect(task.workingDirectory).toBe(targetDir)
  })

  it('D4. Server + agent-runner agree on git repo handling', () => {
    const { repoDir } = createTestGitRepo({
      withFiles: { 'package.json': '{"name": "test"}' },
    })

    // Both layers should detect this as a git repo
    const serverResult = setupProjectRepo({
      projectId: 'proj-d4',
      projectName: 'Cross-Layer',
      workingDirectory: repoDir,
    })

    const agentResult = localRepoSetup({ workingDirectory: repoDir })

    // Both should succeed
    expect(serverResult.workingDirectory).toBe(repoDir)
    expect(agentResult.success).toBe(true)
    expect(agentResult.workingDirectory).toBe(repoDir)

    // Both detect it as git
    expect(serverResult.source?.isGit).toBe(true)
    expect(agentResult.needsGitInit).toBeUndefined()

    // Both return file trees with content
    expect(serverResult.fileTree.length).toBeGreaterThan(0)
    expect(agentResult.fileTree!.length).toBeGreaterThan(0)

    // Both see package.json in key files
    expect(serverResult.keyFiles?.packageInfo).toContain('package.json')
    expect(agentResult.keyFiles?.packageInfo).toContain('package.json')
  })

  it('D5. Server + agent-runner agree on non-git directory handling', () => {
    const dir = makeTmpDir('cross-nongit')
    writeFileSync(join(dir, 'data.txt'), 'some data')

    const serverResult = setupProjectRepo({
      projectId: 'proj-d5',
      projectName: 'Non-Git Cross',
      workingDirectory: dir,
    })

    const agentResult = localRepoSetup({ workingDirectory: dir })

    // Both return the same workingDirectory
    expect(serverResult.workingDirectory).toBe(dir)
    expect(agentResult.workingDirectory).toBe(dir)

    // Both detect non-git
    expect(serverResult.needsGitInit).toBe(true)
    expect(agentResult.needsGitInit).toBe(true)

    // Both have empty file trees for non-git dirs
    expect(serverResult.fileTree).toEqual([])
    expect(agentResult.fileTree).toEqual([])
  })
})

// ===========================================================================
// E. Edge cases for workingDirectory
// ===========================================================================

describe('E. Edge cases', { timeout: 15_000 }, () => {
  it('E1. Directory with spaces in path', () => {
    const parentDir = makeTmpDir('spaces')
    const targetDir = join(parentDir, 'my project with spaces')

    const result = localRepoSetup({ workingDirectory: targetDir })

    expect(result.success).toBe(true)
    expect(result.workingDirectory).toBe(targetDir)
    expect(existsSync(targetDir)).toBe(true)
  })

  it('E2. Deeply nested non-existent path is created', () => {
    const parentDir = makeTmpDir('deep')
    const targetDir = join(parentDir, 'a', 'b', 'c', 'd', 'project')

    const result = localRepoSetup({ workingDirectory: targetDir })

    expect(result.success).toBe(true)
    expect(result.workingDirectory).toBe(targetDir)
    expect(existsSync(targetDir)).toBe(true)
  })

  it('E3. isGitRepo returns false for non-git directory', () => {
    const dir = makeTmpDir('not-git')
    expect(isGitRepo(dir)).toBe(false)
  })

  it('E4. isGitRepo returns true for git directory', () => {
    const { repoDir } = createTestGitRepo()
    expect(isGitRepo(repoDir)).toBe(true)
  })

  it('E5. getFileTree returns empty for non-existent directory', () => {
    expect(getFileTree('/nonexistent/path/that/does/not/exist')).toEqual([])
  })

  it('E6. getGitRemoteUrl returns undefined for local-only repo', () => {
    const { repoDir } = createTestGitRepo()
    expect(getGitRemoteUrl(repoDir)).toBeUndefined()
  })

  it('E7. getGitRemoteUrl returns URL for repo with remote', () => {
    const { repoDir, bareDir } = createTestGitRepo({ withRemote: true })
    expect(getGitRemoteUrl(repoDir)).toBe(bareDir)
  })
})
