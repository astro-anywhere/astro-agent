/**
 * API Client tests
 *
 * Tests the HTTP client functions for device auth, focusing on:
 * - Error parsing in registerMachine (error_description, detail fields)
 * - DeviceAuthApiError construction
 * - pollForToken RFC 8628 state handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DeviceAuthApiError } from '../api-client.js'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DeviceAuthApiError', () => {
  it('should set name, message, code, and statusCode', () => {
    const err = new DeviceAuthApiError('test message', 'network', 502)
    expect(err.name).toBe('DeviceAuthApiError')
    expect(err.message).toBe('test message')
    expect(err.code).toBe('network')
    expect(err.statusCode).toBe(502)
  })

  it('should make statusCode optional', () => {
    const err = new DeviceAuthApiError('timeout', 'timeout')
    expect(err.statusCode).toBeUndefined()
  })

  it('should be an instance of Error', () => {
    const err = new DeviceAuthApiError('err', 'network')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(DeviceAuthApiError)
  })
})

describe('requestDeviceCode', () => {
  it('should POST to /api/device/authorize with machineInfo', async () => {
    const { requestDeviceCode } = await import('../api-client.js')
    const mockResponse = {
      deviceCode: 'dc-123',
      userCode: 'UC-456',
      verificationUri: 'https://example.com/device',
      verificationUriComplete: 'https://example.com/device?code=dc-123',
      expiresIn: 900,
      interval: 5,
    }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    })

    const result = await requestDeviceCode('https://api.example.com', {
      hostname: 'test-host',
      platform: 'darwin',
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/api/device/authorize',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    )
    expect(result.deviceCode).toBe('dc-123')
    expect(result.userCode).toBe('UC-456')
  })

  it('should throw DeviceAuthApiError with "network" code on fetch failure', async () => {
    const { requestDeviceCode } = await import('../api-client.js')
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    await expect(
      requestDeviceCode('https://api.example.com', { hostname: 'h', platform: 'p' })
    ).rejects.toThrow(DeviceAuthApiError)

    try {
      await requestDeviceCode('https://api.example.com', { hostname: 'h', platform: 'p' })
    } catch {
      // Second call also fails with same mock reset
    }
  })

  it('should throw DeviceAuthApiError with "server_error" on non-ok response', async () => {
    const { requestDeviceCode } = await import('../api-client.js')
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    })

    try {
      await requestDeviceCode('https://api.example.com', { hostname: 'h', platform: 'p' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthApiError)
      const apiErr = err as DeviceAuthApiError
      expect(apiErr.code).toBe('server_error')
      expect(apiErr.statusCode).toBe(500)
      expect(apiErr.message).toContain('500')
    }
  })
})

describe('registerMachine — error parsing', () => {
  it('should extract error_description from JSON error response', async () => {
    const { registerMachine } = await import('../api-client.js')
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({
        error: 'Failed to register machine',
        error_description: 'Database constraint violation — your user account may not exist.',
        detail: 'foreign key constraint "fk_user_id" violated',
      }),
    })

    try {
      await registerMachine('https://api.example.com', 'token-123', { hostname: 'test' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthApiError)
      const apiErr = err as DeviceAuthApiError
      expect(apiErr.code).toBe('server_error')
      expect(apiErr.statusCode).toBe(500)
      // Should include error_description
      expect(apiErr.message).toContain('Database constraint violation')
      // Should include detail
      expect(apiErr.message).toContain('foreign key constraint')
    }
  })

  it('should fall back to error field when error_description is absent', async () => {
    const { registerMachine } = await import('../api-client.js')
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({
        error: 'Failed to register machine',
      }),
    })

    try {
      await registerMachine('https://api.example.com', 'token-123', { hostname: 'test' })
      expect.unreachable('should have thrown')
    } catch (err) {
      const apiErr = err as DeviceAuthApiError
      expect(apiErr.message).toContain('Failed to register machine')
    }
  })

  it('should handle non-JSON error response gracefully', async () => {
    const { registerMachine } = await import('../api-client.js')
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway',
    })

    try {
      await registerMachine('https://api.example.com', 'token-123', { hostname: 'test' })
      expect.unreachable('should have thrown')
    } catch (err) {
      const apiErr = err as DeviceAuthApiError
      expect(apiErr.statusCode).toBe(502)
      expect(apiErr.message).toContain('Bad Gateway')
    }
  })

  it('should handle empty error response body', async () => {
    const { registerMachine } = await import('../api-client.js')
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => '',
    })

    try {
      await registerMachine('https://api.example.com', 'token-123', { hostname: 'test' })
      expect.unreachable('should have thrown')
    } catch (err) {
      const apiErr = err as DeviceAuthApiError
      expect(apiErr.statusCode).toBe(500)
      expect(apiErr.message).toContain('Machine registration failed (500)')
    }
  })

  it('should throw "network" error when fetch itself fails', async () => {
    const { registerMachine } = await import('../api-client.js')
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    try {
      await registerMachine('https://api.example.com', 'token-123', { hostname: 'test' })
      expect.unreachable('should have thrown')
    } catch (err) {
      const apiErr = err as DeviceAuthApiError
      expect(apiErr.code).toBe('network')
      expect(apiErr.message).toContain('ECONNREFUSED')
    }
  })

  it('should send correct Authorization header and body', async () => {
    const { registerMachine } = await import('../api-client.js')
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        machineId: 'mid-1',
        machineName: 'test',
        relayUrl: 'wss://relay.example.com',
        wsToken: 'ws-tok',
        message: 'ok',
        accessToken: 'new-at',
        refreshToken: 'new-rt',
        expiresIn: 3600,
      }),
    })

    await registerMachine('https://api.example.com', 'my-token', { hostname: 'test' })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/api/device/register',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer my-token',
        },
      })
    )

    // Verify body contains machineInfo
    const callArgs = mockFetch.mock.calls[0]
    const body = JSON.parse(callArgs[1].body as string)
    expect(body.machineInfo).toEqual({ hostname: 'test' })
  })
})

describe('pollForToken — RFC 8628 states', () => {
  it('should return tokens on immediate success (200)', async () => {
    const { pollForToken } = await import('../api-client.js')
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        accessToken: 'at-123',
        tokenType: 'Bearer',
        expiresIn: 3600,
        refreshToken: 'rt-123',
        scopes: ['machine:connect'],
      }),
    })

    const result = await pollForToken('https://api.example.com', 'UC-123', 0.01, 5)
    expect(result.accessToken).toBe('at-123')
  })

  it('should throw "denied" on access_denied', async () => {
    const { pollForToken } = await import('../api-client.js')
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'access_denied', errorDescription: 'User denied' }),
    })

    try {
      await pollForToken('https://api.example.com', 'UC-123', 0.01, 5)
      expect.unreachable('should have thrown')
    } catch (err) {
      const apiErr = err as DeviceAuthApiError
      expect(apiErr.code).toBe('denied')
    }
  })

  it('should throw "expired" on expired_token', async () => {
    const { pollForToken } = await import('../api-client.js')
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'expired_token', errorDescription: 'Expired' }),
    })

    try {
      await pollForToken('https://api.example.com', 'UC-123', 0.01, 5)
      expect.unreachable('should have thrown')
    } catch (err) {
      const apiErr = err as DeviceAuthApiError
      expect(apiErr.code).toBe('expired')
    }
  })

  it('should continue polling on authorization_pending then succeed', async () => {
    const { pollForToken } = await import('../api-client.js')
    // First poll: pending
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'authorization_pending', errorDescription: 'Pending' }),
    })
    // Second poll: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        accessToken: 'at-delayed',
        tokenType: 'Bearer',
        expiresIn: 3600,
        refreshToken: 'rt-delayed',
        scopes: ['machine:connect'],
      }),
    })

    const result = await pollForToken('https://api.example.com', 'UC-123', 0.01, 5)
    expect(result.accessToken).toBe('at-delayed')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('should throw "server_error" when token endpoint returns non-JSON (e.g., reverse proxy HTML)', async () => {
    const { pollForToken } = await import('../api-client.js')
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
    })

    try {
      await pollForToken('https://api.example.com', 'UC-123', 0.01, 5)
      expect.unreachable('should have thrown')
    } catch (err) {
      const apiErr = err as DeviceAuthApiError
      expect(apiErr.code).toBe('server_error')
      expect(apiErr.statusCode).toBe(502)
      expect(apiErr.message).toContain('non-JSON')
    }
  })

  it('should throw "network" on fetch failure during polling', async () => {
    const { pollForToken } = await import('../api-client.js')
    mockFetch.mockRejectedValueOnce(new Error('Network is down'))

    try {
      await pollForToken('https://api.example.com', 'UC-123', 0.01, 5)
      expect.unreachable('should have thrown')
    } catch (err) {
      const apiErr = err as DeviceAuthApiError
      expect(apiErr.code).toBe('network')
    }
  })

  it('should throw "timeout" when deadline is exceeded', async () => {
    const { pollForToken } = await import('../api-client.js')
    // Always return pending
    mockFetch.mockImplementation(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'authorization_pending', errorDescription: 'Pending' }),
    }))

    try {
      // Very short timeout (0.05 seconds) with 0.01s interval
      await pollForToken('https://api.example.com', 'UC-123', 0.01, 0.05)
      expect.unreachable('should have thrown')
    } catch (err) {
      const apiErr = err as DeviceAuthApiError
      expect(apiErr.code).toBe('timeout')
    }
  })
})
