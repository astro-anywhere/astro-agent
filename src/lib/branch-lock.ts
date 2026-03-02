/**
 * Per-branch async mutex for serializing worktree creation.
 *
 * When multiple tasks share the same branch (same project), they must
 * create worktrees sequentially to avoid "branch already exists" errors.
 * Tasks on different branches run in parallel without contention.
 */

import { resolve } from 'node:path';

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
   * Derive a lock key that matches the worktree branch naming in worktree.ts.
   *
   * Key format: `{resolvedWorkdir}::{shortProjectId}-{shortNodeId}`
   * Fallback:   `{resolvedWorkdir}::{taskId}`
   *
   * The workdir prefix scopes locks per repository so different repos
   * never contend even if they share project IDs.
   */
  static computeLockKey(
    workdir: string,
    shortProjectId?: string,
    shortNodeId?: string,
    taskId?: string,
  ): string {
    const resolvedWorkdir = resolve(workdir);
    const suffix =
      shortProjectId && shortNodeId
        ? `${shortProjectId}-${shortNodeId}`
        : taskId ?? 'unknown';
    return `${resolvedWorkdir}::${suffix}`;
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
