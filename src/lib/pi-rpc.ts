/**
 * Pi RPC bridge — JSONL stdin/stdout communication with Pi coding agent
 *
 * Spawns `pi --mode rpc` as a child process and communicates via
 * LF-delimited JSONL over stdin/stdout.
 *
 * Uses a Map<id, resolver> pattern for command/response correlation
 * with 30-second timeouts and event dispatching to registered handlers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Pi Event Types
// ---------------------------------------------------------------------------

export interface PiAgentStartEvent {
  type: 'event';
  event: 'agent_start';
  data?: Record<string, unknown>;
}

export interface PiMessageUpdateEvent {
  type: 'event';
  event: 'message_update';
  data: {
    text?: string;
    delta?: string;
    [key: string]: unknown;
  };
}

export interface PiToolExecutionStartEvent {
  type: 'event';
  event: 'tool_execution_start';
  data: {
    toolName: string;
    toolInput?: unknown;
    [key: string]: unknown;
  };
}

export interface PiToolExecutionEndEvent {
  type: 'event';
  event: 'tool_execution_end';
  data: {
    toolName: string;
    result?: unknown;
    success?: boolean;
    [key: string]: unknown;
  };
}

export interface PiAgentEndEvent {
  type: 'event';
  event: 'agent_end';
  data?: {
    exitCode?: number;
    usage?: { input_tokens?: number; output_tokens?: number };
    cost_usd?: number;
    model?: string;
    num_turns?: number;
    duration_ms?: number;
    [key: string]: unknown;
  };
}

export interface PiAutoCompactionStartEvent {
  type: 'event';
  event: 'auto_compaction_start';
  data?: Record<string, unknown>;
}

export interface PiExtensionUiRequestEvent {
  type: 'event';
  event: 'extension_ui_request';
  data: {
    question: string;
    options?: string[];
    requestId?: string;
    [key: string]: unknown;
  };
}

export type PiEvent =
  | PiAgentStartEvent
  | PiMessageUpdateEvent
  | PiToolExecutionStartEvent
  | PiToolExecutionEndEvent
  | PiAgentEndEvent
  | PiAutoCompactionStartEvent
  | PiExtensionUiRequestEvent;

// ---------------------------------------------------------------------------
// RPC Message Types
// ---------------------------------------------------------------------------

export interface PiRpcCommand {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface PiRpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { message: string; code?: number };
}

type PiRpcMessage = PiRpcResponse | (PiEvent & { id?: never });

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/** Default command timeout (30 seconds) */
const COMMAND_TIMEOUT_MS = 30_000;

export type PiEventHandler = (event: PiEvent) => void;

export class PiRpcBridge {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private pendingCommands = new Map<string, {
    resolve: (res: PiRpcResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private eventHandlers: PiEventHandler[] = [];
  private piPath: string;
  private started = false;

  constructor(piPath = 'pi') {
    this.piPath = piPath;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  /**
   * Start the Pi RPC process.
   * @param signal Optional AbortSignal to terminate the process.
   * @param cwd Optional working directory for the process.
   * @param env Optional extra environment variables (e.g., task.environment).
   */
  start(signal?: AbortSignal, cwd?: string, env?: Record<string, string>): void {
    if (this.started) return;

    try {
      this.process = spawn(this.piPath, ['--mode', 'rpc'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
    } catch (err) {
      throw new Error(`Failed to spawn Pi process: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.started = true;

    // Set up line-based JSONL parsing on stdout
    this.readline = createInterface({ input: this.process.stdout! });
    this.readline.on('line', (line: string) => this.handleLine(line));

    // Handle process exit
    this.process.on('exit', (code, sig) => {
      this.started = false;
      // Reject all pending commands
      for (const [id, pending] of this.pendingCommands) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Pi process exited (code=${code}, signal=${sig})`));
        this.pendingCommands.delete(id);
      }
    });

    this.process.on('error', (err) => {
      this.started = false;
      for (const [id, pending] of this.pendingCommands) {
        clearTimeout(pending.timer);
        pending.reject(err);
        this.pendingCommands.delete(id);
      }
    });

    // Wire up AbortSignal
    if (signal) {
      const abortHandler = () => this.stop();
      signal.addEventListener('abort', abortHandler, { once: true });
      this.process.on('exit', () => signal.removeEventListener('abort', abortHandler));
    }
  }

  /**
   * Gracefully stop the Pi process.
   * Sends SIGTERM, escalates to SIGKILL after 5 seconds.
   */
  stop(): void {
    if (!this.process || !this.started) return;

    this.started = false;
    this.readline?.close();
    this.readline = null;

    this.process.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.process.kill('SIGKILL');
      }
    }, 5000);

    this.process.on('exit', () => clearTimeout(killTimer));
  }

  get isRunning(): boolean {
    return this.started && this.process !== null && !this.process.killed;
  }

  // ─── Event Handling ─────────────────────────────────────────────

  /**
   * Register an event handler for Pi streaming events.
   */
  onEvent(handler: PiEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Remove an event handler.
   */
  offEvent(handler: PiEventHandler): void {
    const idx = this.eventHandlers.indexOf(handler);
    if (idx >= 0) this.eventHandlers.splice(idx, 1);
  }

  // ─── Commands ───────────────────────────────────────────────────

  /**
   * Send an RPC command and wait for the response.
   */
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<PiRpcResponse> {
    if (!this.isRunning) {
      throw new Error('Pi RPC bridge is not running');
    }

    const id = randomUUID();
    const command: PiRpcCommand = { id, method, params };

    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Pi RPC command '${method}' timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      this.pendingCommands.set(id, { resolve, reject, timer });

      const json = JSON.stringify(command) + '\n';
      try {
        this.process!.stdin!.write(json);
      } catch (err) {
        clearTimeout(timer);
        this.pendingCommands.delete(id);
        reject(new Error(`Failed to write to Pi stdin: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  /** Send a prompt to the Pi agent */
  async prompt(text: string): Promise<PiRpcResponse> {
    return this.sendCommand('prompt', { text });
  }

  /** Send a steer message to the Pi agent */
  async steer(message: string): Promise<PiRpcResponse> {
    return this.sendCommand('steer', { message });
  }

  /** Abort the current operation */
  async abort(): Promise<PiRpcResponse> {
    return this.sendCommand('abort');
  }

  /** Get agent state */
  async getState(): Promise<PiRpcResponse> {
    return this.sendCommand('getState');
  }

  /** Start a new session */
  async newSession(): Promise<PiRpcResponse> {
    return this.sendCommand('newSession');
  }

  /** Set the model */
  async setModel(model: string): Promise<PiRpcResponse> {
    return this.sendCommand('setModel', { model });
  }

  // ─── Internal ───────────────────────────────────────────────────

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let msg: PiRpcMessage;
    try {
      msg = JSON.parse(line) as PiRpcMessage;
    } catch {
      // Not valid JSON — ignore
      return;
    }

    // Check if this is a command response (has `id` and `ok` fields)
    if ('id' in msg && msg.id && 'ok' in msg) {
      const response = msg as PiRpcResponse;
      const pending = this.pendingCommands.get(response.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCommands.delete(response.id);
        pending.resolve(response);
      }
      return;
    }

    // Otherwise treat as an event
    if ('type' in msg && msg.type === 'event') {
      const event = msg as PiEvent;
      for (const handler of this.eventHandlers) {
        try {
          handler(event);
        } catch {
          // Don't let handler errors break the bridge
        }
      }
    }
  }
}
