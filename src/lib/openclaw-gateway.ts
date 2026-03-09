/**
 * OpenClaw Gateway — Shared utilities for adapter and bridge
 *
 * Consolidates config reading, probing, frame parsing, and session key
 * management that was previously duplicated across openclaw-adapter.ts,
 * openclaw-bridge.ts, and providers.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  port: number;
  token: string;
  url: string;
  /** Default notification recipient (e.g., Telegram username). Read from openclaw.json */
  defaultRecipient?: string;
}

export interface GatewayFrame {
  type: 'event' | 'res';
  id?: string;
  event?: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
  seq?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 3;
export const CONNECT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Config Reader
// ---------------------------------------------------------------------------

/**
 * Read the OpenClaw gateway config from ~/.openclaw/openclaw.json.
 * Returns null if the config file doesn't exist or is invalid.
 */
export function readGatewayConfig(): GatewayConfig | null {
  try {
    const configPath = join(homedir(), '.openclaw', 'openclaw.json');
    if (!existsSync(configPath)) return null;

    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const port = raw?.gateway?.port as number | undefined;
    if (!port) return null;

    const token = (raw?.gateway?.auth?.token as string) || '';
    const bind = (raw?.gateway?.bind as string) || '127.0.0.1';
    const host = bind === 'loopback' || bind === '127.0.0.1' ? '127.0.0.1' : bind;

    // Read default notification recipient from astro-specific config
    const defaultRecipient = (raw?.astro?.notifyTo as string) || undefined;

    return { port, token, url: `ws://${host}:${port}`, defaultRecipient };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Frame Parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw WebSocket message into a GatewayFrame.
 * Returns null if the data is not valid JSON.
 */
export function parseGatewayFrame(data: unknown): GatewayFrame | null {
  try {
    return JSON.parse(String(data)) as GatewayFrame;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gateway Probe
// ---------------------------------------------------------------------------

/**
 * Quick probe: connect to a WebSocket URL and check for connect.challenge.
 * Does NOT perform a full handshake — just confirms the gateway is reachable.
 */
export function probeGateway(url: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val: boolean) => { if (!resolved) { resolved = true; resolve(val); } };

    const ws: WebSocket = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.removeAllListeners();
      ws.close();
      done(false);
    }, timeoutMs);

    ws.on('message', (data) => {
      const frame = parseGatewayFrame(data);
      if (frame?.type === 'event' && frame.event === 'connect.challenge') {
        clearTimeout(timeout);
        ws!.removeAllListeners();
        ws!.close();
        done(true);
      }
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      ws?.removeAllListeners();
      done(false);
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      done(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Session Key Utilities
// ---------------------------------------------------------------------------

/** Create a session key for a task */
export function makeSessionKey(taskId: string): string {
  return `astro:task:${taskId}`;
}

/**
 * Check if a payload's sessionKey matches the expected key.
 * The gateway prepends 'agent:main:' to session keys in events,
 * so we need to match both forms.
 */
export function matchesSessionKey(payloadKey: unknown, expectedKey: string): boolean {
  if (typeof payloadKey !== 'string') return false;
  return payloadKey === expectedKey || payloadKey === `agent:main:${expectedKey}`;
}
