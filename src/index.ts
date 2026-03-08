/**
 * Astro Agent Runner
 *
 * Lightweight agent runner for local, remote, and HPC environments.
 * Exports the public API for programmatic use.
 */

// Types
export type {
  ProviderType,
  ProviderInfo,
  ProviderCapabilities,
  MachineResources,
  CpuInfo,
  MemoryInfo,
  GpuInfo,
  Task,
  TaskResult,
  TaskStatus,
  TaskArtifact,
  WSMessage,
  WSMessageType,
  RunnerConfig,
  StoredConfig,
  SSHHost,
  DiscoveredHost,
  DeviceAuthRequest,
  DeviceAuthResult,
  RunnerEvent,
  RunnerEventHandler,
  SlurmInfo,
  SlurmPartitionDetail,
  SlurmJobStatus,
  SlurmJobConfig,
} from './types.js';

// Library exports
export { getMachineResources, formatBytes, formatResourceSummary } from './lib/resources.js';
export { detectProviders, getProvider, isProviderAvailable, formatProviderInfo, formatProvidersSummary } from './lib/providers.js';
export { discoverRemoteHosts, formatDiscoveredHosts, buildSSHCommand } from './lib/ssh-discovery.js';
export { WebSocketClient, type WebSocketClientOptions } from './lib/websocket-client.js';
export { TaskExecutor, type TaskExecutorOptions } from './lib/task-executor.js';
export { config, ConfigManager } from './lib/config.js';

// Slurm lib
export { detectSlurm, getPartitionInfo } from './lib/slurm-detect.js';
export { SlurmExecutor } from './lib/slurm-executor.js';
export type { SlurmTaskInput, SlurmExecuteOptions, SlurmExecuteResult } from './lib/slurm-executor.js';

// Provider adapters
export { createProviderAdapter, getAvailableAdapters } from './providers/index.js';
export type { ProviderAdapter, TaskOutputStream, ProviderStatus } from './providers/base-adapter.js';
export { ClaudeSdkAdapter } from './providers/claude-sdk-adapter.js';
export { CodexAdapter } from './providers/codex-adapter.js';
