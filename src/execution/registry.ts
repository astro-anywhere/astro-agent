/**
 * Execution Strategy Registry
 *
 * Manages all available execution strategies. Provides detection, lookup,
 * and listing of strategies.
 */

import type { ExecutionStrategy, ExecutionStrategyInfo, ExecutionStrategyType } from './types.js';
import { DirectStrategy } from './direct-strategy.js';
import { SlurmStrategy } from './slurm-strategy.js';
import { DockerStrategy } from './docker-strategy.js';
import { K8sExecStrategy } from './kubernetes-exec-strategy.js';

export class ExecutionStrategyRegistry {
  private strategies = new Map<ExecutionStrategyType, ExecutionStrategy>();
  private detectionResults = new Map<ExecutionStrategyType, ExecutionStrategyInfo>();
  private detected = false;

  /**
   * Detect all strategies in parallel.
   * Instantiates each strategy, calls detect(), and stores available ones.
   */
  async detectAll(): Promise<ExecutionStrategyInfo[]> {
    const allStrategies: ExecutionStrategy[] = [
      new DirectStrategy(),
      new SlurmStrategy(),
      new DockerStrategy(),
      new K8sExecStrategy(),
    ];

    const results = await Promise.allSettled(
      allStrategies.map(async (strategy): Promise<ExecutionStrategyInfo> => {
        const detection = await strategy.detect();

        // Always register the strategy instance so it can be retrieved
        this.strategies.set(strategy.id, strategy);

        const info: ExecutionStrategyInfo = {
          id: strategy.id,
          name: strategy.name,
          available: detection.available,
          version: detection.version,
          metadata: detection.metadata,
        };

        this.detectionResults.set(strategy.id, info);
        return info;
      }),
    );

    this.detected = true;

    return results
      .filter((r): r is PromiseFulfilledResult<ExecutionStrategyInfo> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  /**
   * Get a specific strategy by ID.
   * Returns null if the strategy hasn't been detected or isn't registered.
   */
  get(id: ExecutionStrategyType): ExecutionStrategy | null {
    return this.strategies.get(id) ?? null;
  }

  /**
   * Get the default strategy (always DirectStrategy).
   */
  getDefault(): ExecutionStrategy {
    let direct = this.strategies.get('direct');
    if (!direct) {
      direct = new DirectStrategy();
      this.strategies.set('direct', direct);
    }
    return direct;
  }

  /**
   * List all detected strategies (available and unavailable).
   */
  listAll(): ExecutionStrategyInfo[] {
    return Array.from(this.detectionResults.values());
  }

  /**
   * List only available strategies.
   */
  listAvailable(): ExecutionStrategyInfo[] {
    return Array.from(this.detectionResults.values()).filter((s) => s.available);
  }

  /**
   * Check if detection has been run.
   */
  isDetected(): boolean {
    return this.detected;
  }
}

/** Singleton registry instance */
export const executionStrategyRegistry = new ExecutionStrategyRegistry();
