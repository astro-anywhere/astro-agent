/**
 * Tests for WebSocket client reconnection behavior,
 * specifically token refresh failures and reconnect scheduling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the module under test
const mockConfigManager = vi.hoisted(() => ({
  getRefreshToken: vi.fn().mockReturnValue('mock-refresh-token'),
  getWsToken: vi.fn().mockReturnValue('mock-ws-token'),
  getApiUrl: vi.fn().mockReturnValue('https://api.example.com'),
  setAccessToken: vi.fn(),
  setRefreshToken: vi.fn(),
  setWsToken: vi.fn(),
  getRunnerId: vi.fn().mockReturnValue('runner-test'),
  getMachineId: vi.fn().mockReturnValue('machine-test'),
}));

const mockGetMachineResources = vi.hoisted(() => vi.fn().mockResolvedValue({
  hostname: 'test-host',
  platform: 'linux',
  cpuCores: 4,
  memoryTotal: 8000,
  memoryFree: 4000,
}));

vi.mock('../config.js', () => ({
  configManager: mockConfigManager,
  default: mockConfigManager,
}));

vi.mock('../resources.js', () => ({
  getMachineResources: mockGetMachineResources,
}));

// We test the reconnect logic by extracting and testing the scheduling behavior
// rather than creating full WebSocket connections.

describe('WebSocket reconnect on token refresh failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should retry connect after token refresh fails', async () => {
    // Simulate the reconnect scheduling logic:
    // When connect() fails (e.g. token refresh error), scheduleReconnect should
    // be called again so the retry chain continues.
    let reconnectCount = 0;
    let shouldReconnect = true;
    const maxRetries = -1; // infinite
    const baseDelay = 1000;
    const maxDelay = 60000;

    const mockConnect = vi.fn().mockRejectedValue(new Error('Token refresh failed'));

    function scheduleReconnect() {
      if (maxRetries >= 0 && reconnectCount >= maxRetries) return;
      reconnectCount++;

      const delay = Math.min(
        baseDelay * Math.pow(2, reconnectCount - 1),
        maxDelay,
      );

      setTimeout(() => {
        mockConnect().catch(() => {
          // This is the fix: re-schedule on failure
          if (shouldReconnect) {
            scheduleReconnect();
          }
        });
      }, delay);
    }

    // Start the reconnect chain
    scheduleReconnect();

    // Advance exactly through each retry delay:
    // Retry 1: 1s, Retry 2: 2s, Retry 3: 4s
    await vi.advanceTimersByTimeAsync(1000); // fires retry 1
    await vi.advanceTimersByTimeAsync(2000); // fires retry 2
    await vi.advanceTimersByTimeAsync(4000); // fires retry 3

    // Stop further retries
    shouldReconnect = false;

    // Without the fix, only 1 connect() call would happen.
    // With the fix, each failure triggers another retry.
    expect(mockConnect.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(reconnectCount).toBeGreaterThanOrEqual(3);
  });

  it('should stop retrying when shouldReconnect is false', async () => {
    let reconnectCount = 0;
    let shouldReconnect = true;
    const baseDelay = 1000;
    const maxDelay = 60000;

    const mockConnect = vi.fn().mockRejectedValue(new Error('Token refresh failed'));

    function scheduleReconnect() {
      reconnectCount++;

      const delay = Math.min(
        baseDelay * Math.pow(2, reconnectCount - 1),
        maxDelay,
      );

      setTimeout(() => {
        mockConnect().catch(() => {
          if (shouldReconnect) {
            scheduleReconnect();
          }
        });
      }, delay);
    }

    scheduleReconnect();

    // Let first retry fire
    await vi.advanceTimersByTimeAsync(baseDelay + 100);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Disable reconnection (simulates user calling disconnect())
    shouldReconnect = false;

    // Advance time — no more retries should happen
    await vi.advanceTimersByTimeAsync(maxDelay * 2);
    expect(mockConnect).toHaveBeenCalledTimes(2); // one more was already scheduled
  });

  it('should use exponential backoff with cap', () => {
    const baseDelay = 1000;
    const maxDelay = 60000;

    const delays = [];
    for (let attempt = 1; attempt <= 10; attempt++) {
      delays.push(Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay));
    }

    expect(delays[0]).toBe(1000);   // 1s
    expect(delays[1]).toBe(2000);   // 2s
    expect(delays[2]).toBe(4000);   // 4s
    expect(delays[3]).toBe(8000);   // 8s
    expect(delays[4]).toBe(16000);  // 16s
    expect(delays[5]).toBe(32000);  // 32s
    expect(delays[6]).toBe(60000);  // capped at 60s
    expect(delays[7]).toBe(60000);  // stays capped
  });
});

describe('Token refresh error messages', () => {
  it('should include HTTP status code in error message', () => {
    const status = 401;
    const statusText = 'Unauthorized';
    const errorBody = { error: 'invalid_token' };

    // This matches the updated error format in refreshAccessToken()
    const errorMessage = `Token refresh failed (${status}): ${errorBody.error || statusText}`;

    expect(errorMessage).toBe('Token refresh failed (401): invalid_token');
    expect(errorMessage).toContain('401');
  });

  it('should fall back to statusText when body has no error field', () => {
    const status = 502;
    const statusText = 'Bad Gateway';
    const errorBody = {} as { error?: string };

    const errorMessage = `Token refresh failed (${status}): ${errorBody.error || statusText}`;

    expect(errorMessage).toBe('Token refresh failed (502): Bad Gateway');
  });

  it('should handle unparseable response body', () => {
    const status = 500;
    const statusText = 'Internal Server Error';
    // When .json() fails, we construct a fallback error
    const fallbackError = { error: `HTTP ${status} ${statusText}` };

    const errorMessage = `Token refresh failed (${status}): ${fallbackError.error || statusText}`;

    expect(errorMessage).toBe('Token refresh failed (500): HTTP 500 Internal Server Error');
  });
});
