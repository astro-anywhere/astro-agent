/**
 * Tests for WORKSPACE_V2.md section 13 scenarios:
 *
 * 1. parseGitignoreContent — pattern parsing
 * 2. isIgnoredByPattern — pattern matching
 * 3. createCopyWorktree with .gitignore — excludes ignored files
 * 4. createCopyWorktree without .gitignore — copies everything (except hardcoded)
 * 5. applyChangesFromCopy — diff-and-apply for created, modified, deleted files
 * 6. POST /api/repo/git-init — initializes git in a non-git directory
 * 7. GET /api/repo/detect?path=... — returns dirSizeMB for non-git dirs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestServer, postJson, request } from '../helpers/test-server.js'
import {
  createCopyWorktree,
  applyChangesFromCopy,
  parseGitignoreContent,
  isIgnoredByPattern,
  loadGitignorePatterns,
} from '../src/lib/copy-worktree.js'
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = []

/**
 * Create a temporary project directory populated with the given files.
 * Keys are relative paths; values are file contents (string or Buffer).
 */
function createTestProject(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'astro-gitignore-test-'))
  tmpDirs.push(dir)
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dir, relativePath)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content)
  }
  return dir
}

// ---------------------------------------------------------------------------
// Server setup (for route tests)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupTestServer()
})

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
// parseGitignoreContent
// ===========================================================================

describe('parseGitignoreContent', () => {
  it('parses patterns, strips comments, blank lines, and negation patterns', () => {
    const content = [
      '# This is a comment',
      '',
      '*.pyc',
      '  # Another comment with leading spaces  ',
      'dist/',
      '',
      '!important.pyc',
      'build/',
      '  *.log  ',
    ].join('\n')

    const patterns = parseGitignoreContent(content)

    expect(patterns).toEqual(['*.pyc', 'dist/', 'build/', '*.log'])
    // Comments stripped
    expect(patterns).not.toContain('# This is a comment')
    // Negation stripped
    expect(patterns).not.toContain('!important.pyc')
  })

  it('returns empty array for empty content', () => {
    expect(parseGitignoreContent('')).toEqual([])
    expect(parseGitignoreContent('\n\n\n')).toEqual([])
    expect(parseGitignoreContent('# only comments\n# here')).toEqual([])
  })
})

// ===========================================================================
// isIgnoredByPattern
// ===========================================================================

describe('isIgnoredByPattern', () => {
  it('matches simple wildcard patterns (*.pyc matches foo/bar.pyc)', () => {
    const patterns = ['*.pyc']
    expect(isIgnoredByPattern('foo/bar.pyc', patterns, false)).toBe(true)
    expect(isIgnoredByPattern('bar.pyc', patterns, false)).toBe(true)
    expect(isIgnoredByPattern('deep/nested/thing.pyc', patterns, false)).toBe(true)
  })

  it('matches directory patterns with trailing / (dist/ matches directory but not file)', () => {
    const patterns = ['dist/']
    // Directory named dist — should match
    expect(isIgnoredByPattern('dist', patterns, true)).toBe(true)
    // File named dist — should NOT match (trailing / means dir-only)
    expect(isIgnoredByPattern('dist', patterns, false)).toBe(false)
    // A nested directory named dist — should match (un-anchored)
    expect(isIgnoredByPattern('src/dist', patterns, true)).toBe(true)
  })

  it('matches anchored patterns (/build matches build but not src/build)', () => {
    const patterns = ['/build']
    // Root-level build — should match
    expect(isIgnoredByPattern('build', patterns, false)).toBe(true)
    expect(isIgnoredByPattern('build', patterns, true)).toBe(true)
    // Nested build — should NOT match (anchored to root)
    expect(isIgnoredByPattern('src/build', patterns, false)).toBe(false)
    expect(isIgnoredByPattern('src/build', patterns, true)).toBe(false)
  })

  it('does NOT match non-matching paths', () => {
    const patterns = ['*.pyc', 'dist/', '/build']
    expect(isIgnoredByPattern('src/main.ts', patterns, false)).toBe(false)
    expect(isIgnoredByPattern('README.md', patterns, false)).toBe(false)
    expect(isIgnoredByPattern('app.js', patterns, false)).toBe(false)
    expect(isIgnoredByPattern('src', patterns, true)).toBe(false)
  })
})

// ===========================================================================
// loadGitignorePatterns
// ===========================================================================

describe('loadGitignorePatterns', () => {
  it('loads patterns from .gitignore file', async () => {
    const dir = createTestProject({
      '.gitignore': '*.log\ndist/\n# comment\n',
    })
    const patterns = await loadGitignorePatterns(dir)
    expect(patterns).toEqual(['*.log', 'dist/'])
  })

  it('returns empty array when no .gitignore exists', async () => {
    const dir = createTestProject({
      'app.ts': 'console.log("hello")',
    })
    const patterns = await loadGitignorePatterns(dir)
    expect(patterns).toEqual([])
  })
})

// ===========================================================================
// createCopyWorktree with .gitignore
// ===========================================================================

describe('createCopyWorktree with .gitignore', () => {
  it('excludes files matching .gitignore patterns', async () => {
    const projectDir = createTestProject({
      '.gitignore': '*.log\ndist/\n',
      'app.ts': 'console.log("hello")',
      'error.log': 'some error output',
      'dist/bundle.js': 'bundled code',
      'src/utils.ts': 'export const x = 1',
    })

    const result = await createCopyWorktree(projectDir, '.astro', 'gitignore-test-1')

    // app.ts and src/utils.ts should be copied
    expect(existsSync(join(result.worktreePath, 'app.ts'))).toBe(true)
    expect(existsSync(join(result.worktreePath, 'src/utils.ts'))).toBe(true)

    // .gitignore itself should be copied (it's not in its own ignore list)
    expect(existsSync(join(result.worktreePath, '.gitignore'))).toBe(true)

    // error.log should NOT be copied (matches *.log)
    expect(existsSync(join(result.worktreePath, 'error.log'))).toBe(false)

    // dist/ directory should NOT be copied (matches dist/)
    expect(existsSync(join(result.worktreePath, 'dist'))).toBe(false)
    expect(existsSync(join(result.worktreePath, 'dist/bundle.js'))).toBe(false)

    await result.cleanup()
  })
})

// ===========================================================================
// createCopyWorktree without .gitignore
// ===========================================================================

describe('createCopyWorktree without .gitignore', () => {
  it('copies all files except hardcoded exclusions (.git, node_modules, agent dir)', async () => {
    const projectDir = createTestProject({
      'app.ts': 'console.log("hello")',
      'data.log': 'some log data',
      'dist/bundle.js': 'bundled code',
      'src/utils.ts': 'export const x = 1',
      '.git/HEAD': 'ref: refs/heads/main',
      'node_modules/pkg/index.js': 'module.exports = {}',
      '.astro/config.json': '{}',
    })

    const result = await createCopyWorktree(projectDir, '.astro', 'no-gitignore-test')

    // All non-excluded files should be copied
    expect(existsSync(join(result.worktreePath, 'app.ts'))).toBe(true)
    expect(existsSync(join(result.worktreePath, 'data.log'))).toBe(true)
    expect(existsSync(join(result.worktreePath, 'dist/bundle.js'))).toBe(true)
    expect(existsSync(join(result.worktreePath, 'src/utils.ts'))).toBe(true)

    // Hardcoded exclusions should NOT be copied
    expect(existsSync(join(result.worktreePath, '.git'))).toBe(false)
    expect(existsSync(join(result.worktreePath, 'node_modules'))).toBe(false)
    expect(existsSync(join(result.worktreePath, '.astro'))).toBe(false)

    await result.cleanup()
  })
})

// ===========================================================================
// applyChangesFromCopy
// ===========================================================================

describe('applyChangesFromCopy', () => {
  it('detects created, modified, and deleted files correctly', async () => {
    // Set up the "original" directory
    const originalDir = createTestProject({
      'existing.txt': 'original content',
      'unchanged.txt': 'same in both',
      'deleted.txt': 'this file will be deleted from worktree',
    })

    // Set up the "worktree" directory (simulates agent changes)
    const worktreeDir = createTestProject({
      'existing.txt': 'modified content',      // modified
      'unchanged.txt': 'same in both',          // unchanged
      'created.txt': 'brand new file',          // created (not in original)
      // deleted.txt is absent — simulating deletion
    })

    const result = await applyChangesFromCopy(worktreeDir, originalDir, '.astro')

    // Verify detected changes
    expect(result.created).toContain('created.txt')
    expect(result.modified).toContain('existing.txt')
    expect(result.deleted).toContain('deleted.txt')

    // unchanged.txt should NOT appear in any list
    expect(result.created).not.toContain('unchanged.txt')
    expect(result.modified).not.toContain('unchanged.txt')
    expect(result.deleted).not.toContain('unchanged.txt')

    // Verify on-disk effects:
    // New file was actually copied to original
    expect(existsSync(join(originalDir, 'created.txt'))).toBe(true)
    expect(readFileSync(join(originalDir, 'created.txt'), 'utf-8')).toBe('brand new file')

    // Modified file was updated in original
    expect(readFileSync(join(originalDir, 'existing.txt'), 'utf-8')).toBe('modified content')

    // Deleted file is reported but NOT actually deleted from original
    expect(existsSync(join(originalDir, 'deleted.txt'))).toBe(true)
    expect(readFileSync(join(originalDir, 'deleted.txt'), 'utf-8')).toBe(
      'this file will be deleted from worktree',
    )
  })

  it('excludes agent dir from comparison', async () => {
    const originalDir = createTestProject({
      'app.ts': 'original',
      '.astro/config.json': '{}',
    })

    const worktreeDir = createTestProject({
      'app.ts': 'original',
      '.astro/config.json': '{"changed": true}',
      '.astro/worktrees/task-1/output.txt': 'agent output',
    })

    const result = await applyChangesFromCopy(worktreeDir, originalDir, '.astro')

    // Agent dir changes should be excluded from all lists
    expect(result.created).not.toContain('.astro/config.json')
    expect(result.modified).not.toContain('.astro/config.json')
    expect(result.created).not.toContain('.astro/worktrees/task-1/output.txt')

    // No changes should be detected (only agent dir differs)
    expect(result.created).toHaveLength(0)
    expect(result.modified).toHaveLength(0)
    expect(result.deleted).toHaveLength(0)
  })
})

// ===========================================================================
// POST /api/repo/git-init
// ===========================================================================

describe('POST /api/repo/git-init', () => {
  it('initializes git in a non-git directory and returns source with isGit=true', async () => {
    const dir = createTestProject({
      'main.py': 'print("hello")',
      'data/input.csv': 'a,b,c\n1,2,3',
    })

    const res = await postJson('/api/repo/git-init', {
      workingDirectory: dir,
      projectId: 'test-git-init-1',
      projectName: 'Git Init Test',
    })

    expect(res.status).toBe(200)

    const body = await res.json()

    // Directory should now have a .git folder
    expect(existsSync(join(dir, '.git'))).toBe(true)

    // Response should have source info indicating it is now a git repo
    expect(body.source).toBeDefined()
    expect(body.source.isGit).toBe(true)

    // Should have working directory set
    expect(body.workingDirectory).toBe(dir)

    // Should return file tree (git ls-files output)
    expect(body.fileTree).toBeDefined()
    expect(Array.isArray(body.fileTree)).toBe(true)
  })
})

// ===========================================================================
// GET /api/repo/detect — dirSizeMB
// ===========================================================================

describe('GET /api/repo/detect — dirSizeMB', () => {
  it('returns dirSizeMB as a positive number for non-git directories', async () => {
    const dir = createTestProject({
      'file1.txt': 'some content for size calculation',
      'file2.txt': 'more content to ensure non-zero size',
      'subdir/nested.txt': 'nested file content',
    })

    const res = await request(`/api/repo/detect?path=${encodeURIComponent(dir)}`)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.exists).toBe(true)
    expect(body.isGit).toBe(false)
    expect(typeof body.dirSizeMB).toBe('number')
    expect(body.dirSizeMB).toBeGreaterThan(0)
  })

  it('returns exists:false and no dirSizeMB for non-existent paths', async () => {
    const nonExistentPath = join(tmpdir(), 'astro-nonexistent-' + Date.now())

    const res = await request(`/api/repo/detect?path=${encodeURIComponent(nonExistentPath)}`)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.exists).toBe(false)
    expect(body.dirSizeMB).toBeUndefined()
  })
})
