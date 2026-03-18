/**
 * Tests for PiAdapter using the @mariozechner/pi-coding-agent SDK.
 *
 * Mocks createAgentSession so no real Pi process is spawned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  beforeEach(async () => {
    vi.clearAllMocks();
    session = createMockSession();
    mockCreateAgentSession.mockResolvedValue({ session });
  });

  describe('isAvailable', () => {
    it('returns true when SDK is importable', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
      expect(await adapter.isAvailable()).toBe(true);
    });
  });

  describe('execute', () => {
    it('calls createAgentSession with cwd and inMemory sessionManager', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
      const stream = createMockStream();

      await adapter.execute(baseTask({ workingDirectory: '/my/dir' }), stream, new AbortController().signal);

      expect(mockCreateAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/my/dir' }),
      );
    });

    it('calls session.prompt with the task prompt', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();

      await adapter.execute(baseTask({ prompt: 'hello world' }), createMockStream(), new AbortController().signal);

      expect(session.prompt).toHaveBeenCalledWith('hello world');
    });

    it('prepends systemPrompt before task prompt', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();

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
      const adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'agent_start' });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.sessionInit).toHaveBeenCalledOnce();
    });

    it('streams text deltas from message_update events', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
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

    it('ignores non-text_delta message_update events', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' } });
        session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.text).toHaveBeenCalledTimes(1);
      expect(stream.text).toHaveBeenCalledWith('answer');
    });

    it('emits toolUse on tool_execution_start', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolUse).toHaveBeenCalledWith('bash', { command: 'ls' });
    });

    it('emits toolResult on tool_execution_end', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_end', toolName: 'bash', result: 'output', isError: false });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'output', true);
    });

    it('emits toolResult with isError=true when tool fails', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_end', toolName: 'bash', result: 'error msg', isError: true });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'error msg', false);
    });

    it('emits fileChange for file-modifying tools', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_start', toolName: 'Write', args: { path: '/tmp/foo.ts' } });
        session.emit({ type: 'tool_execution_end', toolName: 'Write', result: 'ok', isError: false });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.fileChange).toHaveBeenCalledWith('/tmp/foo.ts', 'modified');
    });

    it('emits fileChange with "created" for Create tool', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_start', toolName: 'Create', args: { path: '/tmp/new.ts' } });
        session.emit({ type: 'tool_execution_end', toolName: 'Create', result: 'ok', isError: false });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.fileChange).toHaveBeenCalledWith('/tmp/new.ts', 'created');
    });

    it('does not emit fileChange for non-file tools', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
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
      const adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'auto_compaction_start' });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.status).toHaveBeenCalledWith('running', undefined, 'Compacting context');
    });

    it('returns completed status on success', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();

      const result = await adapter.execute(baseTask(), createMockStream(), new AbortController().signal);

      expect(result.status).toBe('completed');
      expect(result.taskId).toBe('task-1');
    });

    it('returns metrics from session stats', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();

      const result = await adapter.execute(baseTask(), createMockStream(), new AbortController().signal);

      expect(result.metrics?.inputTokens).toBe(100);
      expect(result.metrics?.outputTokens).toBe(50);
      expect(result.metrics?.totalCost).toBe(0.002);
      expect(result.metrics?.model).toContain('anthropic');
      expect(result.metrics?.numTurns).toBe(1);
    });

    it('returns cancelled status when aborted', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
      const ac = new AbortController();

      session.prompt = vi.fn().mockImplementation(async () => {
        ac.abort();
      });

      const result = await adapter.execute(baseTask(), createMockStream(), ac.signal);

      expect(result.status).toBe('cancelled');
    });

    it('calls session.abort() when signal fires', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
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
      const adapter = new PiAdapter();

      session.prompt = vi.fn().mockRejectedValue(new Error('Pi crashed'));

      const result = await adapter.execute(baseTask(), createMockStream(), new AbortController().signal);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Pi crashed');
    });

    it('serializes non-string tool results to JSON', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
      const stream = createMockStream();

      session.prompt = vi.fn().mockImplementation(async () => {
        session.emit({ type: 'tool_execution_start', toolName: 'bash', args: {} });
        session.emit({ type: 'tool_execution_end', toolName: 'bash', result: { lines: ['a', 'b'] }, isError: false });
      });

      await adapter.execute(baseTask(), stream, new AbortController().signal);

      expect(stream.toolResult).toHaveBeenCalledWith('bash', '{"lines":["a","b"]}', true);
    });
  });

  describe('getStatus', () => {
    it('returns available=true when SDK is importable', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();

      const status = await adapter.getStatus();

      expect(status.available).toBe(true);
      expect(status.activeTasks).toBe(0);
      expect(status.maxTasks).toBe(2);
    });
  });

  describe('resumeTask', () => {
    it('returns error when no preserved session exists', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();

      const result = await adapter.resumeTask('missing', 'hi', '/tmp', 'sid', createMockStream(), new AbortController().signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No active Pi session');
    });

    it('calls session.prompt with followUp behavior on preserved session', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();

      await adapter.execute(baseTask({ id: 'task-r' }), createMockStream(), new AbortController().signal);

      const result = await adapter.resumeTask('task-r', 'follow up', '/tmp', 'sid', createMockStream(), new AbortController().signal);

      expect(session.prompt).toHaveBeenLastCalledWith('follow up', expect.objectContaining({ streamingBehavior: 'followUp' }));
      expect(result.success).toBe(true);
    });

    it('returns error when aborted before start', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();
      const ac = new AbortController();
      ac.abort();

      const result = await adapter.resumeTask('any', 'hi', '/tmp', 'sid', createMockStream(), ac.signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('aborted');
    });
  });

  describe('getTaskContext', () => {
    it('returns null when no preserved session', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();

      expect(adapter.getTaskContext('missing')).toBeNull();
    });

    it('returns context after successful execute', async () => {
      const { PiAdapter } = await import('../src/providers/pi-adapter.js');
      const adapter = new PiAdapter();

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
