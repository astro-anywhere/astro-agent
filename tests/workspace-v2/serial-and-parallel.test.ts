/**
 * Serial & Parallel execution tests for Workspace V2 (WORKSPACE_V2.md §13)
 *
 * 1. Direct-mode serial constraint: dispatch returns 409 when a task is already active.
 * 2. Parallel copy-mode: concurrent copy worktrees coexist without conflict.
 *
 * Uses PGlite-backed test server for dispatch route tests and real
 * temporary directories for copy-worktree tests.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupTestServer, postJson } from '../helpers/test-server.js'
import { db } from '../../server/lib/db/index.js'
import { dispatchQueueEntries } from '../../server/lib/db/schema.js'
import { createCopyWorktree } from '../src/lib/copy-worktree.js'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
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

function createTestProject(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'astro-serial-test-'))
  tmpDirs.push(dir)
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dir, relativePath)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content)
  }
  return dir
}

/** IDs of dispatch_queue_entries inserted during tests, for cleanup. */
const insertedEntryIds: string[] = []

/**
 * Insert a fake dispatch queue entry for a given projectId and status.
 * This simulates a task in the specified state.
 */
async function insertQueueEntry(projectId: string, status = 'dispatched'): Promise<string> {
  const id = `entry-${randomUUID()}`
  await db.insert(dispatchQueueEntries).values({
    id,
    nodeId: `node-${id}`,
    projectId,
    status,
    priority: 'normal',
    retryCount: 0,
    maxRetries: 2,
  })
  insertedEntryIds.push(id)
  return id
}

// ---------------------------------------------------------------------------
// Setup & Cleanup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupTestServer()
})

afterEach(async () => {
  // Clean up inserted dispatch queue entries
  for (const id of insertedEntryIds) {
    try {
      await db.delete(dispatchQueueEntries).where(eq(dispatchQueueEntries.id, id))
    } catch {
      // best-effort
    }
  }
  insertedEntryIds.length = 0
})

afterAll(async () => {
  for (const dir of tmpDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

// ===========================================================================
// A. Direct-mode serial execution constraint (POST /api/dispatch/task)
// ===========================================================================

describe('Direct-mode serial execution constraint', { timeout: 30_000 }, () => {
  /** Build a dispatch request body. Non-dryRun so the serial check is exercised. */
  const makeBody = (projectId: string, deliveryMode: string) => ({
    nodeId: `node-${randomUUID()}`,
    projectId,
    title: 'Test task',
    description: 'Test task description',
    workingDirectory: '/tmp/test-serial',
    deliveryMode,
  })

  it('returns 409 when a dispatched entry exists for the same project in direct mode', async () => {
    const projectId = randomUUID()

    // Simulate an active task for this project
    await insertQueueEntry(projectId, 'dispatched')

    // Attempt to dispatch another task with deliveryMode=direct
    const res = await postJson('/api/dispatch/task', makeBody(projectId, 'direct'))

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toContain('Serial execution required')
  })

  it('returns 409 when an in_progress entry exists for the same project in direct mode', async () => {
    const projectId = randomUUID()

    // Simulate an in_progress task
    await insertQueueEntry(projectId, 'in_progress')

    const res = await postJson('/api/dispatch/task', makeBody(projectId, 'direct'))

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toContain('Serial execution required')
  })

  it('does NOT return 409 for a different projectId in direct mode', async () => {
    const blockedProjectId = randomUUID()
    const freeProjectId = randomUUID()

    // Active entry exists only for blockedProjectId
    await insertQueueEntry(blockedProjectId, 'dispatched')

    // Dispatch for a different project should not trigger the serial constraint.
    // It may fail for other reasons (no machine available), but NOT with 409.
    const res = await postJson('/api/dispatch/task', makeBody(freeProjectId, 'direct'))

    expect(res.status).not.toBe(409)
  })

  it('does NOT return 409 for non-direct delivery modes even with active tasks', async () => {
    const projectId = randomUUID()

    // Active entry exists for this project
    await insertQueueEntry(projectId, 'dispatched')

    // Dispatch with deliveryMode=pr -- should not trigger the serial constraint
    const res = await postJson('/api/dispatch/task', makeBody(projectId, 'pr'))

    expect(res.status).not.toBe(409)
  })

  it('does NOT return 409 for copy delivery mode even with active tasks', async () => {
    const projectId = randomUUID()

    // Active entry exists for this project
    await insertQueueEntry(projectId, 'dispatched')

    // Dispatch with deliveryMode=copy -- should not trigger the serial constraint
    const res = await postJson('/api/dispatch/task', makeBody(projectId, 'copy'))

    expect(res.status).not.toBe(409)
  })

  it('does NOT return 409 when the only entries are completed/failed/cancelled', async () => {
    const projectId = randomUUID()

    // Insert entries that are NOT active (completed, failed, cancelled)
    await insertQueueEntry(projectId, 'completed')
    await insertQueueEntry(projectId, 'failed')
    await insertQueueEntry(projectId, 'cancelled')

    const res = await postJson('/api/dispatch/task', makeBody(projectId, 'direct'))

    // Should not be blocked by the serial constraint
    expect(res.status).not.toBe(409)
  })
})

// ===========================================================================
// B. Parallel copy worktrees
// ===========================================================================

describe('Parallel copy worktrees', { timeout: 30_000 }, () => {
  it('two tasks create concurrent copy worktrees without conflict', async () => {
    const projectDir = createTestProject({
      'src/index.ts': 'export const main = () => "hello";',
      'src/utils.ts': 'export const add = (a: number, b: number) => a + b;',
      'README.md': '# My Project',
      'config.json': '{"key": "value"}',
    })

    // Create two copy worktrees for different tasks in the same project
    const [wt1, wt2] = await Promise.all([
      createCopyWorktree(projectDir, '.astro', 'task-alpha'),
      createCopyWorktree(projectDir, '.astro', 'task-beta'),
    ])

    // Both worktrees should exist at different paths
    expect(wt1.worktreePath).not.toBe(wt2.worktreePath)
    expect(existsSync(wt1.worktreePath)).toBe(true)
    expect(existsSync(wt2.worktreePath)).toBe(true)

    // Both should contain the same source files
    for (const wt of [wt1, wt2]) {
      expect(existsSync(join(wt.worktreePath, 'src/index.ts'))).toBe(true)
      expect(existsSync(join(wt.worktreePath, 'src/utils.ts'))).toBe(true)
      expect(existsSync(join(wt.worktreePath, 'README.md'))).toBe(true)
      expect(existsSync(join(wt.worktreePath, 'config.json'))).toBe(true)
    }

    // File contents should match source
    expect(readFileSync(join(wt1.worktreePath, 'src/index.ts'), 'utf-8')).toBe(
      'export const main = () => "hello";',
    )
    expect(readFileSync(join(wt2.worktreePath, 'src/index.ts'), 'utf-8')).toBe(
      'export const main = () => "hello";',
    )

    // Modifications in one worktree should NOT affect the other
    writeFileSync(join(wt1.worktreePath, 'src/index.ts'), 'export const main = () => "modified";')
    expect(readFileSync(join(wt2.worktreePath, 'src/index.ts'), 'utf-8')).toBe(
      'export const main = () => "hello";',
    )

    // Neither worktree should contain the agent directory
    expect(existsSync(join(wt1.worktreePath, '.astro'))).toBe(false)
    expect(existsSync(join(wt2.worktreePath, '.astro'))).toBe(false)

    // Clean up
    await wt1.cleanup()
    await wt2.cleanup()
  })

  it('cleanup of one worktree does not affect the other', async () => {
    const projectDir = createTestProject({
      'app.py': 'print("hello")',
      'lib/helper.py': 'def greet(): return "hi"',
    })

    const wt1 = await createCopyWorktree(projectDir, '.astro', 'task-one')
    const wt2 = await createCopyWorktree(projectDir, '.astro', 'task-two')

    // Both exist
    expect(existsSync(wt1.worktreePath)).toBe(true)
    expect(existsSync(wt2.worktreePath)).toBe(true)

    // Clean up only wt1
    await wt1.cleanup()

    // wt1 should be gone
    expect(existsSync(wt1.worktreePath)).toBe(false)

    // wt2 should still exist with all files intact
    expect(existsSync(wt2.worktreePath)).toBe(true)
    expect(existsSync(join(wt2.worktreePath, 'app.py'))).toBe(true)
    expect(existsSync(join(wt2.worktreePath, 'lib/helper.py'))).toBe(true)
    expect(readFileSync(join(wt2.worktreePath, 'app.py'), 'utf-8')).toBe('print("hello")')

    // The parent worktrees directory should still exist
    const worktreesDir = join(projectDir, '.astro', 'worktrees')
    expect(existsSync(worktreesDir)).toBe(true)

    // Clean up wt2
    await wt2.cleanup()
    expect(existsSync(wt2.worktreePath)).toBe(false)
  })
})
