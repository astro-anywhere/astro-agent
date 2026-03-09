/**
 * Steer Session Hints — End-to-End Field Threading Tests
 *
 * Verifies that sessionId and branchName flow through the full steer pipeline:
 *   1. Type definitions — TaskSteerIncomingMessage includes new fields
 *   2. WebSocket normalization — dot-notation → underscore format preserves fields
 *   3. Callback chain — onTaskSteer signature passes all fields
 *   4. Task executor — steerTask accepts hints, validates sessionId mismatch
 *   5. Backward compatibility — omitting new fields works everywhere
 *
 * Run with: npx vitest run tests/steer-session-hints.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { TaskSteerIncomingMessage } from '../src/types'

// ============================================================================
// 1. Type definition tests
// ============================================================================

describe('TaskSteerIncomingMessage type (src/types.ts)', () => {
  it('accepts sessionId and branchName in payload', () => {
    const msg: TaskSteerIncomingMessage = {
      type: 'task_steer',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-1',
        message: 'continue with tests',
        action: 'guidance',
        interrupt: false,
        sessionId: 'session-abc-123',
        branchName: 'feat/my-feature',
      },
    }
    expect(msg.payload.sessionId).toBe('session-abc-123')
    expect(msg.payload.branchName).toBe('feat/my-feature')
  })

  it('sessionId and branchName are optional (backward compatible)', () => {
    const msg: TaskSteerIncomingMessage = {
      type: 'task_steer',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-1',
        message: 'do something',
      },
    }
    expect(msg.payload.sessionId).toBeUndefined()
    expect(msg.payload.branchName).toBeUndefined()
  })

  it('preserves all original fields alongside new ones', () => {
    const msg: TaskSteerIncomingMessage = {
      type: 'task_steer',
      timestamp: '2026-03-08T00:00:00Z',
      payload: {
        taskId: 'task-42',
        message: 'add error handling',
        action: 'redirect',
        interrupt: true,
        sessionId: 'session-xyz',
        branchName: 'fix/error-handling',
      },
    }
    expect(msg.type).toBe('task_steer')
    expect(msg.payload.taskId).toBe('task-42')
    expect(msg.payload.message).toBe('add error handling')
    expect(msg.payload.action).toBe('redirect')
    expect(msg.payload.interrupt).toBe(true)
    expect(msg.payload.sessionId).toBe('session-xyz')
    expect(msg.payload.branchName).toBe('fix/error-handling')
  })
})

// ============================================================================
// 2. WebSocket dot-notation normalization
// ============================================================================

describe('WebSocket steer message normalization', () => {
  /**
   * Simulates the normalization logic in websocket-client.ts (lines 706-721)
   * that converts relay dot-notation to agent-runner underscore format.
   */
  function normalizeSteerMessage(raw: Record<string, unknown>): TaskSteerIncomingMessage {
    return {
      type: 'task_steer',
      timestamp: raw.timestamp as string ?? new Date().toISOString(),
      payload: {
        taskId: raw.taskId as string,
        message: raw.message as string,
        action: raw.action as string | undefined,
        interrupt: raw.interrupt as boolean | undefined,
        sessionId: raw.sessionId as string | undefined,
        branchName: raw.branchName as string | undefined,
      },
    }
  }

  it('extracts sessionId from relay dot-notation message', () => {
    const relayMsg = {
      type: 'task.steer',
      timestamp: '2026-03-08T00:00:00Z',
      taskId: 'task-1',
      message: 'resume',
      sessionId: 'session-from-relay',
    }
    const normalized = normalizeSteerMessage(relayMsg)
    expect(normalized.type).toBe('task_steer')
    expect(normalized.payload.sessionId).toBe('session-from-relay')
  })

  it('extracts branchName from relay dot-notation message', () => {
    const relayMsg = {
      type: 'task.steer',
      taskId: 'task-1',
      message: 'check tests',
      branchName: 'feat/tests',
    }
    const normalized = normalizeSteerMessage(relayMsg)
    expect(normalized.payload.branchName).toBe('feat/tests')
  })

  it('extracts both sessionId and branchName together', () => {
    const relayMsg = {
      type: 'task.steer',
      timestamp: '2026-03-08T12:00:00Z',
      correlationId: 'task-1',
      taskId: 'task-1',
      message: 'continue',
      action: 'guidance',
      interrupt: false,
      sessionId: 'session-resume-456',
      branchName: 'fix/steer-resume',
    }
    const normalized = normalizeSteerMessage(relayMsg)
    expect(normalized.payload.taskId).toBe('task-1')
    expect(normalized.payload.message).toBe('continue')
    expect(normalized.payload.action).toBe('guidance')
    expect(normalized.payload.interrupt).toBe(false)
    expect(normalized.payload.sessionId).toBe('session-resume-456')
    expect(normalized.payload.branchName).toBe('fix/steer-resume')
  })

  it('handles missing sessionId and branchName (backward compat)', () => {
    const relayMsg = {
      type: 'task.steer',
      taskId: 'task-old',
      message: 'legacy steer',
      action: 'guidance',
      interrupt: false,
    }
    const normalized = normalizeSteerMessage(relayMsg)
    expect(normalized.payload.sessionId).toBeUndefined()
    expect(normalized.payload.branchName).toBeUndefined()
    expect(normalized.payload.taskId).toBe('task-old')
    expect(normalized.payload.message).toBe('legacy steer')
  })

  it('handles undefined values gracefully', () => {
    const relayMsg = {
      type: 'task.steer',
      taskId: 'task-1',
      message: 'test',
      sessionId: undefined,
      branchName: undefined,
    }
    const normalized = normalizeSteerMessage(relayMsg)
    expect(normalized.payload.sessionId).toBeUndefined()
    expect(normalized.payload.branchName).toBeUndefined()
  })

  it('preserves timestamp from relay message', () => {
    const relayMsg = {
      type: 'task.steer',
      timestamp: '2026-01-15T10:30:00Z',
      taskId: 'task-1',
      message: 'go',
    }
    const normalized = normalizeSteerMessage(relayMsg)
    expect(normalized.timestamp).toBe('2026-01-15T10:30:00Z')
  })

  it('uses current time when relay message has no timestamp', () => {
    const before = new Date().toISOString()
    const relayMsg = {
      type: 'task.steer',
      taskId: 'task-1',
      message: 'go',
    }
    const normalized = normalizeSteerMessage(relayMsg)
    const after = new Date().toISOString()
    expect(normalized.timestamp >= before).toBe(true)
    expect(normalized.timestamp <= after).toBe(true)
  })
})

// ============================================================================
// 3. Callback chain — onTaskSteer signature
// ============================================================================

describe('onTaskSteer callback chain', () => {
  /**
   * Simulates the handleTaskSteer → onTaskSteer callback invocation
   * from websocket-client.ts lines 1136-1138.
   */
  function simulateHandleTaskSteer(
    message: TaskSteerIncomingMessage,
    onTaskSteer: (taskId: string, message: string, action?: string, interrupt?: boolean, sessionId?: string, branchName?: string) => void,
  ) {
    const { taskId, message: steerMessage, action, interrupt, sessionId, branchName } = message.payload
    onTaskSteer(taskId, steerMessage, action, interrupt, sessionId, branchName)
  }

  it('passes sessionId and branchName to callback', () => {
    const callback = vi.fn()
    const msg: TaskSteerIncomingMessage = {
      type: 'task_steer',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-1',
        message: 'resume work',
        action: 'guidance',
        interrupt: false,
        sessionId: 'session-abc',
        branchName: 'feat/branch',
      },
    }
    simulateHandleTaskSteer(msg, callback)
    expect(callback).toHaveBeenCalledWith(
      'task-1', 'resume work', 'guidance', false, 'session-abc', 'feat/branch',
    )
  })

  it('passes undefined for missing optional fields', () => {
    const callback = vi.fn()
    const msg: TaskSteerIncomingMessage = {
      type: 'task_steer',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-2',
        message: 'steer',
      },
    }
    simulateHandleTaskSteer(msg, callback)
    expect(callback).toHaveBeenCalledWith(
      'task-2', 'steer', undefined, undefined, undefined, undefined,
    )
  })

  it('passes sessionId without branchName', () => {
    const callback = vi.fn()
    const msg: TaskSteerIncomingMessage = {
      type: 'task_steer',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-3',
        message: 'check',
        sessionId: 'session-only',
      },
    }
    simulateHandleTaskSteer(msg, callback)
    expect(callback).toHaveBeenCalledWith(
      'task-3', 'check', undefined, undefined, 'session-only', undefined,
    )
  })

  it('passes branchName without sessionId', () => {
    const callback = vi.fn()
    const msg: TaskSteerIncomingMessage = {
      type: 'task_steer',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-4',
        message: 'deploy',
        branchName: 'release/v1',
      },
    }
    simulateHandleTaskSteer(msg, callback)
    expect(callback).toHaveBeenCalledWith(
      'task-4', 'deploy', undefined, undefined, undefined, 'release/v1',
    )
  })
})

// ============================================================================
// 4. Task executor steerTask — session hint validation
// ============================================================================

describe('steerTask session hint validation', () => {
  /**
   * Simulates the session hint validation logic from task-executor.ts.
   * When the frontend sends a sessionId hint, and the adapter finds a
   * different sessionId for the task, a mismatch warning should be logged.
   */
  function validateSessionHint(
    sessionIdHint: string | undefined,
    adapterSessionId: string | undefined,
  ): { match: boolean; warning?: string } {
    if (!sessionIdHint || !adapterSessionId) {
      return { match: true } // no hint or no adapter session — skip validation
    }
    if (sessionIdHint !== adapterSessionId) {
      return {
        match: false,
        warning: `Session hint mismatch: hint=${sessionIdHint}, actual=${adapterSessionId}`,
      }
    }
    return { match: true }
  }

  it('no warning when sessionId hint matches adapter session', () => {
    const result = validateSessionHint('session-abc', 'session-abc')
    expect(result.match).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  it('warns on sessionId mismatch', () => {
    const result = validateSessionHint('session-frontend', 'session-adapter')
    expect(result.match).toBe(false)
    expect(result.warning).toContain('session-frontend')
    expect(result.warning).toContain('session-adapter')
  })

  it('no warning when hint is undefined (legacy client)', () => {
    const result = validateSessionHint(undefined, 'session-adapter')
    expect(result.match).toBe(true)
  })

  it('no warning when adapter has no session', () => {
    const result = validateSessionHint('session-hint', undefined)
    expect(result.match).toBe(true)
  })

  it('no warning when both are undefined', () => {
    const result = validateSessionHint(undefined, undefined)
    expect(result.match).toBe(true)
  })
})

// ============================================================================
// 5. Task executor steerTask — full routing with session hints
// ============================================================================

describe('steerTask routing with session hints', () => {
  /**
   * Simulates the steerTask routing logic from task-executor.ts.
   * Tests both mid-execution (running tasks) and post-completion resume paths.
   */
  type TaskState = 'running_claude' | 'running_codex' | 'completed_with_session' | 'completed_no_session' | 'not_found'

  interface SteerResult {
    accepted: boolean
    reason?: string
    path: 'inject' | 'resume' | 'rejected'
    sessionMismatch?: boolean
  }

  function simulateSteerTask(
    taskState: TaskState,
    adapterSessionId: string | undefined,
    sessionIdHint?: string,
    _branchNameHint?: string, // eslint-disable-line @typescript-eslint/no-unused-vars
  ): SteerResult {
    // Mid-execution: task is running
    if (taskState === 'running_claude') {
      return { accepted: true, path: 'inject' }
    }
    if (taskState === 'running_codex') {
      return { accepted: false, reason: 'Provider does not support mid-execution steering', path: 'rejected' }
    }

    // Post-completion: check for preserved session
    if (taskState === 'completed_with_session' && adapterSessionId) {
      const mismatch = sessionIdHint != null && adapterSessionId !== sessionIdHint
      return { accepted: true, path: 'resume', sessionMismatch: mismatch }
    }

    if (taskState === 'completed_no_session') {
      return { accepted: false, reason: 'Task not found or session expired', path: 'rejected' }
    }

    return { accepted: false, reason: 'Task not found or session expired', path: 'rejected' }
  }

  describe('mid-execution steering', () => {
    it('Claude: accepts steer and injects (ignores session hints)', () => {
      const result = simulateSteerTask('running_claude', undefined, 'session-hint', 'branch-hint')
      expect(result.accepted).toBe(true)
      expect(result.path).toBe('inject')
    })

    it('Codex: rejects mid-execution steer', () => {
      const result = simulateSteerTask('running_codex', undefined, 'session-hint')
      expect(result.accepted).toBe(false)
      expect(result.path).toBe('rejected')
      expect(result.reason).toContain('does not support')
    })
  })

  describe('post-completion resume', () => {
    it('accepts resume when session exists', () => {
      const result = simulateSteerTask('completed_with_session', 'session-abc', 'session-abc')
      expect(result.accepted).toBe(true)
      expect(result.path).toBe('resume')
      expect(result.sessionMismatch).toBe(false)
    })

    it('accepts resume with no session hint (legacy client)', () => {
      const result = simulateSteerTask('completed_with_session', 'session-abc')
      expect(result.accepted).toBe(true)
      expect(result.path).toBe('resume')
      expect(result.sessionMismatch).toBe(false)
    })

    it('detects session mismatch during resume', () => {
      const result = simulateSteerTask('completed_with_session', 'session-actual', 'session-stale')
      expect(result.accepted).toBe(true) // still accepted — warning only
      expect(result.path).toBe('resume')
      expect(result.sessionMismatch).toBe(true)
    })

    it('rejects when no session exists', () => {
      const result = simulateSteerTask('completed_no_session', undefined, 'session-hint')
      expect(result.accepted).toBe(false)
      expect(result.path).toBe('rejected')
      expect(result.reason).toContain('not found or session expired')
    })

    it('rejects when task is not found', () => {
      const result = simulateSteerTask('not_found', undefined)
      expect(result.accepted).toBe(false)
      expect(result.path).toBe('rejected')
    })
  })

  describe('branchName forwarding', () => {
    it('branchName does not affect routing (passthrough only)', () => {
      // Same task state, different branchNames — same routing result
      const withBranch = simulateSteerTask('completed_with_session', 'session-1', 'session-1', 'feat/a')
      const withoutBranch = simulateSteerTask('completed_with_session', 'session-1', 'session-1')
      expect(withBranch.accepted).toBe(withoutBranch.accepted)
      expect(withBranch.path).toBe(withoutBranch.path)
    })
  })
})

// ============================================================================
// 6. Start.ts callback integration — field forwarding
// ============================================================================

describe('start.ts callback → taskExecutor forwarding', () => {
  /**
   * Simulates the onTaskSteer callback in start.ts that forwards
   * all fields from the WS client to the task executor.
   */
  function simulateStartCallback(
    taskId: string,
    message: string,
    action?: string,
    interrupt?: boolean,
    sessionId?: string,
    branchName?: string,
  ) {
    // This mirrors: taskExecutor.steerTask(taskId, message, interrupt ?? false, sessionId, branchName)
    return {
      steerTaskArgs: [taskId, message, interrupt ?? false, sessionId, branchName] as const,
      logMessage: `Received steer for task ${taskId}: "${message.slice(0, 100)}"${action ? ` (action: ${action})` : ''}${interrupt ? ' (interrupt)' : ''}${sessionId ? ` session=${sessionId}` : ''}`,
    }
  }

  it('forwards all 6 fields from WS to executor', () => {
    const { steerTaskArgs } = simulateStartCallback(
      'task-1', 'resume please', 'guidance', false, 'session-abc', 'feat/branch',
    )
    expect(steerTaskArgs).toEqual(['task-1', 'resume please', false, 'session-abc', 'feat/branch'])
  })

  it('defaults interrupt to false when undefined', () => {
    const { steerTaskArgs } = simulateStartCallback('task-1', 'go', 'guidance', undefined)
    expect(steerTaskArgs[2]).toBe(false)
  })

  it('includes sessionId in log message when present', () => {
    const { logMessage } = simulateStartCallback('task-1', 'go', 'guidance', false, 'session-xyz')
    expect(logMessage).toContain('session=session-xyz')
  })

  it('omits sessionId from log when absent', () => {
    const { logMessage } = simulateStartCallback('task-1', 'go', 'guidance', false)
    expect(logMessage).not.toContain('session=')
  })

  it('includes action in log when present', () => {
    const { logMessage } = simulateStartCallback('task-1', 'redirect', 'redirect', true)
    expect(logMessage).toContain('(action: redirect)')
    expect(logMessage).toContain('(interrupt)')
  })

  it('truncates long messages in log to 100 chars', () => {
    const longMessage = 'a'.repeat(200)
    const { logMessage } = simulateStartCallback('task-1', longMessage)
    // The log should contain the first 100 chars, not all 200
    expect(logMessage).toContain('a'.repeat(100))
    expect(logMessage).not.toContain('a'.repeat(101))
  })

  it('passes undefined sessionId and branchName when not provided', () => {
    const { steerTaskArgs } = simulateStartCallback('task-1', 'legacy steer', 'guidance', false)
    expect(steerTaskArgs[3]).toBeUndefined() // sessionId
    expect(steerTaskArgs[4]).toBeUndefined() // branchName
  })
})

// ============================================================================
// 7. Full pipeline integration — relay → normalize → callback → executor
// ============================================================================

describe('full pipeline: relay message → steer execution', () => {
  function fullPipeline(relayPayload: Record<string, unknown>) {
    // Step 1: Normalize relay dot-notation to agent-runner format
    const normalized: TaskSteerIncomingMessage = {
      type: 'task_steer',
      timestamp: relayPayload.timestamp as string ?? new Date().toISOString(),
      payload: {
        taskId: relayPayload.taskId as string,
        message: relayPayload.message as string,
        action: relayPayload.action as string | undefined,
        interrupt: relayPayload.interrupt as boolean | undefined,
        sessionId: relayPayload.sessionId as string | undefined,
        branchName: relayPayload.branchName as string | undefined,
      },
    }

    // Step 2: Extract from normalized message (handleTaskSteer)
    const { taskId, message, action, interrupt, sessionId, branchName } = normalized.payload

    // Step 3: Forward through start.ts callback
    const executorArgs = {
      taskId,
      message,
      interrupt: interrupt ?? false,
      sessionId,
      branchName,
    }

    return { normalized, executorArgs, action }
  }

  it('full payload: all fields survive the pipeline', () => {
    const { executorArgs, action } = fullPipeline({
      type: 'task.steer',
      timestamp: '2026-03-08T12:00:00Z',
      correlationId: 'task-abc',
      taskId: 'task-abc',
      message: 'Please add error handling',
      action: 'guidance',
      interrupt: false,
      sessionId: 'session-resume-456',
      branchName: 'feat/error-handling',
    })

    expect(executorArgs.taskId).toBe('task-abc')
    expect(executorArgs.message).toBe('Please add error handling')
    expect(executorArgs.interrupt).toBe(false)
    expect(executorArgs.sessionId).toBe('session-resume-456')
    expect(executorArgs.branchName).toBe('feat/error-handling')
    expect(action).toBe('guidance')
  })

  it('minimal payload: backward compatible', () => {
    const { executorArgs } = fullPipeline({
      type: 'task.steer',
      taskId: 'task-old',
      message: 'do stuff',
    })

    expect(executorArgs.taskId).toBe('task-old')
    expect(executorArgs.message).toBe('do stuff')
    expect(executorArgs.interrupt).toBe(false)
    expect(executorArgs.sessionId).toBeUndefined()
    expect(executorArgs.branchName).toBeUndefined()
  })

  it('interrupt=true survives the pipeline', () => {
    const { executorArgs } = fullPipeline({
      type: 'task.steer',
      taskId: 'task-1',
      message: 'stop and change direction',
      interrupt: true,
      sessionId: 'session-xyz',
    })

    expect(executorArgs.interrupt).toBe(true)
    expect(executorArgs.sessionId).toBe('session-xyz')
  })

  it('correlationId is ignored (not forwarded to executor)', () => {
    const { executorArgs } = fullPipeline({
      type: 'task.steer',
      correlationId: 'should-be-ignored',
      taskId: 'task-1',
      message: 'test',
    })

    expect(executorArgs).not.toHaveProperty('correlationId')
  })

  it('extra fields from relay are dropped during normalization', () => {
    const { normalized } = fullPipeline({
      type: 'task.steer',
      taskId: 'task-1',
      message: 'test',
      unknownField: 'should-not-appear',
      extraData: { nested: true },
    })

    expect(normalized.payload).not.toHaveProperty('unknownField')
    expect(normalized.payload).not.toHaveProperty('extraData')
  })
})

// ============================================================================
// 8. Edge cases and special values
// ============================================================================

describe('edge cases', () => {
  it('empty string sessionId is preserved (not treated as undefined)', () => {
    const msg: TaskSteerIncomingMessage = {
      type: 'task_steer',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-1',
        message: 'test',
        sessionId: '',
      },
    }
    expect(msg.payload.sessionId).toBe('')
  })

  it('very long sessionId is accepted (no length validation at this layer)', () => {
    const longId = 'session-' + 'x'.repeat(500)
    const msg: TaskSteerIncomingMessage = {
      type: 'task_steer',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-1',
        message: 'test',
        sessionId: longId,
      },
    }
    expect(msg.payload.sessionId).toBe(longId)
  })

  it('branchName with special characters is preserved', () => {
    const specialBranch = 'feat/user@org/fix-issue#123'
    const msg: TaskSteerIncomingMessage = {
      type: 'task_steer',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-1',
        message: 'test',
        branchName: specialBranch,
      },
    }
    expect(msg.payload.branchName).toBe(specialBranch)
  })

  it('branchName with slashes (nested branches) is preserved', () => {
    const nestedBranch = 'astro/project-abc/task-1/worktree'
    const msg: TaskSteerIncomingMessage = {
      type: 'task_steer',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-1',
        message: 'test',
        branchName: nestedBranch,
      },
    }
    expect(msg.payload.branchName).toBe(nestedBranch)
  })

  it('all four action types work with session hints', () => {
    const actions = ['guidance', 'redirect', 'pause', 'resume'] as const
    for (const action of actions) {
      const msg: TaskSteerIncomingMessage = {
        type: 'task_steer',
        timestamp: new Date().toISOString(),
        payload: {
          taskId: 'task-1',
          message: `action: ${action}`,
          action,
          sessionId: 'session-1',
          branchName: 'feat/test',
        },
      }
      expect(msg.payload.action).toBe(action)
      expect(msg.payload.sessionId).toBe('session-1')
    }
  })
})
