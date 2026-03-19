/**
 * Integration test for PiAdapter against the real Pi SDK.
 *
 * Requires:
 *   - `pi` installed and `~/.pi/agent/auth.json` configured (e.g. via `pi /login`)
 *   - Network access to the LLM provider
 *
 * Run with: npx vitest run tests/pi-integration.test.ts
 *
 * Skipped automatically if Pi SDK is not available or auth is not configured.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TaskOutputStream } from '../src/providers/base-adapter.js';

// Skip the entire suite if auth is not configured
const authPath = join(homedir(), '.pi', 'agent', 'auth.json');
const hasAuth = existsSync(authPath);

// Collect all stream calls for assertions
function createRecordingStream() {
  const calls: { method: string; args: unknown[] }[] = [];

  const handler = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
  };

  const stream: TaskOutputStream = {
    stdout: handler('stdout'),
    stderr: handler('stderr'),
    status: handler('status'),
    toolTrace: handler('toolTrace'),
    text: handler('text'),
    toolUse: handler('toolUse'),
    toolResult: handler('toolResult'),
    fileChange: handler('fileChange'),
    sessionInit: handler('sessionInit'),
    approvalRequest: async () => ({ answered: false }),
  };

  return { stream, calls };
}

describe.skipIf(!hasAuth)('PiAdapter integration', () => {
  let adapter: any;

  afterEach(() => {
    adapter?.destroy();
  });

  it('executes a simple prompt and receives text + sessionInit events', async () => {
    const { PiAdapter } = await import('../src/providers/pi-adapter.js');
    adapter = new PiAdapter();

    const { stream, calls } = createRecordingStream();
    const ac = new AbortController();

    const result = await adapter.execute(
      {
        id: 'integration-text-1',
        prompt: 'Reply with exactly: "Hello from Pi integration test". Do not use any tools.',
        workingDirectory: '/tmp',
        type: 'execution',
      } as any,
      stream,
      ac.signal,
    );

    // Basic result checks
    expect(result.status).toBe('completed');
    expect(result.taskId).toBe('integration-text-1');
    expect(result.output).toBeTruthy();
    expect(result.output.length).toBeGreaterThan(0);

    // Should have received sessionInit with model info
    const sessionInits = calls.filter(c => c.method === 'sessionInit');
    expect(sessionInits.length).toBeGreaterThanOrEqual(1);
    const [sessionId, model] = sessionInits[0].args as [string, string | undefined];
    expect(sessionId).toMatch(/^pi-/);
    // Model should be populated (e.g. "anthropic/claude-sonnet-4")
    if (model) {
      expect(model).toContain('/');
      console.log(`[integration] Model: ${model}`);
    }

    // Should have received text events
    const textCalls = calls.filter(c => c.method === 'text');
    expect(textCalls.length).toBeGreaterThan(0);
    const fullText = textCalls
      .map(c => c.args[0] as string)
      .join('');
    expect(fullText).toBeTruthy();
    console.log(`[integration] Text output (${textCalls.length} chunks): ${fullText.slice(0, 200)}`);

    // Metrics should be present
    expect(result.metrics).toBeTruthy();
    expect(result.metrics?.inputTokens).toBeGreaterThan(0);
    expect(result.metrics?.outputTokens).toBeGreaterThan(0);
    console.log(`[integration] Metrics: input=${result.metrics?.inputTokens}, output=${result.metrics?.outputTokens}, cost=${result.metrics?.totalCost}, model=${result.metrics?.model}`);

    // Status events should have been emitted
    const statusCalls = calls.filter(c => c.method === 'status');
    expect(statusCalls.length).toBeGreaterThan(0);
    console.log(`[integration] Status events: ${statusCalls.length}`);
  }, 60_000);

  it('executes a tool-using prompt and receives toolUse/toolResult events', async () => {
    const { PiAdapter } = await import('../src/providers/pi-adapter.js');
    adapter = new PiAdapter();

    const { stream, calls } = createRecordingStream();
    const ac = new AbortController();

    const result = await adapter.execute(
      {
        id: 'integration-tool-1',
        prompt: 'Use the bash tool to run: echo "pi-test-ok". Then reply with "Done".',
        workingDirectory: '/tmp',
        type: 'execution',
      } as any,
      stream,
      ac.signal,
    );

    expect(result.status).toBe('completed');

    // Should have received tool events
    const toolUseCalls = calls.filter(c => c.method === 'toolUse');
    const toolResultCalls = calls.filter(c => c.method === 'toolResult');

    console.log(`[integration] Tool use events: ${toolUseCalls.length}`);
    console.log(`[integration] Tool result events: ${toolResultCalls.length}`);

    // We expect at least one tool call (bash)
    expect(toolUseCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolResultCalls.length).toBeGreaterThanOrEqual(1);

    // Check toolUse structure: (toolName, toolInput, toolCallId)
    const firstToolUse = toolUseCalls[0].args;
    const toolName = firstToolUse[0] as string;
    const toolInput = firstToolUse[1];
    const toolCallId = firstToolUse[2] as string | undefined;
    console.log(`[integration] First tool: name=${toolName}, input=${JSON.stringify(toolInput)}, callId=${toolCallId}`);
    expect(toolName).toBeTruthy();
    expect(typeof toolName).toBe('string');

    // Check toolResult structure: (toolName, result, success, toolCallId)
    const firstToolResult = toolResultCalls[0].args;
    const resultToolName = firstToolResult[0] as string;
    const resultText = firstToolResult[1] as string;
    const resultSuccess = firstToolResult[2] as boolean;
    const resultCallId = firstToolResult[3] as string | undefined;
    console.log(`[integration] First result: name=${resultToolName}, success=${resultSuccess}, callId=${resultCallId}, text=${String(resultText).slice(0, 100)}`);
    expect(resultToolName).toBeTruthy();
    expect(typeof resultSuccess).toBe('boolean');

    // If Pi provides toolCallId, it should be a string
    if (toolCallId !== undefined) {
      expect(typeof toolCallId).toBe('string');
      // The toolCallId from toolUse and toolResult should match for the same tool
      if (resultCallId !== undefined) {
        // Find matching pair
        const matchingResult = toolResultCalls.find(c => c.args[3] === toolCallId);
        expect(matchingResult).toBeTruthy();
      }
    }

    // tool_execution_update events are now silently ignored (no longer pollute text stream)
    // Text events should only contain assistant text/thinking, not tool output
    const textCalls = calls.filter(c => c.method === 'text');
    const textContent = textCalls.map(c => c.args[0] as string).join('');
    console.log(`[integration] Text events: ${textCalls.length}, content preview: ${textContent.slice(0, 200)}`);

    // Print full event log for debugging
    console.log(`[integration] Full event log (${calls.length} events):`);
    for (const call of calls) {
      if (call.method === 'text') {
        console.log(`  ${call.method}: "${(call.args[0] as string).slice(0, 80)}"`);
      } else if (call.method === 'status') {
        console.log(`  ${call.method}: ${call.args[1]} ${call.args[2]}`);
      } else {
        console.log(`  ${call.method}: ${JSON.stringify(call.args).slice(0, 120)}`);
      }
    }
  }, 90_000);

  it('tool results are plain text, not JSON-wrapped Pi content objects', async () => {
    const { PiAdapter } = await import('../src/providers/pi-adapter.js');
    adapter = new PiAdapter();

    const { stream, calls } = createRecordingStream();
    const ac = new AbortController();

    const result = await adapter.execute(
      {
        id: 'integration-nojson-1',
        prompt: 'List the contents of the /tmp directory using the ls tool. Then say "done".',
        workingDirectory: '/tmp',
        type: 'execution',
      } as any,
      stream,
      ac.signal,
    );

    expect(result.status).toBe('completed');

    // Every toolResult text must NOT be raw JSON with "content" wrapper
    const toolResultCalls = calls.filter(c => c.method === 'toolResult');
    expect(toolResultCalls.length).toBeGreaterThan(0);

    for (const call of toolResultCalls) {
      const resultText = call.args[1] as string;
      console.log(`[integration] toolResult text (${resultText.length} chars): ${resultText.slice(0, 200)}`);

      // Must not be a JSON-wrapped Pi content object
      expect(resultText).not.toMatch(/^\{"content":\[/);
      // Must be a plain string, not start with {
      if (resultText.startsWith('{')) {
        // If it starts with { it should NOT be a Pi content wrapper
        try {
          const parsed = JSON.parse(resultText);
          expect(parsed).not.toHaveProperty('content');
        } catch {
          // Not valid JSON, that's fine
        }
      }
    }

    // Text events should not contain Pi content objects (tool_execution_update is now silent)
    const textCalls = calls.filter(c => c.method === 'text');
    for (const call of textCalls) {
      const text = call.args[0] as string;
      expect(text).not.toMatch(/^\{"content":\[/);
    }
  }, 90_000);

  it('handles abort signal correctly', async () => {
    const { PiAdapter } = await import('../src/providers/pi-adapter.js');
    adapter = new PiAdapter();

    const { stream } = createRecordingStream();
    const ac = new AbortController();

    // Abort immediately
    setTimeout(() => ac.abort(), 500);

    const result = await adapter.execute(
      {
        id: 'integration-abort-1',
        prompt: 'Write a very long essay about the history of computing. Make it at least 5000 words.',
        workingDirectory: '/tmp',
        type: 'execution',
      } as any,
      stream,
      ac.signal,
    );

    expect(result.status).toBe('cancelled');
    console.log(`[integration] Abort test: status=${result.status}`);
  }, 30_000);
});
