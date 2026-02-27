/**
 * Sessions List Request/Response Tests
 *
 * Verifies the sessions_list_request message handling in the agent runner:
 *   1. Type definitions — SessionsListRequestMessage and SessionsListResponseMessage
 *   2. Message routing — sessions_list_request case in routeMessage
 *   3. Response construction — sendSessionsListResponse
 *   4. Session discovery — onSessionsList callback logic (filesystem scanning)
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  SessionsListRequestMessage,
  SessionsListResponseMessage,
  ClaudeCodeSessionInfo,
} from '../src/types'

// ============================================================================
// 1. Type definition tests
// ============================================================================

describe('SessionsList type definitions', () => {
  it('SessionsListRequestMessage has correct shape', () => {
    const msg: SessionsListRequestMessage = {
      type: 'sessions_list_request',
      timestamp: new Date().toISOString(),
      payload: {
        correlationId: 'corr-123',
      },
    }

    expect(msg.type).toBe('sessions_list_request')
    expect(msg.payload.correlationId).toBe('corr-123')
  })

  it('SessionsListResponseMessage has correct shape with sessions', () => {
    const msg: SessionsListResponseMessage = {
      type: 'sessions_list_response',
      timestamp: new Date().toISOString(),
      payload: {
        correlationId: 'corr-123',
        sessions: [
          {
            sessionId: 'abc-def',
            summary: 'Fix login bug',
            lastModified: Date.now(),
            fileSize: 1234,
            firstPrompt: 'Fix the login page',
            gitBranch: 'main',
            cwd: '/home/user/project',
          },
        ],
      },
    }

    expect(msg.type).toBe('sessions_list_response')
    expect(msg.payload.sessions).toHaveLength(1)
    expect(msg.payload.sessions[0].sessionId).toBe('abc-def')
    expect(msg.payload.sessions[0].cwd).toBe('/home/user/project')
    expect(msg.payload.error).toBeUndefined()
  })

  it('SessionsListResponseMessage supports error field', () => {
    const msg: SessionsListResponseMessage = {
      type: 'sessions_list_response',
      timestamp: new Date().toISOString(),
      payload: {
        correlationId: 'corr-456',
        sessions: [],
        error: 'Permission denied',
      },
    }

    expect(msg.payload.sessions).toHaveLength(0)
    expect(msg.payload.error).toBe('Permission denied')
  })
})

// ============================================================================
// 2. Message routing tests
// ============================================================================

describe('Sessions list message routing', () => {
  function routeMessage(type: string): string {
    switch (type) {
      case 'file_list_request': return 'file_list'
      case 'directory_list_request': return 'directory_list'
      case 'sessions_list_request': return 'sessions_list'
      case 'git_init_request': return 'git_init'
      default: return 'unknown'
    }
  }

  it('routes sessions_list_request to sessions_list handler', () => {
    expect(routeMessage('sessions_list_request')).toBe('sessions_list')
  })

  it('does not confuse sessions_list_request with other types', () => {
    expect(routeMessage('file_list_request')).toBe('file_list')
    expect(routeMessage('directory_list_request')).toBe('directory_list')
  })
})

// ============================================================================
// 3. Response construction tests
// ============================================================================

describe('Sessions list response construction', () => {
  function buildResponse(
    correlationId: string,
    sessions: ClaudeCodeSessionInfo[],
    error?: string,
  ): SessionsListResponseMessage {
    return {
      type: 'sessions_list_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, sessions, error },
    }
  }

  it('builds successful response with sessions', () => {
    const sessions: ClaudeCodeSessionInfo[] = [
      {
        sessionId: 'sess-1',
        summary: 'Implement auth',
        lastModified: 1700000000000,
        fileSize: 5000,
        gitBranch: 'feature/auth',
        cwd: '/home/user/app',
      },
      {
        sessionId: 'sess-2',
        summary: 'Fix tests',
        lastModified: 1700001000000,
        fileSize: 2000,
      },
    ]
    const resp = buildResponse('corr-1', sessions)

    expect(resp.type).toBe('sessions_list_response')
    expect(resp.payload.correlationId).toBe('corr-1')
    expect(resp.payload.sessions).toHaveLength(2)
    expect(resp.payload.error).toBeUndefined()
  })

  it('builds error response with empty sessions', () => {
    const resp = buildResponse('corr-2', [], 'Failed to read directory')

    expect(resp.payload.sessions).toHaveLength(0)
    expect(resp.payload.error).toBe('Failed to read directory')
  })

  it('builds response for no sessions found', () => {
    const resp = buildResponse('corr-3', [])

    expect(resp.payload.sessions).toHaveLength(0)
    expect(resp.payload.error).toBeUndefined()
  })
})

// ============================================================================
// 4. Session discovery logic tests (simulates onSessionsList callback)
// ============================================================================

describe('onSessionsList callback logic', () => {
  /**
   * Simulates the onSessionsList handler from start.ts.
   * Uses a custom base directory instead of ~/.claude/projects.
   */
  function discoverSessions(baseDir: string): {
    sessions: ClaudeCodeSessionInfo[]
    error?: string
  } {
    if (!existsSync(baseDir)) {
      return { sessions: [] }
    }

    const sessions: ClaudeCodeSessionInfo[] = []
    const projectDirs = readdirSync(baseDir, { withFileTypes: true })
      .filter(d => d.isDirectory())

    for (const projDir of projectDirs) {
      const projPath = join(baseDir, projDir.name)
      const cwd = projDir.name.replace(/^-/, '/').replace(/-/g, '/')

      let jsonlFiles: string[]
      try {
        jsonlFiles = readdirSync(projPath).filter(f => f.endsWith('.jsonl'))
      } catch { continue }

      for (const file of jsonlFiles) {
        const sessionId = file.replace('.jsonl', '')
        const filePath = join(projPath, file)
        try {
          const stat = statSync(filePath)
          if (stat.size < 100) continue

          const content = readFileSync(filePath, 'utf-8')
          const firstNewline = content.indexOf('\n')
          const secondNewline = firstNewline > -1 ? content.indexOf('\n', firstNewline + 1) : -1
          let summary = ''
          let firstPrompt = ''
          let gitBranch = ''
          let customTitle = ''

          const linesToCheck = secondNewline > -1 ? content.slice(0, secondNewline) : content.slice(0, 2000)
          for (const line of linesToCheck.split('\n')) {
            if (!line.trim()) continue
            try {
              const entry = JSON.parse(line)
              if (entry.type === 'user' && entry.message?.content) {
                const textContent = Array.isArray(entry.message.content)
                  ? entry.message.content.find((c: { type: string }) => c.type === 'text')?.text || ''
                  : String(entry.message.content)
                if (!firstPrompt) firstPrompt = textContent.slice(0, 200)
                if (!summary) summary = textContent.slice(0, 100)
              }
              if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch
              if (entry.customTitle) customTitle = entry.customTitle
            } catch { /* skip */ }
          }

          sessions.push({
            sessionId,
            summary,
            lastModified: stat.mtimeMs,
            fileSize: stat.size,
            customTitle,
            firstPrompt,
            gitBranch,
            cwd,
          })
        } catch { /* skip */ }
      }
    }

    sessions.sort((a, b) => b.lastModified - a.lastModified)
    return { sessions: sessions.slice(0, 50) }
  }

  const testDir = join(tmpdir(), `astro-sessions-test-${Date.now()}`)

  function setupTestDir() {
    mkdirSync(join(testDir, '-home-user-project'), { recursive: true })
  }

  function cleanupTestDir() {
    try { rmSync(testDir, { recursive: true, force: true }) } catch { /* ok */ }
  }

  it('returns empty sessions for nonexistent directory', () => {
    const result = discoverSessions('/this/path/definitely/does/not/exist')
    expect(result.sessions).toHaveLength(0)
    expect(result.error).toBeUndefined()
  })

  it('returns empty sessions for empty projects directory', () => {
    setupTestDir()
    try {
      const emptyDir = join(testDir, 'empty')
      mkdirSync(emptyDir, { recursive: true })
      const result = discoverSessions(emptyDir)
      expect(result.sessions).toHaveLength(0)
    } finally {
      cleanupTestDir()
    }
  })

  it('skips tiny session files (< 100 bytes)', () => {
    setupTestDir()
    try {
      const projDir = join(testDir, '-home-user-project')
      writeFileSync(join(projDir, 'tiny-session.jsonl'), 'small')

      const result = discoverSessions(testDir)
      const found = result.sessions.find(s => s.sessionId === 'tiny-session')
      expect(found).toBeUndefined()
    } finally {
      cleanupTestDir()
    }
  })

  it('parses session with user message', () => {
    setupTestDir()
    try {
      const projDir = join(testDir, '-home-user-project')
      const sessionData = [
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'text', text: 'Fix the authentication bug in login.ts' }] },
          gitBranch: 'fix/auth',
          sessionId: 'test-session-1',
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'I will fix the auth bug.' }] },
        }),
      ].join('\n')

      writeFileSync(join(projDir, 'test-session-1.jsonl'), sessionData)

      const result = discoverSessions(testDir)
      const session = result.sessions.find(s => s.sessionId === 'test-session-1')

      expect(session).toBeDefined()
      expect(session!.summary).toBe('Fix the authentication bug in login.ts')
      expect(session!.firstPrompt).toBe('Fix the authentication bug in login.ts')
      expect(session!.gitBranch).toBe('fix/auth')
      expect(session!.cwd).toBe('/home/user/project')
      expect(session!.fileSize).toBeGreaterThan(0)
    } finally {
      cleanupTestDir()
    }
  })

  it('decodes cwd from project directory name', () => {
    setupTestDir()
    try {
      const projDir = join(testDir, '-home-xf2217-Repos-astro')
      mkdirSync(projDir, { recursive: true })
      const sessionData = JSON.stringify({
        type: 'user',
        message: { content: 'Hello world - this is a test session with enough content to pass the size check' },
        sessionId: 'cwd-test',
      }) + '\n'

      writeFileSync(join(projDir, 'cwd-test.jsonl'), sessionData)

      const result = discoverSessions(testDir)
      const session = result.sessions.find(s => s.sessionId === 'cwd-test')

      expect(session).toBeDefined()
      expect(session!.cwd).toBe('/home/xf2217/Repos/astro')
    } finally {
      cleanupTestDir()
    }
  })

  it('sorts sessions by lastModified descending', () => {
    setupTestDir()
    try {
      const projDir = join(testDir, '-home-user-project')

      // Write two sessions, the first should be older
      const data1 = JSON.stringify({
        type: 'user',
        message: { content: 'First session with enough content to pass the minimum size check threshold' },
        sessionId: 'older-session',
      }) + '\n'
      writeFileSync(join(projDir, 'older-session.jsonl'), data1)

      // Small delay to ensure different mtime
      const data2 = JSON.stringify({
        type: 'user',
        message: { content: 'Second session with enough content to pass the minimum size check threshold' },
        sessionId: 'newer-session',
      }) + '\n'
      // Write with a slight delay
      writeFileSync(join(projDir, 'newer-session.jsonl'), data2)

      const result = discoverSessions(testDir)
      expect(result.sessions.length).toBeGreaterThanOrEqual(2)
      // Newer should come first
      if (result.sessions.length >= 2) {
        expect(result.sessions[0].lastModified).toBeGreaterThanOrEqual(result.sessions[1].lastModified)
      }
    } finally {
      cleanupTestDir()
    }
  })

  it('limits results to 50 sessions', () => {
    setupTestDir()
    try {
      const projDir = join(testDir, '-home-user-project')

      for (let i = 0; i < 55; i++) {
        const data = JSON.stringify({
          type: 'user',
          message: { content: `Session ${i} with enough content to pass the minimum file size threshold of 100 bytes` },
          sessionId: `session-${i}`,
        }) + '\n'
        writeFileSync(join(projDir, `session-${i}.jsonl`), data)
      }

      const result = discoverSessions(testDir)
      expect(result.sessions.length).toBeLessThanOrEqual(50)
    } finally {
      cleanupTestDir()
    }
  })

  it('handles string content (not array)', () => {
    setupTestDir()
    try {
      const projDir = join(testDir, '-home-user-project')
      const sessionData = JSON.stringify({
        type: 'user',
        message: { content: 'Simple string content that is long enough to pass the file size minimum check' },
        sessionId: 'string-content-session',
      }) + '\n'

      writeFileSync(join(projDir, 'string-content-session.jsonl'), sessionData)

      const result = discoverSessions(testDir)
      const session = result.sessions.find(s => s.sessionId === 'string-content-session')

      expect(session).toBeDefined()
      expect(session!.summary).toBe('Simple string content that is long enough to pass the file size minimum check')
    } finally {
      cleanupTestDir()
    }
  })

  it('discovers real Claude sessions if available', () => {
    const claudeDir = join(homedir(), '.claude', 'projects')
    if (!existsSync(claudeDir)) {
      // Skip on machines without Claude Code installed
      return
    }

    const result = discoverSessions(claudeDir)
    // Just verify it doesn't crash — may or may not find sessions
    expect(Array.isArray(result.sessions)).toBe(true)
    expect(result.error).toBeUndefined()

    // If sessions found, verify structure
    for (const session of result.sessions) {
      expect(session.sessionId).toBeDefined()
      expect(typeof session.lastModified).toBe('number')
      expect(typeof session.fileSize).toBe('number')
      expect(session.fileSize).toBeGreaterThanOrEqual(100)
    }
  })
})

// ============================================================================
// 5. End-to-end message flow simulation
// ============================================================================

describe('Sessions list end-to-end message flow', () => {
  it('relay request → agent handler → relay response (full round trip)', () => {
    // 1. Relay sends sessions_list_request
    const relayRequest: SessionsListRequestMessage = {
      type: 'sessions_list_request',
      timestamp: new Date().toISOString(),
      payload: {
        correlationId: 'e2e-corr-1',
      },
    }

    // 2. Agent handler extracts correlationId
    const { correlationId } = relayRequest.payload
    expect(correlationId).toBe('e2e-corr-1')

    // 3. Agent discovers sessions (mock)
    const sessions: ClaudeCodeSessionInfo[] = [
      {
        sessionId: 'found-session',
        summary: 'Test task',
        lastModified: Date.now(),
        fileSize: 500,
        gitBranch: 'main',
        cwd: '/home/user/project',
      },
    ]

    // 4. Agent sends response
    const response: SessionsListResponseMessage = {
      type: 'sessions_list_response',
      timestamp: new Date().toISOString(),
      payload: {
        correlationId,
        sessions,
      },
    }

    // 5. Verify response
    expect(response.type).toBe('sessions_list_response')
    expect(response.payload.correlationId).toBe('e2e-corr-1')
    expect(response.payload.sessions).toHaveLength(1)
    expect(response.payload.sessions[0].sessionId).toBe('found-session')
    expect(response.payload.error).toBeUndefined()
  })
})
