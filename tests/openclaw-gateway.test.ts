/**
 * OpenClaw Gateway Shared Utilities Tests
 *
 * Tests for the consolidated gateway config, probe, frame parsing,
 * and session key utilities.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  parseGatewayFrame,
  probeGateway,
  makeSessionKey,
  matchesSessionKey,
} from '../src/lib/openclaw-gateway.js'

// ---------------------------------------------------------------------------
// parseGatewayFrame
// ---------------------------------------------------------------------------

describe('parseGatewayFrame', () => {
  it('should parse valid JSON into a GatewayFrame', () => {
    const data = JSON.stringify({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'abc' },
    })
    const frame = parseGatewayFrame(data)
    expect(frame).toEqual({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'abc' },
    })
  })

  it('should return null for invalid JSON', () => {
    expect(parseGatewayFrame('not-json')).toBeNull()
  })

  it('should return null for empty string', () => {
    expect(parseGatewayFrame('')).toBeNull()
  })

  it('should handle Buffer input', () => {
    const data = Buffer.from(JSON.stringify({ type: 'res', id: '1', ok: true }))
    const frame = parseGatewayFrame(data)
    expect(frame).toEqual({ type: 'res', id: '1', ok: true })
  })
})

// ---------------------------------------------------------------------------
// makeSessionKey
// ---------------------------------------------------------------------------

describe('makeSessionKey', () => {
  it('should create astro:task: prefixed key', () => {
    expect(makeSessionKey('task-42')).toBe('astro:task:task-42')
  })

  it('should handle UUIDs', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    expect(makeSessionKey(uuid)).toBe(`astro:task:${uuid}`)
  })
})

// ---------------------------------------------------------------------------
// matchesSessionKey
// ---------------------------------------------------------------------------

describe('matchesSessionKey', () => {
  it('should match exact session key', () => {
    expect(matchesSessionKey('astro:task:42', 'astro:task:42')).toBe(true)
  })

  it('should match with agent:main: prefix', () => {
    expect(matchesSessionKey('agent:main:astro:task:42', 'astro:task:42')).toBe(true)
  })

  it('should not match different keys', () => {
    expect(matchesSessionKey('astro:task:99', 'astro:task:42')).toBe(false)
  })

  it('should return false for non-string payload key', () => {
    expect(matchesSessionKey(42, 'astro:task:42')).toBe(false)
    expect(matchesSessionKey(null, 'astro:task:42')).toBe(false)
    expect(matchesSessionKey(undefined, 'astro:task:42')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// probeGateway
// ---------------------------------------------------------------------------

describe('probeGateway', () => {
  let wss: WebSocketServer
  let port: number

  afterEach(async () => {
    if (wss) {
      for (const client of wss.clients) {
        client.close()
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })

  it('should return true when gateway sends connect.challenge', async () => {
    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => {
      wss.on('listening', () => {
        const addr = wss.address()
        if (typeof addr === 'object' && addr) {
          port = addr.port
        }
        resolve()
      })
    })

    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'test' },
      }))
    })

    const result = await probeGateway(`ws://127.0.0.1:${port}`)
    expect(result).toBe(true)
  })

  it('should return false for unreachable port', async () => {
    const result = await probeGateway('ws://127.0.0.1:59998', 1000)
    expect(result).toBe(false)
  })

  it('should return false on timeout with no challenge', async () => {
    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => {
      wss.on('listening', () => {
        const addr = wss.address()
        if (typeof addr === 'object' && addr) {
          port = addr.port
        }
        resolve()
      })
    })

    // Accept connection but don't send challenge
    wss.on('connection', () => {
      // silence
    })

    const result = await probeGateway(`ws://127.0.0.1:${port}`, 500)
    expect(result).toBe(false)
  })
})
