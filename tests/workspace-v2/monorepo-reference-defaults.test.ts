/**
 * Tests for WORKSPACE_V2.md §13 scenarios:
 *
 * 1. Monorepo subdirectory — worktree at git root, CWD at subdirectory
 * 2. Reference mode — file map includes absolute paths for agent to read files
 * 3. Reference mode — agent writes to worktree (files exist in worktree, not original)
 * 4. Default project directory — no directory given → ~/.astro/projects/{id}/ is created
 * 5. buildProjectSource — detects subdirectory for monorepo
 *
 * These tests use REAL git repos in temporary directories — no mocking of git
 * or filesystem operations. Only worktree-include and worktree-setup are mocked
 * because they depend on astro config files absent from throwaway test repos.
 */

import { describe, it, expect, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'

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
import { createWorktree } from '../src/lib/worktree.js'
import {
  createReferenceWorktree,
} from '../src/lib/copy-worktree.js'
import { setupProjectRepo } from '../../server/lib/repo-setup.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Directories created during tests — cleaned up in afterAll. */
const tmpDirs: string[] = []

/**
 * Create a monorepo-style git repository with:
 *  - packages/web/index.ts
 *  - packages/api/index.ts
 *  - root package.json
 *  - a bare remote set as `origin`
 *  - `main` branch pushed to origin
 *
 * Returns the repo root, bare remote, and the packages/web subdirectory path.
 */
function createMonorepoGitRepo(): {
  repoDir: string
  bareDir: string
  subDir: string
} {
  // Use realpathSync to resolve macOS /var → /private/var symlinks so paths
  // match what git rev-parse --show-toplevel and path.resolve() return.
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'astro-monorepo-test-')))
  const bareDir = realpathSync(mkdtempSync(join(tmpdir(), 'astro-monorepo-bare-')))
  tmpDirs.push(repoDir, bareDir)

  execFileSync('git', ['init', '--bare'], { cwd: bareDir })
  execFileSync('git', ['init'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], {
    cwd: repoDir,
  })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir })
  execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir })

  // Create monorepo structure
  mkdirSync(join(repoDir, 'packages', 'web'), { recursive: true })
  mkdirSync(join(repoDir, 'packages', 'api'), { recursive: true })
  writeFileSync(join(repoDir, 'package.json'), '{"name": "monorepo"}')
  writeFileSync(
    join(repoDir, 'packages', 'web', 'index.ts'),
    'export const web = true;',
  )
  writeFileSync(
    join(repoDir, 'packages', 'api', 'index.ts'),
    'export const api = true;',
  )

  execFileSync('git', ['add', '.'], { cwd: repoDir })
  execFileSync('git', ['commit', '-m', 'init monorepo'], { cwd: repoDir })
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir })

  return { repoDir, bareDir, subDir: join(repoDir, 'packages', 'web') }
}

/**
 * Create a temporary project directory populated with the given files.
 * Keys are relative paths; values are file contents.
 */
function createTestProject(files: Record<string, string | Buffer>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'astro-ref-test-')))
  tmpDirs.push(dir)
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dir, relativePath)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content)
  }
  return dir
}

/**
 * Recursively list all file paths relative to `root`.
 */
function listFilesRecursive(root: string, prefix = ''): string[] {
  const results: string[] = []
  if (!existsSync(root)) return results
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(join(root, entry.name), rel))
    } else {
      results.push(rel)
    }
  }
  return results.sort()
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
// 1 & 2. Monorepo worktree tests
// ===========================================================================

describe(
  'monorepo worktree (real git)',
  { timeout: 30_000 },
  () => {
    it('creates worktree at git root level with workingDirectory pointing to subdirectory', async () => {
      const { subDir } = createMonorepoGitRepo()

      const result = await createWorktree({
        workingDirectory: subDir,
        taskId: 'mono-task-1',
      })

      expect(result).not.toBeNull()
      const setup = result!

      // The worktree is created under {gitRoot}/.astro/worktrees/
      expect(setup.workingDirectory).toContain(
        join('.astro', 'worktrees', 'mono-task-1'),
      )

      // result.workingDirectory should point to packages/web/ within the worktree
      expect(setup.workingDirectory).toMatch(/packages\/web$/)

      // The worktree root (parent of packages/) should contain both packages
      const worktreeRoot = join(setup.workingDirectory, '..', '..')
      expect(existsSync(join(worktreeRoot, 'packages', 'web', 'index.ts'))).toBe(true)
      expect(existsSync(join(worktreeRoot, 'packages', 'api', 'index.ts'))).toBe(true)
      expect(existsSync(join(worktreeRoot, 'package.json'))).toBe(true)

      // Cleanup works
      await setup.cleanup()
      expect(existsSync(setup.workingDirectory)).toBe(false)
    })

    it('uses standard branch prefix for monorepo subdirectory tasks', async () => {
      const { subDir } = createMonorepoGitRepo()

      const result = await createWorktree({
        workingDirectory: subDir,
        taskId: 'mono-task-2',
      })

      expect(result).not.toBeNull()
      // Branch name should use the default "astro/" prefix
      expect(result!.branchName).toBe('astro/mono-task-2')

      await result!.cleanup()
    })
  },
)

// ===========================================================================
// 3, 4, 5. Reference mode tests
// ===========================================================================

describe(
  'reference mode (real filesystem)',
  { timeout: 30_000 },
  () => {
    it('creates empty worktree with correct file map entries', async () => {
      const projectDir = createTestProject({
        'src/main.ts': 'console.log("hello");',
        'src/lib/utils.ts': 'export const add = (a: number, b: number) => a + b;',
        'README.md': '# Test Project',
        'data/large.bin': Buffer.alloc(2_000_000, 0xff),
      })

      const result = await createReferenceWorktree(projectDir, '.astro', 'ref-test-1')

      // Worktree directory exists
      expect(existsSync(result.worktreePath)).toBe(true)

      // Worktree is empty (no files copied)
      const worktreeContents = listFilesRecursive(result.worktreePath)
      expect(worktreeContents).toEqual([])

      // File map contains entries for all source files
      expect(result.fileMap.length).toBe(4)

      const paths = result.fileMap.map((e) => e.relativePath).sort()
      expect(paths).toEqual([
        'README.md',
        'data/large.bin',
        'src/lib/utils.ts',
        'src/main.ts',
      ])

      // Each entry has relativePath, sizeBytes, and classification
      for (const entry of result.fileMap) {
        expect(entry).toHaveProperty('relativePath')
        expect(entry).toHaveProperty('sizeBytes')
        expect(entry).toHaveProperty('classification')
        expect(typeof entry.relativePath).toBe('string')
        expect(typeof entry.sizeBytes).toBe('number')
        expect(['code', 'data']).toContain(entry.classification)
      }

      // Verify classification: small files = code, large files = data
      const largeEntry = result.fileMap.find((e) => e.relativePath === 'data/large.bin')!
      expect(largeEntry.classification).toBe('data')
      expect(largeEntry.sizeBytes).toBe(2_000_000)

      const codeEntry = result.fileMap.find((e) => e.relativePath === 'src/main.ts')!
      expect(codeEntry.classification).toBe('code')

      await result.cleanup()
    })

    it('agent writes to worktree without affecting original source', async () => {
      const projectDir = createTestProject({
        'src/app.ts': 'run();',
        'README.md': '# Original',
      })

      const result = await createReferenceWorktree(projectDir, '.astro', 'ref-test-2')

      // Write a new file to the reference worktree
      const newFilePath = join(result.worktreePath, 'output.txt')
      mkdirSync(dirname(newFilePath), { recursive: true })
      writeFileSync(newFilePath, 'agent wrote this')

      // Write another file in a subdirectory
      const nestedPath = join(result.worktreePath, 'results', 'analysis.json')
      mkdirSync(dirname(nestedPath), { recursive: true })
      writeFileSync(nestedPath, '{"status": "done"}')

      // Files exist in the worktree
      expect(existsSync(newFilePath)).toBe(true)
      expect(readFileSync(newFilePath, 'utf-8')).toBe('agent wrote this')
      expect(existsSync(nestedPath)).toBe(true)

      // Files do NOT exist in the original source directory
      expect(existsSync(join(projectDir, 'output.txt'))).toBe(false)
      expect(existsSync(join(projectDir, 'results', 'analysis.json'))).toBe(false)

      // Original files are still intact
      expect(readFileSync(join(projectDir, 'src/app.ts'), 'utf-8')).toBe('run();')
      expect(readFileSync(join(projectDir, 'README.md'), 'utf-8')).toBe('# Original')

      await result.cleanup()
    })

    it('file map entries can be used to construct absolute paths to the original', async () => {
      const projectDir = createTestProject({
        'index.ts': 'export {};',
        'lib/helpers.ts': 'export const h = 1;',
        'config/settings.json': '{"debug": true}',
      })

      const result = await createReferenceWorktree(projectDir, '.astro', 'ref-test-3')

      // Every entry's relativePath can be joined with sourceDir to get an absolute path
      // that actually exists on disk
      for (const entry of result.fileMap) {
        const absPath = join(projectDir, entry.relativePath)
        expect(existsSync(absPath)).toBe(true)
      }

      // Verify we can actually read the file content through the absolute path
      const indexEntry = result.fileMap.find((e) => e.relativePath === 'index.ts')!
      const content = readFileSync(join(projectDir, indexEntry.relativePath), 'utf-8')
      expect(content).toBe('export {};')

      await result.cleanup()
    })
  },
)

// ===========================================================================
// 6. Default project directory
// ===========================================================================

describe(
  'default project directory',
  { timeout: 30_000 },
  () => {
    const defaultDirProjectId = `default-dir-test-${Date.now()}`
    const expectedDir = join(homedir(), '.astro', 'projects', defaultDirProjectId)

    afterAll(async () => {
      // Clean up the created directory
      try {
        await rm(expectedDir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    })

    it('creates ~/.astro/projects/{id}/ when no workingDirectory is given', () => {
      const result = setupProjectRepo({
        projectId: defaultDirProjectId,
        projectName: 'Default Dir Test',
      })

      // workingDirectory matches ~/.astro/projects/{projectId}
      expect(result.workingDirectory).toBe(expectedDir)

      // Directory exists on disk
      expect(existsSync(expectedDir)).toBe(true)

      // Has .astro/config.json (agent directory created)
      expect(existsSync(join(expectedDir, '.astro', 'config.json'))).toBe(true)

      // Is a git repo (has .git/)
      expect(existsSync(join(expectedDir, '.git'))).toBe(true)

      // Source is populated
      expect(result.source).toBeDefined()
      expect(result.source!.isGit).toBe(true)
    })
  },
)

// ===========================================================================
// 7. setupProjectRepo subdirectory detection (monorepo)
// ===========================================================================

describe(
  'setupProjectRepo subdirectory detection',
  { timeout: 30_000 },
  () => {
    it('detects subdirectory when workingDirectory is inside a monorepo', () => {
      const { subDir } = createMonorepoGitRepo()

      const result = setupProjectRepo({
        projectId: 'mono-detect',
        projectName: 'Mono',
        workingDirectory: subDir,
      })

      // source.subdirectory should be defined and equal 'packages/web'
      expect(result.source).toBeDefined()
      expect(result.source!.subdirectory).toBeDefined()
      expect(result.source!.subdirectory).toBe('packages/web')

      // source.isGit should be true
      expect(result.source!.isGit).toBe(true)
    })
  },
)
