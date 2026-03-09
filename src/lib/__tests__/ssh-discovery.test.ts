/**
 * SSH Discovery deduplication tests
 *
 * Tests that discoverRemoteHosts() properly deduplicates hosts
 * across SSH config, VS Code tunnels, and known_hosts by tracking
 * both alias names AND resolved hostnames.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock file system — controls what parseSSHConfig / parseKnownHosts see
let mockSSHConfig = ''
let mockKnownHosts = ''
let mockVSCodeHosts: string | null = null

vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => {
    if (path.endsWith('.ssh/config')) {
      if (!mockSSHConfig) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return mockSSHConfig
    }
    if (path.endsWith('.ssh/known_hosts')) {
      if (!mockKnownHosts) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return mockKnownHosts
    }
    // VS Code config paths
    if (path.includes('remote-ssh') && path.endsWith('hosts.json')) {
      if (!mockVSCodeHosts) throw new Error('ENOENT')
      return mockVSCodeHosts
    }
    throw new Error(`Unmocked readFile: ${path}`)
  },
}))

vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
}))

describe('SSH Discovery — deduplication', () => {
  beforeEach(() => {
    vi.resetModules()
    mockSSHConfig = ''
    mockKnownHosts = ''
    mockVSCodeHosts = null
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should deduplicate hosts with same resolved hostname from SSH config', async () => {
    // Two aliases pointing to the same hostname
    mockSSHConfig = [
      'Host misha',
      '  HostName misha.ycrc.yale.edu',
      '  User zz572',
      '',
      'Host jump-server',
      '  HostName misha.ycrc.yale.edu',
      '  User zz572',
    ].join('\n')

    const { discoverRemoteHosts } = await import('../ssh-discovery.js')
    const hosts = await discoverRemoteHosts()

    // Should only have one entry for misha.ycrc.yale.edu
    const mishaHosts = hosts.filter(h => h.hostname === 'misha.ycrc.yale.edu')
    expect(mishaHosts).toHaveLength(1)
    expect(mishaHosts[0].name).toBe('misha') // first one wins
  })

  it('should deduplicate known_hosts entries that overlap with SSH config hostnames', async () => {
    mockSSHConfig = [
      'Host farnam',
      '  HostName farnam.hpc.yale.edu',
      '  User zz572',
    ].join('\n')

    // known_hosts has the same FQDN
    mockKnownHosts = [
      'farnam.hpc.yale.edu ssh-rsa AAAAB3...',
    ].join('\n')

    const { discoverRemoteHosts } = await import('../ssh-discovery.js')
    const hosts = await discoverRemoteHosts()

    // Should only have one entry — SSH config takes priority
    const farnamHosts = hosts.filter(h =>
      h.hostname === 'farnam.hpc.yale.edu' || h.name === 'farnam.hpc.yale.edu'
    )
    expect(farnamHosts).toHaveLength(1)
    expect(farnamHosts[0].source).toBe('ssh-config')
  })

  it('should keep hosts with different resolved hostnames', async () => {
    mockSSHConfig = [
      'Host server-a',
      '  HostName alpha.example.com',
      '',
      'Host server-b',
      '  HostName beta.example.com',
    ].join('\n')

    const { discoverRemoteHosts } = await import('../ssh-discovery.js')
    const hosts = await discoverRemoteHosts()

    expect(hosts).toHaveLength(2)
    expect(hosts.map(h => h.name).sort()).toEqual(['server-a', 'server-b'])
  })

  it('should skip wildcard patterns and localhost', async () => {
    mockSSHConfig = [
      'Host *',
      '  ServerAliveInterval 60',
      '',
      'Host local',
      '  HostName localhost',
      '',
      'Host prod',
      '  HostName prod.example.com',
    ].join('\n')

    const { discoverRemoteHosts } = await import('../ssh-discovery.js')
    const hosts = await discoverRemoteHosts()

    expect(hosts).toHaveLength(1)
    expect(hosts[0].name).toBe('prod')
  })

  it('should skip git forge hosts', async () => {
    mockSSHConfig = [
      'Host github.com',
      '  HostName github.com',
      '  User git',
      '',
      'Host gitlab.com',
      '  HostName gitlab.com',
      '  User git',
      '',
      'Host my-server',
      '  HostName server.example.com',
    ].join('\n')

    const { discoverRemoteHosts } = await import('../ssh-discovery.js')
    const hosts = await discoverRemoteHosts()

    expect(hosts).toHaveLength(1)
    expect(hosts[0].name).toBe('my-server')
  })

  it('should handle case-insensitive hostname comparison', async () => {
    mockSSHConfig = [
      'Host upper',
      '  HostName SERVER.Example.COM',
      '',
      'Host lower',
      '  HostName server.example.com',
    ].join('\n')

    const { discoverRemoteHosts } = await import('../ssh-discovery.js')
    const hosts = await discoverRemoteHosts()

    // Case-insensitive dedup — only first one should survive
    expect(hosts).toHaveLength(1)
    expect(hosts[0].name).toBe('upper')
  })

  it('should add known_hosts entries not already in SSH config', async () => {
    mockSSHConfig = [
      'Host myhost',
      '  HostName myhost.example.com',
    ].join('\n')

    mockKnownHosts = [
      'other.example.com ssh-rsa AAAAB3...',
    ].join('\n')

    const { discoverRemoteHosts } = await import('../ssh-discovery.js')
    const hosts = await discoverRemoteHosts()

    expect(hosts).toHaveLength(2)
    const names = hosts.map(h => h.name)
    expect(names).toContain('myhost')
    expect(names).toContain('other.example.com')
  })

  it('should return empty when no SSH config exists', async () => {
    // All mocks default to empty/ENOENT
    const { discoverRemoteHosts } = await import('../ssh-discovery.js')
    const hosts = await discoverRemoteHosts()

    expect(hosts).toHaveLength(0)
  })

  it('should parse user, port, identityFile, and proxyJump from SSH config', async () => {
    mockSSHConfig = [
      'Host hpc',
      '  HostName hpc.university.edu',
      '  User researcher',
      '  Port 2222',
      '  IdentityFile ~/.ssh/id_hpc',
      '  ProxyJump bastion',
    ].join('\n')

    const { discoverRemoteHosts } = await import('../ssh-discovery.js')
    const hosts = await discoverRemoteHosts()

    expect(hosts).toHaveLength(1)
    expect(hosts[0].user).toBe('researcher')
    expect(hosts[0].port).toBe(2222)
    expect(hosts[0].identityFile).toBe('/home/testuser/.ssh/id_hpc')
    expect(hosts[0].proxyJump).toBe('bastion')
  })

  it('should skip IP addresses and hashed entries in known_hosts', async () => {
    mockKnownHosts = [
      '192.168.1.1 ssh-rsa AAAAB3...',
      '|1|base64hash= ssh-rsa AAAAB3...',
      'real-host.example.com ssh-rsa AAAAB3...',
    ].join('\n')

    const { discoverRemoteHosts } = await import('../ssh-discovery.js')
    const hosts = await discoverRemoteHosts()

    expect(hosts).toHaveLength(1)
    expect(hosts[0].name).toBe('real-host.example.com')
  })

  it('should handle inline comments in HostName', async () => {
    mockSSHConfig = [
      'Host myhost',
      '  HostName 10.0.0.5  # internal IP',
    ].join('\n')

    const { discoverRemoteHosts } = await import('../ssh-discovery.js')
    const hosts = await discoverRemoteHosts()

    expect(hosts).toHaveLength(1)
    // Inline comment should be stripped
    expect(hosts[0].hostname).toBe('10.0.0.5')
  })
})

describe('formatDiscoveredHosts', () => {
  it('should return "No remote hosts" for empty array', async () => {
    const { formatDiscoveredHosts } = await import('../ssh-discovery.js')
    expect(formatDiscoveredHosts([])).toBe('No remote hosts discovered.')
  })

  it('should group hosts by source', async () => {
    const { formatDiscoveredHosts } = await import('../ssh-discovery.js')
    const result = formatDiscoveredHosts([
      { name: 'a', hostname: 'a.com', source: 'ssh-config' },
      { name: 'b', hostname: 'b.com', source: 'known-hosts' },
    ])
    expect(result).toContain('SSH config')
    expect(result).toContain('known hosts')
  })
})

describe('buildSSHCommand', () => {
  it('should build basic SSH command', async () => {
    const { buildSSHCommand } = await import('../ssh-discovery.js')
    const cmd = buildSSHCommand({ name: 'myhost', hostname: 'myhost.com', source: 'ssh-config' })
    expect(cmd).toBe('ssh myhost.com')
  })

  it('should include user@hostname when user is set', async () => {
    const { buildSSHCommand } = await import('../ssh-discovery.js')
    const cmd = buildSSHCommand({ name: 'myhost', hostname: 'myhost.com', user: 'admin', source: 'ssh-config' })
    expect(cmd).toBe('ssh admin@myhost.com')
  })

  it('should include port, identity file, and proxy jump', async () => {
    const { buildSSHCommand } = await import('../ssh-discovery.js')
    const cmd = buildSSHCommand({
      name: 'hpc',
      hostname: 'hpc.edu',
      port: 2222,
      identityFile: '/home/user/.ssh/id_hpc',
      proxyJump: 'bastion',
      source: 'ssh-config',
    })
    expect(cmd).toBe('ssh -p 2222 -i /home/user/.ssh/id_hpc -J bastion hpc.edu')
  })

  it('should append command when provided', async () => {
    const { buildSSHCommand } = await import('../ssh-discovery.js')
    const cmd = buildSSHCommand(
      { name: 'myhost', hostname: 'myhost.com', source: 'ssh-config' },
      'ls -la'
    )
    expect(cmd).toBe('ssh myhost.com ls -la')
  })
})
