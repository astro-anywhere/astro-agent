/**
 * Unit tests for BranchLockManager — per-branch async mutex
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BranchLockManager } from '../branch-lock.js';

describe('BranchLockManager', () => {
  let manager: BranchLockManager;

  beforeEach(() => {
    manager = new BranchLockManager();
  });

  describe('computeLockKey', () => {
    it('should use shortProjectId-shortNodeId when both are provided', () => {
      const key = BranchLockManager.computeLockKey('/repo', 'abc123', 'def456');
      expect(key).toBe('/repo::abc123-def456');
    });

    it('should fall back to taskId when short IDs are missing', () => {
      const key = BranchLockManager.computeLockKey('/repo', undefined, undefined, 'task-42');
      expect(key).toBe('/repo::task-42');
    });

    it('should use "unknown" when nothing is provided', () => {
      const key = BranchLockManager.computeLockKey('/repo');
      expect(key).toBe('/repo::unknown');
    });

    it('should resolve relative paths', () => {
      const key = BranchLockManager.computeLockKey('./relative', 'abc', 'def');
      expect(key).toContain('::abc-def');
      expect(key).not.toContain('./');
    });

    it('should scope keys by workdir so different repos never collide', () => {
      const key1 = BranchLockManager.computeLockKey('/repo-a', 'abc', 'def');
      const key2 = BranchLockManager.computeLockKey('/repo-b', 'abc', 'def');
      expect(key1).not.toBe(key2);
    });
  });

  describe('acquire and release', () => {
    it('should acquire immediately when unlocked', async () => {
      const handle = await manager.acquire('key-1', 'task-a');
      expect(manager.isLocked('key-1')).toBe(true);
      handle.release();
    });

    it('should release and clean up', async () => {
      const handle = await manager.acquire('key-1', 'task-a');
      handle.release();
      expect(manager.isLocked('key-1')).toBe(false);
    });

    it('should allow re-acquisition after release', async () => {
      const h1 = await manager.acquire('key-1', 'task-a');
      h1.release();

      const h2 = await manager.acquire('key-1', 'task-b');
      expect(manager.isLocked('key-1')).toBe(true);
      h2.release();
    });
  });

  describe('FIFO ordering', () => {
    it('should serialize tasks on the same key in FIFO order', async () => {
      const order: string[] = [];

      // First task acquires immediately
      const h1 = await manager.acquire('key-1', 'task-1');
      order.push('task-1-acquired');

      // Second and third tasks queue up
      const p2 = manager.acquire('key-1', 'task-2').then((h) => {
        order.push('task-2-acquired');
        return h;
      });
      const p3 = manager.acquire('key-1', 'task-3').then((h) => {
        order.push('task-3-acquired');
        return h;
      });

      expect(manager.getQueueLength('key-1')).toBe(2);

      // Release first → second should acquire
      h1.release();
      const h2 = await p2;
      expect(order).toEqual(['task-1-acquired', 'task-2-acquired']);

      // Release second → third should acquire
      h2.release();
      const h3 = await p3;
      expect(order).toEqual(['task-1-acquired', 'task-2-acquired', 'task-3-acquired']);

      h3.release();
      expect(manager.isLocked('key-1')).toBe(false);
      expect(manager.getQueueLength('key-1')).toBe(0);
    });
  });

  describe('parallel different keys', () => {
    it('should allow concurrent acquisition on different keys', async () => {
      const h1 = await manager.acquire('key-a', 'task-1');
      const h2 = await manager.acquire('key-b', 'task-2');

      // Both acquired without blocking
      expect(manager.isLocked('key-a')).toBe(true);
      expect(manager.isLocked('key-b')).toBe(true);

      h1.release();
      h2.release();
    });
  });

  describe('idempotent release', () => {
    it('should be safe to call release() multiple times on the same handle', async () => {
      const h1 = await manager.acquire('key-1', 'task-1');
      const p2 = manager.acquire('key-1', 'task-2');

      // Double release should not promote two waiters
      h1.release();
      h1.release(); // should be no-op

      const h2 = await p2;
      expect(manager.isLocked('key-1')).toBe(true);
      h2.release();
    });

    it('should not corrupt state when double-released without waiters', async () => {
      const h1 = await manager.acquire('key-1', 'task-1');
      h1.release();
      h1.release(); // no-op

      // Should still be acquirable
      const h2 = await manager.acquire('key-1', 'task-2');
      expect(manager.isLocked('key-1')).toBe(true);
      h2.release();
    });
  });

  describe('queue length tracking', () => {
    it('should return 0 for unknown keys', () => {
      expect(manager.getQueueLength('nonexistent')).toBe(0);
    });

    it('should track queue length correctly as tasks queue and dequeue', async () => {
      const h1 = await manager.acquire('key-1', 'task-1');
      expect(manager.getQueueLength('key-1')).toBe(0);

      const p2 = manager.acquire('key-1', 'task-2');
      expect(manager.getQueueLength('key-1')).toBe(1);

      const p3 = manager.acquire('key-1', 'task-3');
      expect(manager.getQueueLength('key-1')).toBe(2);

      h1.release();
      const h2 = await p2;
      expect(manager.getQueueLength('key-1')).toBe(1);

      h2.release();
      const h3 = await p3;
      expect(manager.getQueueLength('key-1')).toBe(0);

      h3.release();
    });
  });

  describe('releaseAll', () => {
    it('should release all locks and resolve all waiters', async () => {
      const h1 = await manager.acquire('key-a', 'task-1');
      const p2 = manager.acquire('key-a', 'task-2');
      const h3 = await manager.acquire('key-b', 'task-3');

      // Suppress unused variable warnings — we just need them resolved
      void h1;
      void h3;

      manager.releaseAll();

      // Queued waiter should have resolved
      const h2 = await p2;
      expect(h2).toBeDefined();
      expect(h2.release).toBeTypeOf('function');

      // All locks should be cleared
      expect(manager.isLocked('key-a')).toBe(false);
      expect(manager.isLocked('key-b')).toBe(false);
    });
  });

  describe('isLocked', () => {
    it('should return false for unknown keys', () => {
      expect(manager.isLocked('nonexistent')).toBe(false);
    });

    it('should reflect current state accurately', async () => {
      expect(manager.isLocked('key-1')).toBe(false);

      const h = await manager.acquire('key-1', 'task-1');
      expect(manager.isLocked('key-1')).toBe(true);

      h.release();
      expect(manager.isLocked('key-1')).toBe(false);
    });
  });
});
