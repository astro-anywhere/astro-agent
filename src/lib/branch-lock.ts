/**
 * Per-project async mutex for serializing merge operations.
 *
 * Tasks in the same project execute in parallel but serialize at merge
 * time via this lock. The short-held merge lock ensures only one task
 * squash-merges into the project branch at a time. Tasks on different
 * projects run without contention.
 */

import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

export interface BranchLockHandle {
  /** Release the lock. Idempotent — safe to call multiple times. */
  release: () => void;
}

interface LockEntry {
  holder: string | undefined; // taskId of current holder
  queue: Array<{
    taskId: string | undefined;
    resolve: (handle: BranchLockHandle) => void;
  }>;
}

export class BranchLockManager {
  private locks: Map<string, LockEntry> = new Map();

  /**
   * Derive a lock key scoped to the **project** level.
   *
   * All tasks in the same project share one merge lock so they serialize
   * **at merge time**. Task execution runs in parallel; only the
   * squash-merge into the project branch is serialized so each task
   * merges onto the current project branch tip.
   *
   * Key format: `{canonicalWorkdir}::{shortProjectId}`
   * Fallback:   `{canonicalWorkdir}::{taskId}`
   *
   * Uses `realpathSync` to follow symlinks so that the same repo accessed
   * via different paths (e.g., symlink vs real path) shares the same lock.
   * Falls back to `resolve()` if the path doesn't exist yet.
   */
  static computeLockKey(
    workdir: string,
    shortProjectId?: string,
    _shortNodeId?: string,
    taskId?: string,
  ): string {
    let canonicalWorkdir: string;
    try {
      canonicalWorkdir = realpathSync(workdir);
    } catch {
      // Path doesn't exist yet (e.g., worktree not created) — fall back to resolve()
      canonicalWorkdir = resolve(workdir);
    }
    const suffix = shortProjectId ?? taskId ?? 'unknown';
    return `${canonicalWorkdir}::${suffix}`;
  }

  /**
   * Acquire the lock for a given key.
   * Resolves immediately if unlocked; queues (FIFO) if another task holds it.
   */
  acquire(key: string, taskId?: string): Promise<BranchLockHandle> {
    let entry = this.locks.get(key);

    if (!entry) {
      // First acquisition — no contention
      entry = { holder: taskId, queue: [] };
      this.locks.set(key, entry);
      return Promise.resolve(this.createHandle(key));
    }

    if (entry.holder === undefined) {
      // Lock exists but is released — reacquire
      entry.holder = taskId;
      return Promise.resolve(this.createHandle(key));
    }

    // Lock is held — queue the waiter
    return new Promise<BranchLockHandle>((resolvePromise) => {
      entry.queue.push({ taskId, resolve: resolvePromise });
    });
  }

  /**
   * Release the lock and promote the next waiter (FIFO).
   */
  release(key: string): void {
    const entry = this.locks.get(key);
    if (!entry) return;

    if (entry.queue.length > 0) {
      const next = entry.queue.shift()!;
      entry.holder = next.taskId;
      next.resolve(this.createHandle(key));
    } else {
      // No waiters — clean up
      this.locks.delete(key);
    }
  }

  /** Check if a key is currently locked. */
  isLocked(key: string): boolean {
    const entry = this.locks.get(key);
    return entry !== undefined && entry.holder !== undefined;
  }

  /** Number of tasks waiting (not including the current holder). */
  getQueueLength(key: string): number {
    const entry = this.locks.get(key);
    return entry?.queue.length ?? 0;
  }

  /** Release all locks and resolve all waiters. Used during cancelAll(). */
  releaseAll(): void {
    for (const [key, entry] of this.locks) {
      // Resolve all queued waiters so their promises don't leak
      for (const waiter of entry.queue) {
        waiter.resolve(this.createHandle(key));
      }
      entry.queue = [];
      entry.holder = undefined;
    }
    this.locks.clear();
  }

  private createHandle(key: string): BranchLockHandle {
    let released = false;
    return {
      release: () => {
        if (released) return; // idempotent
        released = true;
        this.release(key);
      },
    };
  }
}
