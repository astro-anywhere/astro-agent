/**
 * WebSocket client with automatic reconnection and heartbeat
 */

import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import type {
  WSMessage,
  RegisterMessage,
  HeartbeatMessage,
  TaskStatusMessage,
  TaskOutputMessage,
  TaskResultMessage,
  TaskToolTraceMessage,
  TaskTextMessage,
  TaskOperationalMessage,
  TaskToolUseMessage,
  TaskToolResultWSMessage,
  TaskFileChangeMessage,
  TaskSessionInitMessage,
  TaskSteerAckWSMessage,
  TaskSteerIncomingMessage,
  TaskApprovalRequestMessage,
  TaskApprovalResponseMessage,
  TaskSafetyDecisionMessage,
  ResourceUpdateMessage,
  RegisteredMessage,
  HeartbeatAckMessage,
  TaskDispatchMessage,
  TaskCancelMessage,
  ConfigUpdateMessage,
  ErrorMessage,
  FileListRequestMessage,
  FileListResponseMessage,
  FileContentRequestMessage,
  FileContentResponseMessage,
  FileUploadRequestMessage,
  FileUploadChunkMessage,
  FileUploadResponseMessage,
  DirectoryListRequestMessage,
  DirectoryListResponseMessage,
  CreateDirectoryRequestMessage,
  CreateDirectoryResponseMessage,
  ContentSearchRequestMessage,
  ContentSearchResponseMessage,
  ContentSearchMatch,
  RepoSetupRequestMessage,
  RepoSetupResponseMessage,
  SlashCommandsRequestMessage,
  SlashCommandsResponseMessage,
  RepoDetectRequestMessage,
  RepoDetectResponseMessage,
  BranchListRequestMessage,
  BranchListResponseMessage,
  GitCheckoutRequestMessage,
  GitCheckoutResponseMessage,
  GitCreateBranchRequestMessage,
  GitCreateBranchResponseMessage,
  GitInitRequestMessage,
  GitInitResponseMessage,
  ChannelNotificationMessage,
  ChannelResponseMessage,
  ChannelApprovalRequestMessage,
  ProviderInfo,
  ExecutionStrategyInfo,
  RunnerConfig,
  RunnerEvent,
  RunnerEventHandler,
  TaskResult,
  Task,
} from '../types.js';
import { OpenClawBridge } from './openclaw-bridge.js';
import { getMachineResources } from './resources.js';
import { config as configManager } from './config.js';

const DEFAULT_CONFIG: RunnerConfig = {
  relayUrl: 'wss://relay.astro.dev',
  maxConcurrentTasks: 40,
  heartbeatInterval: 30000, // 30 seconds
  reconnectMaxRetries: -1, // Infinite retries
  reconnectBaseDelay: 3000, // 3 seconds
  reconnectMaxDelay: 60000, // 1 minute
  taskTimeout: 3600000, // 1 hour
  logLevel: 'info',
};

type DispatchPublicKey = NonNullable<Task['dispatchTrustedKeys']>[number];

function mergeDispatchPublicKeys(
  configuredKeys: DispatchPublicKey[],
  additionalKeys?: DispatchPublicKey[],
): DispatchPublicKey[] {
  const seen = new Set<string>();
  const merged: DispatchPublicKey[] = [];

  for (const key of [...configuredKeys, ...(additionalKeys ?? [])]) {
    const fingerprint = `${key.kty ?? ''}:${key.crv ?? ''}:${key.x ?? ''}:${key.y ?? ''}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    merged.push(key);
  }

  return merged;
}

export interface WebSocketClientOptions {
  runnerId: string;
  machineId: string;
  providers: ProviderInfo[];
  executionStrategies?: ExecutionStrategyInfo[];
  config?: Partial<RunnerConfig>;
  onEvent?: RunnerEventHandler;
  onTaskDispatch?: (task: Task) => void;
  onTaskCancel?: (taskId: string) => void;
  onTaskSteer?: (taskId: string, message: string, action?: string, interrupt?: boolean, sessionId?: string, branchName?: string) => void;
  onTaskSafetyDecision?: (taskId: string, decision: 'proceed' | 'init-git' | 'sandbox' | 'cancel') => void;
  onTaskCleanup?: (taskId: string, branchName?: string) => void;
  onProjectCleanup?: (projectId: string) => void;
  onFileList?: (path: string, correlationId: string) => void;
  onFileContent?: (path: string, correlationId: string) => void;
  onFileUpload?: (destinationPath: string, fileName: string, size: number, totalChunks: number, overwrite: boolean, correlationId: string) => void;
  onFileUploadChunk?: (correlationId: string, chunkIndex: number, encoding: 'utf-8' | 'base64', content: string) => void;
  onDirectoryList?: (path: string, correlationId: string) => void;
  onCreateDirectory?: (parentPath: string, name: string, correlationId: string) => void;
  onContentSearch?: (root: string, pattern: string, correlationId: string, opts?: { caseSensitive?: boolean; maxMatchesPerFile?: number; limit?: number }) => void;
  onRepoSetup?: (payload: RepoSetupRequestMessage['payload']) => void;
  onSlashCommands?: (correlationId: string, workingDirectory?: string) => void;
  onRepoDetect?: (payload: RepoDetectRequestMessage['payload']) => void;
  onBranchList?: (payload: BranchListRequestMessage['payload']) => void;
  onGitCheckout?: (payload: GitCheckoutRequestMessage['payload']) => void;
  onGitCreateBranch?: (payload: GitCreateBranchRequestMessage['payload']) => void;
  onGitInit?: (payload: GitInitRequestMessage['payload']) => void;
  onSessionsList?: (
    correlationId: string,
    maxAgeMs?: number,
    providers?: import('../types.js').ExternalAgentProvider[],
    cwd?: string,
  ) => void;
  onImportSessions?: (
    correlationId: string,
    workingDirectory: string,
    sessions: import('../types.js').ImportSessionsRequestMessage['payload']['sessions'],
  ) => void;
  onOpenClawBridgeReady?: (bridge: OpenClawBridge) => void;
  version?: string;
  wsToken?: string;
}

/** Cleanup message: remove worktree + branch for a previously executed task */
interface TaskCleanupMessage {
  type: 'task_cleanup';
  timestamp: string;
  payload: { taskId: string; branchName?: string };
}

/** Cleanup message: remove auto-provisioned workspace for a deleted project */
interface ProjectCleanupMessage {
  type: 'project_cleanup';
  timestamp: string;
  payload: { projectId: string };
}

type IncomingMessage =
  | RegisteredMessage
  | HeartbeatAckMessage
  | TaskDispatchMessage
  | TaskCancelMessage
  | TaskCleanupMessage
  | ProjectCleanupMessage
  | TaskSteerIncomingMessage
  | TaskApprovalResponseMessage
  | TaskSafetyDecisionMessage
  | ConfigUpdateMessage
  | FileListRequestMessage
  | FileContentRequestMessage
  | FileUploadRequestMessage
  | FileUploadChunkMessage
  | DirectoryListRequestMessage
  | CreateDirectoryRequestMessage
  | ContentSearchRequestMessage
  | RepoSetupRequestMessage
  | SlashCommandsRequestMessage
  | RepoDetectRequestMessage
  | BranchListRequestMessage
  | GitCheckoutRequestMessage
  | GitCreateBranchRequestMessage
  | GitInitRequestMessage
  | import('../types.js').SessionsListRequestMessage
  | import('../types.js').ImportSessionsRequestMessage
  | ChannelNotificationMessage
  | ChannelResponseMessage
  | ChannelApprovalRequestMessage
  | ErrorMessage;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private config: RunnerConfig;
  private runnerId: string;
  private machineId: string;
  private providers: ProviderInfo[];
  private executionStrategies?: ExecutionStrategyInfo[];
  private version: string;
  private wsToken?: string;

  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private tokenRefreshTimeout: NodeJS.Timeout | null = null;
  private pongTimeout: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private shouldReconnect = true;
  private activeTasks: Set<string> = new Set();
  private pendingMessages: WSMessage[] = [];
  private static MAX_PENDING = 5000;
  private pendingApprovals: Map<string, { resolve: (result: { answered: boolean; answer?: string; message?: string }) => void; reject: (error: Error) => void }> = new Map();
  private openclawBridge: OpenClawBridge | null = null;

  private onEvent?: RunnerEventHandler;
  private onTaskDispatch?: (task: Task) => void;
  private onTaskCancel?: (taskId: string) => void;
  private onTaskSteer?: (taskId: string, message: string, action?: string, interrupt?: boolean, sessionId?: string, branchName?: string) => void;
  private onTaskSafetyDecision?: (taskId: string, decision: 'proceed' | 'init-git' | 'sandbox' | 'cancel') => void;
  private onTaskCleanup?: (taskId: string, branchName?: string) => void;
  private onProjectCleanup?: (projectId: string) => void;
  private onFileList?: (path: string, correlationId: string) => void;
  private onFileContent?: (path: string, correlationId: string) => void;
  private onFileUpload?: (destinationPath: string, fileName: string, size: number, totalChunks: number, overwrite: boolean, correlationId: string) => void;
  private onFileUploadChunk?: (correlationId: string, chunkIndex: number, encoding: 'utf-8' | 'base64', content: string) => void;
  private onDirectoryList?: (path: string, correlationId: string) => void;
  private onCreateDirectory?: (parentPath: string, name: string, correlationId: string) => void;
  private onContentSearch?: (root: string, pattern: string, correlationId: string, opts?: { caseSensitive?: boolean; maxMatchesPerFile?: number; limit?: number }) => void;
  private onRepoSetup?: (payload: RepoSetupRequestMessage['payload']) => void;
  private onSlashCommands?: (correlationId: string, workingDirectory?: string) => void;
  private onRepoDetect?: (payload: RepoDetectRequestMessage['payload']) => void;
  private onBranchList?: (payload: BranchListRequestMessage['payload']) => void;
  private onGitCheckout?: (payload: GitCheckoutRequestMessage['payload']) => void;
  private onGitCreateBranch?: (payload: GitCreateBranchRequestMessage['payload']) => void;
  private onGitInit?: (payload: GitInitRequestMessage['payload']) => void;
  private onSessionsList?: (
    correlationId: string,
    maxAgeMs?: number,
    providers?: import('../types.js').ExternalAgentProvider[],
    cwd?: string,
  ) => void;
  private onImportSessions?: (
    correlationId: string,
    workingDirectory: string,
    sessions: import('../types.js').ImportSessionsRequestMessage['payload']['sessions'],
  ) => void;
  private onOpenClawBridgeReady?: (bridge: OpenClawBridge) => void;

  constructor(options: WebSocketClientOptions) {
    this.runnerId = options.runnerId;
    this.machineId = options.machineId;
    this.providers = options.providers;
    this.executionStrategies = options.executionStrategies;
    this.version = options.version ?? '0.1.0';
    this.wsToken = options.wsToken;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.onEvent = options.onEvent;
    this.onTaskDispatch = options.onTaskDispatch;
    this.onTaskCancel = options.onTaskCancel;
    this.onTaskSteer = options.onTaskSteer;
    this.onTaskSafetyDecision = options.onTaskSafetyDecision;
    this.onTaskCleanup = options.onTaskCleanup;
    this.onProjectCleanup = options.onProjectCleanup;
    this.onFileList = options.onFileList;
    this.onFileContent = options.onFileContent;
    this.onFileUpload = options.onFileUpload;
    this.onFileUploadChunk = options.onFileUploadChunk;
    this.onDirectoryList = options.onDirectoryList;
    this.onCreateDirectory = options.onCreateDirectory;
    this.onContentSearch = options.onContentSearch;
    this.onRepoSetup = options.onRepoSetup;
    this.onSlashCommands = options.onSlashCommands;
    this.onRepoDetect = options.onRepoDetect;
    this.onBranchList = options.onBranchList;
    this.onGitCheckout = options.onGitCheckout;
    this.onGitCreateBranch = options.onGitCreateBranch;
    this.onGitInit = options.onGitInit;
    this.onSessionsList = options.onSessionsList;
    this.onImportSessions = options.onImportSessions;
    this.onOpenClawBridgeReady = options.onOpenClawBridgeReady;
  }

  /**
   * Check if access token is expired or expiring soon
   */
  private isTokenExpiring(token: string, bufferSeconds: number = 5 * 60): boolean {
    try {
      const decoded = jwt.decode(token) as { exp?: number };
      if (!decoded || !decoded.exp) {
        return true; // Assume expired if we can't decode
      }

      const now = Math.floor(Date.now() / 1000);
      return decoded.exp < now + bufferSeconds;
    } catch {
      return true; // Assume expired on error
    }
  }

  /**
   * Refresh the access token and WebSocket token using the refresh token
   */
  private async refreshAccessToken(): Promise<string> {
    const refreshToken = configManager.getRefreshToken();
    if (!refreshToken) {
      throw new Error('No refresh token available. Please run setup again to re-authenticate.');
    }

    const apiUrl = configManager.getApiUrl();
    const response = await fetch(`${apiUrl}/api/device/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken,
        grantType: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: `HTTP ${response.status} ${response.statusText}` })) as { error?: string };
      throw new Error(`Token refresh failed (${response.status}): ${error.error || response.statusText}`);
    }

    const data = await response.json() as { accessToken: string; refreshToken?: string; wsToken?: string };

    // Update stored tokens
    configManager.setAccessToken(data.accessToken);
    if (data.refreshToken) {
      configManager.setRefreshToken(data.refreshToken);
    }
    if (data.wsToken) {
      configManager.setWsToken(data.wsToken);
    }

    // Return wsToken for WebSocket connections (signed with RELAY_JWT_SECRET)
    // Falls back to accessToken if server didn't return a wsToken
    return data.wsToken || data.accessToken;
  }

  /**
   * Ensure we have a valid WebSocket token before connecting.
   * Returns null in dev mode when no token is configured (allows unauthenticated connections).
   */
  private async ensureValidToken(): Promise<string | null> {
    let token = this.wsToken || configManager.getWsToken();

    // In dev mode (non-wss relay), skip auth entirely
    if (this.config.relayUrl.startsWith('ws://')) {
      if (!token) {
        return null;
      }
      // Even with a stale token, dev mode doesn't need auth
      if (this.isTokenExpiring(token)) {
        return null;
      }
    }

    if (!token) {
      throw new Error('No access token configured. Please run setup to authenticate.');
    }

    // Check if token is expired or expiring soon
    if (this.isTokenExpiring(token)) {
      console.log('[ws-client] Access token expired or expiring soon, refreshing...');
      try {
        token = await this.refreshAccessToken();
        this.wsToken = token; // Update instance token
        console.log('[ws-client] ✅ Access token refreshed successfully');
      } catch (error) {
        console.error('[ws-client] ❌ Failed to refresh token:', error instanceof Error ? error.message : String(error));
        throw new Error(`Authentication failed: ${error instanceof Error ? error.message : 'Token refresh failed'}. Please run setup again.`);
      }
    }

    return token;
  }

  /**
   * Schedule a proactive token refresh before the current token expires.
   * Refreshes at 80% of the token's lifetime so we never hit expiry while connected.
   */
  private scheduleTokenRefresh(): void {
    this.cancelTokenRefresh();

    const token = this.wsToken || configManager.getWsToken();
    if (!token) return; // Dev mode, no token needed

    try {
      const decoded = jwt.decode(token) as { exp?: number } | null;
      if (!decoded?.exp) return;

      const now = Math.floor(Date.now() / 1000);
      const expiresInSec = decoded.exp - now;
      if (expiresInSec <= 0) return; // Already expired

      // Refresh at 80% of lifetime (e.g., 48 min for a 60-min token), minimum 60s
      const refreshInMs = Math.max(expiresInSec * 0.8, 60) * 1000;

      console.log(`[ws-client] Token refresh scheduled in ${Math.round(refreshInMs / 1000 / 60)}min`);

      this.tokenRefreshTimeout = setTimeout(async () => {
        try {
          console.log('[ws-client] Proactively refreshing token before expiry...');
          const newToken = await this.refreshAccessToken();
          this.wsToken = newToken;
          console.log('[ws-client] ✅ Token refreshed (connection stays open, new token used on next reconnect)');
          // Re-schedule for the next refresh cycle
          this.scheduleTokenRefresh();
        } catch (error) {
          console.error('[ws-client] ❌ Proactive token refresh failed:', error instanceof Error ? error.message : String(error));
          // Retry in 5 minutes
          this.tokenRefreshTimeout = setTimeout(() => this.scheduleTokenRefresh(), 5 * 60 * 1000);
        }
      }, refreshInMs);
    } catch {
      // Can't decode token, skip scheduling
    }
  }

  private cancelTokenRefresh(): void {
    if (this.tokenRefreshTimeout) {
      clearTimeout(this.tokenRefreshTimeout);
      this.tokenRefreshTimeout = null;
    }
  }

  /**
   * Connect to the relay server
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    // Ensure we have a valid token before connecting (null = dev mode, no auth)
    let token: string | null;
    try {
      token = await this.ensureValidToken();
    } catch (error) {
      this.isConnecting = false;
      throw error;
    }

    return new Promise((resolve, reject) => {
      try {
        const headers: Record<string, string> = {
          'X-Runner-Id': this.runnerId,
          'X-Machine-Id': this.machineId,
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        this.ws = new WebSocket(this.config.relayUrl, { headers });

        this.ws.on('open', async () => {
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          await this.handleOpen();
          resolve();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data);
        });

        const thisSocket = this.ws;
        this.ws.on('close', (code, reason) => {
          // Only handle close if this is still the active socket.
          // When the server closes a stale connection after re-registration,
          // the old socket's close handler fires — ignore it to prevent a reconnect loop.
          if (this.ws !== thisSocket) {
            return;
          }
          this.handleClose(code, reason.toString());
        });

        this.ws.on('error', (error) => {
          this.isConnecting = false;
          if (this.reconnectAttempts === 0) {
            reject(error);
          }
          this.emitEvent({ type: 'error', error: error as Error });
        });

        this.ws.on('pong', () => {
          // Server responded to ping, connection is alive
          if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
          }
        });
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the relay server
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.cleanup();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
  }

  /**
   * Send a task status update
   */
  sendTaskStatus(
    taskId: string,
    status: TaskStatusMessage['payload']['status'],
    progress?: number,
    message?: string
  ): void {
    const msg: TaskStatusMessage = {
      type: 'task_status',
      timestamp: new Date().toISOString(),
      payload: { taskId, status, progress, message },
    };
    this.send(msg);
  }

  /**
   * Send task output (stdout/stderr)
   */
  sendTaskOutput(taskId: string, stream: 'stdout' | 'stderr', data: string, sequence: number): void {
    const msg: TaskOutputMessage = {
      type: 'task_output',
      timestamp: new Date().toISOString(),
      payload: { taskId, stream, data, sequence },
    };
    this.send(msg);
  }

  /**
   * Send task result
   */
  sendTaskResult(result: TaskResult): void {
    const msg: TaskResultMessage = {
      type: 'task_result',
      timestamp: new Date().toISOString(),
      payload: result,
    };
    this.send(msg);

    // Do NOT remove from activeTasks here — keep the task in the heartbeat
    // so the server's dead job checker doesn't flag it as dead before the
    // result message is delivered. The task-executor's finally block calls
    // removeActiveTask() after cleanup, which is the authoritative removal.
  }

  /**
   * Send tool trace
   */
  sendToolTrace(taskId: string, toolName: string, toolInput?: unknown, toolResult?: unknown, success?: boolean): void {
    const msg: TaskToolTraceMessage = {
      type: 'task_tool_trace',
      timestamp: new Date().toISOString(),
      payload: { taskId, toolName, toolInput, toolResult, success },
    };
    this.send(msg);
  }

  /**
   * Send structured text (bypasses stdout throttle on relay).
   *
   * IMPORTANT: This method must NOT reset any agent-side timeouts (idle timeout,
   * hard cap, etc.). The task-level heartbeat in task-executor.ts calls this
   * directly to keep the server's activity timer alive without resetting the
   * agent-side idle timeout. If this method ever gains timeout-reset behavior,
   * hung agents will run until hard cap instead of idle-timing out.
   */
  sendTaskText(taskId: string, text: string, sequence: number): void {
    const msg: TaskTextMessage = {
      type: 'task_text',
      timestamp: new Date().toISOString(),
      payload: { taskId, text, sequence },
    };
    this.send(msg);
  }

  /**
   * Send a structured operational status line.
   */
  sendTaskOperational(taskId: string, message: string, source: 'astro' | 'git' | 'delivery'): void {
    const msg: TaskOperationalMessage = {
      type: 'task_operational',
      timestamp: new Date().toISOString(),
      payload: { taskId, message, source },
    };
    this.send(msg);
  }

  /**
   * Send structured tool use event
   */
  sendTaskToolUse(taskId: string, toolName: string, toolInput: unknown, toolUseId?: string): void {
    const msg: TaskToolUseMessage = {
      type: 'task_tool_use',
      timestamp: new Date().toISOString(),
      payload: { taskId, toolName, toolInput, ...(toolUseId ? { toolUseId } : {}) },
    };
    this.send(msg);
  }

  /**
   * Send structured tool result event
   */
  sendTaskToolResult(taskId: string, toolName: string, result: unknown, success: boolean, toolUseId?: string): void {
    const msg: TaskToolResultWSMessage = {
      type: 'task_tool_result',
      timestamp: new Date().toISOString(),
      payload: { taskId, toolName, result, success, ...(toolUseId ? { toolUseId } : {}) },
    };
    this.send(msg);
  }

  /**
   * Send structured file change event
   */
  sendTaskFileChange(taskId: string, path: string, action: 'created' | 'modified' | 'deleted', linesAdded?: number, linesRemoved?: number, diff?: string): void {
    const msg: TaskFileChangeMessage = {
      type: 'task_file_change',
      timestamp: new Date().toISOString(),
      payload: { taskId, path, action, linesAdded, linesRemoved, diff },
    };
    this.send(msg);
  }

  /**
   * Send structured session init event
   */
  sendTaskSessionInit(taskId: string, sessionId: string, model?: string): void {
    const msg: TaskSessionInitMessage = {
      type: 'task_session_init',
      timestamp: new Date().toISOString(),
      payload: { taskId, sessionId, model },
    };
    this.send(msg);
  }

  /**
   * Send steer acknowledgment
   */
  sendSteerAck(taskId: string, accepted: boolean, message?: string, interrupted?: boolean): void {
    const msg: TaskSteerAckWSMessage = {
      type: 'task_steer_ack',
      timestamp: new Date().toISOString(),
      payload: { taskId, accepted, message },
    };
    if (interrupted) {
      (msg.payload as Record<string, unknown>).interrupted = true;
    }
    this.send(msg);
  }

  /**
   * Send approval request and wait for response
   * Returns a promise that resolves when the user responds (no timeout)
   */
  sendApprovalRequest(taskId: string, question: string, options: string[]): Promise<{ answered: boolean; answer?: string; message?: string }> {
    const requestId = `${taskId}-${Date.now()}`;

    return new Promise((resolve, reject) => {
      // Store the promise handlers
      this.pendingApprovals.set(requestId, { resolve, reject });

      // Send the approval request message
      const msg: TaskApprovalRequestMessage = {
        type: 'task_approval_request',
        timestamp: new Date().toISOString(),
        payload: { taskId, requestId, question, options },
      };
      this.send(msg);

      console.log(`[ws-client] Sent approval request ${requestId} for task ${taskId}`);
    });
  }

  /**
   * Send safety prompt to user
   */
  sendSafetyPrompt(
    taskId: string,
    safetyTier: 'safe' | 'guarded' | 'risky' | 'unsafe',
    warning: string | undefined,
    options: Array<{ id: string; label: string; description?: string }>,
  ): void {
    const msg = {
      type: 'task_safety_prompt' as const,
      timestamp: new Date().toISOString(),
      payload: {
        taskId,
        safetyTier,
        warning,
        blockReason: undefined,
        options,
      },
    };
    this.send(msg);
    console.log(`[ws-client] Sent safety prompt for task ${taskId} (tier: ${safetyTier})`);
  }

  /**
   * Send resource update
   */
  async sendResourceUpdate(): Promise<void> {
    const resources = await getMachineResources();
    const msg: ResourceUpdateMessage = {
      type: 'resource_update',
      timestamp: new Date().toISOString(),
      payload: { runnerId: this.runnerId, resources },
    };
    this.send(msg);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get current configuration
   */
  getConfig(): RunnerConfig {
    return { ...this.config };
  }

  /**
   * Get active task count
   */
  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  /**
   * Add task to active set
   */
  addActiveTask(taskId: string): void {
    this.activeTasks.add(taskId);
  }

  /**
   * Remove task from active set
   */
  removeActiveTask(taskId: string): void {
    this.activeTasks.delete(taskId);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async handleOpen(): Promise<void> {
    // Send registration message
    const resources = await getMachineResources();
    // Allow config to override the display name (e.g., SSH alias like "nebius-2")
    const machineName = configManager.getMachineName();
    const registerMsg: RegisterMessage = {
      type: 'register',
      timestamp: new Date().toISOString(),
      payload: {
        runnerId: this.runnerId,
        machineId: this.machineId,
        ...(machineName ? { name: machineName } : {}),
        providers: this.providers,
        executionStrategies: this.executionStrategies,
        resources,
        version: this.version,
      },
    };
    this.send(registerMsg);

    // Drain any messages buffered while disconnected
    this.drainPendingMessages();

    // Start heartbeat
    this.startHeartbeat();

    // Schedule proactive token refresh before expiry
    this.scheduleTokenRefresh();

    this.emitEvent({ type: 'connected' });
  }

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const raw = JSON.parse(data.toString()) as { type: string; [key: string]: unknown };

      // Handle task.steer (dot notation from relay) by normalizing to task_steer
      if (raw.type === 'task.steer') {
        // Relay sends: { type: 'task.steer', taskId, message, action, interrupt, sessionId, branchName }
        // Normalize to agent-runner format: { type: 'task_steer', payload: { ... } }
        const steerMsg: TaskSteerIncomingMessage = {
          type: 'task_steer',
          timestamp: raw.timestamp as string ?? new Date().toISOString(),
          payload: {
            taskId: raw.taskId as string,
            message: raw.message as string,
            action: raw.action as string | undefined,
            interrupt: raw.interrupt as boolean | undefined,
            sessionId: raw.sessionId as string | undefined,
            branchName: raw.branchName as string | undefined,
          },
        };
        this.handleTaskSteer(steerMsg);
        return;
      }

      // Handle file_list.request (dot notation from relay)
      if (raw.type === 'file_list.request') {
        const fileListMsg: FileListRequestMessage = {
          type: 'file_list_request',
          timestamp: raw.timestamp as string ?? new Date().toISOString(),
          payload: {
            path: raw.path as string,
            correlationId: raw.correlationId as string,
          },
        };
        this.handleFileListRequest(fileListMsg);
        return;
      }

      // Handle directory_list.request (dot notation from relay)
      if (raw.type === 'directory_list.request') {
        const dirListMsg: DirectoryListRequestMessage = {
          type: 'directory_list_request',
          timestamp: raw.timestamp as string ?? new Date().toISOString(),
          payload: {
            path: raw.path as string ?? (raw.payload as { path?: string })?.path ?? '~',
            correlationId: raw.correlationId as string ?? (raw.payload as { correlationId?: string })?.correlationId ?? '',
          },
        };
        this.handleDirectoryListRequest(dirListMsg);
        return;
      }

      // Handle create_directory.request (dot notation from relay)
      if (raw.type === 'create_directory.request') {
        const createDirMsg: CreateDirectoryRequestMessage = {
          type: 'create_directory_request',
          timestamp: raw.timestamp as string ?? new Date().toISOString(),
          payload: {
            parentPath: raw.parentPath as string ?? (raw.payload as { parentPath?: string })?.parentPath ?? '',
            name: raw.name as string ?? (raw.payload as { name?: string })?.name ?? '',
            correlationId: raw.correlationId as string ?? (raw.payload as { correlationId?: string })?.correlationId ?? '',
          },
        };
        this.handleCreateDirectoryRequest(createDirMsg);
        return;
      }

      // Handle slash_commands.request (dot notation from relay)
      if (raw.type === 'slash_commands.request') {
        const slashMsg: SlashCommandsRequestMessage = {
          type: 'slash_commands_request',
          timestamp: raw.timestamp as string ?? new Date().toISOString(),
          payload: {
            correlationId: raw.correlationId as string,
            workingDirectory: raw.workingDirectory as string | undefined,
          },
        };
        this.handleSlashCommandsRequest(slashMsg);
        return;
      }

      // Handle repo_setup.request (dot notation from relay)
      if (raw.type === 'repo_setup.request') {
        const repoMsg: RepoSetupRequestMessage = {
          type: 'repo_setup_request',
          timestamp: raw.timestamp as string ?? new Date().toISOString(),
          payload: raw.payload as RepoSetupRequestMessage['payload'],
        };
        this.handleRepoSetupRequest(repoMsg);
        return;
      }

      // Handle repo_detect.request (dot notation from relay)
      if (raw.type === 'repo_detect.request') {
        const detectMsg: RepoDetectRequestMessage = {
          type: 'repo_detect_request',
          timestamp: raw.timestamp as string ?? new Date().toISOString(),
          payload: raw.payload as RepoDetectRequestMessage['payload'],
        };
        this.handleRepoDetectRequest(detectMsg);
        return;
      }

      // Handle branch_list.request (dot notation from relay)
      if (raw.type === 'branch_list.request') {
        const branchListMsg: BranchListRequestMessage = {
          type: 'branch_list_request',
          timestamp: raw.timestamp as string ?? new Date().toISOString(),
          payload: raw.payload as BranchListRequestMessage['payload'],
        };
        this.handleBranchListRequest(branchListMsg);
        return;
      }

      // Handle git_checkout.request (dot notation from relay)
      if (raw.type === 'git_checkout.request') {
        const msg: GitCheckoutRequestMessage = {
          type: 'git_checkout_request',
          timestamp: raw.timestamp as string ?? new Date().toISOString(),
          payload: raw.payload as GitCheckoutRequestMessage['payload'],
        };
        this.handleGitCheckoutRequest(msg);
        return;
      }

      // Handle git_create_branch.request (dot notation from relay)
      if (raw.type === 'git_create_branch.request') {
        const msg: GitCreateBranchRequestMessage = {
          type: 'git_create_branch_request',
          timestamp: raw.timestamp as string ?? new Date().toISOString(),
          payload: raw.payload as GitCreateBranchRequestMessage['payload'],
        };
        this.handleGitCreateBranchRequest(msg);
        return;
      }

      // Handle git_init.request (dot notation from relay)
      if (raw.type === 'git_init.request') {
        const gitInitMsg: GitInitRequestMessage = {
          type: 'git_init_request',
          timestamp: raw.timestamp as string ?? new Date().toISOString(),
          payload: raw.payload as GitInitRequestMessage['payload'],
        };
        this.handleGitInitRequest(gitInitMsg);
        return;
      }

      // Handle content_search.request (dot notation from relay)
      if (raw.type === 'content_search.request') {
        const searchMsg: ContentSearchRequestMessage = {
          type: 'content_search_request',
          timestamp: raw.timestamp as string ?? new Date().toISOString(),
          payload: raw.payload as ContentSearchRequestMessage['payload'],
        };
        this.handleContentSearchRequest(searchMsg);
        return;
      }

      // Handle channel.* (dot notation from relay) — normalize to underscore
      if (typeof raw.type === 'string' && raw.type.startsWith('channel.')) {
        const normalized = {
          ...raw,
          type: raw.type.replaceAll('.', '_'),
        } as unknown as IncomingMessage;
        this.routeMessage(normalized);
        return;
      }

      const message = raw as unknown as IncomingMessage;
      this.routeMessage(message);
    } catch (error) {
      this.emitEvent({ type: 'error', error: error as Error });
    }
  }

  private routeMessage(message: IncomingMessage): void {
    switch (message.type) {
      case 'registered':
        this.handleRegistered(message);
        break;
      case 'heartbeat_ack':
        // Heartbeat acknowledged, nothing to do
        break;
      case 'task_dispatch':
        this.handleTaskDispatch(message);
        break;
      case 'task_cancel':
        this.handleTaskCancel(message);
        break;
      case 'task_cleanup':
        this.handleTaskCleanup(message);
        break;
      case 'project_cleanup':
        this.handleProjectCleanup(message as ProjectCleanupMessage);
        break;
      case 'task_steer':
        this.handleTaskSteer(message as unknown as TaskSteerIncomingMessage);
        break;
      case 'task_approval_response':
        this.handleApprovalResponse(message as TaskApprovalResponseMessage);
        break;
      case 'task_safety_decision':
        this.handleSafetyDecision(message as unknown as { type: 'task_safety_decision'; timestamp: string; payload: { taskId: string; decision: 'proceed' | 'init-git' | 'sandbox' | 'cancel' } });
        break;
      case 'config_update':
        this.handleConfigUpdate(message);
        break;
      case 'file_list_request':
        this.handleFileListRequest(message as FileListRequestMessage);
        break;
      case 'file_content_request':
        this.handleFileContentRequest(message as FileContentRequestMessage);
        break;
      case 'file_upload_request':
        this.handleFileUploadRequest(message as FileUploadRequestMessage);
        break;
      case 'file_upload_chunk':
        this.handleFileUploadChunk(message as FileUploadChunkMessage);
        break;
      case 'directory_list_request':
        this.handleDirectoryListRequest(message as DirectoryListRequestMessage);
        break;
      case 'create_directory_request':
        this.handleCreateDirectoryRequest(message as CreateDirectoryRequestMessage);
        break;
      case 'content_search_request':
        this.handleContentSearchRequest(message as ContentSearchRequestMessage);
        break;
      case 'repo_setup_request':
        this.handleRepoSetupRequest(message as RepoSetupRequestMessage);
        break;
      case 'slash_commands_request':
        this.handleSlashCommandsRequest(message as SlashCommandsRequestMessage);
        break;
      case 'repo_detect_request':
        this.handleRepoDetectRequest(message as RepoDetectRequestMessage);
        break;
      case 'branch_list_request':
        this.handleBranchListRequest(message as BranchListRequestMessage);
        break;
      case 'git_checkout_request':
        this.handleGitCheckoutRequest(message as GitCheckoutRequestMessage);
        break;
      case 'git_create_branch_request':
        this.handleGitCreateBranchRequest(message as GitCreateBranchRequestMessage);
        break;
      case 'git_init_request':
        this.handleGitInitRequest(message as GitInitRequestMessage);
        break;
      case 'sessions_list_request':
        this.handleSessionsListRequest(message as import('../types.js').SessionsListRequestMessage);
        break;
      case 'import_sessions_request':
        this.handleImportSessionsRequest(message as import('../types.js').ImportSessionsRequestMessage);
        break;
      case 'channel_notification':
        this.handleChannelNotification(message as ChannelNotificationMessage);
        break;
      case 'channel_response':
        this.handleChannelResponse(message as ChannelResponseMessage);
        break;
      case 'channel_approval_request':
        this.handleChannelApprovalRequest(message as ChannelApprovalRequestMessage);
        break;
      case 'error':
        this.handleError(message);
        break;
    }
  }

  private handleRegistered(message: RegisteredMessage): void {
    // Apply server-provided configuration
    if (message.payload.config) {
      this.config = { ...this.config, ...message.payload.config };
    }

    // Start the OpenClaw bridge if this machine has the openclaw provider
    if (this.providers.some(p => p.type === 'openclaw' && p.available)) {
      this.startOpenClawBridge();
    }
  }

  // ─── OpenClaw Bridge (channel relay) ────────────────────────────

  private startOpenClawBridge(): void {
    if (this.openclawBridge) return;

    const bridge = new OpenClawBridge();
    this.openclawBridge = bridge; // Assign immediately to prevent double-start on rapid reconnect
    bridge.start().then((connected) => {
      if (!connected) {
        // Only null out if this is still our bridge (not replaced by a newer attempt)
        if (this.openclawBridge === bridge) {
          bridge.stop();
          this.openclawBridge = null;
        }
        return;
      }
      console.log('[ws-client] OpenClaw bridge started for channel relay');

      // Notify task executor so it can wire the bridge to the adapter
      if (this.onOpenClawBridgeReady) {
        this.onOpenClawBridgeReady(bridge);
      }

      // Forward inbound messages from OpenClaw to the server
      bridge.on('inbound', (payload: Record<string, unknown>) => {
        this.send({
          type: 'channel_inbound',
          timestamp: new Date().toISOString(),
          payload: {
            sourceMessageId: (payload.messageId as string) ?? String(Date.now()),
            text: (payload.text as string) ?? '',
            senderId: (payload.senderId as string) ?? 'unknown',
            senderName: (payload.senderName as string) ?? 'unknown',
            channelId: (payload.channelId as string) ?? '',
            threadId: payload.threadId as string | undefined,
            metadata: payload.metadata as Record<string, unknown> | undefined,
          },
        });
      });
    }).catch((err) => {
      if (this.openclawBridge === bridge) {
        bridge.stop();
        this.openclawBridge = null;
      }
      console.warn('[ws-client] Failed to start OpenClaw bridge:', err);
    });
  }

  private async handleChannelNotification(message: ChannelNotificationMessage): Promise<void> {
    const { correlationId, notification } = message.payload;

    if (!this.openclawBridge?.isConnected) {
      this.send({
        type: 'channel_notification_ack',
        timestamp: new Date().toISOString(),
        payload: { correlationId, success: false, error: 'OpenClaw bridge not connected' },
      });
      return;
    }

    try {
      await this.openclawBridge.sendNotification(notification);
      this.send({
        type: 'channel_notification_ack',
        timestamp: new Date().toISOString(),
        payload: { correlationId, success: true },
      });
    } catch (err) {
      this.send({
        type: 'channel_notification_ack',
        timestamp: new Date().toISOString(),
        payload: {
          correlationId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private async handleChannelResponse(message: ChannelResponseMessage): Promise<void> {
    const { correlationId, response } = message.payload;

    if (!this.openclawBridge?.isConnected) {
      this.send({
        type: 'channel_response_ack',
        timestamp: new Date().toISOString(),
        payload: { correlationId, success: false, error: 'OpenClaw bridge not connected' },
      });
      return;
    }

    try {
      await this.openclawBridge.sendResponse(response);
      this.send({
        type: 'channel_response_ack',
        timestamp: new Date().toISOString(),
        payload: { correlationId, success: true },
      });
    } catch (err) {
      this.send({
        type: 'channel_response_ack',
        timestamp: new Date().toISOString(),
        payload: {
          correlationId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private async handleChannelApprovalRequest(message: ChannelApprovalRequestMessage): Promise<void> {
    const { correlationId, approvalId, projectId, taskId, question, options, to } = message.payload;

    if (!this.openclawBridge?.isConnected) {
      console.warn(`[ws-client] Channel approval ${approvalId} skipped: OpenClaw bridge not connected`);
      this.send({
        type: 'channel_approval_response',
        timestamp: new Date().toISOString(),
        payload: { correlationId, approvalId, response: '', error: 'OpenClaw bridge not connected' },
      });
      return;
    }

    try {
      const response = await this.openclawBridge.requestApproval({
        approvalId, projectId, taskId, question, options, to,
      });
      this.send({
        type: 'channel_approval_response',
        timestamp: new Date().toISOString(),
        payload: { correlationId, approvalId, response },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[ws-client] Channel approval ${approvalId} failed:`, errorMsg);
      this.send({
        type: 'channel_approval_response',
        timestamp: new Date().toISOString(),
        payload: { correlationId, approvalId, response: '', error: errorMsg },
      });
    }
  }

  private async handleTaskDispatch(message: TaskDispatchMessage): Promise<void> {
    const task = message.payload;

    // Verify dispatch signature if present
    const publicKeys = mergeDispatchPublicKeys(
      configManager.getDispatchPublicKeys(),
      task.dispatchTrustedKeys,
    );
    const requireSigned = configManager.getRequireSignedDispatches();

    if (task.dispatchSignature && task.dispatchSigningPayload) {
      if (publicKeys.length > 0) {
        const { verifyDispatch } = await import('./dispatch-verifier.js');
        const result = await verifyDispatch(
          publicKeys,
          task.dispatchSignature,
          task.dispatchSigningPayload,
          task,
          configManager.getMachineId(),
        );
        if (!result.valid) {
          console.error(`[ws-client] Dispatch signature verification FAILED: ${result.reason}`);
          this.sendTaskResult({
            taskId: task.id,
            status: 'failed',
            error: `Dispatch signature verification failed: ${result.reason}`,
          });
          return;
        }
        console.log(`[ws-client] Dispatch signature verified for task ${task.id}`);
      }
    } else if (requireSigned) {
      console.error(`[ws-client] Unsigned dispatch rejected (requireSignedDispatches=true)`);
      this.sendTaskResult({
        taskId: task.id,
        status: 'failed',
        error: 'Unsigned dispatch rejected. This agent requires signed dispatches.',
      });
      return;
    }

    this.activeTasks.add(task.id);
    // ACK the dispatch so the relay server knows we received it.
    // Without this, lost WS messages only surface after 5+ min dead job detection.
    this.send({
      type: 'task_dispatch_ack',
      timestamp: new Date().toISOString(),
      payload: { taskId: task.id },
    });
    this.emitEvent({ type: 'task_received', task });
    this.onTaskDispatch?.(task);
  }

  private handleTaskCancel(message: TaskCancelMessage): void {
    const { taskId } = message.payload;
    this.activeTasks.delete(taskId);
    this.emitEvent({ type: 'task_cancelled', taskId });
    this.onTaskCancel?.(taskId);
  }

  private handleTaskCleanup(message: { type: 'task_cleanup'; timestamp: string; payload: { taskId: string; branchName?: string } }): void {
    const { taskId, branchName } = message.payload;
    console.log(`[ws-client] Received cleanup request for task ${taskId}${branchName ? ` branch=${branchName}` : ''}`);
    this.onTaskCleanup?.(taskId, branchName);
  }

  private handleProjectCleanup(message: ProjectCleanupMessage): void {
    const { projectId } = message.payload;
    console.log(`[ws-client] Received project cleanup request for project ${projectId}`);
    this.onProjectCleanup?.(projectId);
  }

  private handleTaskSteer(message: TaskSteerIncomingMessage): void {
    const { taskId, message: steerMessage, action, interrupt, sessionId, branchName } = message.payload;
    this.onTaskSteer?.(taskId, steerMessage, action, interrupt, sessionId, branchName);
  }

  private handleSafetyDecision(message: { type: 'task_safety_decision'; timestamp: string; payload: { taskId: string; decision: 'proceed' | 'init-git' | 'sandbox' | 'cancel' } }): void {
    const { taskId, decision } = message.payload;
    console.log(`[ws-client] Received safety decision for ${taskId}: ${decision}`);
    this.onTaskSafetyDecision?.(taskId, decision);
  }

  private handleApprovalResponse(message: TaskApprovalResponseMessage): void {
    const { requestId, answered, answer, message: responseMessage } = message.payload;
    const pending = this.pendingApprovals.get(requestId);

    if (pending) {
      console.log(`[ws-client] Received approval response for ${requestId}: answered=${answered}, answer=${answer}`);
      this.pendingApprovals.delete(requestId);
      pending.resolve({ answered, answer, message: responseMessage });
    } else {
      console.warn(`[ws-client] Received approval response for unknown request ${requestId}`);
    }
  }

  private handleConfigUpdate(message: ConfigUpdateMessage): void {
    this.config = { ...this.config, ...message.payload };

    // Restart heartbeat with new interval if changed
    if (message.payload.heartbeatInterval) {
      this.stopHeartbeat();
      this.startHeartbeat();
    }
  }

  private handleError(message: ErrorMessage): void {
    const code = message.payload?.code ?? 'UNKNOWN';
    const msg = message.payload?.message ?? 'Unknown error';
    const error = new Error(`${code}: ${msg}`);
    this.emitEvent({ type: 'error', error });
  }

  private handleFileListRequest(message: FileListRequestMessage): void {
    const { path, correlationId } = message.payload;
    this.onFileList?.(path, correlationId);
  }

  /**
   * Send file list response
   */
  sendFileListResponse(correlationId: string, files: string[]): void {
    const msg: FileListResponseMessage = {
      type: 'file_list_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, files },
    };
    this.send(msg);
  }

  private handleFileContentRequest(message: FileContentRequestMessage): void {
    const { path, correlationId } = message.payload;
    this.onFileContent?.(path, correlationId);
  }

  /**
   * Send file content response
   */
  sendFileContentResponse(
    correlationId: string,
    path: string,
    content?: string,
    encoding?: 'utf-8' | 'base64',
    mimeType?: string,
    size?: number,
    error?: string,
    chunked?: boolean,
    chunkIndex?: number,
    totalChunks?: number,
  ): void {
    const msg: FileContentResponseMessage = {
      type: 'file_content_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, path, content, encoding, mimeType, size, error, chunked, chunkIndex, totalChunks },
    };
    this.send(msg);
  }

  private handleFileUploadRequest(message: FileUploadRequestMessage): void {
    const { destinationPath, fileName, size, totalChunks, overwrite, correlationId } = message.payload;
    this.onFileUpload?.(destinationPath, fileName, size, totalChunks, overwrite, correlationId);
  }

  private handleFileUploadChunk(message: FileUploadChunkMessage): void {
    const { correlationId, chunkIndex, encoding, content } = message.payload;
    this.onFileUploadChunk?.(correlationId, chunkIndex, encoding, content);
  }

  /**
   * Send file upload response
   */
  sendFileUploadResponse(correlationId: string, success: boolean, path?: string, error?: string): void {
    const msg: FileUploadResponseMessage = {
      type: 'file_upload_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, success, path, error },
    };
    this.send(msg);
  }

  private handleDirectoryListRequest(message: DirectoryListRequestMessage): void {
    const { path, correlationId } = message.payload;
    this.onDirectoryList?.(path, correlationId);
  }

  /**
   * Send directory list response
   */
  sendDirectoryListResponse(
    correlationId: string,
    path: string,
    entries: DirectoryListResponseMessage['payload']['entries'],
    error?: string,
    homeDirectory?: string,
  ): void {
    const msg: DirectoryListResponseMessage = {
      type: 'directory_list_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, path, entries, error, homeDirectory },
    };
    this.send(msg);
  }

  private handleCreateDirectoryRequest(message: CreateDirectoryRequestMessage): void {
    const { parentPath, name, correlationId } = message.payload;
    this.onCreateDirectory?.(parentPath, name, correlationId);
  }

  private handleContentSearchRequest(message: ContentSearchRequestMessage): void {
    const { root, pattern, correlationId, caseSensitive, maxMatchesPerFile, limit } = message.payload;
    this.onContentSearch?.(root, pattern, correlationId, { caseSensitive, maxMatchesPerFile, limit });
  }

  sendContentSearchResponse(correlationId: string, matches: ContentSearchMatch[], error?: string): void {
    const msg: ContentSearchResponseMessage = {
      type: 'content_search_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, matches, error },
    };
    this.send(msg);
  }

  /**
   * Send create directory response
   */
  sendCreateDirectoryResponse(
    correlationId: string,
    success: boolean,
    path?: string,
    error?: string,
  ): void {
    const msg: CreateDirectoryResponseMessage = {
      type: 'create_directory_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, success, path, error },
    };
    this.send(msg);
  }

  private handleRepoSetupRequest(message: RepoSetupRequestMessage): void {
    this.onRepoSetup?.(message.payload);
  }

  private handleSlashCommandsRequest(message: SlashCommandsRequestMessage): void {
    const { correlationId, workingDirectory } = message.payload;
    this.onSlashCommands?.(correlationId, workingDirectory);
  }

  /**
   * Send slash commands response
   */
  sendSlashCommandsResponse(correlationId: string, commands: Array<{ name: string; description: string }>): void {
    const msg: SlashCommandsResponseMessage = {
      type: 'slash_commands_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, commands },
    };
    this.send(msg);
  }

  /**
   * Send repo setup response
   */
  sendRepoSetupResponse(
    correlationId: string,
    result: Omit<RepoSetupResponseMessage['payload'], 'correlationId'>,
  ): void {
    const msg: RepoSetupResponseMessage = {
      type: 'repo_setup_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, ...result },
    };
    this.send(msg);
  }

  private handleRepoDetectRequest(message: RepoDetectRequestMessage): void {
    this.onRepoDetect?.(message.payload);
  }

  /**
   * Send repo detect response
   */
  sendRepoDetectResponse(
    correlationId: string,
    result: Omit<RepoDetectResponseMessage['payload'], 'correlationId'>,
  ): void {
    const msg: RepoDetectResponseMessage = {
      type: 'repo_detect_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, ...result },
    };
    this.send(msg);
  }

  private handleBranchListRequest(message: BranchListRequestMessage): void {
    this.onBranchList?.(message.payload);
  }

  /**
   * Send branch list response
   */
  sendBranchListResponse(
    correlationId: string,
    result: Omit<BranchListResponseMessage['payload'], 'correlationId'>,
  ): void {
    const msg: BranchListResponseMessage = {
      type: 'branch_list_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, ...result },
    };
    this.send(msg);
  }

  private handleGitCheckoutRequest(message: GitCheckoutRequestMessage): void {
    this.onGitCheckout?.(message.payload);
  }

  sendGitCheckoutResponse(
    correlationId: string,
    result: Omit<GitCheckoutResponseMessage['payload'], 'correlationId'>,
  ): void {
    const msg: GitCheckoutResponseMessage = {
      type: 'git_checkout_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, ...result },
    };
    this.send(msg);
  }

  private handleGitCreateBranchRequest(message: GitCreateBranchRequestMessage): void {
    this.onGitCreateBranch?.(message.payload);
  }

  sendGitCreateBranchResponse(
    correlationId: string,
    result: Omit<GitCreateBranchResponseMessage['payload'], 'correlationId'>,
  ): void {
    const msg: GitCreateBranchResponseMessage = {
      type: 'git_create_branch_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, ...result },
    };
    this.send(msg);
  }

  private handleGitInitRequest(message: GitInitRequestMessage): void {
    this.onGitInit?.(message.payload);
  }

  /**
   * Send git init response
   */
  sendGitInitResponse(
    correlationId: string,
    result: Omit<GitInitResponseMessage['payload'], 'correlationId'>,
  ): void {
    const msg: GitInitResponseMessage = {
      type: 'git_init_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, ...result },
    };
    this.send(msg);
  }

  private handleSessionsListRequest(message: import('../types.js').SessionsListRequestMessage): void {
    this.onSessionsList?.(
      message.payload.correlationId,
      message.payload.maxAgeMs,
      message.payload.providers,
      message.payload.cwd,
    );
  }

  /**
   * Send sessions list response
   */
  sendSessionsListResponse(
    correlationId: string,
    sessions: import('../types.js').ClaudeCodeSessionInfo[],
    error?: string,
  ): void {
    const msg: import('../types.js').SessionsListResponseMessage = {
      type: 'sessions_list_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, sessions, error },
    };
    this.send(msg);
  }

  private handleImportSessionsRequest(
    message: import('../types.js').ImportSessionsRequestMessage,
  ): void {
    this.onImportSessions?.(
      message.payload.correlationId,
      message.payload.workingDirectory,
      message.payload.sessions,
    );
  }

  /**
   * Send import sessions response
   */
  sendImportSessionsResponse(
    correlationId: string,
    result: Omit<import('../types.js').ImportSessionsResponseMessage['payload'], 'correlationId'>,
  ): void {
    const msg: import('../types.js').ImportSessionsResponseMessage = {
      type: 'import_sessions_response',
      timestamp: new Date().toISOString(),
      payload: { correlationId, ...result },
    };
    this.send(msg);
  }

  private handleClose(code: number, reason: string): void {
    this.cleanup();
    this.emitEvent({ type: 'disconnected', reason: `${code}: ${reason}` });

    // Custom close code 4001 means this connection was replaced by another
    // process with the same machineId — do not reconnect.
    if (code === 4001) {
      console.error('[ws-client] Connection replaced by another process with the same machineId. Not reconnecting.');
      this.shouldReconnect = false;
      return;
    }

    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private send(message: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      if (this.pendingMessages.length >= WebSocketClient.MAX_PENDING) {
        this.pendingMessages.shift();
        console.warn('[ws-client] Pending buffer full, dropping oldest message');
      }
      this.pendingMessages.push(message);
      console.log(`[ws-client] Buffered ${message.type} message (${this.pendingMessages.length} pending, WS state: ${this.ws?.readyState ?? 'null'})`);
    }
  }

  private drainPendingMessages(): void {
    if (this.pendingMessages.length === 0) return;
    const count = this.pendingMessages.length;
    console.log(`[ws-client] Draining ${count} buffered messages after reconnect`);
    const messages = this.pendingMessages.splice(0);
    for (const msg of messages) {
      this.send(msg);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Send application-level heartbeat
        const resources = await getMachineResources();
        const heartbeat: HeartbeatMessage = {
          type: 'heartbeat',
          timestamp: new Date().toISOString(),
          payload: {
            runnerId: this.runnerId,
            activeTasks: Array.from(this.activeTasks),
            resources,
          },
        };
        this.send(heartbeat);

        // Also send WebSocket ping for connection health
        this.ws.ping();

        // Expect a pong within 10 seconds; if not, the connection is dead
        if (this.pongTimeout) clearTimeout(this.pongTimeout);
        this.pongTimeout = setTimeout(() => {
          console.warn('[ws-client] Pong timeout — connection appears dead, forcing reconnect');
          this.pongTimeout = null;
          this.ws?.terminate();
        }, 10000);
      }
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    const maxRetries = this.config.reconnectMaxRetries;
    if (maxRetries >= 0 && this.reconnectAttempts >= maxRetries) {
      return;
    }

    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const delay = Math.min(
      this.config.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1) +
        Math.random() * 1000,
      this.config.reconnectMaxDelay
    );

    this.emitEvent({ type: 'reconnecting', attempt: this.reconnectAttempts });

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch(() => {
        // connect() failed before opening a WebSocket (e.g. token refresh error).
        // No 'close' event will fire, so we must schedule the next retry ourselves.
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  private cleanup(): void {
    this.stopHeartbeat();
    this.cancelTokenRefresh();

    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }

    if (this.openclawBridge) {
      this.openclawBridge.stop();
      this.openclawBridge = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private emitEvent(event: RunnerEvent): void {
    this.onEvent?.(event);
  }
}
