/**
 * Execution Strategy Types
 *
 * Core interfaces for the execution strategy abstraction. Execution strategies
 * are orthogonal to agent models (Claude, Codex): a strategy defines HOW a
 * command runs (direct spawn, SLURM batch, Docker container, K8s pod),
 * while a provider defines WHAT reasons about the task.
 */

// ============================================================================
// Strategy Identification
// ============================================================================

export type ExecutionStrategyType = 'direct' | 'slurm' | 'docker' | 'k8s-exec' | 'ssh';

// ============================================================================
// Core Interface
// ============================================================================

export interface ExecutionStrategy {
  /** Unique strategy identifier */
  readonly id: ExecutionStrategyType;

  /** Human-readable name */
  readonly name: string;

  /** True for submit-and-monitor strategies (SLURM) */
  readonly isAsync: boolean;

  /** Capability 1: Detection — probe environment for availability and metadata */
  detect(): Promise<ExecutionStrategyDetection>;

  /** Capability 2: Context injection — optional prompt prefix for AI awareness */
  buildContext?(): Promise<string>;

  /** Capability 3: Job submission — execute a command with streaming callbacks */
  execute(spec: ExecutionSpec, callbacks: ExecutionCallbacks, signal: AbortSignal): Promise<ExecutionResult>;

  /** Capability 4+5: Cancel a running/queued job */
  cancel(jobId: string): Promise<void>;

  /** Capability 4+5: Get current status of a job */
  getStatus(jobId: string): Promise<ExecutionJobStatus | null>;
}

// ============================================================================
// Detection
// ============================================================================

export interface ExecutionStrategyDetection {
  available: boolean;
  version?: string;
  /** Strategy-specific metadata: partitions, namespaces, clouds, etc. */
  metadata?: Record<string, unknown>;
  /** For strategies that detect multiple backends (e.g., SSH hosts) */
  additionalEntries?: ExecutionStrategyInfo[];
}

// ============================================================================
// Execution Spec & Callbacks
// ============================================================================

export interface ExecutionSpec {
  jobId: string;
  command: string | string[];
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  /** Strategy-specific options: partition, image, pod, cloud, etc. */
  options?: Record<string, unknown>;
}

export interface ExecutionCallbacks {
  onStdout(data: string): void;
  onStderr(data: string): void;
  onStatus(status: string, progress?: number, message?: string): void;
}

// ============================================================================
// Execution Result
// ============================================================================

export interface ExecutionResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  exitCode?: number;
  output?: string;
  error?: string;
  /** External job ID: SLURM job ID, container ID, pod name, sky cluster */
  externalJobId?: string;
}

// ============================================================================
// Job Status
// ============================================================================

export interface ExecutionJobStatus {
  jobId: string;
  externalJobId: string;
  state: string;
  progress?: number;
  message?: string;
  startedAt?: string;
  exitCode?: number;
}

// ============================================================================
// Registry Info (for registration payload)
// ============================================================================

export interface ExecutionStrategyInfo {
  /** Strategy ID. Base strategies use ExecutionStrategyType values.
   *  SSH hosts use dynamic IDs like "ssh:<alias>". */
  id: string;
  name: string;
  available: boolean;
  version?: string;
  metadata?: Record<string, unknown>;
}
