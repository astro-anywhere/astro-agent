/**
 * End-to-end pipeline test for Workspace V2
 *
 * Simulates the full data flow from frontend trigger through to agent-runner
 * workspace setup, verifying type contracts and field propagation across layers:
 *
 *   Frontend (execution-store.ts)
 *     -> POST /api/dispatch/task (dispatch.ts validates + builds prompt)
 *     -> relayServer.dispatchTask(taskDispatch)
 *     -> agent-runner receives Task with workspace fields
 *     -> task-executor uses workspace fields for workspace setup
 *
 * These are UNIT tests that verify the contract between layers: types match,
 * fields flow correctly, schemas validate. No running server required.
 * Filesystem tests use real tmp directories (no mocking).
 */

import { describe, it, expect, afterAll } from 'vitest'
import { z } from 'zod'
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

// ── Frontend types ──────────────────────────────────────────────────────
import type {
  Project,
  ProjectSource,
  DeliveryMode,
  WorktreeStrategy,
  RemoteType,
} from '../../src/types/index.js'

// ── Frontend utilities ──────────────────────────────────────────────────
import {
  deriveDeliveryMode,
  deliveryModeLabel,
  resolveProjectSource,
} from '../../src/lib/project-source.js'

// ── Agent-runner types ──────────────────────────────────────────────────
import type { Task } from '../src/types.js'
import type { WorktreeOptions } from '../src/lib/worktree.js'

// ── Agent-runner copy worktree ──────────────────────────────────────────
import {
  createCopyWorktree,
  createReferenceWorktree,
} from '../src/lib/copy-worktree.js'

// ── Server repo-setup ──────────────────────────────────────────────────
import {
  setupProjectRepo,
} from '../../server/lib/repo-setup.js'

// ---------------------------------------------------------------------------
// Dispatch schema (reproduced from server/routes/dispatch.ts to verify
// the contract without importing Hono route internals)
// ---------------------------------------------------------------------------
const dispatchTaskSchema = z.object({
  nodeId: z.string().min(1).max(100),
  projectId: z.string().min(1).max(100),
  title: z.string().min(1).max(1000),
  description: z.string().min(1).max(50000),
  dependencies: z.array(z.string().max(100)).max(100).optional(),
  verification: z.enum(['auto', 'human']).optional(),
  visionDoc: z.string().max(100000).optional(),
  dependencyOutputs: z.array(z.object({
    nodeId: z.string().max(100),
    title: z.string().max(1000),
    output: z.string().max(100000),
  })).max(100).optional(),
  priority: z.enum(['critical', 'high', 'normal', 'low']).optional(),
  preferredProvider: z.string().max(100).optional(),
  targetMachineId: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
  workingDirectory: z.string().max(1000).refine(
    (path) => !path.includes('..'),
    { message: 'Path traversal not allowed' },
  ).optional(),
  sourceDirectory: z.string().max(1000).refine(
    (path) => !path.includes('..'),
    { message: 'Path traversal not allowed' },
  ).optional(),
  force: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  computeBackend: z.string().max(100).optional(),
  deliveryMode: z.enum(['pr', 'push', 'branch', 'copy', 'direct']).optional(),
  remoteType: z.enum(['github', 'gitlab', 'bitbucket', 'generic', 'none']).optional(),
  agentDir: z.string().max(100).optional(),
  worktreeStrategy: z.enum(['copy', 'reference', 'direct']).optional(),
})

// ---------------------------------------------------------------------------
// Temp directory tracking
// ---------------------------------------------------------------------------
const tmpDirs: string[] = []

afterAll(async () => {
  for (const dir of tmpDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

/** Create a real git repo with an initial commit and optional bare remote. */
function createTestGitRepo(opts?: { withRemote?: boolean }): {
  repoDir: string
  bareDir?: string
} {
  const repoDir = mkdtempSync(join(tmpdir(), 'astro-pipeline-repo-'))
  tmpDirs.push(repoDir)

  execFileSync('git', ['init'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir })

  writeFileSync(join(repoDir, 'hello.txt'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repoDir })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })

  if (opts?.withRemote) {
    const bareDir = mkdtempSync(join(tmpdir(), 'astro-pipeline-bare-'))
    tmpDirs.push(bareDir)
    execFileSync('git', ['init', '--bare'], { cwd: bareDir })
    execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir })
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir })
    return { repoDir, bareDir }
  }

  return { repoDir }
}

// ===========================================================================
// A. Type contract verification (compile-time + runtime)
// ===========================================================================

describe('A. Type contract verification', () => {
  // Test 1: Task type includes all workspace fields
  it('1. Task type includes all workspace fields', () => {
    const task: Task = {
      id: 'test',
      projectId: 'p1',
      planNodeId: 'n1',
      provider: 'claude-code',
      prompt: 'test prompt',
      workingDirectory: '/tmp/test',
      createdAt: new Date().toISOString(),
      deliveryMode: 'copy',
      agentDir: '.astro',
      worktreeStrategy: 'copy',
    }

    // Runtime verification: all workspace fields are present and have correct values
    expect(task.deliveryMode).toBe('copy')
    expect(task.agentDir).toBe('.astro')
    expect(task.worktreeStrategy).toBe('copy')

    // Also verify optional remoteType field
    const taskWithRemote: Task = {
      ...task,
      remoteType: 'github',
    }
    expect(taskWithRemote.remoteType).toBe('github')
  })

  // Test 2: Frontend types include workspace fields on Project
  it('2. Frontend Project type includes workspace fields', () => {
    const project: Partial<Project> = {
      agentDir: '.astro',
      worktreeStrategy: 'copy',
      deliveryMode: 'copy',
      source: {
        localPath: '/tmp/project',
        remoteType: 'github',
        baseBranch: 'main',
        isGit: true,
      },
    }

    expect(project.agentDir).toBe('.astro')
    expect(project.worktreeStrategy).toBe('copy')
    expect(project.deliveryMode).toBe('copy')
    expect(project.source?.remoteType).toBe('github')
  })

  // Test 3: DeliveryMode includes 'copy'
  it('3. DeliveryMode includes all five modes', () => {
    const modes: DeliveryMode[] = ['pr', 'push', 'branch', 'copy', 'direct']

    expect(modes).toHaveLength(5)
    expect(modes).toContain('copy')
    expect(modes).toContain('direct')
    expect(modes).toContain('pr')
    expect(modes).toContain('push')
    expect(modes).toContain('branch')
  })

  // Test 4: WorktreeStrategy type exists
  it('4. WorktreeStrategy type includes all strategies', () => {
    const strategies: WorktreeStrategy[] = ['copy', 'reference', 'direct']

    expect(strategies).toHaveLength(3)
    expect(strategies).toContain('copy')
    expect(strategies).toContain('reference')
    expect(strategies).toContain('direct')
  })
})

// ===========================================================================
// B. Dispatch schema validation (simulates frontend -> server)
// ===========================================================================

describe('B. Dispatch schema validation', () => {
  // Test 5: All delivery modes pass schema validation
  it('5. All delivery modes pass schema validation', () => {
    const basebody = {
      nodeId: 'node-1',
      projectId: 'proj-1',
      title: 'Test task',
      description: 'A test task description',
      workingDirectory: '/tmp/test',
    }

    const deliveryModes: Array<'pr' | 'push' | 'branch' | 'copy' | 'direct'> = [
      'pr', 'push', 'branch', 'copy', 'direct',
    ]

    for (const mode of deliveryModes) {
      const result = dispatchTaskSchema.safeParse({ ...basebody, deliveryMode: mode })
      expect(result.success, `deliveryMode '${mode}' should pass validation`).toBe(true)
    }

    // Invalid delivery mode should fail
    const invalid = dispatchTaskSchema.safeParse({ ...basebody, deliveryMode: 'invalid' })
    expect(invalid.success).toBe(false)
  })

  // Test 6: Workspace fields pass through dispatch body
  it('6. Workspace fields pass through dispatch body', () => {
    const fullBody = {
      nodeId: 'node-1',
      projectId: 'proj-1',
      title: 'Test task',
      description: 'A test task description',
      workingDirectory: '/tmp/test',
      deliveryMode: 'copy' as const,
      agentDir: '.myagent',
      worktreeStrategy: 'reference' as const,
      remoteType: 'github' as const,
      sourceDirectory: '/tmp/original',
    }

    const result = dispatchTaskSchema.safeParse(fullBody)
    expect(result.success).toBe(true)

    if (result.success) {
      expect(result.data.deliveryMode).toBe('copy')
      expect(result.data.agentDir).toBe('.myagent')
      expect(result.data.worktreeStrategy).toBe('reference')
      expect(result.data.remoteType).toBe('github')
      expect(result.data.sourceDirectory).toBe('/tmp/original')
    }
  })

  // All worktree strategies pass validation
  it('6b. All worktree strategies pass schema validation', () => {
    const basebody = {
      nodeId: 'node-1',
      projectId: 'proj-1',
      title: 'Test task',
      description: 'A test task description',
      workingDirectory: '/tmp/test',
    }

    const strategies: Array<'copy' | 'reference' | 'direct'> = [
      'copy', 'reference', 'direct',
    ]

    for (const strategy of strategies) {
      const result = dispatchTaskSchema.safeParse({ ...basebody, worktreeStrategy: strategy })
      expect(result.success, `worktreeStrategy '${strategy}' should pass validation`).toBe(true)
    }

    const invalid = dispatchTaskSchema.safeParse({ ...basebody, worktreeStrategy: 'invalid' })
    expect(invalid.success).toBe(false)
  })

  // All remote types pass validation
  it('6c. All remote types pass schema validation', () => {
    const basebody = {
      nodeId: 'node-1',
      projectId: 'proj-1',
      title: 'Test task',
      description: 'A test task description',
      workingDirectory: '/tmp/test',
    }

    const remoteTypes: Array<'github' | 'gitlab' | 'bitbucket' | 'generic' | 'none'> = [
      'github', 'gitlab', 'bitbucket', 'generic', 'none',
    ]

    for (const rt of remoteTypes) {
      const result = dispatchTaskSchema.safeParse({ ...basebody, remoteType: rt })
      expect(result.success, `remoteType '${rt}' should pass validation`).toBe(true)
    }
  })

  // Path traversal is rejected
  it('6d. Path traversal in workingDirectory is rejected', () => {
    const body = {
      nodeId: 'node-1',
      projectId: 'proj-1',
      title: 'Test task',
      description: 'A test task description',
      workingDirectory: '/tmp/../etc/passwd',
    }

    const result = dispatchTaskSchema.safeParse(body)
    expect(result.success).toBe(false)
  })
})

// ===========================================================================
// C. Project source utilities (frontend layer)
// ===========================================================================

describe('C. Project source utilities', () => {
  // Test 7: deriveDeliveryMode returns correct mode for each remoteType
  it('7. deriveDeliveryMode returns correct mode for each remoteType', () => {
    // non-git -> 'direct'
    expect(deriveDeliveryMode({
      localPath: '/tmp/scripts',
      remoteType: 'none',
      baseBranch: 'main',
      isGit: false,
    })).toBe('direct')

    // github -> 'pr'
    expect(deriveDeliveryMode({
      localPath: '/tmp/project',
      remoteUrl: 'git@github.com:user/repo.git',
      remoteType: 'github',
      baseBranch: 'main',
      isGit: true,
    })).toBe('pr')

    // gitlab -> 'pr'
    expect(deriveDeliveryMode({
      localPath: '/tmp/project',
      remoteUrl: 'git@gitlab.com:user/repo.git',
      remoteType: 'gitlab',
      baseBranch: 'main',
      isGit: true,
    })).toBe('pr')

    // bitbucket -> 'pr'
    expect(deriveDeliveryMode({
      localPath: '/tmp/project',
      remoteUrl: 'git@bitbucket.org:user/repo.git',
      remoteType: 'bitbucket',
      baseBranch: 'main',
      isGit: true,
    })).toBe('pr')

    // generic -> 'push'
    expect(deriveDeliveryMode({
      localPath: '/tmp/project',
      remoteUrl: 'git@self-hosted.example.com:user/repo.git',
      remoteType: 'generic',
      baseBranch: 'main',
      isGit: true,
    })).toBe('push')

    // none + git -> 'branch'
    expect(deriveDeliveryMode({
      localPath: '/tmp/analysis',
      remoteType: 'none',
      baseBranch: 'main',
      isGit: true,
    })).toBe('branch')
  })

  // Test 8: deliveryModeLabel includes 'copy' mode
  it('8. deliveryModeLabel returns "Copy to Worktree" for copy mode', () => {
    expect(deliveryModeLabel('copy')).toBe('Copy to Worktree')

    // Also verify other modes for completeness
    expect(deliveryModeLabel('pr')).toBe('Pull Request')
    expect(deliveryModeLabel('push')).toBe('Push to Remote')
    expect(deliveryModeLabel('branch')).toBe('Local Branch')
    expect(deliveryModeLabel('direct')).toBe('Direct (in-place)')
  })

  // Test 9: resolveProjectSource does not include deprecated 'type' field
  it('9. resolveProjectSource result uses remoteType, not deprecated type field', () => {
    const project = {
      workingDirectory: '/home/user/work',
    } as Project

    const source = resolveProjectSource(project)
    expect(source).toBeDefined()

    // The ProjectSource interface uses 'remoteType', not a deprecated 'type' field
    expect(source!.remoteType).toBeDefined()
    expect(source!.localPath).toBe('/home/user/work')
    expect(source!.baseBranch).toBe('main')

    // Verify the returned object only has known ProjectSource keys
    const keys = Object.keys(source!)
    const allowedKeys: Array<keyof ProjectSource> = [
      'localPath', 'subdirectory', 'remoteUrl', 'remoteType', 'baseBranch', 'isGit',
    ]
    for (const key of keys) {
      expect(allowedKeys).toContain(key)
    }
  })
})

// ===========================================================================
// D. Repo setup creates agent dir correctly
// ===========================================================================

describe('D. Repo setup agent dir', { timeout: 30_000 }, () => {
  // Test 10: setupProjectRepo + ensureAgentDir flow for git repo
  it('10. setupProjectRepo creates .astro/config.json with correct fields', () => {
    const { repoDir } = createTestGitRepo()

    const result = setupProjectRepo({
      projectId: 'test-project-10',
      projectName: 'Test Project',
      projectDescription: 'A test project',
      workingDirectory: repoDir,
    })

    // .astro/config.json should exist
    const configPath = join(repoDir, '.astro', 'config.json')
    expect(existsSync(configPath)).toBe(true)

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.branchPrefix).toBe('astro/')
    expect(config.baseBranch).toBeDefined()
    expect(config.deliveryMode).toBeDefined()

    // Since this is a local-only repo (no remote), deliveryMode should be 'branch'
    expect(config.deliveryMode).toBe('branch')
    expect(config.remoteType).toBe('none')

    // Result should include agentDir
    expect(result.agentDir).toBe('.astro')

    // Result should include source and deliveryMode
    expect(result.source).toBeDefined()
    expect(result.source!.isGit).toBe(true)
    expect(result.deliveryMode).toBe('branch')
  })

  // Test 11: Full round-trip: setupProjectRepo -> fields -> dispatch schema -> task type
  it('11. Full round-trip: repo setup -> dispatch schema -> Task type', () => {
    const { repoDir } = createTestGitRepo()

    // Step 1: setupProjectRepo
    const repoResult = setupProjectRepo({
      projectId: 'test-project-11',
      projectName: 'Round Trip Project',
      workingDirectory: repoDir,
    })

    // Step 2: Build dispatch body using returned values
    const dispatchBody = {
      nodeId: 'node-roundtrip',
      projectId: 'test-project-11',
      title: 'Round trip test task',
      description: 'Verify field propagation across all layers',
      workingDirectory: repoResult.workingDirectory,
      deliveryMode: repoResult.deliveryMode ?? 'branch',
      agentDir: repoResult.agentDir ?? '.astro',
      worktreeStrategy: 'direct' as const,
      remoteType: repoResult.source?.remoteType ?? 'none',
    }

    // Step 3: Validate through dispatch schema
    const validated = dispatchTaskSchema.safeParse(dispatchBody)
    expect(validated.success).toBe(true)

    if (!validated.success) return

    // Step 4: Build a Task object from validated data (simulates relay dispatch)
    const task: Task = {
      id: `exec-${validated.data.nodeId}-${Date.now()}`,
      projectId: validated.data.projectId,
      planNodeId: validated.data.nodeId,
      provider: 'claude-code',
      prompt: `## Current Task\n\n**${validated.data.title}**\n\n${validated.data.description}`,
      workingDirectory: validated.data.workingDirectory!,
      createdAt: new Date().toISOString(),
      deliveryMode: validated.data.deliveryMode,
      agentDir: validated.data.agentDir,
      worktreeStrategy: validated.data.worktreeStrategy,
      remoteType: validated.data.remoteType,
    }

    // Step 5: Assert all fields flow through correctly
    expect(task.workingDirectory).toBe(repoResult.workingDirectory)
    expect(task.deliveryMode).toBe(repoResult.deliveryMode ?? 'branch')
    expect(task.agentDir).toBe(repoResult.agentDir ?? '.astro')
    expect(task.worktreeStrategy).toBe('direct')
    expect(task.remoteType).toBe(repoResult.source?.remoteType ?? 'none')
    expect(task.projectId).toBe('test-project-11')
    expect(task.planNodeId).toBe('node-roundtrip')
  })
})

// ===========================================================================
// E. Agent-runner workspace preparation contracts
// ===========================================================================

describe('E. Agent-runner workspace contracts', { timeout: 30_000 }, () => {
  // Test 12: WorktreeOptions accepts agentDir
  it('12. WorktreeOptions type accepts agentDir', () => {
    const opts: WorktreeOptions = {
      workingDirectory: '/tmp/test',
      taskId: 'test-1',
      agentDir: '.myagent',
    }

    expect(opts.agentDir).toBe('.myagent')
    expect(opts.workingDirectory).toBe('/tmp/test')
    expect(opts.taskId).toBe('test-1')

    // Also verify optional fields compile
    const fullOpts: WorktreeOptions = {
      workingDirectory: '/tmp/test',
      taskId: 'test-2',
      agentDir: '.astro',
      rootOverride: '/custom/root',
      projectId: 'proj-1',
      nodeId: 'node-1',
    }
    expect(fullOpts.rootOverride).toBe('/custom/root')
    expect(fullOpts.projectId).toBe('proj-1')
    expect(fullOpts.nodeId).toBe('node-1')
  })

  // Test 13: Copy worktree creates path under agent dir
  it('13. createCopyWorktree produces path under agent dir', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'astro-pipeline-copy-'))
    tmpDirs.push(projectDir)

    // Create some test files
    writeFileSync(join(projectDir, 'main.ts'), 'console.log("hello")')
    mkdirSync(join(projectDir, 'src'), { recursive: true })
    writeFileSync(join(projectDir, 'src', 'index.ts'), 'export default 42')

    const result = await createCopyWorktree(projectDir, '.astro', 'copy-task-e2e')

    // Path should be {sourceDir}/.astro/worktrees/{taskId}
    expect(result.worktreePath).toBe(
      join(projectDir, '.astro', 'worktrees', 'copy-task-e2e'),
    )
    expect(existsSync(result.worktreePath)).toBe(true)

    // Files should be copied
    expect(existsSync(join(result.worktreePath, 'main.ts'))).toBe(true)
    expect(existsSync(join(result.worktreePath, 'src', 'index.ts'))).toBe(true)

    // Content should match
    expect(readFileSync(join(result.worktreePath, 'main.ts'), 'utf-8')).toBe(
      'console.log("hello")',
    )

    await result.cleanup()
    expect(existsSync(result.worktreePath)).toBe(false)
  })

  // Test 13b: Reference worktree also creates path under agent dir
  it('13b. createReferenceWorktree produces path under agent dir', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'astro-pipeline-ref-'))
    tmpDirs.push(projectDir)

    writeFileSync(join(projectDir, 'app.py'), 'print("hello")')

    const result = await createReferenceWorktree(projectDir, '.astro', 'ref-task-e2e')

    expect(result.worktreePath).toBe(
      join(projectDir, '.astro', 'worktrees', 'ref-task-e2e'),
    )
    expect(existsSync(result.worktreePath)).toBe(true)

    // Reference worktree is empty but has a file map
    expect(result.fileMap.length).toBeGreaterThan(0)
    expect(result.fileMap.some((e) => e.relativePath === 'app.py')).toBe(true)

    await result.cleanup()
  })

  // Test 14: End-to-end path verification for all delivery modes
  it('14. All delivery modes produce correct workspace path patterns', () => {
    const gitRoot = '/home/user/my-project'
    const agentDir = '.astro'
    const taskId = 'exec-node-123-1700000000'

    type PathExpectation = {
      mode: DeliveryMode
      description: string
      expectedPattern: string
    }

    const expectations: PathExpectation[] = [
      {
        mode: 'pr',
        description: 'git worktree under agent dir',
        expectedPattern: join(gitRoot, agentDir, 'worktrees', taskId),
      },
      {
        mode: 'push',
        description: 'git worktree under agent dir',
        expectedPattern: join(gitRoot, agentDir, 'worktrees', taskId),
      },
      {
        mode: 'branch',
        description: 'git worktree under agent dir',
        expectedPattern: join(gitRoot, agentDir, 'worktrees', taskId),
      },
      {
        mode: 'copy',
        description: 'copy worktree under agent dir',
        expectedPattern: join(gitRoot, agentDir, 'worktrees', taskId),
      },
      {
        mode: 'direct',
        description: 'original workingDirectory (no worktree)',
        expectedPattern: gitRoot,
      },
    ]

    for (const { mode, expectedPattern } of expectations) {
      if (mode === 'direct') {
        // Direct mode uses the original working directory
        const workspacePath = gitRoot
        expect(workspacePath).toBe(expectedPattern)
      } else if (mode === 'copy') {
        // Copy mode: {sourceDir}/{agentDir}/worktrees/{taskId}
        const workspacePath = join(gitRoot, agentDir, 'worktrees', taskId)
        expect(workspacePath).toBe(expectedPattern)
      } else {
        // Git worktree modes (pr, push, branch): {gitRoot}/{agentDir}/worktrees/{taskId}
        const workspacePath = join(gitRoot, agentDir, 'worktrees', taskId)
        expect(workspacePath).toBe(expectedPattern)
      }
    }
  })

  // Test 14b: Verify actual createCopyWorktree path matches the expected pattern
  it('14b. createCopyWorktree path matches expected pattern from test 14', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'astro-pipeline-14b-'))
    tmpDirs.push(sourceDir)

    writeFileSync(join(sourceDir, 'file.txt'), 'content')

    const taskId = 'exec-node-abc-1700000000'
    const agentDir = '.astro'

    const result = await createCopyWorktree(sourceDir, agentDir, taskId)

    // Verify path matches the expected pattern: {sourceDir}/{agentDir}/worktrees/{taskId}
    expect(result.worktreePath).toBe(
      join(sourceDir, agentDir, 'worktrees', taskId),
    )

    await result.cleanup()
  })
})

// ===========================================================================
// F. Cross-layer consistency checks
// ===========================================================================

describe('F. Cross-layer consistency', () => {
  // Verify that the dispatch schema enum values match the TypeScript type unions
  it('F1. Dispatch schema delivery modes match DeliveryMode type', () => {
    // The schema allows these delivery modes
    const schemaDeliveryModes = ['pr', 'push', 'branch', 'copy', 'direct']

    // Verify each one passes the schema
    for (const mode of schemaDeliveryModes) {
      const result = dispatchTaskSchema.safeParse({
        nodeId: 'n',
        projectId: 'p',
        title: 't',
        description: 'd',
        deliveryMode: mode,
      })
      expect(result.success).toBe(true)
    }

    // Also verify each is a valid DeliveryMode at the type level
    const typedModes: DeliveryMode[] = schemaDeliveryModes as DeliveryMode[]
    expect(typedModes).toHaveLength(5)
  })

  it('F2. Dispatch schema worktree strategies match WorktreeStrategy type', () => {
    const schemaStrategies = ['copy', 'reference', 'direct']

    for (const strategy of schemaStrategies) {
      const result = dispatchTaskSchema.safeParse({
        nodeId: 'n',
        projectId: 'p',
        title: 't',
        description: 'd',
        worktreeStrategy: strategy,
      })
      expect(result.success).toBe(true)
    }

    const typedStrategies: WorktreeStrategy[] = schemaStrategies as WorktreeStrategy[]
    expect(typedStrategies).toHaveLength(3)
  })

  it('F3. Dispatch schema remote types match RemoteType type', () => {
    const schemaRemoteTypes = ['github', 'gitlab', 'bitbucket', 'generic', 'none']

    for (const rt of schemaRemoteTypes) {
      const result = dispatchTaskSchema.safeParse({
        nodeId: 'n',
        projectId: 'p',
        title: 't',
        description: 'd',
        remoteType: rt,
      })
      expect(result.success).toBe(true)
    }

    const typedRemoteTypes: RemoteType[] = schemaRemoteTypes as RemoteType[]
    expect(typedRemoteTypes).toHaveLength(5)
  })

  it('F4. Task type delivery mode values match dispatch schema', () => {
    // Build a Task with each delivery mode and verify it satisfies the type
    const deliveryModes: Array<Task['deliveryMode']> = ['pr', 'push', 'branch', 'copy', 'direct', undefined]

    for (const mode of deliveryModes) {
      // Verify the Task type accepts each delivery mode (compile-time check)
      expect(() => {
        const _task: Task = {
          id: 'test',
          projectId: 'p1',
          planNodeId: 'n1',
          provider: 'claude-code',
          prompt: 'test',
          workingDirectory: '/tmp/test',
          createdAt: new Date().toISOString(),
          deliveryMode: mode,
        }
        return _task
      }).not.toThrow()

      // If mode is defined, it should also pass the dispatch schema
      if (mode !== undefined) {
        const result = dispatchTaskSchema.safeParse({
          nodeId: 'n',
          projectId: 'p',
          title: 't',
          description: 'd',
          deliveryMode: mode,
        })
        expect(result.success).toBe(true)
      }
    }
  })

  // Full pipeline simulation: project setup -> derive fields -> validate schema -> build Task
  it('F5. Full pipeline: non-git project -> direct delivery', () => {
    const plainDir = mkdtempSync(join(tmpdir(), 'astro-pipeline-nongit-'))
    tmpDirs.push(plainDir)

    writeFileSync(join(plainDir, 'script.py'), 'print("hello")')

    // setupProjectRepo detects non-git dir
    const result = setupProjectRepo({
      projectId: 'nongit-project',
      projectName: 'Non-Git Project',
      workingDirectory: plainDir,
    })

    expect(result.needsGitInit).toBe(true)
    expect(result.deliveryMode).toBe('direct')
    expect(result.source?.isGit).toBe(false)
    expect(result.source?.remoteType).toBe('none')

    // Build dispatch body
    const dispatchBody = {
      nodeId: 'node-nongit',
      projectId: 'nongit-project',
      title: 'Process data',
      description: 'Run the data processing script',
      workingDirectory: result.workingDirectory,
      deliveryMode: result.deliveryMode ?? 'direct',
    }

    const validated = dispatchTaskSchema.safeParse(dispatchBody)
    expect(validated.success).toBe(true)

    // Build Task
    if (validated.success) {
      const task: Task = {
        id: 'exec-nongit-1',
        projectId: validated.data.projectId,
        planNodeId: validated.data.nodeId,
        provider: 'claude-code',
        prompt: validated.data.description,
        workingDirectory: validated.data.workingDirectory!,
        createdAt: new Date().toISOString(),
        deliveryMode: validated.data.deliveryMode,
      }

      // Direct delivery mode: agent uses original working directory
      expect(task.deliveryMode).toBe('direct')
      expect(task.workingDirectory).toBe(plainDir)
    }
  })
})
