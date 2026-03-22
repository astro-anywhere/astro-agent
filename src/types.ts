/**
 * Core types for the Astro Agent Runner CLI
 */

import type { webcrypto } from 'node:crypto';

type JsonWebKey = webcrypto.JsonWebKey;

// ============================================================================
// Provider Types
// ============================================================================

export type ProviderType = 'claude-sdk' | 'codex' | 'openclaw' | 'opencode' | 'pi' | 'slurm' | 'custom';

// Re-export from the canonical source
export type { ExecutionStrategyType, ExecutionStrategyInfo } from './execution/types.js';
import type { ExecutionStrategyType, ExecutionStrategyInfo } from './execution/types.js';

export interface HpcCapability {
  clusterName?: string;
  partitions: string[];
  defaultPartition?: string;
  accounts: string[];
}

export interface ProviderInfo {
  type: ProviderType;
  name: string;
  version: string | null;
  path: string;
  available: boolean;
  capabilities: ProviderCapabilities;
  hpcCapability?: HpcCapability;
}

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  multiTurn: boolean;
  maxConcurrentTasks: number;
  defaultModel?: string;
  availableModels?: string[];
}

// ============================================================================
// Machine Resource Types
// ============================================================================

export interface MachineResources {
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  cpu: CpuInfo;
  memory: MemoryInfo;
  gpu: GpuInfo[];
}

export interface CpuInfo {
  model: string;
  cores: number;
  speed: number; // MHz
  loadAvg: number[]; // 1, 5, 15 minute averages
}

export interface MemoryInfo {
  total: number; // bytes
  free: number; // bytes
  used: number; // bytes
  usedPercent: number;
}

export interface GpuInfo {
  name: string;
  vendor: string;
  memoryTotal: number; // bytes
  memoryFree: number; // bytes
  utilization: number; // percent
}

// ============================================================================
// Image / Multimodal Types
// ============================================================================

/** Base64-encoded image for multimodal dispatch */
export interface ImageAttachment {
  /** Blob ID from the blobs table */
  blobId: string;
  /** MIME type (image/png, image/jpeg, etc.) */
  mimeType: string;
  /** Base64-encoded image data */
  data: string;
  /** Optional filename */
  filename?: string;
}

// ============================================================================
// Task Types
// ============================================================================

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

/**
 * Dispatch task type — tells the agent runner what kind of work this is.
 * Matches TaskDispatchType in server/types/relay.ts.
 */
export type TaskDispatchType = 'execution' | 'plan' | 'chat' | 'summarize' | 'playground';

/**
 * A single message in a conversation history.
 * Matches ConversationMessage in server/types/relay.ts.
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Task {
  id: string;
  projectId: string;
  planNodeId: string;
  provider: ProviderType;
  prompt: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  timeout?: number; // ms
  maxTurns?: number; // Override default maxTurns for the agent SDK
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> }; // Force structured JSON output
  executionStrategy?: ExecutionStrategyType;
  createdAt: string;

  /** Task type: 'execution' | 'plan' | 'chat' | 'summarize'. Defaults to 'execution'. */
  type?: TaskDispatchType;

  /** System prompt — passed to Claude SDK's options.systemPrompt */
  systemPrompt?: string;

  /** Conversation history for multi-turn chat tasks */
  messages?: ConversationMessage[];

  /** Explicit model selection — e.g. 'claude-sonnet-4-20250514' */
  model?: string;

  /** How results should be delivered: 'pr' | 'push' | 'branch' | 'copy' | 'direct' */
  deliveryMode?: 'pr' | 'push' | 'branch' | 'copy' | 'direct';

  /** Remote type of the source repository */
  remoteType?: 'github' | 'gitlab' | 'bitbucket' | 'generic' | 'none';

  /** Agent directory name (default '.astro') */
  agentDir?: string;

  /** Target branch for worktree creation and PR base (e.g., 'main', 'develop') */
  baseBranch?: string;

  /** Per-component delivery branch (e.g., 'astro/7b19a9-e4f1a2').
   *  In multi-task components, per-task branches are created from this branch.
   *  In singleton components, the agent works directly on this branch. */
  deliveryBranch?: string;

  /** @deprecated Use `deliveryBranch` instead. Kept for backward compatibility with older servers. */
  projectBranch?: string;

  /** When true, this task is the only task in its delivery branch component.
   *  The agent works directly on the delivery branch (no task sub-branch).
   *  PR is created from delivery branch directly to base branch. */
  deliveryBranchIsSingleton?: boolean;

  /** Worktree strategy for non-git or copy-based execution */
  worktreeStrategy?: 'copy' | 'reference' | 'direct';

  /** Per-task worktree control. When false, skip worktree and run in raw workdir. */
  useWorktree?: boolean;

  /** Human-readable task title — used for PR titles instead of raw prompt */
  title?: string;

  /** Human-readable task description — used for PR body instead of raw prompt */
  description?: string;

  /** Compact node ID token used for branch names and PR titles */
  shortNodeId?: string;

  /** Compact project ID token used for branch names and PR titles */
  shortProjectId?: string;

  /** Images embedded in task content, sent as base64 for multimodal prompts */
  images?: ImageAttachment[];

  /** Skip safety check — server already approved this working directory */
  skipSafetyCheck?: boolean;

  /** The original safety decision that caused skipSafetyCheck to be set.
   *  'proceed' = user chose non-git direct execution (do NOT init git).
   *  'init-git' = user chose to initialize git (init git if not already done).
   *  undefined = builtin template, text-only task, or other auto-skip reason. */
  safetyDecision?: 'proceed' | 'init-git';

  /** Base URL of the Astro server — used for linking back to tasks in PR bodies */
  astroBaseUrl?: string;

  /** GitHub issue URL to reference in the PR body (e.g., "https://github.com/org/repo/issues/42") */
  githubIssueUrl?: string;

  /** GitHub issue number to reference in the PR body (e.g., 42 → "Closes #42") */
  githubIssueNumber?: number;

  /** ECDSA P-256 signature of the dispatch signing payload (base64url-encoded) */
  dispatchSignature?: string;
  /** The signed payload for verification by the agent runner */
  dispatchSigningPayload?: {
    v: 1;
    nodeId: string;
    projectId: string;
    machineId: string;
    timestamp: string;
    nonce: string;
  };
  /** Additional trusted browser public keys for shared-machine dispatch verification */
  dispatchTrustedKeys?: JsonWebKey[];

  /** Resume an existing Claude Code session by ID (provider session ID from session_init) */
  resumeSessionId?: string;
}

/** Structured execution summary produced by the agent after task completion */
export interface ExecutionSummary {
  status: 'success' | 'partial' | 'failure';
  workCompleted: string;
  /** 1-2 paragraph executive summary: what was done, why, approach taken, and key decisions */
  executiveSummary: string;
  keyFindings: string[];
  filesChanged: string[];
  followUps: string[];
  /** PR URL if the agent created a pull request during execution */
  prUrl?: string;
  /** PR number if the agent created a pull request during execution */
  prNumber?: number;
  /** Branch name the agent worked on or created */
  branchName?: string;
}

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  exitCode?: number;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  artifacts?: TaskArtifact[];
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  /** Git SHA of the delivery branch before this task's PR was merged */
  commitBeforeSha?: string;
  /** Git SHA of the delivery branch after this task's PR was merged */
  commitAfterSha?: string;
  /** Delivery outcome — separate from execution status */
  deliveryStatus?: 'success' | 'failed' | 'skipped';
  /** Error message when deliveryStatus is 'failed' */
  deliveryError?: string;
  /** Structured execution summary (generated via follow-up structured output turn) */
  summary?: ExecutionSummary;
  metrics?: {
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalCost?: number;
    model?: string;
    numTurns?: number;
  };
}

export interface TaskArtifact {
  type: 'file' | 'log' | 'metric';
  name: string;
  path?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// WebSocket Protocol Types
// ============================================================================

export type WSMessageType =
  // Client -> Server
  | 'register'
  | 'heartbeat'
  | 'task_status'
  | 'task_output'
  | 'task_result'
  | 'task_tool_trace'
  | 'task_text'
  | 'task_operational'
  | 'task_tool_use'
  | 'task_tool_result'
  | 'task_file_change'
  | 'task_session_init'
  | 'task_steer_ack'
  | 'task_dispatch_ack'
  | 'task_approval_request'
  | 'task_safety_prompt'
  | 'task_safety_response'
  | 'resource_update'
  | 'file_list_response'
  | 'file_content_response'
  | 'file_upload_response'
  | 'directory_list_response'
  | 'create_directory_response'
  | 'slash_commands_response'
  | 'repo_detect_response'
  | 'branch_list_response'
  | 'git_init_response'
  | 'sessions_list_response'
  | 'channel_notification_ack'
  | 'channel_response_ack'
  | 'channel_approval_response'
  | 'channel_inbound'
  // Server -> Client
  | 'registered'
  | 'heartbeat_ack'
  | 'task_dispatch'
  | 'task_cancel'
  | 'task_steer'
  | 'task_approval_response'
  | 'task_safety_decision'
  | 'config_update'
  | 'file_list_request'
  | 'file_content_request'
  | 'file_upload_request'
  | 'file_upload_chunk'
  | 'directory_list_request'
  | 'create_directory_request'
  | 'repo_setup_request'
  | 'repo_setup_response'
  | 'slash_commands_request'
  | 'repo_detect_request'
  | 'branch_list_request'
  | 'git_init_request'
  | 'sessions_list_request'
  | 'channel_notification'
  | 'channel_response'
  | 'channel_approval_request'
  | 'project_cleanup'
  | 'error';

export interface WSMessage {
  type: WSMessageType;
  timestamp: string;
  payload: unknown;
}

// Client -> Server Messages

// ExecutionStrategyInfo is re-exported from ./execution/types.js above

export interface RegisterMessage extends WSMessage {
  type: 'register';
  payload: {
    runnerId: string;
    machineId: string;
    providers: ProviderInfo[];
    executionStrategies?: ExecutionStrategyInfo[];
    resources: MachineResources;
    version: string;
  };
}

export interface HeartbeatMessage extends WSMessage {
  type: 'heartbeat';
  payload: {
    runnerId: string;
    activeTasks: string[];
    resources: MachineResources;
  };
}

export interface TaskStatusMessage extends WSMessage {
  type: 'task_status';
  payload: {
    taskId: string;
    status: TaskStatus;
    progress?: number; // 0-100
    message?: string;
  };
}

export interface TaskOutputMessage extends WSMessage {
  type: 'task_output';
  payload: {
    taskId: string;
    stream: 'stdout' | 'stderr';
    data: string;
    sequence: number;
  };
}

export interface TaskResultMessage extends WSMessage {
  type: 'task_result';
  payload: TaskResult;
}

export interface TaskToolTraceMessage extends WSMessage {
  type: 'task_tool_trace';
  payload: {
    taskId: string;
    toolName: string;
    toolInput?: unknown;
    toolResult?: unknown;
    success?: boolean;
  };
}

export interface TaskTextMessage extends WSMessage {
  type: 'task_text';
  payload: {
    taskId: string;
    text: string;
    sequence: number;
  };
}

export interface TaskOperationalMessage extends WSMessage {
  type: 'task_operational';
  payload: {
    taskId: string;
    message: string;
    source: 'astro' | 'git' | 'delivery';
  };
}

export interface TaskToolUseMessage extends WSMessage {
  type: 'task_tool_use';
  payload: {
    taskId: string;
    toolName: string;
    toolInput: unknown;
    /** Claude API tool_use_id — enables exact matching of tool_result to tool_use */
    toolUseId?: string;
  };
}

export interface TaskToolResultWSMessage extends WSMessage {
  type: 'task_tool_result';
  payload: {
    taskId: string;
    toolName: string;
    result: unknown;
    success: boolean;
    /** Claude API tool_use_id — enables exact matching back to tool_use */
    toolUseId?: string;
  };
}

export interface TaskFileChangeMessage extends WSMessage {
  type: 'task_file_change';
  payload: {
    taskId: string;
    path: string;
    action: 'created' | 'modified' | 'deleted';
    linesAdded?: number;
    linesRemoved?: number;
    diff?: string;
  };
}

export interface TaskSessionInitMessage extends WSMessage {
  type: 'task_session_init';
  payload: {
    taskId: string;
    sessionId: string;
    model?: string;
  };
}

export interface TaskSteerAckWSMessage extends WSMessage {
  type: 'task_steer_ack';
  payload: {
    taskId: string;
    accepted: boolean;
    message?: string;
  };
}

export interface TaskApprovalRequestMessage extends WSMessage {
  type: 'task_approval_request';
  payload: {
    taskId: string;
    requestId: string;
    question: string;
    options: string[];
  };
}

export interface TaskSafetyPromptMessage extends WSMessage {
  type: 'task_safety_prompt';
  payload: {
    taskId: string;
    safetyTier: 'safe' | 'guarded' | 'risky' | 'unsafe';
    warning?: string;
    blockReason?: string;
    options: Array<{
      id: string;
      label: string;
      description?: string;
    }>;
  };
}

export interface TaskSafetyResponseMessage extends WSMessage {
  type: 'task_safety_response';
  payload: {
    taskId: string;
    decision: 'proceed' | 'init-git' | 'sandbox' | 'cancel';
    sandboxMode?: boolean;
  };
}

export interface ResourceUpdateMessage extends WSMessage {
  type: 'resource_update';
  payload: {
    runnerId: string;
    resources: MachineResources;
  };
}

// Server -> Client Messages

export interface RegisteredMessage extends WSMessage {
  type: 'registered';
  payload: {
    runnerId: string;
    serverTime: string;
    config: RunnerConfig;
  };
}

export interface HeartbeatAckMessage extends WSMessage {
  type: 'heartbeat_ack';
  payload: {
    serverTime: string;
  };
}

export interface TaskDispatchMessage extends WSMessage {
  type: 'task_dispatch';
  payload: Task;
}

export interface TaskCancelMessage extends WSMessage {
  type: 'task_cancel';
  payload: {
    taskId: string;
    reason?: string;
  };
}

export interface TaskSteerIncomingMessage extends WSMessage {
  type: 'task_steer';
  payload: {
    taskId: string;
    message: string;
    action?: string;
    interrupt?: boolean;
    sessionId?: string;
    branchName?: string;
  };
}

export interface TaskApprovalResponseMessage extends WSMessage {
  type: 'task_approval_response';
  payload: {
    taskId: string;
    requestId: string;
    answered: boolean;
    answer?: string;
    message?: string;
  };
}

export interface TaskSafetyDecisionMessage extends WSMessage {
  type: 'task_safety_decision';
  payload: {
    taskId: string;
    decision: 'proceed' | 'init-git' | 'sandbox' | 'cancel';
    sandboxMode?: boolean;
  };
}

export interface ConfigUpdateMessage extends WSMessage {
  type: 'config_update';
  payload: Partial<RunnerConfig>;
}

export interface ErrorMessage extends WSMessage {
  type: 'error';
  payload: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface FileListRequestMessage extends WSMessage {
  type: 'file_list_request';
  payload: {
    path: string;
    correlationId: string;
  };
}

export interface FileListResponseMessage extends WSMessage {
  type: 'file_list_response';
  payload: {
    correlationId: string;
    files: string[];
  };
}

export interface DirectoryListRequestMessage extends WSMessage {
  type: 'directory_list_request';
  payload: {
    path: string;
    correlationId: string;
  };
}

export interface DirectoryListResponseMessage extends WSMessage {
  type: 'directory_list_response';
  payload: {
    correlationId: string;
    path: string;
    entries: Array<{
      name: string;
      path: string;
      isDirectory: boolean;
      isSymlink?: boolean;
    }>;
    error?: string;
    homeDirectory?: string;
  };
}

export interface FileContentRequestMessage extends WSMessage {
  type: 'file_content_request';
  payload: {
    path: string;
    correlationId: string;
  };
}

export interface FileContentResponseMessage extends WSMessage {
  type: 'file_content_response';
  payload: {
    correlationId: string;
    path: string;
    content?: string;
    encoding?: 'utf-8' | 'base64';
    mimeType?: string;
    size?: number;
    chunked?: boolean;
    chunkIndex?: number;
    totalChunks?: number;
    error?: string;
  };
}

export interface FileUploadRequestMessage extends WSMessage {
  type: 'file_upload_request';
  payload: {
    correlationId: string;
    destinationPath: string;
    fileName: string;
    size: number;
    totalChunks: number;
    overwrite: boolean;
  };
}

export interface FileUploadChunkMessage extends WSMessage {
  type: 'file_upload_chunk';
  payload: {
    correlationId: string;
    chunkIndex: number;
    encoding: 'utf-8' | 'base64';
    content: string;
  };
}

export interface FileUploadResponseMessage extends WSMessage {
  type: 'file_upload_response';
  payload: {
    correlationId: string;
    success: boolean;
    path?: string;
    error?: string;
  };
}

export interface CreateDirectoryRequestMessage extends WSMessage {
  type: 'create_directory_request';
  payload: {
    parentPath: string;
    name: string;
    correlationId: string;
  };
}

export interface CreateDirectoryResponseMessage extends WSMessage {
  type: 'create_directory_response';
  payload: {
    correlationId: string;
    success: boolean;
    path?: string;
    error?: string;
  };
}

export interface RepoSetupRequestMessage extends WSMessage {
  type: 'repo_setup_request';
  payload: {
    correlationId: string;
    projectId: string;
    projectName: string;
    projectDescription?: string;
    workingDirectory?: string;
    repository?: string;
  };
}

export interface RepoSetupResponseMessage extends WSMessage {
  type: 'repo_setup_response';
  payload: {
    correlationId: string;
    success: boolean;
    workingDirectory?: string;
    fileTree?: string[];
    repository?: string;
    needsGitInit?: boolean;
    keyFiles?: {
      claudeMd?: string;
      readmeMd?: string;
      packageInfo?: string;
    };
    source?: {
      localPath: string;
      subdirectory?: string;
      remoteUrl?: string;
      remoteType: string;
      baseBranch: string;
      isGit: boolean;
    };
    deliveryMode?: string;
    agentDir?: string;
    error?: string;
  };
}

export interface SlashCommandsRequestMessage extends WSMessage {
  type: 'slash_commands_request';
  payload: {
    correlationId: string;
    workingDirectory?: string;
  };
}

export interface SlashCommandsResponseMessage extends WSMessage {
  type: 'slash_commands_response';
  payload: {
    correlationId: string;
    commands: Array<{ name: string; description: string }>;
  };
}

export interface RepoDetectRequestMessage extends WSMessage {
  type: 'repo_detect_request';
  payload: {
    correlationId: string;
    path: string;
  };
}

export interface RepoDetectResponseMessage extends WSMessage {
  type: 'repo_detect_response';
  payload: {
    correlationId: string;
    exists: boolean;
    isGit: boolean;
    remoteUrl?: string;
    remoteType: 'github' | 'gitlab' | 'bitbucket' | 'generic' | 'none';
    baseBranch?: string;
    currentBranch?: string;
    isDirty?: boolean;
    dirtyDetails?: {
      staged: number;
      unstaged: number;
      untracked: number;
    };
    suggestedDeliveryMode: 'pr' | 'push' | 'branch' | 'direct';
    dirSizeMB?: number | null;
    error?: string;
  };
}

export interface BranchListRequestMessage extends WSMessage {
  type: 'branch_list_request';
  payload: {
    correlationId: string;
    path: string;
  };
}

export interface BranchListResponseMessage extends WSMessage {
  type: 'branch_list_response';
  payload: {
    correlationId: string;
    branches: Array<{
      name: string;
      isRemote: boolean;
      isCurrent: boolean;
      isDefault: boolean;
    }>;
    defaultBranch?: string;
    error?: string;
  };
}

export interface GitInitRequestMessage extends WSMessage {
  type: 'git_init_request';
  payload: {
    correlationId: string;
    workingDirectory: string;
    projectId: string;
    projectName: string;
    projectDescription?: string;
  };
}

export interface GitInitResponseMessage extends WSMessage {
  type: 'git_init_response';
  payload: {
    correlationId: string;
    success: boolean;
    workingDirectory?: string;
    fileTree?: string[];
    source?: Record<string, unknown>;
    deliveryMode?: string;
    error?: string;
  };
}

// ============================================================================
// Sessions List Types
// ============================================================================

export interface SessionsListRequestMessage extends WSMessage {
  type: 'sessions_list_request';
  payload: {
    correlationId: string;
    /** Only return sessions modified within this many ms. Omit for all sessions. */
    maxAgeMs?: number;
  };
}

export interface ClaudeCodeSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
}

export interface SessionsListResponseMessage extends WSMessage {
  type: 'sessions_list_response';
  payload: {
    correlationId: string;
    sessions: ClaudeCodeSessionInfo[];
    error?: string;
  };
}

// ============================================================================
// Channel Relay Types (Server <-> Agent Runner <-> OpenClaw Gateway)
// ============================================================================

/** Server -> Agent: Send a notification through OpenClaw */
export interface ChannelNotificationMessage extends WSMessage {
  type: 'channel_notification';
  payload: {
    correlationId: string;
    notification: {
      type: string;
      projectId: string;
      summary: string;
      astroUrl?: string;
      to?: string;
      metadata?: Record<string, unknown>;
    };
  };
}

/** Agent -> Server: Notification delivery acknowledgment */
export interface ChannelNotificationAckMessage extends WSMessage {
  type: 'channel_notification_ack';
  payload: {
    correlationId: string;
    success: boolean;
    error?: string;
  };
}

/** Server -> Agent: Send a chat response through OpenClaw */
export interface ChannelResponseMessage extends WSMessage {
  type: 'channel_response';
  payload: {
    correlationId: string;
    response: {
      text: string;
      channelId: string;
      threadId?: string;
      metadata?: Record<string, unknown>;
    };
  };
}

/** Agent -> Server: Response delivery acknowledgment */
export interface ChannelResponseAckMessage extends WSMessage {
  type: 'channel_response_ack';
  payload: {
    correlationId: string;
    success: boolean;
    error?: string;
  };
}

/** Server -> Agent: Request user approval through OpenClaw */
export interface ChannelApprovalRequestMessage extends WSMessage {
  type: 'channel_approval_request';
  payload: {
    correlationId: string;
    approvalId: string;
    projectId: string;
    taskId: string;
    question: string;
    options?: string[];
    to?: string;
  };
}

/** Agent -> Server: User responded to approval via OpenClaw */
export interface ChannelApprovalResponseMessage extends WSMessage {
  type: 'channel_approval_response';
  payload: {
    correlationId: string;
    approvalId: string;
    response: string;
    error?: string;
  };
}

/** Agent -> Server: Unprompted inbound message from user via OpenClaw */
export interface ChannelInboundMessage extends WSMessage {
  type: 'channel_inbound';
  payload: {
    sourceMessageId: string;
    text: string;
    senderId: string;
    senderName: string;
    channelId: string;
    threadId?: string;
    metadata?: Record<string, unknown>;
  };
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface RunnerConfig {
  relayUrl: string;
  maxConcurrentTasks: number;
  heartbeatInterval: number; // ms
  reconnectMaxRetries: number;
  reconnectBaseDelay: number; // ms
  reconnectMaxDelay: number; // ms
  taskTimeout: number; // ms
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface StoredConfig {
  runnerId: string;
  machineId: string;
  deviceToken?: string;
  relayUrl: string;
  providers: ProviderType[];
  autoStart: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  mcpServers?: Record<string, {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }>;
}

// ============================================================================
// SSH Config Types
// ============================================================================

export interface SSHHost {
  name: string;
  hostname: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}

export interface DiscoveredHost extends SSHHost {
  source: 'ssh-config' | 'vscode-tunnel' | 'known-hosts';
  agentInstalled?: boolean;
  lastChecked?: string;
}

// ============================================================================
// Device Auth Types
// ============================================================================

/** @deprecated Use DeviceAuthServerResponse instead */
export interface DeviceAuthRequest {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** @deprecated Use DeviceTokenServerResponse instead */
export interface DeviceAuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  runnerId: string;
}

/** Response from POST /api/device/authorize */
export interface DeviceAuthServerResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

/** Successful token response from POST /api/device/token */
export interface DeviceTokenServerResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken: string;
  scopes: string[];
}

/** Error response from POST /api/device/token (RFC 8628) */
export interface DeviceTokenError {
  error: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token';
  errorDescription: string;
}

/** Response from POST /api/device/register */
export interface MachineRegisterResponse {
  machineId: string;
  machineName: string;
  relayUrl: string;
  wsToken: string;
  message: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** ECDSA P-256 public key (JWK) for verifying dispatch signatures */
  dispatchPublicKey?: JsonWebKey;
}

// ============================================================================
// Event Types
// ============================================================================

export type RunnerEvent =
  | { type: 'connected' }
  | { type: 'disconnected'; reason: string }
  | { type: 'reconnecting'; attempt: number }
  | { type: 'task_received'; task: Task }
  | { type: 'task_started'; taskId: string }
  | { type: 'task_completed'; result: TaskResult }
  | { type: 'task_cancelled'; taskId: string }
  | { type: 'error'; error: Error };

export type RunnerEventHandler = (event: RunnerEvent) => void;

// ============================================================================
// Slurm Types
// ============================================================================

export interface SlurmInfo {
  available: boolean;
  version?: string;
  clusterName?: string;
  partitions: string[];
  defaultPartition?: string;
  accounts: string[];
  qosLevels: string[];
  /** Enriched partition details (objects with node counts, features, etc.) */
  partitionDetails?: SlurmPartitionDetail[];
  /** Total GPUs across all nodes (from GRES) */
  totalGpus?: number;
  /** Number of nodes with GPUs */
  gpuNodeCount?: number;
}

export interface SlurmPartitionDetail {
  name: string;
  isDefault: boolean;
  /** Whether the partition is administratively available (up vs down/drain) */
  available: boolean;
  totalNodes: number;
  availableNodes: number;
  maxTime?: string;
  features: string[];
}

export interface SlurmJobStatus {
  jobId: string;
  state: string;
  stateReason?: string;
  nodeList?: string;
  exitCode?: number;
}

export interface SlurmJobConfig {
  partition?: string;
  nodes?: number;
  ntasks?: number;
  cpusPerTask?: number;
  mem?: string;
  gpu?: { type?: string; count: number };
  time?: string;
  qos?: string;
  account?: string;
  modules?: string[];
}
