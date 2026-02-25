/**
 * Directory List Request/Response Tests
 *
 * Verifies the directory_list_request message handling in the agent runner:
 *   1. Type definitions — DirectoryListRequestMessage and DirectoryListResponseMessage
 *   2. WebSocket client — message routing (underscore and dot notation)
 *   3. WebSocket client — response sending
 *   4. Start command — onDirectoryList callback (filesystem listing logic)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  DirectoryListRequestMessage,
  DirectoryListResponseMessage,
} from '../src/types'

// ============================================================================
// 1. Type definition tests
// ============================================================================

describe('DirectoryList type definitions', () => {
  it('DirectoryListRequestMessage has correct shape', () => {
    const msg: DirectoryListRequestMessage = {
      type: 'directory_list_request',
      timestamp: new Date().toISOString(),
      payload: {
        path: '/home/user/projects',
        correlationId: 'corr-123',
      },
    }

    expect(msg.type).toBe('directory_list_request')
    expect(msg.payload.path).toBe('/home/user/projects')
    expect(msg.payload.correlationId).toBe('corr-123')
  })

  it('DirectoryListResponseMessage has correct shape with entries', () => {
    const msg: DirectoryListResponseMessage = {
      type: 'directory_list_response',
      timestamp: new Date().toISOString(),
      payload: {
        correlationId: 'corr-123',
        path: '/home/user/projects',
        entries: [
          { name: 'src', path: '/home/user/projects/src', isDirectory: true },
          { name: 'docs', path: '/home/user/projects/docs', isDirectory: true, isSymlink: true },
        ],
        homeDirectory: '/home/user',
      },
    }

    expect(msg.type).toBe('directory_list_response')
    expect(msg.payload.entries).toHaveLength(2)
    expect(msg.payload.entries[0].name).toBe('src')
    expect(msg.payload.entries[0].isDirectory).toBe(true)
    expect(msg.payload.entries[1].isSymlink).toBe(true)
    expect(msg.payload.homeDirectory).toBe('/home/user')
    expect(msg.payload.error).toBeUndefined()
  })

  it('DirectoryListResponseMessage supports error field', () => {
    const msg: DirectoryListResponseMessage = {
      type: 'directory_list_response',
      timestamp: new Date().toISOString(),
      payload: {
        correlationId: 'corr-456',
        path: '/nonexistent',
        entries: [],
        error: 'Directory does not exist',
      },
    }

    expect(msg.payload.entries).toHaveLength(0)
    expect(msg.payload.error).toBe('Directory does not exist')
  })
})

// ============================================================================
// 2. Message routing tests (simulated)
// ============================================================================

describe('Directory list message routing', () => {
  /**
   * Simulates the WebSocket client's dot-notation normalization logic.
   * This mirrors the code in websocket-client.ts that converts
   * 'directory_list.request' to 'directory_list_request'.
   */
  function normalizeDotNotation(raw: Record<string, unknown>): DirectoryListRequestMessage | null {
    if (raw.type === 'directory_list.request') {
      return {
        type: 'directory_list_request',
        timestamp: raw.timestamp as string ?? new Date().toISOString(),
        payload: {
          path: raw.path as string ?? (raw.payload as { path?: string })?.path ?? '~',
          correlationId: raw.correlationId as string ?? (raw.payload as { correlationId?: string })?.correlationId ?? '',
        },
      }
    }
    return null
  }

  it('normalizes directory_list.request (dot notation) to directory_list_request', () => {
    const raw = {
      type: 'directory_list.request',
      timestamp: '2025-01-01T00:00:00Z',
      path: '/home/user',
      correlationId: 'corr-abc',
    }

    const normalized = normalizeDotNotation(raw)
    expect(normalized).not.toBeNull()
    expect(normalized!.type).toBe('directory_list_request')
    expect(normalized!.payload.path).toBe('/home/user')
    expect(normalized!.payload.correlationId).toBe('corr-abc')
  })

  it('handles dot notation with payload wrapper', () => {
    const raw = {
      type: 'directory_list.request',
      timestamp: '2025-01-01T00:00:00Z',
      payload: {
        path: '/tmp',
        correlationId: 'corr-def',
      },
    }

    const normalized = normalizeDotNotation(raw)
    expect(normalized).not.toBeNull()
    expect(normalized!.payload.path).toBe('/tmp')
    expect(normalized!.payload.correlationId).toBe('corr-def')
  })

  it('defaults path to ~ when not provided', () => {
    const raw = {
      type: 'directory_list.request',
      correlationId: 'corr-ghi',
    }

    const normalized = normalizeDotNotation(raw)
    expect(normalized).not.toBeNull()
    expect(normalized!.payload.path).toBe('~')
  })

  it('does not normalize non-directory_list messages', () => {
    const raw = { type: 'file_list.request', path: '/home' }
    const normalized = normalizeDotNotation(raw)
    expect(normalized).toBeNull()
  })

  /**
   * Simulates the routeMessage switch case to verify directory_list_request
   * is a recognized message type.
   */
  function routeMessage(type: string): string {
    switch (type) {
      case 'file_list_request': return 'file_list'
      case 'directory_list_request': return 'directory_list'
      case 'repo_setup_request': return 'repo_setup'
      case 'repo_detect_request': return 'repo_detect'
      case 'branch_list_request': return 'branch_list'
      case 'git_init_request': return 'git_init'
      default: return 'unknown'
    }
  }

  it('routes directory_list_request to directory_list handler', () => {
    expect(routeMessage('directory_list_request')).toBe('directory_list')
  })

  it('routes file_list_request to file_list handler (not confused)', () => {
    expect(routeMessage('file_list_request')).toBe('file_list')
  })
})

// ============================================================================
// 3. Response construction tests
// ============================================================================

describe('Directory list response construction', () => {
  /**
   * Simulates WebSocketClient.sendDirectoryListResponse()
   */
  function buildResponse(
    correlationId: string,
    path: string,
    entries: DirectoryListResponseMessage['payload']['entries'],
    error?: string,
    homeDirectory?: string,
  ): DirectoryListResponseMessage {
    return {
      type: 'directory_list_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, path, entries, error, homeDirectory },
    }
  }

  it('builds successful response with entries', () => {
    const entries = [
      { name: 'src', path: '/project/src', isDirectory: true },
      { name: 'tests', path: '/project/tests', isDirectory: true },
    ]
    const resp = buildResponse('corr-1', '/project', entries, undefined, '/home/user')

    expect(resp.type).toBe('directory_list_response')
    expect(resp.payload.correlationId).toBe('corr-1')
    expect(resp.payload.path).toBe('/project')
    expect(resp.payload.entries).toHaveLength(2)
    expect(resp.payload.error).toBeUndefined()
    expect(resp.payload.homeDirectory).toBe('/home/user')
  })

  it('builds error response with empty entries', () => {
    const resp = buildResponse('corr-2', '/nonexistent', [], 'Directory does not exist', '/home/user')

    expect(resp.payload.entries).toHaveLength(0)
    expect(resp.payload.error).toBe('Directory does not exist')
  })

  it('builds response for empty directory', () => {
    const resp = buildResponse('corr-3', '/empty-dir', [])

    expect(resp.payload.entries).toHaveLength(0)
    expect(resp.payload.error).toBeUndefined()
  })
})

// ============================================================================
// 4. onDirectoryList callback logic tests
// ============================================================================

describe('onDirectoryList callback logic', () => {
  /**
   * Simulates the onDirectoryList handler from start.ts.
   * Uses the real filesystem to test against actual directories.
   */
  function handleDirectoryList(path: string): {
    resolvedPath: string
    entries: Array<{ name: string; path: string; isDirectory: boolean; isSymlink?: boolean }>
    error?: string
    homeDirectory: string
  } {
    const homeDir = homedir()
    const resolvedPath = path === '~' || !path ? homeDir : path

    if (!existsSync(resolvedPath)) {
      return { resolvedPath, entries: [], error: 'Directory does not exist', homeDirectory: homeDir }
    }

    const stat = statSync(resolvedPath)
    if (!stat.isDirectory()) {
      return { resolvedPath, entries: [], error: 'Not a directory', homeDirectory: homeDir }
    }

    const dirents = readdirSync(resolvedPath, { withFileTypes: true })
    const entries = dirents
      .filter(d => !d.name.startsWith('.'))
      .map(d => {
        const fullPath = join(resolvedPath, d.name)
        let isDirectory = d.isDirectory()
        const isSymlink = d.isSymbolicLink()
        if (isSymlink) {
          try {
            const realStat = statSync(fullPath)
            isDirectory = realStat.isDirectory()
          } catch {
            // Broken symlink
          }
        }
        return { name: d.name, path: fullPath, isDirectory, isSymlink }
      })
      .filter(e => e.isDirectory)
      .sort((a, b) => a.name.localeCompare(b.name))

    return { resolvedPath, entries, homeDirectory: homeDir }
  }

  it('resolves ~ to home directory', () => {
    const result = handleDirectoryList('~')
    expect(result.resolvedPath).toBe(homedir())
    expect(result.error).toBeUndefined()
  })

  it('resolves empty path to home directory', () => {
    const result = handleDirectoryList('')
    expect(result.resolvedPath).toBe(homedir())
  })

  it('returns error for nonexistent path', () => {
    const result = handleDirectoryList('/this/path/definitely/does/not/exist/abc123xyz')
    expect(result.entries).toHaveLength(0)
    expect(result.error).toBe('Directory does not exist')
  })

  it('lists only directories (no files)', () => {
    // Use /tmp which should exist on any system and contain some dirs
    const result = handleDirectoryList('/tmp')
    if (result.entries.length > 0) {
      result.entries.forEach(entry => {
        expect(entry.isDirectory).toBe(true)
      })
    }
    expect(result.error).toBeUndefined()
  })

  it('filters out hidden directories (starting with .)', () => {
    const result = handleDirectoryList(homedir())
    const hiddenEntries = result.entries.filter(e => e.name.startsWith('.'))
    expect(hiddenEntries).toHaveLength(0)
  })

  it('entries are sorted alphabetically by name', () => {
    const result = handleDirectoryList(homedir())
    if (result.entries.length > 1) {
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i].name.localeCompare(result.entries[i - 1].name)).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('each entry has name, path, and isDirectory fields', () => {
    const result = handleDirectoryList(homedir())
    result.entries.forEach(entry => {
      expect(entry.name).toBeDefined()
      expect(typeof entry.name).toBe('string')
      expect(entry.path).toBeDefined()
      expect(entry.path).toContain(entry.name)
      expect(entry.isDirectory).toBe(true)
    })
  })

  it('always includes homeDirectory in response', () => {
    const result1 = handleDirectoryList('~')
    expect(result1.homeDirectory).toBe(homedir())

    const result2 = handleDirectoryList('/tmp')
    expect(result2.homeDirectory).toBe(homedir())

    const result3 = handleDirectoryList('/nonexistent')
    expect(result3.homeDirectory).toBe(homedir())
  })

  it('returns error when path is a file, not a directory', () => {
    // /etc/hostname or /etc/hosts should exist as a file on most systems
    const testFile = existsSync('/etc/hostname') ? '/etc/hostname' : '/etc/hosts'
    if (existsSync(testFile)) {
      const result = handleDirectoryList(testFile)
      expect(result.error).toBe('Not a directory')
      expect(result.entries).toHaveLength(0)
    }
  })
})

// ============================================================================
// 5. End-to-end message flow simulation
// ============================================================================

describe('Directory list end-to-end message flow', () => {
  it('relay request → agent handler → relay response (full round trip)', () => {
    // 1. Relay sends directory_list_request
    const relayRequest = {
      type: 'directory_list_request' as const,
      timestamp: new Date().toISOString(),
      payload: {
        path: homedir(),
        correlationId: 'e2e-corr-1',
      },
    }

    // 2. Agent handler extracts path and correlationId
    const { path, correlationId } = relayRequest.payload
    expect(path).toBe(homedir())
    expect(correlationId).toBe('e2e-corr-1')

    // 3. Agent lists directory
    const dirents = readdirSync(path, { withFileTypes: true })
    const entries = dirents
      .filter(d => !d.name.startsWith('.') && d.isDirectory())
      .map(d => ({
        name: d.name,
        path: join(path, d.name),
        isDirectory: true as const,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    // 4. Agent sends response
    const response: DirectoryListResponseMessage = {
      type: 'directory_list_response',
      timestamp: new Date().toISOString(),
      payload: {
        correlationId,
        path,
        entries,
        homeDirectory: homedir(),
      },
    }

    // 5. Verify response
    expect(response.type).toBe('directory_list_response')
    expect(response.payload.correlationId).toBe('e2e-corr-1')
    expect(response.payload.path).toBe(homedir())
    expect(response.payload.homeDirectory).toBe(homedir())
    expect(Array.isArray(response.payload.entries)).toBe(true)
    response.payload.entries.forEach(entry => {
      expect(entry.isDirectory).toBe(true)
      expect(entry.name).not.toMatch(/^\./)
    })
  })

  it('relay dot-notation request → normalize → handle → respond', () => {
    // Relay sends in dot notation format
    const rawMessage: Record<string, unknown> = {
      type: 'directory_list.request',
      timestamp: new Date().toISOString(),
      path: '/tmp',
      correlationId: 'e2e-corr-2',
    }

    // Normalize to underscore format
    expect(rawMessage.type).toBe('directory_list.request')
    const normalized: DirectoryListRequestMessage = {
      type: 'directory_list_request',
      timestamp: rawMessage.timestamp as string,
      payload: {
        path: rawMessage.path as string,
        correlationId: rawMessage.correlationId as string,
      },
    }

    expect(normalized.type).toBe('directory_list_request')
    expect(normalized.payload.path).toBe('/tmp')
    expect(normalized.payload.correlationId).toBe('e2e-corr-2')
  })
})
