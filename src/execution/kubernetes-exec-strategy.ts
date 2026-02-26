/**
 * Kubernetes Exec Execution Strategy
 *
 * Runs commands on existing K8s pods via `kubectl exec`.
 */

import { spawn, exec, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ExecutionStrategy,
  ExecutionSpec,
  ExecutionCallbacks,
  ExecutionResult,
  ExecutionStrategyDetection,
  ExecutionJobStatus,
} from './types.js';

const execAsync = promisify(exec);

export interface K8sExecOptions {
  pod?: string;
  namespace?: string;
  container?: string;
}

export class K8sExecStrategy implements ExecutionStrategy {
  readonly id = 'k8s-exec' as const;
  readonly name = 'Kubernetes Exec';
  readonly isAsync = false;

  private processes = new Map<string, ChildProcess>();

  async detect(): Promise<ExecutionStrategyDetection> {
    // Check if kubectl is available
    try {
      await execAsync('which kubectl', { timeout: 5000 });
    } catch {
      return { available: false };
    }

    // Check if cluster is reachable
    try {
      const { stdout } = await execAsync('kubectl cluster-info --request-timeout=5s 2>/dev/null', {
        timeout: 10000,
      });

      // Extract cluster URL
      const urlMatch = stdout.match(/https?:\/\/[\w.:/-]+/);

      // Get server version
      let serverVersion: string | undefined;
      try {
        const { stdout: versionOut } = await execAsync(
          'kubectl version --output=json --request-timeout=5s 2>/dev/null',
          { timeout: 10000 },
        );
        const versionData = JSON.parse(versionOut) as {
          serverVersion?: { gitVersion?: string };
        };
        serverVersion = versionData.serverVersion?.gitVersion;
      } catch {
        // Version detection failed
      }

      // Get available namespaces
      let namespaces: string[] = [];
      try {
        const { stdout: nsOut } = await execAsync(
          'kubectl get namespaces -o jsonpath=\'{.items[*].metadata.name}\' --request-timeout=5s 2>/dev/null',
          { timeout: 10000 },
        );
        namespaces = nsOut.trim().split(/\s+/).filter(Boolean);
      } catch {
        // Namespace listing failed — limited permissions
      }

      // Get current context
      let currentContext: string | undefined;
      try {
        const { stdout: ctxOut } = await execAsync('kubectl config current-context', { timeout: 5000 });
        currentContext = ctxOut.trim();
      } catch {
        // No context
      }

      // Node details (CPU, memory, GPU capacity)
      interface K8sNodeInfo {
        name: string;
        status: string;
        cpu: string;
        memory: string;
        gpus: number;
      }
      let nodes: K8sNodeInfo[] = [];
      let totalCPU = 0;
      let totalMemoryGi = 0;
      let totalGPUs = 0;

      try {
        const { stdout: nodesOut } = await execAsync(
          'kubectl get nodes -o json --request-timeout=10s 2>/dev/null',
          { timeout: 15000 },
        );
        const nodesData = JSON.parse(nodesOut) as {
          items?: Array<{
            metadata?: { name?: string };
            status?: {
              conditions?: Array<{ type?: string; status?: string }>;
              capacity?: Record<string, string>;
            };
          }>;
        };
        if (nodesData.items) {
          nodes = nodesData.items.map((item) => {
            const name = item.metadata?.name ?? 'unknown';
            const readyCond = item.status?.conditions?.find((c) => c.type === 'Ready');
            const status = readyCond?.status === 'True' ? 'Ready' : 'NotReady';
            const capacity = item.status?.capacity ?? {};
            const cpu = capacity.cpu ?? '0';
            const memory = capacity.memory ?? '0';
            const gpuStr = capacity['nvidia.com/gpu'] ?? '0';
            const gpus = parseInt(gpuStr, 10) || 0;

            // Parse CPU (may be millicores like "4000m" or cores like "4")
            const cpuNum = cpu.endsWith('m') ? parseInt(cpu, 10) / 1000 : parseInt(cpu, 10) || 0;
            totalCPU += cpuNum;

            // Parse memory (Ki -> Gi)
            const memMatch = memory.match(/^(\d+)(Ki|Mi|Gi)?$/);
            if (memMatch) {
              const val = parseInt(memMatch[1]!, 10);
              const unit = memMatch[2];
              if (unit === 'Ki') totalMemoryGi += val / (1024 * 1024);
              else if (unit === 'Mi') totalMemoryGi += val / 1024;
              else if (unit === 'Gi') totalMemoryGi += val;
              else totalMemoryGi += val / (1024 * 1024 * 1024); // bytes
            }

            totalGPUs += gpus;
            return { name, status, cpu, memory, gpus };
          });
        }
      } catch {
        // Node details are optional enrichment
      }

      totalMemoryGi = Math.round(totalMemoryGi * 10) / 10;

      // Pod fallback: when nodes are empty (RBAC denied or autoscaler scaled to 0),
      // count pods by namespace to show the cluster is still active
      let podCount = 0;
      let podsByNamespace: Record<string, number> = {};

      if (nodes.length === 0) {
        try {
          const { stdout: podOut } = await execAsync(
            'kubectl get pods --all-namespaces --no-headers -o custom-columns=NS:.metadata.namespace --request-timeout=10s 2>/dev/null',
            { timeout: 15000 },
          );
          const lines = podOut.trim().split('\n').filter(Boolean);
          podCount = lines.length;
          const nsCounts: Record<string, number> = {};
          for (const line of lines) {
            const ns = line.trim();
            if (ns) {
              nsCounts[ns] = (nsCounts[ns] ?? 0) + 1;
            }
          }
          podsByNamespace = nsCounts;
        } catch {
          // Pod listing may also be restricted
        }
      }

      return {
        available: true,
        version: serverVersion,
        metadata: {
          clusterUrl: urlMatch?.[0],
          currentContext,
          namespaces,
          nodes,
          totalNodes: nodes.length,
          totalCPU,
          totalMemoryGi,
          totalGPUs,
          ...(podCount > 0 ? { podCount, podsByNamespace } : {}),
        },
      };
    } catch {
      return { available: false };
    }
  }

  async buildContext(): Promise<string> {
    const detection = await this.detect();
    if (!detection.available) return '';

    const meta = detection.metadata ?? {};
    const sections: string[] = [];

    sections.push('# Kubernetes Execution Environment');
    sections.push('');
    sections.push('You have `kubectl` access to a Kubernetes cluster.');

    if (meta.currentContext) {
      sections.push(`- Current context: \`${meta.currentContext}\``);
    }
    if (meta.clusterUrl) {
      sections.push(`- Cluster: \`${meta.clusterUrl}\``);
    }
    if (Array.isArray(meta.namespaces) && meta.namespaces.length > 0) {
      sections.push(`- Namespaces: ${(meta.namespaces as string[]).join(', ')}`);
    }

    sections.push('');
    sections.push('Commands are executed via `kubectl exec` on specified pods.');
    sections.push('');

    return sections.join('\n');
  }

  async execute(
    spec: ExecutionSpec,
    callbacks: ExecutionCallbacks,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    if (signal.aborted) {
      return { status: 'cancelled' };
    }

    const opts = (spec.options ?? {}) as K8sExecOptions;

    if (!opts.pod) {
      return {
        status: 'failed',
        error: 'K8s exec requires options.pod to be specified',
      };
    }

    // Build kubectl exec arguments
    const args: string[] = ['exec'];

    if (opts.namespace) {
      args.push('-n', opts.namespace);
    }
    if (opts.container) {
      args.push('-c', opts.container);
    }

    args.push(opts.pod, '--');

    // Command
    if (typeof spec.command === 'string') {
      args.push('sh', '-c', spec.command);
    } else {
      args.push(...spec.command);
    }

    return new Promise<ExecutionResult>((resolve) => {
      const child = spawn('kubectl', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.processes.set(spec.jobId, child);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: ExecutionResult) => {
        if (settled) return;
        settled = true;
        this.processes.delete(spec.jobId);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        resolve(result);
      };

      // Handle abort signal
      const onAbort = () => {
        if (!settled) {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!settled) child.kill('SIGKILL');
          }, 5000).unref();
          finish({
            status: 'cancelled',
            output: stdout,
            error: stderr,
            externalJobId: opts.pod,
          });
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Handle timeout
      let timeoutHandle: NodeJS.Timeout | undefined;
      if (spec.timeout && spec.timeout > 0) {
        timeoutHandle = setTimeout(() => {
          if (!settled) {
            child.kill('SIGTERM');
            setTimeout(() => {
              if (!settled) child.kill('SIGKILL');
            }, 5000).unref();
            finish({
              status: 'timeout',
              output: stdout,
              error: stderr,
              externalJobId: opts.pod,
            });
          }
        }, spec.timeout);
        timeoutHandle.unref();
      }

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        callbacks.onStdout(text);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        callbacks.onStderr(text);
      });

      child.on('error', (err) => {
        finish({
          status: 'failed',
          error: err.message,
          output: stdout,
          externalJobId: opts.pod,
        });
      });

      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        const exitCode = code ?? 1;
        finish({
          status: exitCode === 0 ? 'completed' : 'failed',
          exitCode,
          output: stdout,
          error: stderr || undefined,
          externalJobId: opts.pod,
        });
      });

      const podLabel = opts.namespace ? `${opts.namespace}/${opts.pod}` : opts.pod;
      callbacks.onStatus('running', 0, `kubectl exec on pod ${podLabel}`);
    });
  }

  async cancel(jobId: string): Promise<void> {
    const child = this.processes.get(jobId);
    if (!child) return;

    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, 5000).unref();

    this.processes.delete(jobId);
  }

  async getStatus(jobId: string): Promise<ExecutionJobStatus | null> {
    const child = this.processes.get(jobId);
    if (!child) return null;

    return {
      jobId,
      externalJobId: String(child.pid ?? ''),
      state: child.exitCode !== null ? 'exited' : 'running',
      exitCode: child.exitCode ?? undefined,
    };
  }
}
