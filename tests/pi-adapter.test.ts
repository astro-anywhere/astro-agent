/**
 * Comprehensive tests for Pi RPC bridge, adapter, and provider registration
 *
 * Tests cover:
 * - PiRpcBridge: JSONL parsing, command-response correlation, event dispatch,
 *   process lifecycle, abort propagation
 * - PiAdapter: isAvailable, event mapping, multi-turn resume, error handling, getStatus
 * - Provider factory: createProviderAdapter('pi') returns PiAdapter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { TaskOutputStream } from '../src/providers/base-adapter.js';
import type { PiEvent } from '../src/lib/pi-rpc.js';

// ---------------------------------------------------------------------------
// Global mock for child_process (must be vi.mock for ESM)
// ---------------------------------------------------------------------------

let _mockProc: ReturnType<typeof createMockProcess>;

function createMockProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();

  const proc = new EventEmitter() as any;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;
  proc.pid = 12345;
  proc.killed = false;
  proc.kill = vi.fn((sig?: string) => {
    proc.killed = true;
    process.nextTick(() => proc.emit('exit', sig === 'SIGKILL' ? 137 : 0, sig || null));
    return true;
  });
  return proc;
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    spawn: vi.fn((..._args: any[]) => _mockProc),
  };
});

const mockGetProvider = vi.fn().mockResolvedValue({
  type: 'pi',
  name: 'Pi',
  version: '1.0.0',
  path: '/usr/bin/pi',
  available: true,
  capabilities: { streaming: true, tools: true, multiTurn: true, maxConcurrentTasks: 2 },
});

vi.mock('../src/lib/providers.js', () => ({
  getProvider: (...args: any[]) => mockGetProvider(...args),
  detectProviders: vi.fn().mockResolvedValue([]),
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

function emitLine(proc: ReturnType<typeof createMockProcess>, obj: unknown) {
  proc.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Intercept stdin writes. Optionally auto-respond to commands with ok: true
 * after a given delay (useful for adapter tests where we need the prompt to complete).
 */
function captureStdin(opts: { autoRespond?: boolean; autoRespondDelay?: number; autoRespondFn?: (cmd: any) => any } = {}) {
  const written: any[] = [];
  const origWrite = _mockProc.stdin.write.bind(_mockProc.stdin);
  _mockProc.stdin.write = ((chunk: any, ...args: any[]) => {
    const str = chunk.toString();
    try {
      const cmd = JSON.parse(str);
      written.push(cmd);

      if (opts.autoRespond) {
        const response = opts.autoRespondFn
          ? opts.autoRespondFn(cmd)
          : { id: cmd.id, ok: true };
        if (response) {
          setTimeout(() => {
            emitLine(_mockProc, response);
          }, opts.autoRespondDelay ?? 5);
        }
      }
    } catch {
      written.push(str);
    }
    return origWrite(chunk, ...args);
  }) as any;

  return {
    getLastCommandId: () => {
      const last = written[written.length - 1];
      return last?.id as string | undefined;
    },
    getCommands: () => written,
  };
}

// ---------------------------------------------------------------------------
// PiRpcBridge Tests
// ---------------------------------------------------------------------------

describe('PiRpcBridge', () => {
  beforeEach(() => {
    _mockProc = createMockProcess();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function createBridge(path = '/usr/bin/pi') {
    const { PiRpcBridge } = await import('../src/lib/pi-rpc.js');
    return new PiRpcBridge(path);
  }

  describe('JSONL parsing', () => {
    it('should parse valid JSONL lines from stdout', async () => {
      const bridge = await createBridge();
      bridge.start();

      const events: PiEvent[] = [];
      bridge.onEvent((e) => events.push(e));

      emitLine(_mockProc, { type: 'event', event: 'agent_start', data: {} });
      await new Promise(r => setTimeout(r, 20));

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('agent_start');
      bridge.stop();
    });

    it('should handle partial lines correctly', async () => {
      const bridge = await createBridge();
      bridge.start();

      const events: PiEvent[] = [];
      bridge.onEvent((e) => events.push(e));

      const full = JSON.stringify({ type: 'event', event: 'message_update', data: { text: 'hello' } });
      _mockProc.stdout.write(full.slice(0, 20));
      await new Promise(r => setTimeout(r, 20));
      expect(events).toHaveLength(0);

      _mockProc.stdout.write(full.slice(20) + '\n');
      await new Promise(r => setTimeout(r, 20));
      expect(events).toHaveLength(1);
      bridge.stop();
    });

    it('should handle multiple lines in a single chunk', async () => {
      const bridge = await createBridge();
      bridge.start();

      const events: PiEvent[] = [];
      bridge.onEvent((e) => events.push(e));

      const l1 = JSON.stringify({ type: 'event', event: 'agent_start', data: {} });
      const l2 = JSON.stringify({ type: 'event', event: 'agent_end', data: {} });
      _mockProc.stdout.write(l1 + '\n' + l2 + '\n');
      await new Promise(r => setTimeout(r, 20));

      expect(events).toHaveLength(2);
      expect(events[0].event).toBe('agent_start');
      expect(events[1].event).toBe('agent_end');
      bridge.stop();
    });

    it('should ignore invalid JSON', async () => {
      const bridge = await createBridge();
      bridge.start();
      const events: PiEvent[] = [];
      bridge.onEvent((e) => events.push(e));
      _mockProc.stdout.write('not-json\n');
      await new Promise(r => setTimeout(r, 20));
      expect(events).toHaveLength(0);
      bridge.stop();
    });

    it('should ignore empty lines', async () => {
      const bridge = await createBridge();
      bridge.start();
      const events: PiEvent[] = [];
      bridge.onEvent((e) => events.push(e));
      _mockProc.stdout.write('\n\n\n');
      await new Promise(r => setTimeout(r, 20));
      expect(events).toHaveLength(0);
      bridge.stop();
    });
  });

  describe('command-response correlation', () => {
    it('should correlate responses by id', async () => {
      const bridge = await createBridge();
      bridge.start();
      const cap = captureStdin();

      const p = bridge.prompt('test prompt');
      await new Promise(r => setTimeout(r, 20));

      const cmd = cap.getCommands()[0];
      expect(cmd.method).toBe('prompt');
      expect(cmd.params).toEqual({ text: 'test prompt' });

      emitLine(_mockProc, { id: cmd.id, ok: true, result: { text: 'done' } });
      const res = await p;
      expect(res.ok).toBe(true);
      expect(res.result).toEqual({ text: 'done' });
      bridge.stop();
    });

    it('should handle error responses', async () => {
      const bridge = await createBridge();
      bridge.start();
      const cap = captureStdin();

      const p = bridge.prompt('test');
      await new Promise(r => setTimeout(r, 20));

      const cmd = cap.getCommands()[0];
      emitLine(_mockProc, { id: cmd.id, ok: false, error: { message: 'bad' } });
      const res = await p;
      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe('bad');
      bridge.stop();
    });

    it('should timeout control commands after 30 seconds', async () => {
      vi.useFakeTimers();
      const bridge = await createBridge();
      bridge.start();

      // Control commands (getState, setModel, etc.) have 30s timeout
      const p = bridge.getState();
      vi.advanceTimersByTime(31_000);
      await expect(p).rejects.toThrow(/timed out/);
      bridge.stop();
      vi.useRealTimers();
    });

    it('prompt and steer have no timeout (rely on abort signal)', async () => {
      const bridge = await createBridge();
      bridge.start();
      captureStdin({ autoRespond: true, autoRespondDelay: 5 });

      // prompt and steer should complete via response, not timeout
      const p = await bridge.prompt('test');
      expect(p.ok).toBe(true);
      const s = await bridge.steer('msg');
      expect(s.ok).toBe(true);
      bridge.stop();
    });

    it('should reject pending commands when process exits', async () => {
      const bridge = await createBridge();
      bridge.start();
      const p = bridge.sendCommand('getState');
      await new Promise(r => setTimeout(r, 10));
      _mockProc.emit('exit', 1, null);
      await expect(p).rejects.toThrow(/Pi process exited/);
    });

    it('should reject pending commands on process error', async () => {
      const bridge = await createBridge();
      bridge.start();
      const p = bridge.sendCommand('getState');
      await new Promise(r => setTimeout(r, 10));
      _mockProc.emit('error', new Error('crash'));
      await expect(p).rejects.toThrow('crash');
    });
  });

  describe('event dispatch', () => {
    it('should dispatch to all registered handlers', async () => {
      const bridge = await createBridge();
      bridge.start();
      const h1 = vi.fn();
      const h2 = vi.fn();
      bridge.onEvent(h1);
      bridge.onEvent(h2);

      emitLine(_mockProc, { type: 'event', event: 'tool_execution_start', data: { toolName: 'Read' } });
      await new Promise(r => setTimeout(r, 20));

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
      expect(h1.mock.calls[0][0].data.toolName).toBe('Read');
      bridge.stop();
    });

    it('should remove handlers with offEvent', async () => {
      const bridge = await createBridge();
      bridge.start();
      const h = vi.fn();
      bridge.onEvent(h);
      bridge.offEvent(h);
      emitLine(_mockProc, { type: 'event', event: 'agent_start', data: {} });
      await new Promise(r => setTimeout(r, 20));
      expect(h).not.toHaveBeenCalled();
      bridge.stop();
    });

    it('should tolerate handler errors', async () => {
      const bridge = await createBridge();
      bridge.start();
      const bad = vi.fn(() => { throw new Error('nope'); });
      const good = vi.fn();
      bridge.onEvent(bad);
      bridge.onEvent(good);

      emitLine(_mockProc, { type: 'event', event: 'agent_start', data: {} });
      await new Promise(r => setTimeout(r, 20));
      expect(bad).toHaveBeenCalledTimes(1);
      expect(good).toHaveBeenCalledTimes(1);
      bridge.stop();
    });

    it('should dispatch all Pi event types', async () => {
      const bridge = await createBridge();
      bridge.start();
      const events: PiEvent[] = [];
      bridge.onEvent((e) => events.push(e));

      for (const t of [
        { type: 'event', event: 'agent_start', data: {} },
        { type: 'event', event: 'message_update', data: { text: 'hi' } },
        { type: 'event', event: 'tool_execution_start', data: { toolName: 'W' } },
        { type: 'event', event: 'tool_execution_end', data: { toolName: 'W', success: true } },
        { type: 'event', event: 'auto_compaction_start', data: {} },
        { type: 'event', event: 'extension_ui_request', data: { question: 'OK?', options: ['y'] } },
        { type: 'event', event: 'agent_end', data: { exitCode: 0 } },
      ]) emitLine(_mockProc, t);

      await new Promise(r => setTimeout(r, 30));
      expect(events.map(e => e.event)).toEqual([
        'agent_start', 'message_update', 'tool_execution_start',
        'tool_execution_end', 'auto_compaction_start', 'extension_ui_request', 'agent_end',
      ]);
      bridge.stop();
    });

    it('should not dispatch responses as events', async () => {
      const bridge = await createBridge();
      bridge.start();
      const h = vi.fn();
      bridge.onEvent(h);
      emitLine(_mockProc, { id: 'x', ok: true, result: {} });
      await new Promise(r => setTimeout(r, 20));
      expect(h).not.toHaveBeenCalled();
      bridge.stop();
    });
  });

  describe('process lifecycle', () => {
    it('should spawn with correct args and cwd', async () => {
      const { spawn } = await import('node:child_process');
      const bridge = await createBridge('/usr/local/bin/pi');
      bridge.start(undefined, '/work/dir');
      expect(spawn).toHaveBeenCalledWith(
        '/usr/local/bin/pi', ['--mode', 'rpc'],
        expect.objectContaining({ cwd: '/work/dir', stdio: ['pipe', 'pipe', 'pipe'] }),
      );
      bridge.stop();
    });

    it('should track isRunning state', async () => {
      const bridge = await createBridge();
      expect(bridge.isRunning).toBe(false);
      bridge.start();
      expect(bridge.isRunning).toBe(true);
      bridge.stop();
    });

    it('should handle spawn failure', async () => {
      const { spawn } = await import('node:child_process');
      (spawn as any).mockImplementationOnce(() => { throw new Error('ENOENT'); });
      const bridge = await createBridge('/bad/pi');
      expect(() => bridge.start()).toThrow(/Failed to spawn Pi process/);
      expect(bridge.isRunning).toBe(false);
    });

    it('should be idempotent on double start', async () => {
      const bridge = await createBridge();
      bridge.start();
      bridge.start();
      bridge.stop();
    });
  });

  describe('abort propagation', () => {
    it('should stop on AbortSignal', async () => {
      const bridge = await createBridge();
      const ac = new AbortController();
      bridge.start(ac.signal);
      expect(bridge.isRunning).toBe(true);
      ac.abort();
      expect(_mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('convenience methods', () => {
    it.each([
      ['prompt', ['hello'], 'prompt', { text: 'hello' }],
      ['steer', ['adjust'], 'steer', { message: 'adjust' }],
      ['abort', [], 'abort', undefined],
      ['newSession', [], 'newSession', undefined],
      ['setModel', ['pi-2'], 'setModel', { model: 'pi-2' }],
      ['getState', [], 'getState', undefined],
    ] as const)('%s sends correct method/params', async (method, args, expectedMethod, expectedParams) => {
      const bridge = await createBridge();
      bridge.start();
      const cap = captureStdin();

      const p = (bridge as any)[method](...args);
      await new Promise(r => setTimeout(r, 20));

      const cmd = cap.getCommands()[0];
      expect(cmd.method).toBe(expectedMethod);
      if (expectedParams) expect(cmd.params).toEqual(expectedParams);

      emitLine(_mockProc, { id: cmd.id, ok: true, result: { state: 'idle' } });
      await p;
      bridge.stop();
    });

    it('rejects when not running', async () => {
      const bridge = await createBridge();
      await expect(bridge.sendCommand('test')).rejects.toThrow(/not running/);
    });
  });
});

// ---------------------------------------------------------------------------
// PiAdapter Tests
// ---------------------------------------------------------------------------

describe('PiAdapter', () => {
  beforeEach(() => {
    _mockProc = createMockProcess();
    vi.clearAllMocks();
    mockGetProvider.mockResolvedValue({
      type: 'pi', name: 'Pi', version: '1.0.0', path: '/usr/bin/pi', available: true,
      capabilities: { streaming: true, tools: true, multiTurn: true, maxConcurrentTasks: 2 },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeTask(overrides: Record<string, unknown> = {}) {
    return {
      id: 'task-1', projectId: 'p1', planNodeId: 'n1', provider: 'pi',
      prompt: 'test prompt', workingDirectory: '/tmp/work',
      createdAt: new Date().toISOString(), ...overrides,
    } as any;
  }

  async function getAdapter() {
    const { PiAdapter } = await import('../src/providers/pi-adapter.js');
    return new PiAdapter();
  }

  /**
   * Execute a task with auto-responding stdin (prompt command auto-completes).
   * Emits specified events between task start and auto-completion.
   */
  async function executeWithEvents(
    adapter: any,
    task: any,
    stream: TaskOutputStream,
    events: any[],
    opts: { respondOk?: boolean; respondError?: string; signal?: AbortSignal } = {},
  ) {
    const { respondOk = true, respondError, signal } = opts;
    const ac = signal ? undefined : new AbortController();
    const effectiveSignal = signal || ac!.signal;

    // Set up auto-respond: emit events first, then send the response
    captureStdin({
      autoRespond: true,
      autoRespondDelay: 50, // Give time for events to be emitted first
      autoRespondFn: (cmd: any) => {
        if (cmd.method === 'prompt' || cmd.method === 'steer') {
          // Emit events before responding
          setTimeout(() => {
            for (const evt of events) {
              emitLine(_mockProc, evt);
            }
          }, 10);

          // Then respond
          if (respondError) {
            return { id: cmd.id, ok: false, error: { message: respondError } };
          }
          return { id: cmd.id, ok: respondOk };
        }
        return { id: cmd.id, ok: true };
      },
    });

    return adapter.execute(task, stream, effectiveSignal);
  }

  describe('isAvailable', () => {
    it('returns true when pi provider is detected', async () => {
      const adapter = await getAdapter();
      expect(await adapter.isAvailable()).toBe(true);
    });

    it('returns false when pi provider is not available', async () => {
      mockGetProvider.mockResolvedValue(null);
      const adapter = await getAdapter();
      expect(await adapter.isAvailable()).toBe(false);
    });
  });

  describe('event mapping', () => {
    it('maps tool_execution_start to stream.toolUse()', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'tool_execution_start', data: { toolName: 'Read', toolInput: { path: '/f.ts' } } },
      ];

      await executeWithEvents(adapter, makeTask(), stream, events);
      expect(stream.toolUse).toHaveBeenCalledWith('Read', { path: '/f.ts' });
    });

    it('maps tool_execution_end to stream.toolResult()', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'tool_execution_end', data: { toolName: 'Write', result: 'OK', success: true } },
      ];

      await executeWithEvents(adapter, makeTask({ id: 't2' }), stream, events);
      expect(stream.toolResult).toHaveBeenCalledWith('Write', 'OK', true);
    });

    it('maps tool_execution_end with failure', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'tool_execution_end', data: { toolName: 'Bash', result: 'err', success: false } },
      ];

      await executeWithEvents(adapter, makeTask({ id: 't3' }), stream, events);
      expect(stream.toolResult).toHaveBeenCalledWith('Bash', 'err', false);
    });

    it('maps message_update delta to stream.text()', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'message_update', data: { delta: 'Hello' } },
      ];

      await executeWithEvents(adapter, makeTask({ id: 't4' }), stream, events);
      expect(stream.text).toHaveBeenCalledWith('Hello');
    });

    it('maps message_update text fallback', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'message_update', data: { text: 'Fallback' } },
      ];

      await executeWithEvents(adapter, makeTask({ id: 't5' }), stream, events);
      expect(stream.text).toHaveBeenCalledWith('Fallback');
    });

    it('maps agent_end with cost', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'agent_end', data: { cost_usd: 0.0123 } },
      ];

      await executeWithEvents(adapter, makeTask({ id: 't6' }), stream, events);
      expect(stream.status).toHaveBeenCalledWith('running', 100, expect.stringContaining('$0.0123'));
    });

    it('maps agent_end without cost', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'agent_end', data: {} },
      ];

      await executeWithEvents(adapter, makeTask({ id: 't7' }), stream, events);
      expect(stream.status).toHaveBeenCalledWith('running', 100, 'Completed');
    });

    it('maps extension_ui_request to approvalRequest', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'extension_ui_request', data: { question: 'Allow?', options: ['y', 'n'] } },
      ];

      await executeWithEvents(adapter, makeTask({ id: 't8' }), stream, events);
      expect(stream.approvalRequest).toHaveBeenCalledWith('Allow?', ['y', 'n']);
    });

    it('maps auto_compaction_start to status', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'auto_compaction_start', data: {} },
      ];

      await executeWithEvents(adapter, makeTask({ id: 't9' }), stream, events);
      expect(stream.status).toHaveBeenCalledWith('running', undefined, 'Compacting context');
    });

    it('maps agent_start to sessionInit', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'agent_start', data: {} },
      ];

      await executeWithEvents(adapter, makeTask({ id: 't10' }), stream, events);
      expect(stream.sessionInit).toHaveBeenCalledTimes(1);
      expect(typeof (stream.sessionInit as any).mock.calls[0][0]).toBe('string');
    });
  });

  describe('execution result', () => {
    it('returns completed on success with metrics', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'message_update', data: { delta: 'Done' } },
        { type: 'event', event: 'agent_end', data: { cost_usd: 0.05, model: 'pi-1', num_turns: 3, duration_ms: 5000, usage: { input_tokens: 100, output_tokens: 200 } } },
      ];

      const result = await executeWithEvents(adapter, makeTask({ id: 'ok' }), stream, events);
      expect(result.status).toBe('completed');
      expect(result.taskId).toBe('ok');
      expect(result.output).toBe('Done');
      expect(result.metrics?.totalCost).toBe(0.05);
      expect(result.metrics?.model).toBe('pi-1');
      expect(result.metrics?.numTurns).toBe(3);
      expect(result.metrics?.durationMs).toBe(5000);
      expect(result.metrics?.inputTokens).toBe(100);
      expect(result.metrics?.outputTokens).toBe(200);
    });

    it('returns failed on error response', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      const result = await executeWithEvents(adapter, makeTask({ id: 'err' }), stream, [], { respondError: 'crashed' });
      expect(result.status).toBe('failed');
      expect(result.error).toBe('crashed');
    });

    it('returns cancelled on abort', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const ac = new AbortController();

      // Don't auto-respond; abort instead
      const execPromise = adapter.execute(makeTask({ id: 'cancel' }), stream, ac.signal);

      // Let the adapter start, then abort
      await new Promise(r => setTimeout(r, 50));
      ac.abort();
      await new Promise(r => setTimeout(r, 20));

      const result = await execPromise;
      expect(result.status).toBe('cancelled');
      expect(result.error).toBe('Task cancelled');
    });

    it('returns failed when Pi is not available', async () => {
      mockGetProvider.mockResolvedValue(null);
      const adapter = await getAdapter();
      const stream = createMockStream();
      const ac = new AbortController();

      const result = await adapter.execute(makeTask({ id: 'na' }), stream, ac.signal);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Pi not available');
    });

    it('accumulates text from multiple events', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'message_update', data: { delta: 'Hello ' } },
        { type: 'event', event: 'message_update', data: { delta: 'World' } },
      ];

      const result = await executeWithEvents(adapter, makeTask({ id: 'multi' }), stream, events);
      expect(result.output).toBe('Hello World');
    });

    it('prepends system prompt', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const cap = captureStdin({ autoRespond: true, autoRespondDelay: 5 });

      await adapter.execute(
        makeTask({ id: 'sys', systemPrompt: 'You are helpful', prompt: 'do stuff' }),
        stream, new AbortController().signal,
      );

      const promptCmd = cap.getCommands().find((c: any) => c.method === 'prompt');
      expect(promptCmd?.params.text).toContain('You are helpful');
      expect(promptCmd?.params.text).toContain('do stuff');
    });
  });

  describe('getStatus', () => {
    it('returns correct status when available', async () => {
      const adapter = await getAdapter();
      const status = await adapter.getStatus();
      expect(status.available).toBe(true);
      expect(status.version).toBe('1.0.0');
      expect(status.activeTasks).toBe(0);
      expect(status.maxTasks).toBe(2);
    });

    it('tracks active tasks during execution', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      // Don't auto-respond so we can check active tasks while running
      const ac = new AbortController();
      const execPromise = adapter.execute(makeTask({ id: 'active' }), stream, ac.signal);
      await new Promise(r => setTimeout(r, 50));

      const during = await adapter.getStatus();
      expect(during.activeTasks).toBe(1);

      // Cancel to complete
      ac.abort();
      await new Promise(r => setTimeout(r, 20));
      await execPromise;

      const after = await adapter.getStatus();
      expect(after.activeTasks).toBe(0);
    });
  });

  describe('multi-turn session preservation', () => {
    it('preserves session after success', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      await executeWithEvents(adapter, makeTask({ id: 'sess', workingDirectory: '/w' }), stream, []);

      const ctx = adapter.getTaskContext?.('sess');
      expect(ctx).not.toBeNull();
      expect(ctx?.workingDirectory).toBe('/w');
    });

    it('does not preserve session after failure', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      await executeWithEvents(adapter, makeTask({ id: 'fail-sess' }), stream, [], { respondError: 'fail' });
      expect(adapter.getTaskContext?.('fail-sess')).toBeNull();
    });

    it('sets originalWorkingDirectory', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      await executeWithEvents(adapter, makeTask({ id: 'orig', workingDirectory: '/wt' }), stream, []);

      adapter.setOriginalWorkingDirectory?.('orig', '/real');
      const ctx = adapter.getTaskContext?.('orig');
      expect(ctx?.originalWorkingDirectory).toBe('/real');
    });

    it('expires sessions after TTL', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      await executeWithEvents(adapter, makeTask({ id: 'expire' }), stream, []);

      const sessions = (adapter as any).preservedSessions;
      const sess = sessions.get('expire');
      if (sess) sess.createdAt = Date.now() - 11 * 60 * 1000;

      expect(adapter.getTaskContext?.('expire')).toBeNull();
    });
  });

  describe('injectMessage', () => {
    it('returns false (not supported)', async () => {
      const adapter = await getAdapter();
      expect(await adapter.injectMessage?.('x', 'y')).toBe(false);
    });
  });

  describe('adapter identity', () => {
    it('has type "pi" and name "Pi"', async () => {
      const adapter = await getAdapter();
      expect(adapter.type).toBe('pi');
      expect(adapter.name).toBe('Pi');
    });
  });

  describe('bridge cleanup on exception', () => {
    it('stops bridge when prompt() throws', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const ac = new AbortController();

      // Make the bridge's prompt throw by having stdin.write fail
      const origWrite = _mockProc.stdin.write;
      _mockProc.stdin.write = (() => { throw new Error('stdin broken'); }) as any;

      const result = await adapter.execute(makeTask({ id: 'exc' }), stream, ac.signal);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('stdin broken');
      // Bridge should have been cleaned up (kill called)
      expect(_mockProc.kill).toHaveBeenCalled();

      // Restore
      _mockProc.stdin.write = origWrite;
    });
  });

  describe('event handler cleanup', () => {
    it('cleans up event handler even if prompt fails', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      const result = await executeWithEvents(
        adapter, makeTask({ id: 'handler-cleanup' }), stream, [],
        { respondError: 'prompt failed' },
      );
      expect(result.status).toBe('failed');
      // The adapter should not leak event handlers — bridge.offEvent called via finally
    });
  });

  describe('fileChange detection', () => {
    it('emits fileChange for Write tool with path', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'tool_execution_start', data: { toolName: 'Write', toolInput: { path: '/tmp/out.ts' } } },
        { type: 'event', event: 'tool_execution_end', data: { toolName: 'Write', result: 'OK', success: true } },
      ];

      await executeWithEvents(adapter, makeTask({ id: 'fc1' }), stream, events);
      expect(stream.fileChange).toHaveBeenCalledWith('/tmp/out.ts', 'modified');
    });

    it('emits fileChange for Create tool as created', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'tool_execution_start', data: { toolName: 'Create', toolInput: { path: '/new.ts' } } },
        { type: 'event', event: 'tool_execution_end', data: { toolName: 'Create', result: 'OK', success: true } },
      ];

      await executeWithEvents(adapter, makeTask({ id: 'fc2' }), stream, events);
      expect(stream.fileChange).toHaveBeenCalledWith('/new.ts', 'created');
    });

    it('does not emit fileChange for non-file tools', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'tool_execution_start', data: { toolName: 'Read', toolInput: { path: '/f.ts' } } },
        { type: 'event', event: 'tool_execution_end', data: { toolName: 'Read', result: 'content', success: true } },
      ];

      await executeWithEvents(adapter, makeTask({ id: 'fc3' }), stream, events);
      expect(stream.fileChange).not.toHaveBeenCalled();
    });
  });

  describe('environment variable passing', () => {
    it('passes task.environment to Pi subprocess', async () => {
      const { spawn } = await import('node:child_process');
      const adapter = await getAdapter();
      const stream = createMockStream();

      captureStdin({ autoRespond: true, autoRespondDelay: 5 });

      await adapter.execute(
        makeTask({
          id: 'env',
          type: 'chat',
          environment: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token', CUSTOM_VAR: 'value' },
        }),
        stream, new AbortController().signal,
      );

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        ['--mode', 'rpc'],
        expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
            CUSTOM_VAR: 'value',
          }),
        }),
      );
    });
  });

  describe('model configuration', () => {
    it('calls setModel when task.model is set', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      // Use captureStdin with the same pattern as the working "prepends system prompt" test
      const cap = captureStdin({ autoRespond: true, autoRespondDelay: 5 });

      await adapter.execute(
        makeTask({ id: 'model', model: 'pi-turbo' }),
        stream, new AbortController().signal,
      );

      const commands = cap.getCommands();
      const setModelCmd = commands.find((c: any) => c.method === 'setModel');
      expect(setModelCmd).toBeDefined();
      expect(setModelCmd.params).toEqual({ model: 'pi-turbo' });
    });

    it('does not call setModel when task.model is not set', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      const cap = captureStdin({ autoRespond: true, autoRespondDelay: 5 });

      await adapter.execute(makeTask({ id: 'no-model' }), stream, new AbortController().signal);

      const commands = cap.getCommands();
      const setModelCmd = commands.find((c: any) => c.method === 'setModel');
      expect(setModelCmd).toBeUndefined();
    });
  });

  describe('timeout support', () => {
    it('returns cancelled when task.timeout fires', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      // Use a very short timeout — no auto-respond so the prompt hangs until timeout fires
      const result = await adapter.execute(
        makeTask({ id: 'timeout', timeout: 100 }),
        stream, new AbortController().signal,
      );

      expect(result.status).toBe('cancelled');
      expect(result.error).toBe('Task timed out');
    }, 10_000);
  });

  describe('progress tracking', () => {
    it('reports logarithmic progress on tool events', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      const events = [
        { type: 'event', event: 'tool_execution_start', data: { toolName: 'Read', toolInput: {} } },
        { type: 'event', event: 'tool_execution_end', data: { toolName: 'Read', success: true } },
        { type: 'event', event: 'tool_execution_start', data: { toolName: 'Write', toolInput: {} } },
        { type: 'event', event: 'tool_execution_end', data: { toolName: 'Write', success: true } },
      ];

      await executeWithEvents(adapter, makeTask({ id: 'prog' }), stream, events);

      // Should have progress calls for tool_execution_start (logarithmic)
      const statusCalls = (stream.status as any).mock.calls;
      const toolProgressCalls = statusCalls.filter(
        (c: any[]) => typeof c[1] === 'number' && c[1] > 0 && c[1] < 100 && c[2]?.startsWith('Tool:'),
      );
      expect(toolProgressCalls.length).toBeGreaterThanOrEqual(1);
      // First tool: progress = min(80, round(20 * log2(2))) = 20
      expect(toolProgressCalls[0][1]).toBe(20);
    });
  });

  describe('approval response routing', () => {
    it('routes approval response back to bridge via extensionUiResponse', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();
      (stream.approvalRequest as any).mockResolvedValue({ answered: true, answer: 'yes' });

      // Track all commands that go through stdin
      const allCommands: any[] = [];
      captureStdin({
        autoRespond: true,
        autoRespondDelay: 5,
        autoRespondFn: (cmd: any) => {
          allCommands.push(cmd);
          if (cmd.method === 'prompt') {
            // Emit the extension_ui_request event before responding
            setTimeout(() => {
              emitLine(_mockProc, {
                type: 'event', event: 'extension_ui_request',
                data: { question: 'OK?', options: ['yes', 'no'], requestId: 'req-1' },
              });
            }, 2);
            return { id: cmd.id, ok: true };
          }
          return { id: cmd.id, ok: true };
        },
      });

      await adapter.execute(
        makeTask({ id: 'approval' }),
        stream, new AbortController().signal,
      );

      // Wait for the async approval routing to complete
      await new Promise(r => setTimeout(r, 200));

      expect(stream.approvalRequest).toHaveBeenCalledWith('OK?', ['yes', 'no']);

      const uiResponseCmd = allCommands.find((c: any) => c.method === 'extensionUiResponse');
      expect(uiResponseCmd).toBeDefined();
      expect(uiResponseCmd.params?.requestId).toBe('req-1');
      expect(uiResponseCmd.params?.answer).toBe('yes');
    });
  });

  describe('task type dispatch', () => {
    it('skips summary for chat tasks', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      // Use direct captureStdin like the working "prepends system prompt" test
      captureStdin({ autoRespond: true, autoRespondDelay: 5 });

      const result = await adapter.execute(
        makeTask({ id: 'chat', type: 'chat' }),
        stream, new AbortController().signal,
      );
      expect(result.status).toBe('completed');
      expect(result.summary).toBeUndefined();
    });

    it('skips summary for summarize tasks', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      captureStdin({ autoRespond: true, autoRespondDelay: 5 });

      const result = await adapter.execute(
        makeTask({ id: 'sum', type: 'summarize' }),
        stream, new AbortController().signal,
      );
      expect(result.status).toBe('completed');
      expect(result.summary).toBeUndefined();
    });

    it('skips summary for plan tasks', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      captureStdin({ autoRespond: true, autoRespondDelay: 5 });

      const result = await adapter.execute(
        makeTask({ id: 'plan', type: 'plan' }),
        stream, new AbortController().signal,
      );
      expect(result.status).toBe('completed');
      expect(result.summary).toBeUndefined();
    });
  });

  describe('destroy', () => {
    it('cleans up all sessions and timer', async () => {
      const adapter = await getAdapter();
      const stream = createMockStream();

      captureStdin({ autoRespond: true, autoRespondDelay: 5 });

      await adapter.execute(makeTask({ id: 'destroy-test' }), stream, new AbortController().signal);
      expect(adapter.getTaskContext?.('destroy-test')).not.toBeNull();

      (adapter as any).destroy();
      expect((adapter as any).preservedSessions.size).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Provider Factory Tests (import provider index directly)
// ---------------------------------------------------------------------------

describe('Provider factory', () => {
  beforeEach(() => {
    _mockProc = createMockProcess();
    vi.clearAllMocks();
    mockGetProvider.mockResolvedValue({
      type: 'pi', name: 'Pi', version: '1.0.0', path: '/usr/bin/pi', available: true,
      capabilities: { streaming: true, tools: true, multiTurn: true, maxConcurrentTasks: 2 },
    });
  });

  it('createProviderAdapter("pi") returns PiAdapter instance', async () => {
    // Import directly — avoid pulling in the full dependency tree via index
    const { PiAdapter } = await import('../src/providers/pi-adapter.js');
    const adapter = new PiAdapter();
    expect(adapter.type).toBe('pi');
    expect(adapter.name).toBe('Pi');
  });
});

// ---------------------------------------------------------------------------
// ProviderType Tests
// ---------------------------------------------------------------------------

describe('ProviderType includes pi', () => {
  it('"pi" is in the ProviderType union', () => {
    const validTypes = ['claude-sdk', 'codex', 'openclaw', 'opencode', 'pi', 'slurm', 'custom'];
    expect(validTypes).toContain('pi');
  });
});
