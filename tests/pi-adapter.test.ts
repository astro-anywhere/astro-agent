/**
 * Tests for PiAdapter using the @mariozechner/pi-coding-agent SDK.
 *
 * Mocks createAgentSession so no real Pi process is spawned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskOutputStream } from '../src/providers/base-adapter.js';

// ---------------------------------------------------------------------------
// Mock @mariozechner/pi-coding-agent
// ---------------------------------------------------------------------------

type EventHandler = (event: Record<string, unknown>) => void;

function createMockSession(overrides: Record<string, unknown> = {}) {
  const subscribers: EventHandler[] = [];

  const session = {
    model: { id: 'claude-sonnet-4', provider: 'anthropic' },
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn((handler: EventHandler) => {
      subscribers.push(handler);
      return () => { const i = subscribers.indexOf(handler); if (i >= 0) subscribers.splice(i, 1); };
    }),
    getSessionStats: vi.fn().mockReturnValue({
      sessionFile: null,
      sessionId: 'test-session',
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0.002,
    }),
    emit: (event: Record<string, unknown>) => { subscribers.forEach(h => h(event)); },
    ...overrides,
  };

  return session;
}

const mockCreateAgentSession = vi.fn();
const mockSessionManagerInMemory = vi.fn().mockReturnValue({});

vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: (...args: unknown[]) => mockCreateAgentSession(...args),
  SessionManager: { inMemory: () => mockSessionManagerInMemory() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStream(): TaskOutputStream {
  return {
    stdout: vi.fn(),
    stderr: vi.fn(),
    status: vi.fn(),
    toolTrace: vi.fn(),
    text: vi.fn(),
    toolUse: vi.fn(),
    toolResult: vi.fn(),
    fileChange: vi.fn(),
    sessionInit: vi.fn(),
    approvalRequest: vi.fn().mockResolvedValue({ answered: false }),
  };
}

/** Helper to mock global.fetch for approval endpoint tests */
function mockFetchApproval(response: { ok: boolean; body: unknown }) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: response.ok,
    json: () => Promise.resolve(response.body),
  } as Response);
}

function baseTask(overrides = {}) {
  return {
    id: 'task-1',
    prompt: 'do something',
    workingDirectory: '/tmp',
    type: 'execution',
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PiAdapter', () => {
  let session: ReturnType<typeof createMockSession>;
  let adapter: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    session = createMockSession();
    mockCreateAgentSession.mockResolvedValue({ session });
  });

  afterEach(() => {
    adapter?.destroy();
  });

  describe('isAvailable', () => {
    it('returns true when SDK is importable', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      expect(await adapter.isAvailable()).toBe(true);
    });
  });

  describe('execute', () => {
    it('calls createAgentSession with cwd and inMemory sessionManager', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      await adapter.execute(baseTask({ workingDirectory: '/my/dir' }), stream, new AbortController().signal);

      expect(mockCreateAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/my/dir' }),
      );
    });

    it('calls session.prompt with the task prompt', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      await adapter.execute(baseTask({ prompt: 'hello world' }), createMockStream(), new AbortController().signal);

      expect(session.prompt).toHaveBeenCalledWith('hello world');
    });

    it('prepends systemPrompt before task prompt', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      await adapter.execute(
        baseTask({ prompt: 'task', systemPrompt: 'system' }),
        createMockStream(),
        new AbortController().signal,
      );

      expect(session.prompt).toHaveBeenCalledWith(expect.stringContaining('system'));
      expect(session.prompt).toHaveBeenCalledWith(expect.stringContaining('task'));
    });

    it('emits sessionInit on agent_start event', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'agent_start' });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.sessionInit).toHaveBeenCalledOnce();
    });

    it('streams text deltas from message_update events', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } });
        session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'world' } });
      });

      const result = await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.text).toHaveBeenCalledWith('Hello ');
      expect(stream.text).toHaveBeenCalledWith('world');
      expect(result.output).toBe('Hello world');
    });

    it('streams thinking_delta as text', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' } });
        session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.text).toHaveBeenCalledTimes(2);
      expect(stream.text).toHaveBeenCalledWith('thinking...');
      expect(stream.text).toHaveBeenCalledWith('answer');
    });

    it('does not include thinking_delta in output text', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } });
        session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } });
      });

      const result = await adapter.execute(baseTask(), stream, new AbortController().signal);

      // outputText should only contain text_delta, not thinking
      expect(result.output).toBe('answer');
    });

    it('emits toolUse on tool_execution_start', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolUse).toHaveBeenCalledWith('bash', { command: 'ls' }, undefined);
    });

    it('emits toolResult on tool_execution_end', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_end', toolName: 'bash', result: 'output', isError: false });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'output', true, undefined);
    });

    it('emits toolResult with isError=true when tool fails', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_end', toolName: 'bash', result: 'error msg', isError: true });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'error msg', false, undefined);
    });

    it('emits empty string for null/undefined tool result', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_end', toolName: 'bash', result: null, isError: false });
        session.emit({ type: 'tool_execution_end', toolName: 'bash', result: undefined, isError: false });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolResult).toHaveBeenCalledWith('bash', '', true, undefined);
      expect(stream.toolResult).toHaveBeenCalledTimes(2);
    });

    it('resolves correct file args for parallel tool executions', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        // Two file tools start before either ends (parallel execution)
        session.emit({ type: 'tool_execution_start', toolName: 'Write', args: { path: '/tmp/a.ts' }, toolCallId: 'tc-a' });
        session.emit({ type: 'tool_execution_start', toolName: 'Write', args: { path: '/tmp/b.ts' }, toolCallId: 'tc-b' });
        // End in reverse order
        session.emit({ type: 'tool_execution_end', toolName: 'Write', result: 'ok', isError: false, toolCallId: 'tc-b' });
        session.emit({ type: 'tool_execution_end', toolName: 'Write', result: 'ok', isError: false, toolCallId: 'tc-a' });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      // Each fileChange should reference its own tool's path, not the last started tool's path
      expect(stream.fileChange).toHaveBeenCalledWith('/tmp/b.ts', 'modified');
      expect(stream.fileChange).toHaveBeenCalledWith('/tmp/a.ts', 'modified');
    });

    it('emits fileChange for file-modifying tools', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_start', toolName: 'Write', args: { path: '/tmp/foo.ts' }, toolCallId: 'tc-1' });
        session.emit({ type: 'tool_execution_end', toolName: 'Write', result: 'ok', isError: false, toolCallId: 'tc-1' });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.fileChange).toHaveBeenCalledWith('/tmp/foo.ts', 'modified');
    });

    it('emits fileChange with "created" for Create tool', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_start', toolName: 'Create', args: { path: '/tmp/new.ts' }, toolCallId: 'tc-2' });
        session.emit({ type: 'tool_execution_end', toolName: 'Create', result: 'ok', isError: false, toolCallId: 'tc-2' });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.fileChange).toHaveBeenCalledWith('/tmp/new.ts', 'created');
    });

    it('does not emit fileChange for non-file tools', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } });
        session.emit({ type: 'tool_execution_end', toolName: 'bash', result: 'ok', isError: false });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.fileChange).not.toHaveBeenCalled();
    });

    it('emits status "Compacting context" on auto_compaction_start', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'auto_compaction_start' });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.status).toHaveBeenCalledWith('running', undefined, 'Compacting context');
    });

    it('passes toolCallId from Pi events to stream', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_start', toolCallId: 'tc-123', toolName: 'read', args: { path: '/foo' } });
        session.emit({ type: 'tool_execution_end', toolCallId: 'tc-123', toolName: 'read', result: 'contents', isError: false });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolUse).toHaveBeenCalledWith('read', { path: '/foo' }, 'tc-123');
      expect(stream.toolResult).toHaveBeenCalledWith('read', 'contents', true, 'tc-123');
    });

    it('silently ignores tool_execution_update (no text pollution)', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls' } });
        session.emit({ type: 'tool_execution_update', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls' }, partialResult: 'file1.ts\n' });
        session.emit({ type: 'tool_execution_update', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls' }, partialResult: 'file2.ts\n' });
        session.emit({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', result: 'file1.ts\nfile2.ts\n', isError: false });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      // tool_execution_update should NOT produce text events (prevents raw output in web UI)
      expect(stream.text).not.toHaveBeenCalled();
      // The complete result comes via toolResult from tool_execution_end
      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'file1.ts\nfile2.ts\n', true, 'tc-1');
    });

    it('ignores object partialResult in tool_execution_update', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_update', toolCallId: 'tc-1', toolName: 'custom', args: {}, partialResult: { progress: 50 } });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.text).not.toHaveBeenCalled();
    });

    it('ignores null/undefined partialResult in tool_execution_update', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_update', toolCallId: 'tc-1', toolName: 'bash', args: {}, partialResult: null });
        session.emit({ type: 'tool_execution_update', toolCallId: 'tc-1', toolName: 'bash', args: {}, partialResult: undefined });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.text).not.toHaveBeenCalled();
    });

    it('streams error from message_update error event', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'error',
            reason: 'error',
            error: { errorMessage: 'Rate limit exceeded' },
          },
        });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.text).toHaveBeenCalledWith(expect.stringContaining('Rate limit exceeded'));
    });

    it('emits status on auto_compaction_end with error', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'auto_compaction_end', aborted: true, errorMessage: 'context too large' });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.status).toHaveBeenCalledWith('running', undefined, 'Compaction aborted');
    });

    it('emits retry status with attempt counts', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 1000, errorMessage: 'overloaded' });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.status).toHaveBeenCalledWith('running', undefined, 'Retrying (attempt 2/3)');
    });

    it('streams error text on auto_retry_end failure', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'max retries exceeded' });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.text).toHaveBeenCalledWith(expect.stringContaining('max retries exceeded'));
    });

    it('does not stream text on auto_retry_end success', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'auto_retry_end', success: true, attempt: 1 });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.text).not.toHaveBeenCalled();
    });

    it('passes model info to sessionInit', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'agent_start' });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.sessionInit).toHaveBeenCalledWith(
        expect.stringContaining('pi-'),
        'anthropic/claude-sonnet-4',
      );
    });

    it('ignores message_update with no assistantMessageEvent', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'message_update', message: {} });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.text).not.toHaveBeenCalled();
    });

    it('returns completed status on success', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      const result = await adapter.execute(baseTask(), createMockStream(), new AbortController().signal);

      expect(result.status).toBe('completed');
      expect(result.taskId).toBe('task-1');
    });

    it('returns metrics from session stats', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      const result = await adapter.execute(baseTask(), createMockStream(), new AbortController().signal);

      expect(result.metrics?.inputTokens).toBe(100);
      expect(result.metrics?.outputTokens).toBe(50);
      expect(result.metrics?.totalCost).toBe(0.002);
      expect(result.metrics?.model).toContain('anthropic');
      expect(result.metrics?.numTurns).toBe(1);
    });

    it('returns cancelled status when aborted', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const ac = new AbortController();

      session.prompt = vi.fn().mockImplementation(async () => {
        ac.abort();
      });

      const result = await adapter.execute(baseTask(), createMockStream(), ac.signal);

      expect(result.status).toBe('cancelled');
    });

    it('calls session.abort() when signal fires', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const ac = new AbortController();

      session.prompt = vi.fn().mockImplementation(async () => {
        ac.abort();
        await new Promise(resolve => setTimeout(resolve, 10));
      });

      await adapter.execute(baseTask(), createMockStream(), ac.signal);

      expect(session.abort).toHaveBeenCalled();
    });

    it('returns failed status when session.prompt throws', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      session.prompt = vi.fn().mockRejectedValue(new Error('Pi crashed'));

      const result = await adapter.execute(baseTask(), createMockStream(), new AbortController().signal);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Pi crashed');
    });

    it('serializes non-string tool results to JSON', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_start', toolName: 'bash', args: {} });
        session.emit({ type: 'tool_execution_end', toolName: 'bash', result: { lines: ['a', 'b'] }, isError: false });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolResult).toHaveBeenCalledWith('bash', '{"lines":["a","b"]}', true, undefined);
    });

    it('extracts text from Pi content-structured tool results (object)', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_start', toolName: 'ls', args: { path: '.' }, toolCallId: 'tc-pi' });
        session.emit({
          type: 'tool_execution_end', toolName: 'ls', toolCallId: 'tc-pi', isError: false,
          result: { content: [{ type: 'text', text: 'file1.ts\nfile2.ts\n' }], details: {} },
        });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolResult).toHaveBeenCalledWith('ls', 'file1.ts\nfile2.ts\n', true, 'tc-pi');
    });

    it('extracts text from Pi content-structured tool results (undefined details)', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      // Pi ls tool returns { content: [...], details: undefined } for empty dirs
      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({
          type: 'tool_execution_end', toolName: 'ls', isError: false,
          result: { content: [{ type: 'text', text: '(empty directory)' }], details: undefined },
        });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolResult).toHaveBeenCalledWith('ls', '(empty directory)', true, undefined);
    });

    it('extracts text from pre-serialized JSON string tool results', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      // Some code paths may stringify the result before emitting
      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({
          type: 'tool_execution_end', toolName: 'ls', isError: false,
          result: '{"content":[{"type":"text","text":"daily_paper\\npaper_reading\\n"}],"details":{}}',
        });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolResult).toHaveBeenCalledWith('ls', 'daily_paper\npaper_reading\n', true, undefined);
    });

    it('ignores Pi content-structured partial results in tool_execution_update', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({
          type: 'tool_execution_update', toolName: 'bash', toolCallId: 'tc-pi',
          partialResult: { content: [{ type: 'text', text: 'streaming output\n' }], details: {} },
        });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      // tool_execution_update is now silently ignored
      expect(stream.text).not.toHaveBeenCalled();
    });

    it('ignores pre-serialized JSON string partial results in tool_execution_update', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({
          type: 'tool_execution_update', toolName: 'bash', toolCallId: 'tc-pi',
          partialResult: '{"content":[{"type":"text","text":"streaming\\n"}],"details":{}}',
        });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      // tool_execution_update is now silently ignored
      expect(stream.text).not.toHaveBeenCalled();
    });

    it('concatenates multiple text blocks in Pi content result', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({
          type: 'tool_execution_end', toolName: 'bash', isError: false,
          result: {
            content: [
              { type: 'text', text: 'part1' },
              { type: 'text', text: 'part2' },
            ],
            details: {},
          },
        });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'part1part2', true, undefined);
    });

    it('passes plain string results through unchanged', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({
          type: 'tool_execution_end', toolName: 'bash', isError: false,
          result: 'plain text output',
        });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'plain text output', true, undefined);
    });
  });

  describe('ask_user_question custom tool', () => {
    it('passes customTools containing ask_user_question to createAgentSession', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      await adapter.execute(baseTask(), createMockStream(), new AbortController().signal);

      const callArgs = mockCreateAgentSession.mock.calls[0][0];
      expect(callArgs.customTools).toBeDefined();
      expect(callArgs.customTools).toHaveLength(1);
      expect(callArgs.customTools[0].name).toBe('ask_user_question');
    });

    it('posts to HTTP approval endpoint when ask_user_question tool is invoked', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      const fetchSpy = mockFetchApproval({ ok: true, body: { selectedOption: 'Option B' } });

      let askTool: any;
      mockCreateAgentSession.mockImplementation(async (opts: any) => {
        askTool = opts.customTools[0];
        return { session };
      });

      await adapter.execute(baseTask(), createMockStream(), new AbortController().signal);

      const result = await askTool.execute('tc-ask-1', {
        question: 'Which approach?',
        options: ['Option A', 'Option B'],
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/dispatch/request-dynamic-approval'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"question":"Which approach?"'),
        }),
      );
      expect(result.content[0].text).toBe('User selected: Option B');
      expect(result.details).toEqual({ answered: true, answer: 'Option B' });

      fetchSpy.mockRestore();
    });

    it('returns error details when approval endpoint returns non-ok', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      const fetchSpy = mockFetchApproval({ ok: false, body: { error: 'Execution not found' } });

      let askTool: any;
      mockCreateAgentSession.mockImplementation(async (opts: any) => {
        askTool = opts.customTools[0];
        return { session };
      });

      await adapter.execute(baseTask(), createMockStream(), new AbortController().signal);

      const result = await askTool.execute('tc-ask-2', {
        question: 'Pick one',
        options: ['A', 'B'],
      });

      expect(result.content[0].text).toContain('Approval request failed');
      expect(result.details).toEqual({ answered: false });

      fetchSpy.mockRestore();
    });

    it('returns graceful error when fetch throws', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('Network unreachable'),
      );

      let askTool: any;
      mockCreateAgentSession.mockImplementation(async (opts: any) => {
        askTool = opts.customTools[0];
        return { session };
      });

      await adapter.execute(baseTask(), createMockStream(), new AbortController().signal);

      const result = await askTool.execute('tc-ask-3', {
        question: 'Which?',
        options: ['X', 'Y'],
      });

      expect(result.content[0].text).toContain('Failed to get user approval');
      expect(result.content[0].text).toContain('Network unreachable');
      expect(result.details.answered).toBe(false);
      expect(result.details.error).toBe('Network unreachable');

      fetchSpy.mockRestore();
    });
  });

  describe('getStatus', () => {
    it('returns available=true when SDK is importable', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      const status = await adapter.getStatus();

      expect(status.available).toBe(true);
      expect(status.activeTasks).toBe(0);
      expect(status.maxTasks).toBe(2);
    });
  });

  describe('resumeTask', () => {
    it('returns error when no preserved session exists', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      const result = await adapter.resumeTask('missing', 'hi', '/tmp', 'sid', createMockStream(), new AbortController().signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No active Pi session');
    });

    it('calls session.prompt with followUp behavior on preserved session', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      await adapter.execute(baseTask({ id: 'task-r' }), createMockStream(), new AbortController().signal);

      const result = await adapter.resumeTask('task-r', 'follow up', '/tmp', 'sid', createMockStream(), new AbortController().signal);

      expect(session.prompt).toHaveBeenLastCalledWith('follow up', expect.objectContaining({ streamingBehavior: 'followUp' }));
      expect(result.success).toBe(true);
    });

    it('returns error when aborted before start', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();
      const ac = new AbortController();
      ac.abort();

      const result = await adapter.resumeTask('any', 'hi', '/tmp', 'sid', createMockStream(), ac.signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('aborted');
    });

    it('streams tool and thinking events during resume (event parity with execute)', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      // Execute initial task to create preserved session
      await adapter.execute(baseTask({ id: 'task-events' }), createMockStream(), new AbortController().signal);

      // Set up mock to emit various events during resume
      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' } });
        session.emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' }, toolCallId: 'tc-r1' });
        session.emit({ type: 'tool_execution_update', toolName: 'bash', partialResult: 'file.ts\n', toolCallId: 'tc-r1' });
        session.emit({ type: 'tool_execution_end', toolName: 'bash', result: 'file.ts\n', isError: false, toolCallId: 'tc-r1' });
        session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Done' } });
      });

      const stream = createMockStream();
      const result = await adapter.resumeTask('task-events', 'continue', '/tmp', 'sid', stream, new AbortController().signal);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Done');

      // Verify all event types were streamed
      expect(stream.text).toHaveBeenCalledWith('thinking...');
      expect(stream.toolUse).toHaveBeenCalledWith('bash', { command: 'ls' }, 'tc-r1');
      // tool_execution_update is silently ignored (no stream.text('file.ts\n'))
      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'file.ts\n', true, 'tc-r1');

      // Should NOT emit sessionInit (includeLifecycle=false)
      expect(stream.sessionInit).not.toHaveBeenCalled();
    });

    it('does not emit sessionInit or agent_end during resume', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      await adapter.execute(baseTask({ id: 'task-no-init' }), createMockStream(), new AbortController().signal);

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'agent_start' });
        session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } });
        session.emit({ type: 'agent_end' });
      });

      const stream = createMockStream();
      await adapter.resumeTask('task-no-init', 'hi', '/tmp', 'sid', stream, new AbortController().signal);

      expect(stream.sessionInit).not.toHaveBeenCalled();
      // agent_end emits status('running', 100, 'Completed') only when includeLifecycle=true
      const statusCalls = (stream.status as any).mock.calls;
      const completedCalls = statusCalls.filter((c: any[]) => c[2] === 'Completed');
      expect(completedCalls.length).toBe(0);
    });

    it('returns "No active Pi session" after SESSION_TTL_MS expires', async () => {
      vi.useFakeTimers();
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      // Execute a task to create a preserved session
      await adapter.execute(baseTask({ id: 'ttl-task' }), createMockStream(), new AbortController().signal);

      // Advance time past the 10-minute TTL
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);

      const result = await adapter.resumeTask('ttl-task', 'hi', '/tmp', 'sid', createMockStream(), new AbortController().signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No active Pi session');

      vi.useRealTimers();
    });
  });

  describe('getTaskContext', () => {
    it('returns null when no preserved session', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      expect(adapter.getTaskContext('missing')).toBeNull();
    });

    it('returns context after successful execute', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      adapter = new PiAdapter();

      await adapter.execute(baseTask({ id: 'ctx-task', workingDirectory: '/my/dir' }), createMockStream(), new AbortController().signal);

      const ctx = adapter.getTaskContext('ctx-task');
      expect(ctx).not.toBeNull();
      expect(ctx?.workingDirectory).toBe('/my/dir');
      expect(ctx?.sessionId).toBe('ctx-task');
    });
  });

  describe('provider factory', () => {
    it('createProviderAdapter("pi") returns PiAdapter', async () => {
      const { createProviderAdapter } = await import('../src/providers/index.js');
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');

      const adapter = createProviderAdapter('pi' as any, '/tmp', {}, false, null as any);
      expect(adapter).toBeInstanceOf(PiAdapter);
    });
  });
});
