/**
 * Execution Strategy Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectStrategy } from '../src/execution/direct-strategy.js';
import { SlurmStrategy } from '../src/execution/slurm-strategy.js';
import { DockerStrategy } from '../src/execution/docker-strategy.js';
import { K8sExecStrategy } from '../src/execution/kubernetes-exec-strategy.js';
import { ExecutionStrategyRegistry } from '../src/execution/registry.js';
import type { ExecutionCallbacks } from '../src/execution/types.js';

// ============================================================================
// DirectStrategy
// ============================================================================

describe('DirectStrategy', () => {
  let strategy: DirectStrategy;

  beforeEach(() => {
    strategy = new DirectStrategy();
  });

  it('detect() always returns available=true', async () => {
    const detection = await strategy.detect();
    expect(detection.available).toBe(true);
    expect(detection.version).toBe(process.version);
    expect(detection.metadata?.platform).toBe(process.platform);
  });

  it('has correct id and name', () => {
    expect(strategy.id).toBe('direct');
    expect(strategy.name).toBe('Direct (local)');
    expect(strategy.isAsync).toBe(false);
  });

  it('buildContext() returns Python safety context', async () => {
    const context = await strategy.buildContext();
    expect(context).toContain('Direct Execution Environment');
    expect(context).toContain('NEVER');
    expect(context).toContain('pip install');
    expect(context).toContain('virtual environment');
  });

  it('execute() runs echo command successfully', async () => {
    const callbacks: ExecutionCallbacks = {
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onStatus: vi.fn(),
    };

    const controller = new AbortController();
    const result = await strategy.execute(
      {
        jobId: 'test-1',
        command: 'echo hello world',
        cwd: process.cwd(),
      },
      callbacks,
      controller.signal,
    );

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello world');
    expect(callbacks.onStdout).toHaveBeenCalled();
    expect(callbacks.onStatus).toHaveBeenCalledWith('running', 0, 'Process started');
  });

  it('execute() handles array command', async () => {
    const callbacks: ExecutionCallbacks = {
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onStatus: vi.fn(),
    };

    const controller = new AbortController();
    const result = await strategy.execute(
      {
        jobId: 'test-2',
        command: ['echo', 'array', 'test'],
        cwd: process.cwd(),
      },
      callbacks,
      controller.signal,
    );

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('array test');
  });

  it('execute() handles abort signal', async () => {
    const callbacks: ExecutionCallbacks = {
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onStatus: vi.fn(),
    };

    const controller = new AbortController();

    // Start a long-running process
    const resultPromise = strategy.execute(
      {
        jobId: 'test-3',
        command: 'sleep 60',
        cwd: process.cwd(),
      },
      callbacks,
      controller.signal,
    );

    // Abort after a short delay
    setTimeout(() => controller.abort(), 100);

    const result = await resultPromise;
    expect(result.status).toBe('cancelled');
  });

  it('execute() reports failure exit code', async () => {
    const callbacks: ExecutionCallbacks = {
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onStatus: vi.fn(),
    };

    const controller = new AbortController();
    const result = await strategy.execute(
      {
        jobId: 'test-4',
        command: 'exit 42',
        cwd: process.cwd(),
      },
      callbacks,
      controller.signal,
    );

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(42);
  });

  it('execute() respects timeout', async () => {
    const callbacks: ExecutionCallbacks = {
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onStatus: vi.fn(),
    };

    const controller = new AbortController();
    const result = await strategy.execute(
      {
        jobId: 'test-5',
        command: 'sleep 60',
        cwd: process.cwd(),
        timeout: 200,
      },
      callbacks,
      controller.signal,
    );

    expect(result.status).toBe('timeout');
  });

  it('cancel() terminates a running process', async () => {
    const callbacks: ExecutionCallbacks = {
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onStatus: vi.fn(),
    };

    const controller = new AbortController();

    const resultPromise = strategy.execute(
      {
        jobId: 'test-cancel',
        command: 'sleep 60',
        cwd: process.cwd(),
      },
      callbacks,
      controller.signal,
    );

    // Wait for process to start
    await new Promise((r) => setTimeout(r, 100));

    // Check status
    const status = await strategy.getStatus('test-cancel');
    expect(status).not.toBeNull();
    expect(status?.state).toBe('running');

    // Cancel via strategy (sends SIGTERM) + abort signal (resolves promise)
    await strategy.cancel('test-cancel');
    controller.abort();

    const result = await resultPromise;
    // Process killed → should be cancelled or failed
    expect(['cancelled', 'failed']).toContain(result.status);
  }, 10_000);

  it('getStatus() returns null for unknown jobId', async () => {
    const status = await strategy.getStatus('nonexistent');
    expect(status).toBeNull();
  });

  it('execute() returns cancelled immediately if signal already aborted', async () => {
    const callbacks: ExecutionCallbacks = {
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onStatus: vi.fn(),
    };

    const controller = new AbortController();
    controller.abort();

    const result = await strategy.execute(
      {
        jobId: 'test-pre-aborted',
        command: 'echo should not run',
        cwd: process.cwd(),
      },
      callbacks,
      controller.signal,
    );

    expect(result.status).toBe('cancelled');
  });

  it('execute() passes environment variables', async () => {
    const callbacks: ExecutionCallbacks = {
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onStatus: vi.fn(),
    };

    const controller = new AbortController();
    const result = await strategy.execute(
      {
        jobId: 'test-env',
        command: 'echo $TEST_VAR_EXECUTION',
        cwd: process.cwd(),
        env: { TEST_VAR_EXECUTION: 'strategy_works' },
      },
      callbacks,
      controller.signal,
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('strategy_works');
  });
});

// ============================================================================
// SlurmStrategy
// ============================================================================

describe('SlurmStrategy', () => {
  let strategy: SlurmStrategy;

  beforeEach(() => {
    strategy = new SlurmStrategy();
  });

  it('has correct id and name', () => {
    expect(strategy.id).toBe('slurm');
    expect(strategy.name).toBe('SLURM HPC');
    expect(strategy.isAsync).toBe(true);
  });

  it('detect() returns available=false on non-HPC machines', async () => {
    const detection = await strategy.detect();
    // On a typical dev machine without SLURM, this should be false
    // (unless running on an actual HPC cluster)
    expect(typeof detection.available).toBe('boolean');
    if (!detection.available) {
      expect(detection.version).toBeUndefined();
    }
  });
});

// ============================================================================
// DockerStrategy
// ============================================================================

describe('DockerStrategy', () => {
  let strategy: DockerStrategy;

  beforeEach(() => {
    strategy = new DockerStrategy();
  });

  it('has correct id and name', () => {
    expect(strategy.id).toBe('docker');
    expect(strategy.name).toBe('Docker');
    expect(strategy.isAsync).toBe(false);
  });

  it('detect() returns a boolean available status', async () => {
    const detection = await strategy.detect();
    expect(typeof detection.available).toBe('boolean');
    // Docker might or might not be available on the test machine
    if (detection.available) {
      expect(detection.version).toBeDefined();
    }
  }, 10_000);

  it('buildContext() returns Docker-specific context', async () => {
    const context = await strategy.buildContext();
    expect(context).toContain('Docker');
  });
});

// ============================================================================
// K8sExecStrategy
// ============================================================================

describe('K8sExecStrategy', () => {
  let strategy: K8sExecStrategy;

  beforeEach(() => {
    strategy = new K8sExecStrategy();
  });

  it('has correct id and name', () => {
    expect(strategy.id).toBe('k8s-exec');
    expect(strategy.name).toBe('Kubernetes Exec');
    expect(strategy.isAsync).toBe(false);
  });

  it('detect() returns a boolean available status', async () => {
    const detection = await strategy.detect();
    expect(typeof detection.available).toBe('boolean');
    // If available, check metadata
    if (detection.available) {
      expect(detection.metadata?.currentContext).toBeDefined();
    }
  }, 15_000);

  it('detect() returns cluster metadata when available', async () => {
    const detection = await strategy.detect();
    if (!detection.available) {
      // Skip on machines without K8s
      return;
    }
    expect(detection.metadata).toBeDefined();
    expect(detection.metadata?.clusterUrl).toMatch(/^https?:\/\//);
    expect(Array.isArray(detection.metadata?.namespaces)).toBe(true);
  }, 15_000);

  it('buildContext() returns K8s-specific context when available', async () => {
    const detection = await strategy.detect();
    if (!detection.available) return;

    const context = await strategy.buildContext();
    expect(context).toContain('Kubernetes');
    expect(context).toContain('kubectl');
  }, 15_000);

  it('execute() requires pod option', async () => {
    const detection = await strategy.detect();
    if (!detection.available) return;

    const callbacks: ExecutionCallbacks = {
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onStatus: vi.fn(),
    };
    const controller = new AbortController();

    const result = await strategy.execute(
      { jobId: 'test-no-pod', command: 'echo hello', cwd: process.cwd() },
      callbacks,
      controller.signal,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('pod');
  }, 10_000);
});

// ============================================================================
// ExecutionStrategyRegistry
// ============================================================================

describe('ExecutionStrategyRegistry', () => {
  let registry: ExecutionStrategyRegistry;

  beforeEach(() => {
    registry = new ExecutionStrategyRegistry();
  });

  it('detectAll() always includes direct strategy as available', async () => {
    const results = await registry.detectAll();
    const direct = results.find((s) => s.id === 'direct');
    expect(direct).toBeDefined();
    expect(direct!.available).toBe(true);
  }, 15_000);

  it('detectAll() includes base strategies plus SSH host entries', async () => {
    const results = await registry.detectAll();
    // 4 base strategies (direct, slurm, docker, k8s-exec) + SSH host entries (no parent 'ssh')
    expect(results.length).toBeGreaterThanOrEqual(4);
    const ids = results.map((s) => s.id);
    expect(ids).toContain('direct');
    expect(ids).toContain('slurm');
    expect(ids).toContain('docker');
    expect(ids).toContain('k8s-exec');
    // SSH hosts appear as ssh:<alias>, not a parent 'ssh' entry
    const sshEntries = ids.filter((id) => id.startsWith('ssh:'));
    // May be 0 if no ~/.ssh/config, but should not have bare 'ssh'
    expect(ids).not.toContain('ssh');
  }, 15_000);

  it('listAvailable() has at least 1 entry (direct)', async () => {
    await registry.detectAll();
    const available = registry.listAvailable();
    expect(available.length).toBeGreaterThanOrEqual(1);
    expect(available.some((s) => s.id === 'direct')).toBe(true);
  }, 15_000);

  it('get() returns strategy after detection', async () => {
    await registry.detectAll();
    const direct = registry.get('direct');
    expect(direct).not.toBeNull();
    expect(direct!.id).toBe('direct');
  }, 15_000);

  it('get() returns null for unregistered strategy before detection', () => {
    const result = registry.get('slurm');
    expect(result).toBeNull();
  });

  it('getDefault() always returns DirectStrategy', () => {
    const def = registry.getDefault();
    expect(def.id).toBe('direct');
  });

  it('isDetected() returns false before detection, true after', async () => {
    expect(registry.isDetected()).toBe(false);
    await registry.detectAll();
    expect(registry.isDetected()).toBe(true);
  }, 15_000);

  it('listAll() returns all strategies after detection', async () => {
    await registry.detectAll();
    const all = registry.listAll();
    // 4 base strategies + SSH host entries (no parent 'ssh')
    expect(all.length).toBeGreaterThanOrEqual(4);
  }, 15_000);
});
