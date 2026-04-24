/**
 * Content Search Tests
 *
 * Verifies the content_search_request handling in the agent runner.
 * Mirrors the onContentSearch handler in src/commands/start.ts to exercise:
 *   1. Type shapes for ContentSearchRequestMessage / Response / Match
 *   2. Security validation — path traversal, sensitive paths, non-directory roots
 *   3. Happy path — ripgrep JSON parsing, match extraction, limit enforcement
 *   4. Process lifecycle — duplicate correlationId guard, shutdown cleanup
 *   5. Robustness — 1MB line-buffer cap, invalid regex (ripgrep exit code),
 *      malformed JSON output, empty results
 *
 * Test style follows `tests/directory-list.test.ts`: the handler logic is
 * re-implemented here with an injectable `spawn` fn so we can assert on
 * process behavior without requiring a real `rg` binary on the test machine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, statSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  ContentSearchRequestMessage,
  ContentSearchResponseMessage,
  ContentSearchMatch,
} from '../src/types'

// Use /tmp directly (not os.tmpdir()) because macOS tmpdir is /var/folders/...,
// which would be rejected by the handler's sensitive-path check (/var/).
const TMP_ROOT = '/tmp'

// ============================================================================
// Fake child-process plumbing. Mirrors the subset of `ChildProcess` that the
// real handler touches: stdout/stderr streams, .kill(), .killed flag, and
// 'close'/'error' events.
// ============================================================================

class FakeProc extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(_sig?: string) {
    this.killed = true
    return true
  }
  emitStdout(chunk: string) {
    this.stdout.emit('data', Buffer.from(chunk))
  }
  emitStderr(chunk: string) {
    this.stderr.emit('data', Buffer.from(chunk))
  }
  close(code: number | null) {
    this.emit('close', code)
  }
  fail(err: Error) {
    this.emit('error', err)
  }
}

type SpawnFn = (bin: string, args: string[]) => FakeProc

// ============================================================================
// Re-implementation of onContentSearch (src/commands/start.ts:759-903) with
// `spawn` and `send` injected so we can drive + assert them in tests. Keep in
// sync with the real handler; if the handler changes, update this function
// and the tests covering the new behavior.
// ============================================================================

interface SearchOpts {
  caseSensitive?: boolean
  maxMatchesPerFile?: number
  limit?: number
}

type SendFn = (
  correlationId: string,
  matches: ContentSearchMatch[],
  error?: string,
) => void

function makeHandler(
  spawnFn: SpawnFn,
  sendFn: SendFn,
  activeSearchProcs: Map<string, FakeProc>,
) {
  return function onContentSearch(
    root: string,
    pattern: string,
    correlationId: string,
    opts?: SearchOpts,
  ) {
    try {
      const resolvedRoot = resolve(
        root.startsWith('~') ? root.replace(/^~/, homedir()) : root,
      )

      if (root.includes('..') || resolvedRoot.includes('..')) {
        sendFn(correlationId, [], 'Path traversal not allowed')
        return
      }

      // Prefix comparison so bare roots like '/etc' are blocked too.
      // Unix-oriented; mirrors the handler in src/commands/start.ts.
      const SENSITIVE_ROOTS = ['/etc', '/var', '/root', '/usr', '/bin', '/sbin', '/sys', '/proc', '/boot', '/dev']
      const HOME_SENSITIVE = ['.ssh', '.aws', '.gnupg', '.kube', '.config/gcloud']
      const isSensitive =
        SENSITIVE_ROOTS.some(r => resolvedRoot === r || resolvedRoot.startsWith(r + '/')) ||
        HOME_SENSITIVE.some(h => {
          const p = join(homedir(), h)
          return resolvedRoot === p || resolvedRoot.startsWith(p + '/')
        })
      if (isSensitive) {
        sendFn(correlationId, [], 'Search in sensitive path not allowed')
        return
      }

      if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
        sendFn(correlationId, [], 'Invalid search root: not a directory')
        return
      }

      const args: string[] = [
        '--json',
        '--max-count', String(opts?.maxMatchesPerFile ?? 20),
        '--max-filesize', '1M',
        '--glob', '!node_modules',
        '--glob', '!.git',
        '--glob', '!dist',
        '--glob', '!build',
        '--glob', '!.next',
        '--glob', '!target',
      ]
      if (!opts?.caseSensitive) args.push('--ignore-case')
      args.push(pattern, resolvedRoot)

      const existing = activeSearchProcs.get(correlationId)
      if (existing && !existing.killed) {
        existing.kill()
      }

      const proc = spawnFn('rg', args)
      activeSearchProcs.set(correlationId, proc)
      const matches: ContentSearchMatch[] = []
      const limit = opts?.limit ?? 500
      const MAX_BUF_SIZE = 1024 * 1024
      let buf = ''
      let responseSent = false
      let parseErrors = 0

      proc.stdout.on('data', (chunk: Buffer) => {
        if (matches.length >= limit) {
          if (!proc.killed) proc.kill()
          return
        }
        // Check before append so a single huge chunk cannot blow past the cap
        if (buf.length + chunk.length > MAX_BUF_SIZE) {
          if (!proc.killed) proc.kill()
          if (!responseSent) {
            responseSent = true
            activeSearchProcs.delete(correlationId)
            sendFn(correlationId, matches, 'Search aborted: output line exceeded buffer limit')
          }
          return
        }
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim() || matches.length >= limit) continue
          try {
            const obj = JSON.parse(line) as {
              type: string
              data: {
                path: { text: string }
                line_number: number
                lines: { text: string }
                submatches: Array<{ start: number; end: number }>
              }
            }
            if (obj.type === 'match') {
              const sub = obj.data.submatches[0]
              if (sub === undefined) continue
              matches.push({
                path: obj.data.path.text,
                lineNo: obj.data.line_number,
                line: obj.data.lines.text.trimEnd(),
                matchStart: sub.start,
                matchEnd: sub.end,
              })
            }
          } catch { parseErrors++ }
        }
      })

      proc.stderr.on('data', () => { /* swallow — handler only debug-logs */ })

      proc.on('close', (code: number | null) => {
        // Only delete if this proc still owns the slot (duplicate-request race).
        if (activeSearchProcs.get(correlationId) === proc) {
          activeSearchProcs.delete(correlationId)
        }
        if (responseSent) return
        responseSent = true
        if (code !== 0 && code !== 1 && code !== null) {
          sendFn(correlationId, [], `Search failed (exit ${code})`)
        } else {
          sendFn(correlationId, matches)
        }
      })

      proc.on('error', (err: Error) => {
        if (activeSearchProcs.get(correlationId) === proc) {
          activeSearchProcs.delete(correlationId)
        }
        if (responseSent) return
        responseSent = true
        const msg = err.message.includes('ENOENT')
          ? 'ripgrep not found — install ripgrep or @vscode/ripgrep'
          : err.message
        sendFn(correlationId, [], msg)
      })
    } catch (error) {
      sendFn(correlationId, [], String(error))
    }
  }
}

// Helper to build a ripgrep `match` JSON line matching the real output shape.
function rgMatchLine(path: string, lineNo: number, text: string, start: number, end: number) {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      line_number: lineNo,
      lines: { text: text + '\n' },
      submatches: [{ start, end, match: { text: text.slice(start, end) } }],
    },
  }) + '\n'
}

// ============================================================================
// 1. Type shape tests
// ============================================================================

describe('ContentSearch type definitions', () => {
  it('ContentSearchRequestMessage has correct shape', () => {
    const msg: ContentSearchRequestMessage = {
      type: 'content_search_request',
      timestamp: new Date().toISOString(),
      payload: {
        root: '/home/user/proj',
        pattern: 'TODO',
        correlationId: 'c-1',
        caseSensitive: false,
        maxMatchesPerFile: 10,
        limit: 100,
      },
    }
    expect(msg.type).toBe('content_search_request')
    expect(msg.payload.pattern).toBe('TODO')
    expect(msg.payload.limit).toBe(100)
  })

  it('ContentSearchResponseMessage carries matches or error', () => {
    const ok: ContentSearchResponseMessage = {
      type: 'content_search_response',
      timestamp: new Date().toISOString(),
      payload: {
        correlationId: 'c-1',
        matches: [
          { path: '/p/a.ts', lineNo: 1, line: 'const x = 1', matchStart: 6, matchEnd: 7 },
        ],
      },
    }
    expect(ok.payload.matches).toHaveLength(1)
    expect(ok.payload.error).toBeUndefined()

    const err: ContentSearchResponseMessage = {
      type: 'content_search_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId: 'c-2', matches: [], error: 'bad' },
    }
    expect(err.payload.error).toBe('bad')
  })
})

// ============================================================================
// 2. Security validation tests (no spawn — short-circuit paths)
// ============================================================================

describe('Content search — security validation', () => {
  let spawned: FakeProc[]
  let spawnFn: SpawnFn
  let sent: Array<{ id: string; matches: ContentSearchMatch[]; error?: string }>
  let sendFn: SendFn
  let procs: Map<string, FakeProc>
  let handler: ReturnType<typeof makeHandler>

  beforeEach(() => {
    spawned = []
    spawnFn = vi.fn((bin: string, args: string[]) => {
      const p = new FakeProc()
      spawned.push(p)
      void bin; void args
      return p
    }) as unknown as SpawnFn
    sent = []
    sendFn = (id, matches, error) => { sent.push({ id, matches, error }) }
    procs = new Map()
    handler = makeHandler(spawnFn, sendFn, procs)
  })

  it('rejects raw path traversal (..)', () => {
    handler('/home/user/../../etc/passwd', 'root:', 'c-1')
    expect(sent).toHaveLength(1)
    expect(sent[0].error).toBe('Path traversal not allowed')
    expect(spawned).toHaveLength(0)
  })

  it('rejects ../ prefix', () => {
    handler('../../etc', 'x', 'c-2')
    expect(sent[0].error).toBe('Path traversal not allowed')
    expect(spawned).toHaveLength(0)
  })

  it('rejects nested /etc/ paths', () => {
    handler('/etc/ssh/', 'root', 'c-3')
    expect(sent[0].error).toBe('Search in sensitive path not allowed')
    expect(spawned).toHaveLength(0)
  })

  it('rejects paths containing /.ssh/ (nested)', () => {
    handler('~/.ssh/known_hosts_dir/', 'id_rsa', 'c-4')
    expect(sent[0].error).toBe('Search in sensitive path not allowed')
    expect(spawned).toHaveLength(0)
  })

  it('rejects nested sensitive paths (/root/sub, /var/sub)', () => {
    handler('/root/home/', 'x', 'c-5')
    handler('/var/log/', 'x', 'c-6')
    expect(sent.map(s => s.error)).toEqual([
      'Search in sensitive path not allowed',
      'Search in sensitive path not allowed',
    ])
    expect(spawned).toHaveLength(0)
  })

  // Security: bare sensitive roots must also be rejected. Previously the
  // substring check ('/etc/'.includes) let these through because
  // path.resolve() strips trailing slashes.
  it('rejects bare /etc root', () => {
    handler('/etc', 'x', 'c-bare-etc')
    expect(sent[0].error).toBe('Search in sensitive path not allowed')
    expect(spawned).toHaveLength(0)
  })

  it('rejects bare /etc/ root (trailing slash)', () => {
    handler('/etc/', 'x', 'c-bare-etc-slash')
    expect(sent[0].error).toBe('Search in sensitive path not allowed')
    expect(spawned).toHaveLength(0)
  })

  it('rejects bare /var, /root, /sys, /proc roots', () => {
    handler('/var', 'x', 'c-bare-var')
    handler('/root', 'x', 'c-bare-root')
    handler('/sys', 'x', 'c-bare-sys')
    handler('/proc', 'x', 'c-bare-proc')
    expect(sent.map(s => s.error)).toEqual([
      'Search in sensitive path not allowed',
      'Search in sensitive path not allowed',
      'Search in sensitive path not allowed',
      'Search in sensitive path not allowed',
    ])
    expect(spawned).toHaveLength(0)
  })

  it('rejects bare ~/.ssh root', () => {
    handler('~/.ssh', 'id_rsa', 'c-bare-ssh')
    expect(sent[0].error).toBe('Search in sensitive path not allowed')
    expect(spawned).toHaveLength(0)
  })

  it('rejects ~/.aws, ~/.gnupg, ~/.kube bare roots', () => {
    handler('~/.aws', 'x', 'c-bare-aws')
    handler('~/.gnupg', 'x', 'c-bare-gpg')
    handler('~/.kube', 'x', 'c-bare-kube')
    expect(sent.map(s => s.error)).toEqual([
      'Search in sensitive path not allowed',
      'Search in sensitive path not allowed',
      'Search in sensitive path not allowed',
    ])
    expect(spawned).toHaveLength(0)
  })

  it('does NOT reject unrelated paths that happen to share a prefix substring', () => {
    // '/etcd-data' or '/varnish' must not be caught by the sensitive check
    // (prefix comparison requires an exact match or a '/' boundary).
    const tmp = mkdtempSync(join(TMP_ROOT, 'cs-prefix-'))
    // We can't realistically create /etcd-data, but we can verify the logic
    // falls past the sensitive check for a non-sensitive resolved path.
    // Using a safe tmp path demonstrates the guard lets legitimate paths
    // through to the existsSync check.
    handler(tmp, 'x', 'c-prefix-safe')
    // Should have spawned (passed the sensitive check)
    expect(spawned).toHaveLength(1)
  })

  it('rejects non-existent root', () => {
    handler('/this/path/does/not/exist/zzz', 'x', 'c-7')
    expect(sent[0].error).toBe('Invalid search root: not a directory')
    expect(spawned).toHaveLength(0)
  })

  it('rejects file (non-directory) root', () => {
    const tmp = mkdtempSync(join(TMP_ROOT, 'cs-file-'))
    const filePath = join(tmp, 'a.txt')
    writeFileSync(filePath, 'hi')
    handler(filePath, 'x', 'c-8')
    expect(sent[0].error).toBe('Invalid search root: not a directory')
    expect(spawned).toHaveLength(0)
  })

  it('rejects .env file as a root (it is a file, not a directory)', () => {
    const tmp = mkdtempSync(join(TMP_ROOT, 'cs-env-'))
    const envPath = join(tmp, '.env')
    writeFileSync(envPath, 'SECRET=abc\n')
    handler(envPath, 'SECRET', 'c-env')
    expect(sent[0].error).toBe('Invalid search root: not a directory')
    expect(spawned).toHaveLength(0)
  })
})

// ============================================================================
// 3. Happy path + limit + no-match + pagination
// ============================================================================

describe('Content search — happy path & limits', () => {
  let spawned: FakeProc[]
  let spawnFn: SpawnFn
  let sent: Array<{ id: string; matches: ContentSearchMatch[]; error?: string }>
  let sendFn: SendFn
  let procs: Map<string, FakeProc>
  let handler: ReturnType<typeof makeHandler>
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(TMP_ROOT, 'cs-ok-'))
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    writeFileSync(join(tmpDir, 'src', 'a.ts'), 'TODO here\n')
    spawned = []
    spawnFn = vi.fn((bin: string, args: string[]) => {
      const p = new FakeProc()
      spawned.push(p)
      void bin; void args
      return p
    }) as unknown as SpawnFn
    sent = []
    sendFn = (id, matches, error) => { sent.push({ id, matches, error }) }
    procs = new Map()
    handler = makeHandler(spawnFn, sendFn, procs)
  })

  it('parses ripgrep JSON across multiple files and shapes results correctly', () => {
    handler(tmpDir, 'TODO', 'c-ok-1')
    expect(spawned).toHaveLength(1)
    const proc = spawned[0]

    proc.emitStdout(rgMatchLine('/r/a.ts', 10, '  // TODO fix me', 5, 9))
    proc.emitStdout(rgMatchLine('/r/b.ts', 3, 'TODO here', 0, 4))
    proc.close(0)

    expect(sent).toHaveLength(1)
    expect(sent[0].error).toBeUndefined()
    expect(sent[0].matches).toHaveLength(2)
    expect(sent[0].matches[0]).toEqual({
      path: '/r/a.ts',
      lineNo: 10,
      line: '  // TODO fix me',
      matchStart: 5,
      matchEnd: 9,
    })
    expect(sent[0].matches[1].path).toBe('/r/b.ts')
    // Line should be trimEnd'd (no trailing \n)
    expect(sent[0].matches[1].line.endsWith('\n')).toBe(false)
  })

  it('handles multi-line chunks split across data events', () => {
    handler(tmpDir, 'x', 'c-split')
    const proc = spawned[0]
    const full = rgMatchLine('/p/a', 1, 'abc', 0, 1) + rgMatchLine('/p/b', 2, 'def', 1, 2)
    // Split mid-line to test buffering
    const mid = Math.floor(full.length / 2)
    proc.emitStdout(full.slice(0, mid))
    proc.emitStdout(full.slice(mid))
    proc.close(0)
    expect(sent[0].matches).toHaveLength(2)
  })

  it('returns empty results cleanly when ripgrep exits 1 (no matches)', () => {
    handler(tmpDir, 'nope', 'c-none')
    const proc = spawned[0]
    proc.close(1) // ripgrep's "no matches" exit code
    expect(sent).toHaveLength(1)
    expect(sent[0].matches).toEqual([])
    expect(sent[0].error).toBeUndefined()
  })

  it('enforces total limit across all matches (default 500)', () => {
    handler(tmpDir, 'x', 'c-limit', { limit: 3 })
    const proc = spawned[0]
    for (let i = 0; i < 10; i++) {
      proc.emitStdout(rgMatchLine(`/p/f${i}`, i, 'x', 0, 1))
    }
    // Handler kills the proc when matches.length >= limit on next chunk; close
    // is expected to fire after kill (code=null).
    proc.close(null)
    expect(sent[0].matches.length).toBeLessThanOrEqual(3)
    // With the simulated flush (all 10 lines arrive in one chunk), the loop
    // breaks via `matches.length >= limit continue`, so we hit exactly 3.
    expect(sent[0].matches.length).toBe(3)
  })

  it('kills the ripgrep process once the limit has been reached', () => {
    handler(tmpDir, 'x', 'c-limit-kill', { limit: 2 })
    const proc = spawned[0]
    proc.emitStdout(
      rgMatchLine('/p/a', 1, 'x', 0, 1) +
      rgMatchLine('/p/b', 2, 'x', 0, 1),
    )
    // Second chunk — handler should detect limit reached and kill
    proc.emitStdout(rgMatchLine('/p/c', 3, 'x', 0, 1))
    expect(proc.killed).toBe(true)
  })

  it('passes --max-count, --ignore-case, and glob excludes to ripgrep', () => {
    handler(tmpDir, 'pat', 'c-args', { maxMatchesPerFile: 7 })
    const spawnCall = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]
    const args = spawnCall[1]
    expect(args).toContain('--json')
    expect(args).toContain('--max-count')
    expect(args[args.indexOf('--max-count') + 1]).toBe('7')
    expect(args).toContain('--ignore-case')
    expect(args).toContain('--max-filesize')
    expect(args[args.indexOf('--max-filesize') + 1]).toBe('1M')
    // Pattern is second-to-last, root is last
    expect(args[args.length - 2]).toBe('pat')
    for (const glob of ['!node_modules', '!.git', '!dist', '!build', '!.next', '!target']) {
      expect(args).toContain(glob)
    }
  })

  it('omits --ignore-case when caseSensitive=true', () => {
    handler(tmpDir, 'Foo', 'c-case', { caseSensitive: true })
    const spawnCall = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]
    expect(spawnCall[1]).not.toContain('--ignore-case')
  })
})

// ============================================================================
// 4. Process lifecycle: duplicate correlationId, shutdown, errors
// ============================================================================

describe('Content search — process lifecycle', () => {
  let spawned: FakeProc[]
  let spawnFn: SpawnFn
  let sent: Array<{ id: string; matches: ContentSearchMatch[]; error?: string }>
  let sendFn: SendFn
  let procs: Map<string, FakeProc>
  let handler: ReturnType<typeof makeHandler>
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(TMP_ROOT, 'cs-life-'))
    spawned = []
    spawnFn = vi.fn(() => {
      const p = new FakeProc()
      spawned.push(p)
      return p
    }) as unknown as SpawnFn
    sent = []
    sendFn = (id, matches, error) => { sent.push({ id, matches, error }) }
    procs = new Map()
    handler = makeHandler(spawnFn, sendFn, procs)
  })

  it('duplicate correlationId kills the prior ripgrep process (kill-guard)', () => {
    handler(tmpDir, 'a', 'dup-corr')
    const first = spawned[0]
    expect(first.killed).toBe(false)

    handler(tmpDir, 'b', 'dup-corr')
    expect(first.killed).toBe(true)
    expect(spawned).toHaveLength(2)
    expect(procs.get('dup-corr')).toBe(spawned[1])
  })

  it('late close from replaced proc does NOT evict the current owner', () => {
    // Regression: previously the close handler unconditionally did
    // activeSearchProcs.delete(correlationId). If a second request replaced
    // the map entry, the first proc's late close would orphan the second.
    handler(tmpDir, 'a', 'race-corr')
    const first = spawned[0]
    handler(tmpDir, 'b', 'race-corr')
    const second = spawned[1]
    expect(procs.get('race-corr')).toBe(second)

    // Now the FIRST (replaced) proc's close fires late. It must NOT delete
    // the map entry that now points to `second`.
    first.close(null)
    expect(procs.get('race-corr')).toBe(second)

    // When the second proc closes normally, it *should* clean up.
    second.close(0)
    expect(procs.has('race-corr')).toBe(false)
  })

  it('late error event from replaced proc also preserves current owner', () => {
    handler(tmpDir, 'a', 'race-err')
    const first = spawned[0]
    handler(tmpDir, 'b', 'race-err')
    const second = spawned[1]

    first.fail(new Error('late error from orphaned proc'))
    expect(procs.get('race-err')).toBe(second)
  })

  it('close(0) after responseSent (e.g. via buffer abort) does not send twice', () => {
    handler(tmpDir, 'x', 'c-dbl', { limit: 500 })
    const proc = spawned[0]
    // Overflow the buffer to trigger the abort response
    proc.emitStdout('A'.repeat(1024 * 1024 + 10))
    expect(sent).toHaveLength(1)
    // Now the proc's natural close fires — must NOT produce a second response
    proc.close(null)
    expect(sent).toHaveLength(1)
  })

  it('ripgrep process is tracked in activeSearchProcs during run, removed on close', () => {
    handler(tmpDir, 'x', 'c-track')
    expect(procs.has('c-track')).toBe(true)
    spawned[0].close(0)
    expect(procs.has('c-track')).toBe(false)
  })

  it('shutdown can iterate activeSearchProcs and kill them all', () => {
    handler(tmpDir, 'a', 'c-s1')
    handler(tmpDir, 'b', 'c-s2')
    handler(tmpDir, 'c', 'c-s3')
    expect(procs.size).toBe(3)

    // Simulate the shutdown loop in start.ts:1391
    for (const proc of procs.values()) {
      if (!proc.killed) proc.kill()
    }
    procs.clear()

    expect(spawned.every(p => p.killed)).toBe(true)
    expect(procs.size).toBe(0)
  })

  it('propagates ENOENT as a helpful error', () => {
    handler(tmpDir, 'x', 'c-enoent')
    const err = new Error('spawn rg ENOENT') as Error & { code?: string }
    err.code = 'ENOENT'
    spawned[0].fail(err)
    expect(sent).toHaveLength(1)
    expect(sent[0].error).toBe('ripgrep not found — install ripgrep or @vscode/ripgrep')
  })

  it('reports non-zero, non-1 exit codes as Search failed', () => {
    handler(tmpDir, '[invalid(regex', 'c-badregex')
    const proc = spawned[0]
    // ripgrep exits 2 for invalid regex
    proc.close(2)
    expect(sent[0].error).toBe('Search failed (exit 2)')
    expect(sent[0].matches).toEqual([])
  })

  it('invalid-regex pattern does not crash the handler', () => {
    expect(() => handler(tmpDir, '[unterminated', 'c-badregex-2')).not.toThrow()
    // Cleanup
    spawned[0]?.close(2)
  })
})

// ============================================================================
// 5. Robustness — buffer cap + malformed JSON
// ============================================================================

describe('Content search — robustness', () => {
  let spawned: FakeProc[]
  let spawnFn: SpawnFn
  let sent: Array<{ id: string; matches: ContentSearchMatch[]; error?: string }>
  let sendFn: SendFn
  let procs: Map<string, FakeProc>
  let handler: ReturnType<typeof makeHandler>
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(TMP_ROOT, 'cs-rob-'))
    spawned = []
    spawnFn = vi.fn(() => {
      const p = new FakeProc()
      spawned.push(p)
      return p
    }) as unknown as SpawnFn
    sent = []
    sendFn = (id, matches, error) => { sent.push({ id, matches, error }) }
    procs = new Map()
    handler = makeHandler(spawnFn, sendFn, procs)
  })

  it('1MB line-buffer cap aborts the search with a clear error', () => {
    handler(tmpDir, 'x', 'c-buf')
    const proc = spawned[0]
    // One very long line with no newline
    const huge = 'A'.repeat(1024 * 1024 + 50)
    proc.emitStdout(huge)

    expect(proc.killed).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].error).toBe('Search aborted: output line exceeded buffer limit')
  })

  it('buffer cap is enforced BEFORE append (single oversized chunk rejected without growth)', () => {
    // Regression: previously `buf += chunk; if (buf.length > MAX)` let one
    // huge chunk grow buf past the cap before the check ran. Now the check
    // runs before the append — buf must remain empty when a chunk by itself
    // would exceed the cap.
    handler(tmpDir, 'x', 'c-buf-pre')
    const proc = spawned[0]
    const MAX_BUF_SIZE = 1024 * 1024
    // One chunk that, if appended, would exceed MAX_BUF_SIZE — must be
    // rejected before any append happens.
    const oversized = 'A'.repeat(MAX_BUF_SIZE + 100)
    proc.emitStdout(oversized)

    expect(proc.killed).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].error).toBe('Search aborted: output line exceeded buffer limit')
  })

  it('cumulative buffer cap: multiple chunks together exceeding cap trigger abort before the over-sized append', () => {
    handler(tmpDir, 'x', 'c-buf-cumul')
    const proc = spawned[0]
    const half = 'B'.repeat(600 * 1024) // 600KB
    proc.emitStdout(half) // buf = 600KB (OK)
    expect(sent).toHaveLength(0)
    expect(proc.killed).toBe(false)
    proc.emitStdout(half) // 600KB + 600KB = 1.2MB > 1MB -> abort BEFORE append
    expect(proc.killed).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].error).toBe('Search aborted: output line exceeded buffer limit')
  })

  it('tolerates malformed JSON lines without crashing or polluting matches', () => {
    handler(tmpDir, 'x', 'c-junk')
    const proc = spawned[0]
    proc.emitStdout('{not json}\n')
    proc.emitStdout('garbage line without structure\n')
    proc.emitStdout(rgMatchLine('/p/ok.ts', 1, 'hit', 0, 3))
    proc.close(0)

    expect(sent[0].error).toBeUndefined()
    // Only the valid match line should appear in results
    expect(sent[0].matches).toHaveLength(1)
    expect(sent[0].matches[0].path).toBe('/p/ok.ts')
  })

  it('ignores non-match event types (begin/end/summary)', () => {
    handler(tmpDir, 'x', 'c-evt')
    const proc = spawned[0]
    proc.emitStdout(JSON.stringify({ type: 'begin', data: { path: { text: '/x' } } }) + '\n')
    proc.emitStdout(JSON.stringify({ type: 'end', data: {} }) + '\n')
    proc.emitStdout(rgMatchLine('/p/a', 1, 'hit', 0, 3))
    proc.emitStdout(JSON.stringify({ type: 'summary', data: {} }) + '\n')
    proc.close(0)
    expect(sent[0].matches).toHaveLength(1)
  })

  it('skips matches with empty submatches array', () => {
    handler(tmpDir, 'x', 'c-empty-sub')
    const proc = spawned[0]
    proc.emitStdout(JSON.stringify({
      type: 'match',
      data: {
        path: { text: '/p/a' },
        line_number: 1,
        lines: { text: 'hi\n' },
        submatches: [],
      },
    }) + '\n')
    proc.emitStdout(rgMatchLine('/p/b', 2, 'hit', 0, 3))
    proc.close(0)
    expect(sent[0].matches).toHaveLength(1)
    expect(sent[0].matches[0].path).toBe('/p/b')
  })
})


