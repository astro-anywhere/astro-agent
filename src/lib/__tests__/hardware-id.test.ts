/**
 * Hardware ID derivation tests
 *
 * Tests the exported getHardwareId() and generateMachineName() functions.
 * Since deriveUserMachineId is private, we verify its behavior indirectly
 * by mocking OS-level primitives and observing the output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

// UUID-format regex: 8-4-4-4-12 hex characters
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Reproduce the private deriveUserMachineId logic to compute expected values.
 * This lets us verify the function without exporting it.
 */
function expectedDerivedId(hardwareId: string, username: string): string {
  const hash = createHash('sha256')
    .update(`${hardwareId}:${username}`)
    .digest('hex')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-')
}

// Shared mock state -- tests configure these before importing the module
let mockExecFileImpl: (...args: unknown[]) => Promise<{ stdout: string; stderr: string }>
let mockUsername = 'testuser'
let mockUserInfoThrows = false
let mockNetworkInterfaces: Record<string, Array<{ address: string; mac: string; internal: boolean; family: string; netmask: string; cidr: string }>> = {}

// Mock node:util so that promisify(execFileCb) returns our controllable mock
vi.mock('node:util', () => ({
  promisify: () => {
    // Return a function that delegates to the mutable mockExecFileImpl
    return (...args: unknown[]) => mockExecFileImpl(...args)
  },
}))

// Mock node:os
vi.mock('node:os', () => ({
  userInfo: () => {
    if (mockUserInfoThrows) {
      throw new Error('Not supported on this platform')
    }
    return { username: mockUsername }
  },
  networkInterfaces: () => mockNetworkInterfaces,
}))

describe('Hardware ID', () => {
  beforeEach(() => {
    vi.resetModules()
    // Reset mock state to safe defaults
    mockExecFileImpl = () => Promise.reject(new Error('command not found'))
    mockUsername = 'testuser'
    mockUserInfoThrows = false
    mockNetworkInterfaces = {}
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getHardwareId', () => {
    it('should return an ID in UUID format when hardware UUID is available', async () => {
      const fakeUuid = 'FAKE-UUID-1234-5678-ABCDEF012345'
      mockExecFileImpl = () =>
        Promise.resolve({
          stdout: JSON.stringify({
            SPHardwareDataType: [{ platform_UUID: fakeUuid }],
          }),
          stderr: '',
        })
      mockUsername = 'testuser'

      const { getHardwareId } = await import('../hardware-id.js')
      const result = await getHardwareId()

      expect(result.source).toBe('uuid')
      expect(result.id).toMatch(UUID_FORMAT)

      // Verify it matches the expected derivation
      const expected = expectedDerivedId(fakeUuid.toLowerCase(), 'testuser')
      expect(result.id).toBe(expected)
    })

    it('should return an ID with source "mac" when hardware UUID is unavailable', async () => {
      // execFile fails -> no hardware UUID
      mockExecFileImpl = () => Promise.reject(new Error('command not found'))
      mockUsername = 'testuser'
      mockNetworkInterfaces = {
        en0: [
          {
            address: '192.168.1.100',
            mac: 'aa:bb:cc:dd:ee:ff',
            internal: false,
            family: 'IPv4',
            netmask: '255.255.255.0',
            cidr: '192.168.1.100/24',
          },
        ],
      }

      const { getHardwareId } = await import('../hardware-id.js')
      const result = await getHardwareId()

      expect(result.source).toBe('mac')
      expect(result.id).toMatch(UUID_FORMAT)

      // Verify it matches the expected derivation
      const expectedMac = 'aabbccddeeff'
      const expected = expectedDerivedId(`mac-${expectedMac}`, 'testuser')
      expect(result.id).toBe(expected)
    })

    it('should return source "random" when both UUID and MAC are unavailable', async () => {
      mockExecFileImpl = () => Promise.reject(new Error('command not found'))
      mockUsername = 'testuser'
      // Only loopback/internal interfaces -- no valid MAC
      mockNetworkInterfaces = {
        lo0: [
          {
            address: '127.0.0.1',
            mac: '00:00:00:00:00:00',
            internal: true,
            family: 'IPv4',
            netmask: '255.0.0.0',
            cidr: '127.0.0.1/8',
          },
        ],
      }

      const { getHardwareId } = await import('../hardware-id.js')
      const result = await getHardwareId()

      expect(result.source).toBe('random')
      // Random IDs have a 'rand-' prefix followed by a standard UUID
      expect(result.id).toMatch(
        /^rand-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
    })

    it('should be deterministic -- same inputs produce same ID', async () => {
      const fakeUuid = 'DETERMINISTIC-UUID-TEST'
      mockExecFileImpl = () =>
        Promise.resolve({
          stdout: JSON.stringify({
            SPHardwareDataType: [{ platform_UUID: fakeUuid }],
          }),
          stderr: '',
        })
      mockUsername = 'deterministic-user'

      const { getHardwareId } = await import('../hardware-id.js')
      const first = await getHardwareId()
      const second = await getHardwareId()

      expect(first.id).toBe(second.id)
      expect(first.source).toBe(second.source)
      expect(first.source).toBe('uuid')
    })

    it('should produce different IDs for different usernames on the same hardware', async () => {
      const fakeUuid = 'SHARED-HW-UUID'
      mockExecFileImpl = () =>
        Promise.resolve({
          stdout: JSON.stringify({
            SPHardwareDataType: [{ platform_UUID: fakeUuid }],
          }),
          stderr: '',
        })

      // Get ID for alice
      mockUsername = 'alice'
      const mod1 = await import('../hardware-id.js')
      const aliceResult = await mod1.getHardwareId()

      // Reset modules to get a fresh import with new username
      vi.resetModules()

      // Change username to bob (mock state persists across resetModules)
      mockUsername = 'bob'
      const mod2 = await import('../hardware-id.js')
      const bobResult = await mod2.getHardwareId()

      expect(aliceResult.source).toBe('uuid')
      expect(bobResult.source).toBe('uuid')
      expect(aliceResult.id).not.toBe(bobResult.id)

      // Both should still be valid UUID-formatted hashes
      expect(aliceResult.id).toMatch(UUID_FORMAT)
      expect(bobResult.id).toMatch(UUID_FORMAT)

      // Verify against expected derivations
      const hwLower = fakeUuid.toLowerCase()
      expect(aliceResult.id).toBe(expectedDerivedId(hwLower, 'alice'))
      expect(bobResult.id).toBe(expectedDerivedId(hwLower, 'bob'))
    })

    it('should fall back to env vars when userInfo() throws', async () => {
      const fakeUuid = 'ENV-FALLBACK-UUID'
      mockExecFileImpl = () =>
        Promise.resolve({
          stdout: JSON.stringify({
            SPHardwareDataType: [{ platform_UUID: fakeUuid }],
          }),
          stderr: '',
        })
      mockUserInfoThrows = true

      const originalUser = process.env.USER
      process.env.USER = 'envuser'

      try {
        const { getHardwareId } = await import('../hardware-id.js')
        const result = await getHardwareId()

        expect(result.source).toBe('uuid')
        expect(result.id).toMatch(UUID_FORMAT)

        // Verify the ID was derived using 'envuser' as the username
        const expected = expectedDerivedId(fakeUuid.toLowerCase(), 'envuser')
        expect(result.id).toBe(expected)
      } finally {
        process.env.USER = originalUser
        mockUserInfoThrows = false
      }
    })

    it('should return source as one of the expected values', async () => {
      // Use default mocks (execFile fails, no interfaces) -> random
      mockExecFileImpl = () => Promise.reject(new Error('command not found'))
      mockNetworkInterfaces = {}

      const { getHardwareId } = await import('../hardware-id.js')
      const result = await getHardwareId()

      expect(['uuid', 'mac', 'random']).toContain(result.source)
      expect(typeof result.id).toBe('string')
      expect(result.id.length).toBeGreaterThan(0)
    })

    it('should skip MAC addresses of all-zero value', async () => {
      mockExecFileImpl = () => Promise.reject(new Error('command not found'))
      mockNetworkInterfaces = {
        en0: [
          {
            address: '192.168.1.1',
            mac: '00:00:00:00:00:00',
            internal: false,
            family: 'IPv4',
            netmask: '255.255.255.0',
            cidr: '192.168.1.1/24',
          },
        ],
      }

      const { getHardwareId } = await import('../hardware-id.js')
      const result = await getHardwareId()

      // All-zero MAC should be skipped, falling through to random
      expect(result.source).toBe('random')
    })

    it('should skip docker and veth interfaces when searching for MAC', async () => {
      mockExecFileImpl = () => Promise.reject(new Error('command not found'))
      mockNetworkInterfaces = {
        docker0: [
          {
            address: '172.17.0.1',
            mac: 'aa:bb:cc:dd:ee:ff',
            internal: false,
            family: 'IPv4',
            netmask: '255.255.0.0',
            cidr: '172.17.0.1/16',
          },
        ],
        veth123: [
          {
            address: '172.18.0.1',
            mac: '11:22:33:44:55:66',
            internal: false,
            family: 'IPv4',
            netmask: '255.255.0.0',
            cidr: '172.18.0.1/16',
          },
        ],
      }

      const { getHardwareId } = await import('../hardware-id.js')
      const result = await getHardwareId()

      // docker0 and veth interfaces should be skipped
      expect(result.source).toBe('random')
    })

    it('should prefer priority interfaces (en0, eth0) over other interfaces', async () => {
      mockExecFileImpl = () => Promise.reject(new Error('command not found'))
      mockUsername = 'testuser'
      mockNetworkInterfaces = {
        wlan0: [
          {
            address: '192.168.1.50',
            mac: '11:11:11:11:11:11',
            internal: false,
            family: 'IPv4',
            netmask: '255.255.255.0',
            cidr: '192.168.1.50/24',
          },
        ],
        en0: [
          {
            address: '192.168.1.100',
            mac: 'aa:bb:cc:dd:ee:ff',
            internal: false,
            family: 'IPv4',
            netmask: '255.255.255.0',
            cidr: '192.168.1.100/24',
          },
        ],
      }

      const { getHardwareId } = await import('../hardware-id.js')
      const result = await getHardwareId()

      expect(result.source).toBe('mac')
      // Should use en0's MAC (aabbccddeeff), not wlan0's
      const expected = expectedDerivedId('mac-aabbccddeeff', 'testuser')
      expect(result.id).toBe(expected)
    })
  })

  describe('generateMachineName', () => {
    it('should use "machine" prefix for uuid source', async () => {
      const { generateMachineName } = await import('../hardware-id.js')
      const name = generateMachineName('abcdef01-2345-6789-abcd-ef0123456789', 'uuid')

      expect(name).toMatch(/^machine-[a-z0-9]{8}$/)
    })

    it('should use "device" prefix for mac source', async () => {
      const { generateMachineName } = await import('../hardware-id.js')
      const name = generateMachineName('abcdef01-2345-6789-abcd-ef0123456789', 'mac')

      expect(name).toMatch(/^device-[a-z0-9]{8}$/)
    })

    it('should use "agent" prefix for random source', async () => {
      const { generateMachineName } = await import('../hardware-id.js')
      const name = generateMachineName('rand-abcdef01-2345-6789-abcd-ef0123456789', 'random')

      expect(name).toMatch(/^agent-[a-z0-9]{8}$/)
    })

    it('should use the last 8 alphanumeric characters of the ID as suffix', async () => {
      const { generateMachineName } = await import('../hardware-id.js')
      // ID: "00000000-0000-0000-0000-00000000abcd"
      // Stripped of non-alnum: "000000000000000000000000abcd" -> last 8: "0000abcd"
      const name = generateMachineName('00000000-0000-0000-0000-00000000abcd', 'uuid')
      expect(name).toBe('machine-0000abcd')
    })

    it('should handle IDs shorter than 8 alphanumeric chars', async () => {
      const { generateMachineName } = await import('../hardware-id.js')
      const name = generateMachineName('abc', 'uuid')

      // "abc" stripped is "abc", last 8 of 3-char string is "abc"
      expect(name).toBe('machine-abc')
    })

    it('should strip hyphens and non-alphanumeric characters from the ID', async () => {
      const { generateMachineName } = await import('../hardware-id.js')
      // ID with lots of hyphens: "a-b-c-d-e-f-g-h" -> stripped "abcdefgh" -> last 8: "abcdefgh"
      const name = generateMachineName('a-b-c-d-e-f-g-h', 'mac')
      expect(name).toBe('device-abcdefgh')
    })
  })
})
