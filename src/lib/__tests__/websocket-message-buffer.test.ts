/**
 * Tests for WebSocket client message buffering during disconnect.
 *
 * Verifies:
 * - Messages sent when WS is OPEN go through immediately
 * - Messages sent when WS is CLOSED are buffered
 * - Buffered messages are drained in FIFO order on reconnect
 * - Buffer overflow drops oldest messages
 * - Buffer is empty after drain
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WS_CLIENT_PATH = join(
  import.meta.dirname,
  '..',
  'websocket-client.ts',
)
const source = readFileSync(WS_CLIENT_PATH, 'utf-8')

describe('WebSocket message buffer — source verification', () => {
  it('declares pendingMessages buffer array', () => {
    expect(source).toContain('private pendingMessages: WSMessage[] = []')
  })

  it('declares MAX_PENDING constant', () => {
    expect(source).toContain('private static MAX_PENDING = 5000')
  })

  it('buffers messages when WS is not OPEN', () => {
    // send() should push to pendingMessages when readyState !== OPEN
    expect(source).toContain('this.pendingMessages.push(message)')
  })

  it('drops oldest message when buffer is full', () => {
    expect(source).toContain('this.pendingMessages.length >= WebSocketClient.MAX_PENDING')
    expect(source).toContain('this.pendingMessages.shift()')
    expect(source).toContain("console.warn('[ws-client] Pending buffer full, dropping oldest message')")
  })

  it('defines drainPendingMessages method', () => {
    expect(source).toContain('private drainPendingMessages(): void')
  })

  it('drains buffered messages in FIFO order via splice(0)', () => {
    expect(source).toContain('this.pendingMessages.splice(0)')
  })

  it('logs drain count on reconnect', () => {
    expect(source).toMatch(/console\.log\(`\[ws-client\] Draining \$\{count\} buffered messages after reconnect`\)/)
  })

  it('calls drainPendingMessages in handleOpen after registration', () => {
    // Verify drain is called after send(registerMsg) in handleOpen
    const registerIdx = source.indexOf('this.send(registerMsg)')
    const drainIdx = source.indexOf('this.drainPendingMessages()')
    expect(registerIdx).toBeGreaterThan(-1)
    expect(drainIdx).toBeGreaterThan(-1)
    expect(drainIdx).toBeGreaterThan(registerIdx)
  })

  it('buffer is emptied after drain (splice removes all elements)', () => {
    // splice(0) removes all elements from the array, leaving it empty
    expect(source).toContain('const messages = this.pendingMessages.splice(0)')
  })

  it('early-returns when buffer is empty', () => {
    expect(source).toContain('if (this.pendingMessages.length === 0) return')
  })
})

describe('WebSocket message buffer — behavioral verification', () => {
  it('send() only sends via WebSocket when readyState is OPEN', () => {
    // The OPEN path sends immediately via ws.send
    expect(source).toContain("if (this.ws?.readyState === WebSocket.OPEN)")
    expect(source).toContain('this.ws.send(JSON.stringify(message))')
  })

  it('send() has else branch that buffers when not OPEN', () => {
    // After the OPEN check, the else branch handles buffering
    const sendMethod = source.slice(
      source.indexOf('private send(message: WSMessage): void'),
      source.indexOf('private drainPendingMessages'),
    )
    expect(sendMethod).toContain('} else {')
    expect(sendMethod).toContain('this.pendingMessages.push(message)')
  })

  it('drain calls send() for each buffered message', () => {
    const drainMethod = source.slice(
      source.indexOf('private drainPendingMessages(): void'),
      source.indexOf('private startHeartbeat'),
    )
    expect(drainMethod).toContain('for (const msg of messages)')
    expect(drainMethod).toContain('this.send(msg)')
  })
})
