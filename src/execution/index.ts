/**
 * Execution Strategy Module
 *
 * Barrel export for all execution strategy types, implementations, and registry.
 */

// Types
export type {
  ExecutionStrategyType,
  ExecutionStrategy,
  ExecutionStrategyDetection,
  ExecutionSpec,
  ExecutionCallbacks,
  ExecutionResult,
  ExecutionJobStatus,
  ExecutionStrategyInfo,
} from './types.js';

// Strategy implementations
export { DirectStrategy } from './direct-strategy.js';
export { SlurmStrategy } from './slurm-strategy.js';
export { DockerStrategy } from './docker-strategy.js';
export { K8sExecStrategy } from './kubernetes-exec-strategy.js';
export { SSHStrategy } from './ssh-strategy.js';

// Strategy-specific option types
export type { DockerExecOptions } from './docker-strategy.js';
export type { K8sExecOptions } from './kubernetes-exec-strategy.js';

// Registry
export { ExecutionStrategyRegistry, executionStrategyRegistry } from './registry.js';
