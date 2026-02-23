/**
 * Configuration management using conf (electron-conf compatible)
 */

import Conf from 'conf';
import { randomUUID } from 'node:crypto';
import type { StoredConfig, ProviderType } from '../types.js';
import { getHardwareId } from './hardware-id.js';

// Production defaults (Fly.io backend)
const DEFAULT_API_URL = 'https://api.astroanywhere.com';
const DEFAULT_RELAY_URL = 'wss://relay.astroanywhere.com:3002';

/**
 * Derive API and relay URLs from environment variables.
 *
 * Priority (highest first):
 *   1. ASTRO_SERVER_URL / ASTRO_RELAY_URL  — explicit agent-runner env vars
 *   2. VITE_API_BASE_URL                   — set in .env.prod (points to Fly.io backend)
 *   3. CLOUDFLARED_DOMAIN                  — dev mode with Cloudflare tunnel
 *   4. Defaults                            — Fly.io production backend
 *
 * Relay URL derivation:
 *   - Fly.io backend exposes relay on port 3002 with TLS → wss://<fly-app>.fly.dev:3002
 *   - Cloudflare tunnel maps astro-relay.<domain> → wss://astro-relay.<domain>
 *   - Local dev → ws://localhost:3002
 */
function resolveApiUrlFromEnv(): string {
  // Explicit override
  if (process.env.ASTRO_SERVER_URL) return process.env.ASTRO_SERVER_URL;

  // Prod mode: VITE_API_BASE_URL points to the Fly.io backend
  if (process.env.VITE_API_BASE_URL) return process.env.VITE_API_BASE_URL;

  // Dev mode with tunnel: derive from CLOUDFLARED_DOMAIN
  if (process.env.CLOUDFLARED_DOMAIN) {
    return `https://astro-api.${process.env.CLOUDFLARED_DOMAIN}`;
  }

  return DEFAULT_API_URL;
}

function resolveRelayUrlFromEnv(): string {
  // Explicit override
  if (process.env.ASTRO_RELAY_URL) return process.env.ASTRO_RELAY_URL;

  // Prod mode: derive WSS relay from VITE_API_BASE_URL (Fly.io exposes relay on :3002)
  if (process.env.VITE_API_BASE_URL) {
    const flyHost = process.env.VITE_API_BASE_URL
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    return `wss://${flyHost}:3002`;
  }

  // Dev mode with tunnel: derive from CLOUDFLARED_DOMAIN
  if (process.env.CLOUDFLARED_DOMAIN) {
    return `wss://astro-relay.${process.env.CLOUDFLARED_DOMAIN}`;
  }

  return DEFAULT_RELAY_URL;
}

interface ConfigSchema {
  runnerId: string;
  machineId: string;
  machineName?: string;
  deviceToken?: string;
  apiUrl: string;
  accessToken?: string;
  refreshToken?: string;
  wsToken?: string;
  claudeOauthToken?: string;
  relayUrl: string;
  providers: ProviderType[];
  autoStart: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  lastConnected?: string;
  setupCompleted: boolean;
  mcpServers?: Record<string, {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }>;
}

class ConfigManager {
  private conf: Conf<ConfigSchema>;

  constructor() {
    this.conf = new Conf<ConfigSchema>({
      projectName: 'astro-agent',
      projectVersion: '0.1.0',
      defaults: {
        runnerId: '',
        machineId: '',
        deviceToken: undefined,
        apiUrl: DEFAULT_API_URL,
        accessToken: undefined,
        refreshToken: undefined,
        wsToken: undefined,
        claudeOauthToken: undefined,
        relayUrl: DEFAULT_RELAY_URL,
        providers: [],
        autoStart: false,
        logLevel: 'info',
        lastConnected: undefined,
        setupCompleted: false,
      },
    });
  }

  /**
   * Check if initial setup has been completed
   */
  isSetupComplete(): boolean {
    return this.conf.get('setupCompleted');
  }

  /**
   * Get all stored configuration
   */
  getConfig(): StoredConfig & { apiUrl: string; accessToken?: string; refreshToken?: string; wsToken?: string } {
    return {
      runnerId: this.conf.get('runnerId'),
      machineId: this.conf.get('machineId'),
      deviceToken: this.conf.get('deviceToken'),
      apiUrl: this.conf.get('apiUrl'),
      accessToken: this.conf.get('accessToken'),
      refreshToken: this.conf.get('refreshToken'),
      wsToken: this.conf.get('wsToken'),
      relayUrl: this.conf.get('relayUrl'),
      providers: this.conf.get('providers'),
      autoStart: this.conf.get('autoStart'),
      logLevel: this.conf.get('logLevel'),
      mcpServers: this.conf.get('mcpServers'),
    };
  }

  /**
   * Get runner ID, generating one if not set
   */
  getRunnerId(): string {
    let runnerId = this.conf.get('runnerId');
    if (!runnerId) {
      runnerId = `runner-${randomUUID().slice(0, 8)}`;
      this.conf.set('runnerId', runnerId);
    }
    return runnerId;
  }

  /**
   * Initialize machine ID using hardware-based identifier
   * Should be called during setup - async operation
   */
  async initializeMachineId(): Promise<{ id: string; source: 'uuid' | 'mac' | 'random' }> {
    const existing = this.conf.get('machineId');
    if (existing) {
      // Already initialized - determine source from prefix
      const source = existing.startsWith('mac-') ? 'mac' :
                     existing.startsWith('rand-') ? 'random' : 'uuid';
      return { id: existing, source };
    }

    // Get hardware-based ID (network-agnostic)
    const { id, source } = await getHardwareId();
    this.conf.set('machineId', id);

    return { id, source };
  }

  /**
   * Get machine ID (synchronous)
   * Returns existing ID or generates a temporary one if not initialized
   * Call initializeMachineId() during setup for proper hardware-based ID
   */
  getMachineId(): string {
    let machineId = this.conf.get('machineId');
    if (!machineId) {
      // Fallback for legacy cases - use random UUID
      // This should rarely happen if initializeMachineId() is called during setup
      machineId = `rand-${randomUUID()}`;
      this.conf.set('machineId', machineId);
    }
    return machineId;
  }

  /**
   * Get machine display name (e.g., SSH alias like "nebius-2")
   */
  getMachineName(): string | undefined {
    return this.conf.get('machineName');
  }

  /**
   * Set machine display name
   */
  setMachineName(name: string): void {
    this.conf.set('machineName', name);
  }

  /**
   * Get relay URL.
   * Returns stored value unless it's the hardcoded default, in which case
   * env-based resolution takes precedence (allows mode switching without re-setup).
   */
  getRelayUrl(): string {
    const stored = this.conf.get('relayUrl');
    if (stored !== DEFAULT_RELAY_URL) return stored;
    return resolveRelayUrlFromEnv();
  }

  /**
   * Set relay URL
   */
  setRelayUrl(url: string): void {
    this.conf.set('relayUrl', url);
  }

  /**
   * Get API URL.
   * Returns stored value unless it's the hardcoded default, in which case
   * env-based resolution takes precedence (allows mode switching without re-setup).
   */
  getApiUrl(): string {
    const stored = this.conf.get('apiUrl');
    if (stored !== DEFAULT_API_URL) return stored;
    return resolveApiUrlFromEnv();
  }

  /**
   * Set API URL
   */
  setApiUrl(url: string): void {
    this.conf.set('apiUrl', url);
  }

  /**
   * Get access token
   */
  getAccessToken(): string | undefined {
    return this.conf.get('accessToken');
  }

  /**
   * Set access token
   * Validates token format to prevent storing invalid values
   */
  setAccessToken(token: string): void {
    // Reject null, "null" string, undefined, or empty values
    if (!token || token === 'null' || token === 'undefined') {
      console.warn('[config] Refusing to set invalid accessToken:', token);
      this.conf.delete('accessToken');
      return;
    }

    // Validate JWT format
    if (!token.match(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)) {
      console.error('[config] accessToken does not appear to be a valid JWT format');
      console.error('[config] Token preview:', token.substring(0, 50) + '...');
      this.conf.delete('accessToken');
      return;
    }

    this.conf.set('accessToken', token);
  }

  /**
   * Get refresh token
   */
  getRefreshToken(): string | undefined {
    return this.conf.get('refreshToken');
  }

  /**
   * Set refresh token
   * Validates token format to prevent storing invalid values
   */
  setRefreshToken(token: string): void {
    // Reject null, "null" string, undefined, or empty values
    if (!token || token === 'null' || token === 'undefined') {
      console.warn('[config] Refusing to set invalid refreshToken:', token);
      this.conf.delete('refreshToken');
      return;
    }

    // Validate JWT format
    if (!token.match(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)) {
      console.error('[config] refreshToken does not appear to be a valid JWT format');
      console.error('[config] Token preview:', token.substring(0, 50) + '...');
      this.conf.delete('refreshToken');
      return;
    }

    this.conf.set('refreshToken', token);
  }

  /**
   * Get WebSocket token
   */
  getWsToken(): string | undefined {
    return this.conf.get('wsToken');
  }

  /**
   * Set WebSocket token
   * Validates token format to prevent storing invalid values
   */
  setWsToken(token: string): void {
    // Reject null, "null" string, undefined, or empty values
    if (!token || token === 'null' || token === 'undefined') {
      console.warn('[config] Refusing to set invalid wsToken:', token);
      // Clear any existing invalid token
      this.conf.delete('wsToken');
      return;
    }

    // Validate JWT format (should have 3 base64url-encoded parts separated by dots)
    // Example: eyJhbGc...header.eyJzdWI...payload.signature...
    if (!token.match(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)) {
      console.error('[config] wsToken does not appear to be a valid JWT format');
      console.error('[config] Token preview:', token.substring(0, 50) + '...');
      this.conf.delete('wsToken');
      return;
    }

    this.conf.set('wsToken', token);
  }

  /**
   * Get Claude OAuth token (from `claude setup-token`)
   */
  getClaudeOauthToken(): string | undefined {
    return this.conf.get('claudeOauthToken');
  }

  /**
   * Set Claude OAuth token
   */
  setClaudeOauthToken(token: string): void {
    this.conf.set('claudeOauthToken', token);
  }

  /**
   * Clear Claude OAuth token
   */
  clearClaudeOauthToken(): void {
    this.conf.delete('claudeOauthToken');
  }

  /**
   * Set machine ID (e.g., from backend registration response)
   * Validates ID to prevent storing invalid values
   */
  setMachineId(id: string): void {
    // Reject null, "null" string, undefined, or empty values
    if (!id || id === 'null' || id === 'undefined') {
      console.warn('[config] Refusing to set invalid machineId:', id);
      // Don't auto-generate - let the setup process handle it
      this.conf.delete('machineId');
      return;
    }

    this.conf.set('machineId', id);
  }

  /**
   * Get device token
   */
  getDeviceToken(): string | undefined {
    return this.conf.get('deviceToken');
  }

  /**
   * Set device token
   */
  setDeviceToken(token: string): void {
    this.conf.set('deviceToken', token);
  }

  /**
   * Get configured providers
   */
  getProviders(): ProviderType[] {
    return this.conf.get('providers');
  }

  /**
   * Set configured providers
   */
  setProviders(providers: ProviderType[]): void {
    this.conf.set('providers', providers);
  }

  /**
   * Get auto-start setting
   */
  getAutoStart(): boolean {
    return this.conf.get('autoStart');
  }

  /**
   * Set auto-start setting
   */
  setAutoStart(autoStart: boolean): void {
    this.conf.set('autoStart', autoStart);
  }

  /**
   * Get log level
   */
  getLogLevel(): 'debug' | 'info' | 'warn' | 'error' {
    return this.conf.get('logLevel');
  }

  /**
   * Set log level
   */
  setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
    this.conf.set('logLevel', level);
  }

  /**
   * Update last connected timestamp
   */
  updateLastConnected(): void {
    this.conf.set('lastConnected', new Date().toISOString());
  }

  /**
   * Get last connected timestamp
   */
  getLastConnected(): string | undefined {
    return this.conf.get('lastConnected');
  }

  /**
   * Mark setup as complete
   */
  completeSetup(): void {
    this.conf.set('setupCompleted', true);
  }

  /**
   * Reset all configuration
   */
  reset(): void {
    this.conf.clear();
  }

  /**
   * Get the configuration file path
   */
  getConfigPath(): string {
    return this.conf.path;
  }
}

// Export singleton instance
export const config = new ConfigManager();

// Also export class for testing
export { ConfigManager };
