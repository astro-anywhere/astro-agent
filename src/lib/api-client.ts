/**
 * HTTP client for device auth using native fetch (Node 18+)
 */

import type {
  DeviceAuthServerResponse,
  DeviceTokenServerResponse,
  DeviceTokenError,
  MachineRegisterResponse,
} from '../types.js';

// ============================================================================
// Error handling
// ============================================================================

export type DeviceAuthErrorCode = 'network' | 'timeout' | 'denied' | 'expired' | 'server_error';

export class DeviceAuthApiError extends Error {
  constructor(
    message: string,
    public readonly code: DeviceAuthErrorCode,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'DeviceAuthApiError';
  }
}

// ============================================================================
// API functions
// ============================================================================

/**
 * Request a device authorization code from the backend.
 * POST /api/device/authorize
 */
export async function requestDeviceCode(
  apiUrl: string,
  machineInfo: { hostname: string; platform: string },
): Promise<DeviceAuthServerResponse> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/device/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scopes: ['machine:connect', 'machine:execute', 'machine:read'],
        machineInfo,
      }),
    });
  } catch (err) {
    throw new DeviceAuthApiError(
      `Cannot reach API server at ${apiUrl}: ${(err as Error).message}`,
      'network',
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new DeviceAuthApiError(
      `Device authorize request failed (${res.status}): ${body}`,
      'server_error',
      res.status,
    );
  }

  return (await res.json()) as DeviceAuthServerResponse;
}

/**
 * Poll the backend until the user authorizes (or denies/expires).
 * POST /api/device/token
 *
 * Handles RFC 8628 states:
 *   authorization_pending → keep polling
 *   slow_down → increase interval +5s
 *   access_denied → throw
 *   expired_token → throw
 */
export async function pollForToken(
  apiUrl: string,
  userCode: string,
  intervalSec: number,
  timeoutSec: number,
): Promise<DeviceTokenServerResponse> {
  const deadline = Date.now() + timeoutSec * 1000;
  let currentInterval = intervalSec;

  while (Date.now() < deadline) {
    // Wait before polling
    await sleep(currentInterval * 1000);

    let res: Response;
    try {
      res = await fetch(`${apiUrl}/api/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userCode,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
    } catch (err) {
      throw new DeviceAuthApiError(
        `Cannot reach API server while polling: ${(err as Error).message}`,
        'network',
      );
    }

    // Success → 200
    if (res.ok) {
      return (await res.json()) as DeviceTokenServerResponse;
    }

    // Error → parse RFC 8628 error body
    const body = (await res.json()) as DeviceTokenError;

    switch (body.error) {
      case 'authorization_pending':
        // Keep polling
        continue;
      case 'slow_down':
        currentInterval += 5;
        continue;
      case 'access_denied':
        throw new DeviceAuthApiError('User denied authorization', 'denied', res.status);
      case 'expired_token':
        throw new DeviceAuthApiError('Device code expired', 'expired', res.status);
      default:
        throw new DeviceAuthApiError(
          `Unexpected error: ${body.error} — ${body.errorDescription}`,
          'server_error',
          res.status,
        );
    }
  }

  throw new DeviceAuthApiError('Polling timed out waiting for authorization', 'timeout');
}

/**
 * Register an authenticated machine with the backend.
 * POST /api/device/register (Bearer token)
 */
export async function registerMachine(
  apiUrl: string,
  accessToken: string,
  machineInfo: Record<string, unknown>,
): Promise<MachineRegisterResponse> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/device/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ machineInfo }),
    });
  } catch (err) {
    throw new DeviceAuthApiError(
      `Cannot reach API server for registration: ${(err as Error).message}`,
      'network',
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new DeviceAuthApiError(
      `Machine registration failed (${res.status}): ${body}`,
      'server_error',
      res.status,
    );
  }

  return (await res.json()) as MachineRegisterResponse;
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
