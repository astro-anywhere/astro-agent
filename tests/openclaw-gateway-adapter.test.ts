/**
 * OpenClaw Gateway Adapter Tests
 *
 * Tests the gateway WebSocket-based adapter that replaced the CLI-spawn adapter.
 * Uses a mock WebSocket server to simulate the OpenClaw gateway protocol v3.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketServer } from 'ws'
import { OpenClawAdapter } from '../src/providers/openclaw-adapter.js'
import type { TaskOutputStream } from '../src/providers/base-adapter.js'
import type { Task } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStream(): TaskOutputStream {
  return {
    stdout: vi.fn(),
    stderr: vi.fn(),
    status: vi.fn(),
    toolTrace: vi.fn(),
    text: vi.fn(),
    toolUse: vi.fn(),
    toolResult: vi.fn(),
    fileChange: vi.fn(),
    sessionInit: vi.fn(),
    approvalRequest: vi.fn(),
  }
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-001',
    projectId: 'proj-1',
    planNodeId: 'node-1',
    provider: 'openclaw',
    prompt: 'Say hello',
    workingDirectory: '/tmp',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock Gateway Server
// ---------------------------------------------------------------------------

class MockGateway {
  wss: WebSocketServer
  port: number
  connections: import('ws').WebSocket[] = []
  onChatSend?: (params: Record<string, unknown>, ws: import('ws').WebSocket) => void

  constructor(port: number) {
    this.port = port
    this.wss = new WebSocketServer({ port })

    this.wss.on('connection', (ws) => {
      this.connections.push(ws)

      // Send challenge immediately
      ws.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'test-nonce-123' },
      }))

      ws.on('message', (data) => {
        const frame = JSON.parse(String(data))

        // Handle connect request
        if (frame.type === 'req' && frame.method === 'connect') {
          ws.send(JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: true,
            payload: { type: 'hello-ok', protocol: 3 },
          }))
          return
        }

        // Handle chat.send
        if (frame.type === 'req' && frame.method === 'chat.send') {
          if (this.onChatSend) {
            this.onChatSend(frame.params, ws)
          } else {
            // Default: accept and send a simple response
            const sessionKey = frame.params.sessionKey as string
            const runId = 'run-' + Math.random().toString(36).slice(2)

            ws.send(JSON.stringify({
              type: 'res', id: frame.id, ok: true,
              payload: { runId, status: 'started' },
            }))

            // Simulate agent lifecycle
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'event', event: 'agent', seq: 1,
                payload: {
                  runId,
                  stream: 'lifecycle',
                  data: { phase: 'start' },
                  sessionKey: `agent:main:${sessionKey}`,
                },
              }))
            }, 10)

            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'event', event: 'agent', seq: 2,
                payload: {
                  runId,
                  stream: 'assistant',
                  data: { delta: 'Hello!' },
                  sessionKey: `agent:main:${sessionKey}`,
                },
              }))
            }, 20)

            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'event', event: 'chat', seq: 3,
                payload: {
                  runId,
                  sessionKey: `agent:main:${sessionKey}`,
                  state: 'final',
                  message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
                },
              }))
            }, 30)

            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'event', event: 'agent', seq: 4,
                payload: {
                  runId,
                  stream: 'lifecycle',
                  data: { phase: 'end' },
                  sessionKey: `agent:main:${sessionKey}`,
                },
              }))
            }, 40)
          }
          return
        }

        // Handle chat.abort
        if (frame.type === 'req' && frame.method === 'chat.abort') {
          ws.send(JSON.stringify({
            type: 'res', id: frame.id, ok: true, payload: {},
          }))
          return
        }
      })
    })
  }

  async close(): Promise<void> {
    for (const ws of this.connections) {
      ws.close()
    }
    return new Promise((resolve) => {
      this.wss.close(() => resolve())
    })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenClaw Gateway Adapter', () => {
  let gateway: MockGateway
  let adapter: OpenClawAdapter
  let port: number

  beforeEach(async () => {
    // Use a random port to avoid conflicts
    port = 19000 + Math.floor(Math.random() * 1000)
    gateway = new MockGateway(port)

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 100))

    adapter = new OpenClawAdapter()
    // Override config discovery to use our test port
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).gatewayConfig = {
      port,
      token: 'test-token',
      url: `ws://127.0.0.1:${port}`,
    }
  })

  afterEach(async () => {
    await gateway.close()
  })

  describe('execute — basic flow', () => {
    it('should dispatch task via chat.send and stream events', async () => {
      const stream = createMockStream()
      const controller = new AbortController()

      const result = await adapter.execute(makeTask(), stream, controller.signal)

      expect(result.status).toBe('completed')
      expect(result.output).toContain('Hello!')
      expect(stream.status).toHaveBeenCalledWith('running', 5, 'Connected to gateway')
      expect(stream.status).toHaveBeenCalledWith('running', 10, 'Task dispatched to agent')
      expect(stream.sessionInit).toHaveBeenCalled()
      expect(stream.text).toHaveBeenCalledWith('Hello!')
    })

    it('should include systemPrompt in the message when provided', async () => {
      const stream = createMockStream()
      const controller = new AbortController()
      let capturedMessage = ''

      gateway.onChatSend = (params, ws) => {
        capturedMessage = params.message as string
        const sessionKey = params.sessionKey as string
        const runId = 'run-test'

        ws.send(JSON.stringify({
          type: 'res', id: 'chat-send-1', ok: true,
          payload: { runId, status: 'started' },
        }))

        // Quick lifecycle
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'event', event: 'agent', seq: 1,
            payload: { runId, stream: 'lifecycle', data: { phase: 'start' }, sessionKey: `agent:main:${sessionKey}` },
          }))
          ws.send(JSON.stringify({
            type: 'event', event: 'agent', seq: 2,
            payload: { runId, stream: 'lifecycle', data: { phase: 'end' }, sessionKey: `agent:main:${sessionKey}` },
          }))
        }, 10)
      }

      await adapter.execute(
        makeTask({ systemPrompt: 'You are a helpful agent.', prompt: 'Do the task' }),
        stream,
        controller.signal,
      )

      expect(capturedMessage).toBe('You are a helpful agent.\n\n---\n\nDo the task')
    })

    it('should use astro:task:{id} as session key', async () => {
      const stream = createMockStream()
      const controller = new AbortController()
      let capturedSessionKey = ''

      gateway.onChatSend = (params, ws) => {
        capturedSessionKey = params.sessionKey as string
        const runId = 'run-test'

        ws.send(JSON.stringify({
          type: 'res', id: 'chat-send-1', ok: true,
          payload: { runId, status: 'started' },
        }))

        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'event', event: 'agent', seq: 1,
            payload: { runId, stream: 'lifecycle', data: { phase: 'start' }, sessionKey: `agent:main:${capturedSessionKey}` },
          }))
          ws.send(JSON.stringify({
            type: 'event', event: 'agent', seq: 2,
            payload: { runId, stream: 'lifecycle', data: { phase: 'end' }, sessionKey: `agent:main:${capturedSessionKey}` },
          }))
        }, 10)
      }

      await adapter.execute(makeTask({ id: 'my-task-42' }), stream, controller.signal)

      expect(capturedSessionKey).toBe('astro:task:my-task-42')
    })
  })

  describe('execute — error handling', () => {
    it('should return failed when gateway rejects chat.send', async () => {
      const stream = createMockStream()
      const controller = new AbortController()

      gateway.onChatSend = (_params, ws) => {
        ws.send(JSON.stringify({
          type: 'res', id: 'chat-send-1', ok: false,
          error: { code: 'RATE_LIMITED', message: 'Too many requests' },
        }))
      }

      const result = await adapter.execute(makeTask(), stream, controller.signal)

      expect(result.status).toBe('failed')
      expect(result.error).toContain('Too many requests')
    })

    it('should return failed when gateway is not available', async () => {
      const stream = createMockStream()
      const controller = new AbortController()

      // Point to a non-existent port
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).gatewayConfig = {
        port: 59999,
        token: 'test',
        url: 'ws://127.0.0.1:59999',
      }

      const result = await adapter.execute(makeTask(), stream, controller.signal)

      expect(result.status).toBe('failed')
    })
  })

  describe('execute — tool events', () => {
    it('should forward tool_use and tool_result events', async () => {
      const stream = createMockStream()
      const controller = new AbortController()

      gateway.onChatSend = (params, ws) => {
        const sessionKey = params.sessionKey as string
        const runId = 'run-tools'

        ws.send(JSON.stringify({
          type: 'res', id: 'chat-send-1', ok: true,
          payload: { runId, status: 'started' },
        }))

        setTimeout(() => {
          // lifecycle start
          ws.send(JSON.stringify({
            type: 'event', event: 'agent', seq: 1,
            payload: { runId, stream: 'lifecycle', data: { phase: 'start' }, sessionKey: `agent:main:${sessionKey}` },
          }))
          // tool_use
          ws.send(JSON.stringify({
            type: 'event', event: 'agent', seq: 2,
            payload: { runId, stream: 'tool_use', data: { name: 'exec', input: { command: 'ls' } }, sessionKey: `agent:main:${sessionKey}` },
          }))
          // tool_result
          ws.send(JSON.stringify({
            type: 'event', event: 'agent', seq: 3,
            payload: { runId, stream: 'tool_result', data: { name: 'exec', result: 'file1.ts', success: true }, sessionKey: `agent:main:${sessionKey}` },
          }))
          // lifecycle end
          ws.send(JSON.stringify({
            type: 'event', event: 'agent', seq: 4,
            payload: { runId, stream: 'lifecycle', data: { phase: 'end' }, sessionKey: `agent:main:${sessionKey}` },
          }))
        }, 10)
      }

      await adapter.execute(makeTask(), stream, controller.signal)

      expect(stream.toolUse).toHaveBeenCalledWith('exec', { command: 'ls' })
      expect(stream.toolResult).toHaveBeenCalledWith('exec', 'file1.ts', true)
    })
  })

  describe('execute — abort', () => {
    it('should send chat.abort and return cancelled on abort signal', async () => {
      const stream = createMockStream()
      const controller = new AbortController()

      gateway.onChatSend = (params, ws) => {
        const sessionKey = params.sessionKey as string
        const runId = 'run-abort'

        ws.send(JSON.stringify({
          type: 'res', id: 'chat-send-1', ok: true,
          payload: { runId, status: 'started' },
        }))

        // Start lifecycle but don't end it — user will abort
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'event', event: 'agent', seq: 1,
            payload: { runId, stream: 'lifecycle', data: { phase: 'start' }, sessionKey: `agent:main:${sessionKey}` },
          }))
        }, 10)
      }

      // Abort after a short delay
      setTimeout(() => controller.abort(), 50)

      const result = await adapter.execute(makeTask(), stream, controller.signal)

      expect(result.status).toBe('cancelled')
      expect(result.error).toBe('Task cancelled')
    })
  })
})
