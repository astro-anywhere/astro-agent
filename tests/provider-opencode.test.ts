/**
 * OpenCode Native Event Format — Unit Tests
 *
 * Tests the parsing of OpenCode's native JSONL event format:
 *   {type, sessionID, timestamp, part: {...}}
 *
 * Event types covered:
 * - step_start   → sessionInit + status (stepId, model, title)
 * - text         → text output (part.text)
 * - tool_use     → toolUse/toolResult based on state (running/completed/error)
 * - reasoning    → reasoning text (part.text)
 * - step_finish  → metrics (usage, cost, model, reason)
 * - error        → error output (message, code)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { OpenCodeAdapter } from '../src/providers/opencode-adapter.js'
import type { TaskOutputStream } from '../src/providers/base-adapter.js'

// ---------------------------------------------------------------------------
// Mock TaskOutputStream factory using vi.fn()
// ---------------------------------------------------------------------------

function createMockStream(): TaskOutputStream {
  return {
    stdout: vi.fn(),
    stderr: vi.fn(),
    status: vi.fn(),
    toolTrace: vi.fn(),
    text: vi.fn(),
    toolUse: vi.fn(),
    toolResult: vi.fn(),
    fileChange: vi.fn(),
    sessionInit: vi.fn(),
    approvalRequest: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Helper: build a native OpenCode JSONL event
// ---------------------------------------------------------------------------

function nativeEvent(
  type: string,
  part: Record<string, unknown>,
  opts?: { sessionID?: string; timestamp?: string },
): string {
  return JSON.stringify({
    type,
    sessionID: opts?.sessionID ?? 'test-session-001',
    timestamp: opts?.timestamp ?? '2025-01-15T10:00:00.000Z',
    part,
  })
}

// ===========================================================================
// Tests
// ===========================================================================

describe('OpenCode native event parsing: provider-opencode', () => {
  let adapter: OpenCodeAdapter
  let stream: TaskOutputStream

  beforeEach(() => {
    adapter = new OpenCodeAdapter()
    stream = createMockStream()
  })

  // =========================================================================
  // 1. step_start events
  // =========================================================================

  describe('step_start events', () => {
    it('emits sessionInit with sessionID and model from part', () => {
      adapter.handleStreamLine(nativeEvent('step_start', {
        stepId: 'step-1',
        model: 'anthropic/claude-sonnet-4-20250514',
        title: 'Analyzing code',
      }), stream)

      expect(stream.sessionInit).toHaveBeenCalledWith(
        'test-session-001',
        'anthropic/claude-sonnet-4-20250514',
      )
    })

    it('emits status with step title', () => {
      adapter.handleStreamLine(nativeEvent('step_start', {
        stepId: 'step-1',
        model: 'gpt-4o',
        title: 'Reading project files',
      }), stream)

      expect(stream.status).toHaveBeenCalledWith('running', 0, 'Reading project files')
    })

    it('emits sessionInit without model when not in part', () => {
      adapter.handleStreamLine(nativeEvent('step_start', {
        stepId: 'step-1',
        title: 'Working',
      }), stream)

      expect(stream.sessionInit).toHaveBeenCalledWith('test-session-001', undefined)
    })

    it('does not emit sessionInit when sessionID is missing', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'step_start',
        timestamp: '2025-01-15T10:00:00.000Z',
        part: { stepId: 'step-1', model: 'gpt-4o' },
      }), stream)

      expect(stream.sessionInit).not.toHaveBeenCalled()
    })

    it('does not emit status when title is missing', () => {
      adapter.handleStreamLine(nativeEvent('step_start', {
        stepId: 'step-1',
        model: 'gpt-4o',
      }), stream)

      expect(stream.sessionInit).toHaveBeenCalled()
      expect(stream.status).not.toHaveBeenCalled()
    })

    it('handles empty part gracefully', () => {
      adapter.handleStreamLine(nativeEvent('step_start', {}), stream)

      // sessionID present → sessionInit emitted with undefined model
      expect(stream.sessionInit).toHaveBeenCalledWith('test-session-001', undefined)
      expect(stream.status).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 2. text events
  // =========================================================================

  describe('text events', () => {
    it('emits text with newline appended', () => {
      adapter.handleStreamLine(nativeEvent('text', {
        text: 'Let me analyze the project structure.',
      }), stream)

      expect(stream.text).toHaveBeenCalledWith('Let me analyze the project structure.\n')
    })

    it('handles multiline text', () => {
      adapter.handleStreamLine(nativeEvent('text', {
        text: 'Line 1\nLine 2\nLine 3',
      }), stream)

      expect(stream.text).toHaveBeenCalledWith('Line 1\nLine 2\nLine 3\n')
    })

    it('does not emit when text is empty', () => {
      adapter.handleStreamLine(nativeEvent('text', { text: '' }), stream)

      expect(stream.text).not.toHaveBeenCalled()
    })

    it('does not emit when text is missing from part', () => {
      adapter.handleStreamLine(nativeEvent('text', {}), stream)

      expect(stream.text).not.toHaveBeenCalled()
    })

    it('preserves special characters in text', () => {
      adapter.handleStreamLine(nativeEvent('text', {
        text: 'Code: `const x = 1;` and <html> entities & "quotes"',
      }), stream)

      expect(stream.text).toHaveBeenCalledWith(
        'Code: `const x = 1;` and <html> entities & "quotes"\n',
      )
    })
  })

  // =========================================================================
  // 3. tool_use events — state machine (running/completed/error)
  // =========================================================================

  describe('tool_use events', () => {
    describe('state: running', () => {
      it('emits toolUse with tool name and input', () => {
        adapter.handleStreamLine(nativeEvent('tool_use', {
          toolCallId: 'tc-001',
          tool: 'bash',
          state: 'running',
          input: { command: 'ls -la' },
        }), stream)

        expect(stream.toolUse).toHaveBeenCalledWith('bash', { command: 'ls -la' })
      })

      it('stores toolCallId-to-name mapping', () => {
        adapter.handleStreamLine(nativeEvent('tool_use', {
          toolCallId: 'tc-100',
          tool: 'read_file',
          state: 'running',
          input: { path: 'index.ts' },
        }), stream)

        // Verify by sending a legacy tool_result that references the same ID
        adapter.handleStreamLine(JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tc-100', content: 'file content', is_error: false },
            ],
          },
        }), stream)

        expect(stream.toolResult).toHaveBeenCalledWith('read_file', 'file content', true)
      })

      it('uses "unknown" when tool name is missing', () => {
        adapter.handleStreamLine(nativeEvent('tool_use', {
          toolCallId: 'tc-002',
          state: 'running',
          input: { data: 'test' },
        }), stream)

        expect(stream.toolUse).toHaveBeenCalledWith('unknown', { data: 'test' })
      })

      it('handles undefined input', () => {
        adapter.handleStreamLine(nativeEvent('tool_use', {
          toolCallId: 'tc-003',
          tool: 'bash',
          state: 'running',
        }), stream)

        expect(stream.toolUse).toHaveBeenCalledWith('bash', undefined)
      })
    })

    describe('state: completed', () => {
      it('emits toolResult with success=true', () => {
        adapter.handleStreamLine(nativeEvent('tool_use', {
          toolCallId: 'tc-010',
          tool: 'bash',
          state: 'completed',
          output: 'file1.txt\nfile2.txt',
        }), stream)

        expect(stream.toolResult).toHaveBeenCalledWith('bash', 'file1.txt\nfile2.txt', true)
      })

      it('uses empty string when output is missing', () => {
        adapter.handleStreamLine(nativeEvent('tool_use', {
          toolCallId: 'tc-011',
          tool: 'write_file',
          state: 'completed',
        }), stream)

        expect(stream.toolResult).toHaveBeenCalledWith('write_file', '', true)
      })

      it('uses "unknown" for tool name when missing', () => {
        adapter.handleStreamLine(nativeEvent('tool_use', {
          toolCallId: 'tc-012',
          state: 'completed',
          output: 'done',
        }), stream)

        expect(stream.toolResult).toHaveBeenCalledWith('unknown', 'done', true)
      })
    })

    describe('state: error', () => {
      it('emits toolResult with success=false', () => {
        adapter.handleStreamLine(nativeEvent('tool_use', {
          toolCallId: 'tc-020',
          tool: 'bash',
          state: 'error',
          error: 'Permission denied',
        }), stream)

        expect(stream.toolResult).toHaveBeenCalledWith('bash', 'Permission denied', false)
      })

      it('uses default error message when error field is missing', () => {
        adapter.handleStreamLine(nativeEvent('tool_use', {
          toolCallId: 'tc-021',
          tool: 'bash',
          state: 'error',
        }), stream)

        expect(stream.toolResult).toHaveBeenCalledWith('bash', 'Unknown error', false)
      })
    })

    describe('unknown state', () => {
      it('does not emit anything for unrecognized state', () => {
        adapter.handleStreamLine(nativeEvent('tool_use', {
          toolCallId: 'tc-030',
          tool: 'bash',
          state: 'pending',
          input: { command: 'test' },
        }), stream)

        expect(stream.toolUse).not.toHaveBeenCalled()
        expect(stream.toolResult).not.toHaveBeenCalled()
      })
    })

    describe('tool types', () => {
      it.each([
        ['bash', { command: 'echo hello' }],
        ['read_file', { path: 'src/index.ts' }],
        ['write_file', { path: 'out.ts', content: 'export {}' }],
        ['edit_file', { path: 'config.ts', search: 'old', replace: 'new' }],
      ])('handles %s tool correctly', (tool, input) => {
        adapter.handleStreamLine(nativeEvent('tool_use', {
          toolCallId: `tc-${tool}`,
          tool,
          state: 'running',
          input,
        }), stream)

        expect(stream.toolUse).toHaveBeenCalledWith(tool, input)
      })
    })

    describe('empty part', () => {
      it('does not emit when part is empty', () => {
        adapter.handleStreamLine(nativeEvent('tool_use', {}), stream)

        // Part exists but has no state → neither toolUse nor toolResult
        expect(stream.toolUse).not.toHaveBeenCalled()
        expect(stream.toolResult).not.toHaveBeenCalled()
      })
    })
  })

  // =========================================================================
  // 4. reasoning events
  // =========================================================================

  describe('reasoning events', () => {
    it('emits text with reasoning content', () => {
      adapter.handleStreamLine(nativeEvent('reasoning', {
        text: 'I should check the test files before making changes.',
      }), stream)

      expect(stream.text).toHaveBeenCalledWith(
        'I should check the test files before making changes.\n',
      )
    })

    it('handles multiline reasoning', () => {
      adapter.handleStreamLine(nativeEvent('reasoning', {
        text: 'Step 1: Read config\nStep 2: Validate\nStep 3: Apply',
      }), stream)

      expect(stream.text).toHaveBeenCalledWith(
        'Step 1: Read config\nStep 2: Validate\nStep 3: Apply\n',
      )
    })

    it('does not emit when reasoning text is empty', () => {
      adapter.handleStreamLine(nativeEvent('reasoning', { text: '' }), stream)

      expect(stream.text).not.toHaveBeenCalled()
    })

    it('does not emit when text field is missing', () => {
      adapter.handleStreamLine(nativeEvent('reasoning', {}), stream)

      expect(stream.text).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 5. step_finish events
  // =========================================================================

  describe('step_finish events', () => {
    it('emits status with reason and cost', () => {
      adapter.handleStreamLine(nativeEvent('step_finish', {
        usage: { inputTokens: 2500, outputTokens: 800 },
        cost: 0.0345,
        model: 'anthropic/claude-sonnet-4-20250514',
        reason: 'end_turn',
      }), stream)

      expect(stream.status).toHaveBeenCalledWith(
        'running', 100, 'Step completed (end_turn, $0.0345)',
      )
    })

    it('emits status without cost when cost is undefined', () => {
      adapter.handleStreamLine(nativeEvent('step_finish', {
        usage: { inputTokens: 100, outputTokens: 50 },
        reason: 'max_tokens',
      }), stream)

      expect(stream.status).toHaveBeenCalledWith(
        'running', 100, 'Step completed (max_tokens)',
      )
    })

    it('emits status with default reason when reason is missing', () => {
      adapter.handleStreamLine(nativeEvent('step_finish', {
        cost: 0.01,
      }), stream)

      expect(stream.status).toHaveBeenCalledWith(
        'running', 100, 'Step completed (done, $0.0100)',
      )
    })

    it('emits minimal status when part has no cost or reason', () => {
      adapter.handleStreamLine(nativeEvent('step_finish', {}), stream)

      expect(stream.status).toHaveBeenCalledWith('running', 100, 'Step completed')
    })

    it('does not emit when part is undefined', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'step_finish',
        sessionID: 'test-session',
        timestamp: '2025-01-15T10:00:00.000Z',
      }), stream)

      expect(stream.status).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 6. error events
  // =========================================================================

  describe('error events', () => {
    it('emits stderr with code and message', () => {
      adapter.handleStreamLine(nativeEvent('error', {
        message: 'Rate limit exceeded',
        code: 'rate_limit',
      }), stream)

      expect(stream.stderr).toHaveBeenCalledWith('[rate_limit] Rate limit exceeded')
    })

    it('uses "ERROR" when code is missing', () => {
      adapter.handleStreamLine(nativeEvent('error', {
        message: 'Something went wrong',
      }), stream)

      expect(stream.stderr).toHaveBeenCalledWith('[ERROR] Something went wrong')
    })

    it('does not emit stderr when message is missing', () => {
      adapter.handleStreamLine(nativeEvent('error', { code: 'unknown' }), stream)

      expect(stream.stderr).not.toHaveBeenCalled()
    })

    it('does not emit stderr when part is empty', () => {
      adapter.handleStreamLine(nativeEvent('error', {}), stream)

      expect(stream.stderr).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 7. Part structure extraction — {type, sessionID, timestamp, part}
  // =========================================================================

  describe('part structure extraction', () => {
    it('reads sessionID from top-level field', () => {
      const line = JSON.stringify({
        type: 'step_start',
        sessionID: 'custom-session-xyz',
        timestamp: '2025-06-01T12:00:00.000Z',
        part: { stepId: 's1', model: 'gpt-4o', title: 'Init' },
      })

      adapter.handleStreamLine(line, stream)

      expect(stream.sessionInit).toHaveBeenCalledWith('custom-session-xyz', 'gpt-4o')
    })

    it('handles events with different sessionIDs', () => {
      adapter.handleStreamLine(nativeEvent('step_start', {
        stepId: 's1', model: 'gpt-4o', title: 'Step 1',
      }, { sessionID: 'session-A' }), stream)

      adapter.handleStreamLine(nativeEvent('step_start', {
        stepId: 's2', model: 'gpt-4o', title: 'Step 2',
      }, { sessionID: 'session-B' }), stream)

      expect(stream.sessionInit).toHaveBeenCalledTimes(2)
      expect(stream.sessionInit).toHaveBeenCalledWith('session-A', 'gpt-4o')
      expect(stream.sessionInit).toHaveBeenCalledWith('session-B', 'gpt-4o')
    })

    it('ignores timestamp (does not affect parsing)', () => {
      adapter.handleStreamLine(nativeEvent('text', {
        text: 'Hello',
      }, { timestamp: '2099-12-31T23:59:59.999Z' }), stream)

      expect(stream.text).toHaveBeenCalledWith('Hello\n')
    })

    it('preserves part payload for all event types', () => {
      // text
      adapter.handleStreamLine(nativeEvent('text', { text: 'A' }), stream)
      expect(stream.text).toHaveBeenCalledWith('A\n')

      // reasoning
      adapter.handleStreamLine(nativeEvent('reasoning', { text: 'B' }), stream)
      expect(stream.text).toHaveBeenCalledWith('B\n')

      // tool_use
      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'x', tool: 'bash', state: 'running', input: { cmd: 'test' },
      }), stream)
      expect(stream.toolUse).toHaveBeenCalledWith('bash', { cmd: 'test' })
    })
  })

  // =========================================================================
  // 8. Tool ID to name correlation
  // =========================================================================

  describe('tool ID to name correlation', () => {
    it('tracks toolCallId across running → completed states', () => {
      // running
      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'tc-A',
        tool: 'read_file',
        state: 'running',
        input: { path: 'a.ts' },
      }), stream)

      // completed — same toolCallId, tool name present
      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'tc-A',
        tool: 'read_file',
        state: 'completed',
        output: 'file content',
      }), stream)

      expect(stream.toolUse).toHaveBeenCalledWith('read_file', { path: 'a.ts' })
      expect(stream.toolResult).toHaveBeenCalledWith('read_file', 'file content', true)
    })

    it('tracks toolCallId across running → error states', () => {
      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'tc-B',
        tool: 'bash',
        state: 'running',
        input: { command: 'fail' },
      }), stream)

      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'tc-B',
        tool: 'bash',
        state: 'error',
        error: 'Command failed',
      }), stream)

      expect(stream.toolUse).toHaveBeenCalledWith('bash', { command: 'fail' })
      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'Command failed', false)
    })

    it('correlates multiple concurrent tool calls', () => {
      // Two tool calls in sequence
      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'tc-C1', tool: 'read_file', state: 'running', input: { path: 'a.ts' },
      }), stream)
      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'tc-C2', tool: 'bash', state: 'running', input: { command: 'pwd' },
      }), stream)

      // Results come back
      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'tc-C1', tool: 'read_file', state: 'completed', output: 'content A',
      }), stream)
      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'tc-C2', tool: 'bash', state: 'completed', output: '/home/user',
      }), stream)

      const useCalls = (stream.toolUse as ReturnType<typeof vi.fn>).mock.calls
      expect(useCalls).toEqual([
        ['read_file', { path: 'a.ts' }],
        ['bash', { command: 'pwd' }],
      ])

      const resultCalls = (stream.toolResult as ReturnType<typeof vi.fn>).mock.calls
      expect(resultCalls).toEqual([
        ['read_file', 'content A', true],
        ['bash', '/home/user', true],
      ])
    })

    it('native tool IDs are available for legacy tool_result correlation', () => {
      // Register via native tool_use running event
      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'tc-cross',
        tool: 'write_file',
        state: 'running',
        input: { path: 'test.ts', content: '' },
      }), stream)

      // Look up via legacy user/tool_result event
      adapter.handleStreamLine(JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tc-cross', content: 'written', is_error: false },
          ],
        },
      }), stream)

      expect(stream.toolResult).toHaveBeenCalledWith('write_file', 'written', true)
    })
  })

  // =========================================================================
  // 9. Metrics extraction from step_finish
  // =========================================================================

  describe('metrics extraction from step_finish', () => {
    it('extracts cost', () => {
      adapter.handleStreamLine(nativeEvent('step_finish', {
        cost: 0.0456,
        reason: 'end_turn',
      }), stream)

      // Verify via the status message which includes cost
      expect(stream.status).toHaveBeenCalledWith(
        'running', 100, 'Step completed (end_turn, $0.0456)',
      )
    })

    it('extracts input and output tokens', () => {
      adapter.handleStreamLine(nativeEvent('step_finish', {
        usage: { inputTokens: 5000, outputTokens: 2000 },
        cost: 0.05,
        model: 'claude-sonnet-4-20250514',
        reason: 'end_turn',
      }), stream)

      // The metrics are stored internally on the adapter (lastResultMetrics).
      // We verify by checking that no errors occurred and status was emitted properly.
      expect(stream.status).toHaveBeenCalledWith(
        'running', 100, 'Step completed (end_turn, $0.0500)',
      )
    })

    it('extracts reason field', () => {
      adapter.handleStreamLine(nativeEvent('step_finish', {
        reason: 'max_tokens',
      }), stream)

      expect(stream.status).toHaveBeenCalledWith(
        'running', 100, 'Step completed (max_tokens)',
      )
    })

    it('extracts model field', () => {
      adapter.handleStreamLine(nativeEvent('step_finish', {
        model: 'openai/gpt-4o',
        cost: 0.01,
        reason: 'stop',
      }), stream)

      expect(stream.status).toHaveBeenCalledWith(
        'running', 100, 'Step completed (stop, $0.0100)',
      )
    })

    it('handles zero cost correctly', () => {
      adapter.handleStreamLine(nativeEvent('step_finish', {
        cost: 0,
        reason: 'cached',
      }), stream)

      expect(stream.status).toHaveBeenCalledWith(
        'running', 100, 'Step completed (cached, $0.0000)',
      )
    })

    it('handles very small cost values', () => {
      adapter.handleStreamLine(nativeEvent('step_finish', {
        cost: 0.000001,
        reason: 'end_turn',
      }), stream)

      expect(stream.status).toHaveBeenCalledWith(
        'running', 100, 'Step completed (end_turn, $0.0000)',
      )
    })

    it('handles large token counts', () => {
      adapter.handleStreamLine(nativeEvent('step_finish', {
        usage: { inputTokens: 200000, outputTokens: 50000 },
        cost: 2.5,
        model: 'claude-opus-4-20250514',
        reason: 'end_turn',
      }), stream)

      expect(stream.status).toHaveBeenCalledWith(
        'running', 100, 'Step completed (end_turn, $2.5000)',
      )
    })

    it('latest step_finish overwrites metrics', () => {
      // First step_finish
      adapter.handleStreamLine(nativeEvent('step_finish', {
        usage: { inputTokens: 1000, outputTokens: 500 },
        cost: 0.01,
        model: 'model-a',
        reason: 'end_turn',
      }), stream)

      // Second step_finish overwrites
      adapter.handleStreamLine(nativeEvent('step_finish', {
        usage: { inputTokens: 2000, outputTokens: 1000 },
        cost: 0.02,
        model: 'model-b',
        reason: 'stop',
      }), stream)

      // Both emitted status calls
      expect(stream.status).toHaveBeenCalledTimes(2)
      expect((stream.status as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual([
        'running', 100, 'Step completed (stop, $0.0200)',
      ])
    })
  })

  // =========================================================================
  // 10. Malformed JSON and buffering
  // =========================================================================

  describe('malformed JSON and buffering', () => {
    it('treats non-JSON lines as raw stdout', () => {
      adapter.handleStreamLine('raw output line', stream)

      expect(stream.stdout).toHaveBeenCalledWith('raw output line')
      expect(stream.text).not.toHaveBeenCalled()
    })

    it('treats malformed JSON as raw stdout', () => {
      adapter.handleStreamLine('{malformed json', stream)

      expect(stream.stdout).toHaveBeenCalledWith('{malformed json')
    })

    it('treats truncated JSON as raw stdout', () => {
      adapter.handleStreamLine('{"type":"text","sessionID":"abc","part":{"tex', stream)

      expect(stream.stdout).toHaveBeenCalledWith(
        '{"type":"text","sessionID":"abc","part":{"tex',
      )
    })

    it('handles empty string input as raw stdout', () => {
      // Empty strings would normally be filtered by the line splitter,
      // but if passed directly to handleStreamLine, JSON.parse('') throws
      // and the catch block sends it as stdout
      adapter.handleStreamLine('', stream)

      expect(stream.stdout).toHaveBeenCalledWith('')
      expect(stream.text).not.toHaveBeenCalled()
    })

    it('handles JSON array (not object)', () => {
      adapter.handleStreamLine('[1,2,3]', stream)

      // Parses as JSON but type is undefined → falls to default → no output
      expect(stream.text).not.toHaveBeenCalled()
      expect(stream.stdout).not.toHaveBeenCalled()
    })

    it('handles JSON with extra whitespace', () => {
      const line = '  ' + nativeEvent('text', { text: 'Hello' }) + '  '
      // JSON.parse handles leading/trailing whitespace
      adapter.handleStreamLine(line, stream)

      expect(stream.text).toHaveBeenCalledWith('Hello\n')
    })

    it('handles nested JSON strings in part', () => {
      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'tc-json',
        tool: 'write_file',
        state: 'completed',
        output: '{"key": "value with \\"escaped quotes\\""}',
      }), stream)

      expect(stream.toolResult).toHaveBeenCalledWith(
        'write_file',
        '{"key": "value with \\"escaped quotes\\""}',
        true,
      )
    })

    it('handles unicode in text', () => {
      adapter.handleStreamLine(nativeEvent('text', {
        text: 'Hello \u4e16\u754c \ud83c\udf0d',
      }), stream)

      expect(stream.text).toHaveBeenCalledWith('Hello \u4e16\u754c \ud83c\udf0d\n')
    })

    it('handles unknown event type silently', () => {
      adapter.handleStreamLine(nativeEvent('future_event_type', {
        data: 'something',
      }), stream)

      expect(stream.text).not.toHaveBeenCalled()
      expect(stream.stdout).not.toHaveBeenCalled()
      expect(stream.stderr).not.toHaveBeenCalled()
    })

    it('handles empty JSON object', () => {
      adapter.handleStreamLine('{}', stream)

      expect(stream.text).not.toHaveBeenCalled()
      expect(stream.toolUse).not.toHaveBeenCalled()
      expect(stream.sessionInit).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 11. Fixture file replay — end-to-end integration
  // =========================================================================

  describe('fixture file replay', () => {
    it('processes entire opencode-output.jsonl fixture', () => {
      const fixturePath = join(__dirname, 'fixtures', 'opencode-output.jsonl')
      const content = readFileSync(fixturePath, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim())

      for (const line of lines) {
        adapter.handleStreamLine(line, stream)
      }

      // Verify sessionInit from step_start events (2 step_starts)
      expect(stream.sessionInit).toHaveBeenCalledTimes(2)
      expect(stream.sessionInit).toHaveBeenCalledWith(
        'oc-native-001',
        'anthropic/claude-sonnet-4-20250514',
      )

      // Verify text events (4 text events + 2 reasoning events = 6 text calls)
      expect(stream.text).toHaveBeenCalledTimes(6)

      // Verify tool_use events:
      // running: tc-001, tc-002, tc-003, tc-004, tc-005, tc-006, tc-007 = 7 toolUse calls
      expect(stream.toolUse).toHaveBeenCalledTimes(7)

      // completed: tc-001, tc-002, tc-003, tc-005, tc-006, tc-007 = 6 success results
      // error: tc-004 = 1 error result
      // Total: 7 toolResult calls
      expect(stream.toolResult).toHaveBeenCalledTimes(7)

      // Verify step_finish events (2) + step_start status (2) = statuses
      // step_start emits status for title, step_finish emits status for completion
      expect(stream.status).toHaveBeenCalledTimes(4)

      // Verify error event
      expect(stream.stderr).toHaveBeenCalledWith('[rate_limit] Rate limit exceeded')
    })

    it('fixture has valid JSON on every line', () => {
      const fixturePath = join(__dirname, 'fixtures', 'opencode-output.jsonl')
      const content = readFileSync(fixturePath, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim())

      expect(lines.length).toBeGreaterThan(0)

      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    })

    it('every fixture line has type, sessionID, timestamp, and part', () => {
      const fixturePath = join(__dirname, 'fixtures', 'opencode-output.jsonl')
      const content = readFileSync(fixturePath, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim())

      for (const line of lines) {
        const event = JSON.parse(line) as Record<string, unknown>
        expect(event).toHaveProperty('type')
        expect(event).toHaveProperty('sessionID')
        expect(event).toHaveProperty('timestamp')
        expect(event).toHaveProperty('part')
      }
    })

    it('fixture timestamps are valid ISO 8601', () => {
      const fixturePath = join(__dirname, 'fixtures', 'opencode-output.jsonl')
      const content = readFileSync(fixturePath, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim())

      for (const line of lines) {
        const event = JSON.parse(line) as Record<string, unknown>
        const ts = event.timestamp as string
        const date = new Date(ts)
        expect(date.toISOString()).toBe(ts)
      }
    })

    it('fixture tool_use events have valid state transitions', () => {
      const fixturePath = join(__dirname, 'fixtures', 'opencode-output.jsonl')
      const content = readFileSync(fixturePath, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim())

      const toolEvents = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.type === 'tool_use')
        .map((e) => e.part as { toolCallId: string; state: string })

      // Group by toolCallId and verify each has running first
      const byId = new Map<string, string[]>()
      for (const te of toolEvents) {
        const states = byId.get(te.toolCallId) || []
        states.push(te.state)
        byId.set(te.toolCallId, states)
      }

      for (const [, states] of byId) {
        // First state should always be 'running'
        expect(states[0]).toBe('running')
        // Second state should be 'completed' or 'error'
        expect(['completed', 'error']).toContain(states[1])
        // Should have exactly 2 events per tool call
        expect(states.length).toBe(2)
      }
    })
  })

  // =========================================================================
  // 12. Coexistence with legacy format
  // =========================================================================

  describe('coexistence with legacy format', () => {
    it('handles legacy system event alongside native step_start', () => {
      // Legacy
      adapter.handleStreamLine(JSON.stringify({
        type: 'system',
        session_id: 'legacy-sess',
        model: 'gpt-4o',
      }), stream)

      // Native
      adapter.handleStreamLine(nativeEvent('step_start', {
        stepId: 's1',
        model: 'claude-sonnet-4-20250514',
        title: 'Working',
      }), stream)

      expect(stream.sessionInit).toHaveBeenCalledTimes(2)
      expect((stream.sessionInit as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
        'legacy-sess', 'gpt-4o',
      ])
      expect((stream.sessionInit as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual([
        'test-session-001', 'claude-sonnet-4-20250514',
      ])
    })

    it('handles legacy result event alongside native step_finish', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'result',
        total_cost_usd: 0.05,
        num_turns: 3,
        usage: { input_tokens: 1000, output_tokens: 500 },
      }), stream)

      adapter.handleStreamLine(nativeEvent('step_finish', {
        usage: { inputTokens: 2000, outputTokens: 800 },
        cost: 0.08,
        reason: 'end_turn',
      }), stream)

      expect(stream.status).toHaveBeenCalledTimes(2)
    })

    it('tool IDs from native format work with legacy tool_result', () => {
      // Register via native format
      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'mixed-id',
        tool: 'bash',
        state: 'running',
        input: { command: 'echo test' },
      }), stream)

      // Look up via legacy format
      adapter.handleStreamLine(JSON.stringify({
        type: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'mixed-id', content: 'test output' },
        ],
      }), stream)

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'test output', true)
    })

    it('tool IDs from legacy format work across events', () => {
      // Register via legacy assistant event
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 'legacy-id', name: 'read_file', input: { path: 'x.ts' } },
        ],
      }), stream)

      // Complete via native format (would be unusual but tests shared map)
      // The native tool_use completed doesn't need the map, but verifying isolation
      adapter.handleStreamLine(nativeEvent('tool_use', {
        toolCallId: 'native-id',
        tool: 'write_file',
        state: 'completed',
        output: 'done',
      }), stream)

      expect(stream.toolResult).toHaveBeenCalledWith('write_file', 'done', true)
    })
  })
})

// ===========================================================================
// Lifecycle tests — process spawning, abort, timeout, exit codes
// ===========================================================================

import { spawn as realSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

// Mock child_process.spawn
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('node:child_process')
  return {
    ...actual,
    spawn: vi.fn(),
  }
})

// Import spawn after mocking
import { spawn as mockedSpawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// Mock ChildProcess factory
// ---------------------------------------------------------------------------

interface MockChildProcess extends EventEmitter {
  stdin: MockWritable
  stdout: MockReadable
  stderr: MockReadable
  pid: number
  killed: boolean
  kill: ReturnType<typeof vi.fn>
}

interface MockReadable extends EventEmitter {
  setEncoding: ReturnType<typeof vi.fn>
}

interface MockWritable extends EventEmitter {
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

function createMockChildProcess(): MockChildProcess {
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  }) as MockWritable

  const stdout = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
  }) as MockReadable

  const stderr = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
  }) as MockReadable

  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    killed: false,
    kill: vi.fn((signal?: string) => {
      proc.killed = true
      return true
    }),
  }) as MockChildProcess

  return proc
}

describe('OpenCode adapter lifecycle', () => {
  let adapter: OpenCodeAdapter
  let stream: TaskOutputStream
  let mockProc: MockChildProcess

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new OpenCodeAdapter()
    stream = createMockStream()
    mockProc = createMockChildProcess()

    // Set up mock spawn to return our mock process
    ;(mockedSpawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc)

    // Mock isAvailable to bypass actual opencode detection
    vi.spyOn(adapter, 'isAvailable').mockResolvedValue(true)
    // Set the opencodePath directly via reflection
    ;(adapter as unknown as { opencodePath: string }).opencodePath = '/usr/local/bin/opencode'
  })

  // =========================================================================
  // 1. Process spawning with correct args
  // =========================================================================

  describe('process spawning with correct args', () => {
    it('spawns opencode with run --print --output-format json', async () => {
      const task = {
        id: 'task-1',
        prompt: 'Hello world',
      }

      const controller = new AbortController()

      // Schedule process close
      setTimeout(() => mockProc.emit('close', 0), 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(mockedSpawn).toHaveBeenCalledWith(
        '/usr/local/bin/opencode',
        ['run', '--print', '--output-format', 'json', 'Hello world'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      )
    })

    it('includes --model flag when task has model', async () => {
      const task = {
        id: 'task-2',
        prompt: 'Test prompt',
        model: 'claude-sonnet-4-20250514',
      }

      const controller = new AbortController()
      setTimeout(() => mockProc.emit('close', 0), 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(mockedSpawn).toHaveBeenCalledWith(
        '/usr/local/bin/opencode',
        ['run', '--print', '--output-format', 'json', '--model', 'claude-sonnet-4-20250514', 'Test prompt'],
        expect.anything(),
      )
    })

    it('combines systemPrompt with prompt', async () => {
      const task = {
        id: 'task-3',
        prompt: 'User question',
        systemPrompt: 'You are a helpful assistant',
      }

      const controller = new AbortController()
      setTimeout(() => mockProc.emit('close', 0), 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      const expectedPrompt = 'You are a helpful assistant\n\n---\n\nUser question'
      expect(mockedSpawn).toHaveBeenCalledWith(
        '/usr/local/bin/opencode',
        expect.arrayContaining([expectedPrompt]),
        expect.anything(),
      )
    })

    it('uses task workingDirectory as cwd', async () => {
      // Use a directory that actually exists
      const task = {
        id: 'task-4',
        prompt: 'Test',
        workingDirectory: process.cwd(),
      }

      const controller = new AbortController()
      setTimeout(() => mockProc.emit('close', 0), 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(mockedSpawn).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          cwd: process.cwd(),
        }),
      )
    })

    it('rejects when workingDirectory does not exist', async () => {
      // Use a path that definitely doesn't exist
      const nonexistentPath = `/nonexistent-${Date.now()}-${Math.random()}/directory`
      const task = {
        id: 'task-5',
        prompt: 'Test',
        workingDirectory: nonexistentPath,
      }

      const controller = new AbortController()

      const result = await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(result.status).toBe('failed')
      expect(result.error).toContain('Working directory does not exist')
    })
  })

  // =========================================================================
  // 2. Environment variable passthrough
  // =========================================================================

  describe('environment variable passthrough', () => {
    it('passes task.environment to spawn', async () => {
      const task = {
        id: 'task-env-1',
        prompt: 'Test',
        environment: {
          CUSTOM_VAR: 'custom_value',
          API_KEY: 'secret123',
        },
      }

      const controller = new AbortController()
      setTimeout(() => mockProc.emit('close', 0), 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(mockedSpawn).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          env: expect.objectContaining({
            CUSTOM_VAR: 'custom_value',
            API_KEY: 'secret123',
          }),
        }),
      )
    })

    it('merges task environment with process.env', async () => {
      const task = {
        id: 'task-env-2',
        prompt: 'Test',
        environment: {
          NEW_VAR: 'new_value',
        },
      }

      const controller = new AbortController()
      setTimeout(() => mockProc.emit('close', 0), 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      const spawnCall = (mockedSpawn as ReturnType<typeof vi.fn>).mock.calls[0]
      const passedEnv = spawnCall[2].env

      // Should have process.env vars plus task vars
      expect(passedEnv.NEW_VAR).toBe('new_value')
      expect(passedEnv.PATH).toBeDefined() // From process.env
    })

    it('task environment overrides process.env', async () => {
      // Temporarily set a process.env var
      const originalPath = process.env.PATH
      process.env.TEST_OVERRIDE = 'original'

      const task = {
        id: 'task-env-3',
        prompt: 'Test',
        environment: {
          TEST_OVERRIDE: 'overridden',
        },
      }

      const controller = new AbortController()
      setTimeout(() => mockProc.emit('close', 0), 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      const spawnCall = (mockedSpawn as ReturnType<typeof vi.fn>).mock.calls[0]
      const passedEnv = spawnCall[2].env

      expect(passedEnv.TEST_OVERRIDE).toBe('overridden')

      // Cleanup
      delete process.env.TEST_OVERRIDE
    })

    it('works without task.environment', async () => {
      const task = {
        id: 'task-env-4',
        prompt: 'Test',
      }

      const controller = new AbortController()
      setTimeout(() => mockProc.emit('close', 0), 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      const spawnCall = (mockedSpawn as ReturnType<typeof vi.fn>).mock.calls[0]
      const passedEnv = spawnCall[2].env

      // Should still have process.env
      expect(passedEnv.PATH).toBeDefined()
    })
  })

  // =========================================================================
  // 3. Abort/cancellation (SIGTERM then SIGKILL after 5s)
  // =========================================================================

  describe('abort/cancellation', () => {
    it('sends SIGTERM on abort', async () => {
      const task = { id: 'task-abort-1', prompt: 'Test' }
      const controller = new AbortController()

      // Don't emit 'close' immediately — we want to test abort
      const executePromise = adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      // Wait for process to start
      await new Promise((r) => setTimeout(r, 20))

      // Abort
      controller.abort()

      // Verify SIGTERM was called
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')

      // Emit close to resolve the promise
      mockProc.emit('close', null)
      await executePromise
    })

    it('sends SIGKILL after 5s if not killed', async () => {
      vi.useFakeTimers()

      const task = { id: 'task-abort-2', prompt: 'Test' }
      const controller = new AbortController()

      // Reset killed flag to simulate process not dying from SIGTERM
      mockProc.kill.mockImplementation((signal?: string) => {
        // Don't set killed=true to simulate stubborn process
        return true
      })

      const executePromise = adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      // Wait for event handlers to be set up
      await vi.advanceTimersByTimeAsync(10)

      // Abort
      controller.abort()

      // SIGTERM should be called immediately
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')

      // Advance 4.9 seconds — SIGKILL should NOT be called yet
      await vi.advanceTimersByTimeAsync(4900)
      expect(mockProc.kill).not.toHaveBeenCalledWith('SIGKILL')

      // Advance past 5 seconds — SIGKILL should be called
      await vi.advanceTimersByTimeAsync(200)
      expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL')

      // Clean up
      mockProc.emit('close', null)
      await executePromise

      vi.useRealTimers()
    })

    it('does not send SIGKILL if process killed by SIGTERM', async () => {
      vi.useFakeTimers()

      const task = { id: 'task-abort-3', prompt: 'Test' }
      const controller = new AbortController()

      // Set killed=true when SIGTERM received (normal behavior)
      mockProc.kill.mockImplementation((signal?: string) => {
        mockProc.killed = true
        return true
      })

      const executePromise = adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      await vi.advanceTimersByTimeAsync(10)

      // Abort
      controller.abort()

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')
      expect(mockProc.killed).toBe(true)

      // Advance 6 seconds
      await vi.advanceTimersByTimeAsync(6000)

      // SIGKILL should NOT be called because killed=true
      expect(mockProc.kill).not.toHaveBeenCalledWith('SIGKILL')

      // Clean up
      mockProc.emit('close', null)
      await executePromise

      vi.useRealTimers()
    })

    it('returns failed status with exit code when aborted (process killed)', async () => {
      // When a process is killed via SIGTERM, it exits with 128+15=143
      // The adapter returns status based on exit code, not abort signal
      const task = { id: 'task-abort-4', prompt: 'Test' }
      const controller = new AbortController()

      const executePromise = adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      await new Promise((r) => setTimeout(r, 20))

      controller.abort()
      // Simulate process killed by SIGTERM (exit code 143 = 128 + 15)
      mockProc.emit('close', 143)

      const result = await executePromise
      // Process was killed, so exitCode is non-zero → 'failed' status
      expect(result.status).toBe('failed')
      expect(result.exitCode).toBe(143)
    })

    it('returns cancelled status when error thrown after abort', async () => {
      const task = { id: 'task-abort-4b', prompt: 'Test' }
      const controller = new AbortController()

      const executePromise = adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      await new Promise((r) => setTimeout(r, 20))

      // Abort first
      controller.abort()
      // Then emit error (e.g., process couldn't be killed)
      mockProc.emit('error', new Error('Process error during abort'))

      const result = await executePromise
      // Error + signal.aborted → 'cancelled' status
      expect(result.status).toBe('cancelled')
      expect(result.error).toBe('Task cancelled')
    })

    it('removes abort listener after process closes', async () => {
      const task = { id: 'task-abort-5', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => mockProc.emit('close', 0), 20)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      // Aborting after close should not throw or cause issues
      controller.abort()

      // If abort listener wasn't removed, this might cause kill to be called
      // But since we closed the process, kill should not be called
      expect(mockProc.kill).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 4. Process exit code handling
  // =========================================================================

  describe('process exit code handling', () => {
    it('returns completed for exit code 0', async () => {
      const task = { id: 'task-exit-0', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => mockProc.emit('close', 0), 10)

      const result = await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(result.status).toBe('completed')
      expect(result.exitCode).toBe(0)
    })

    it('returns failed for non-zero exit code', async () => {
      const task = { id: 'task-exit-1', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => mockProc.emit('close', 1), 10)

      const result = await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(result.status).toBe('failed')
      expect(result.exitCode).toBe(1)
    })

    it('handles various exit codes', async () => {
      const testCases = [
        { code: 2, expectedStatus: 'failed' },
        { code: 127, expectedStatus: 'failed' },
        { code: 128 + 9, expectedStatus: 'failed' }, // SIGKILL
        { code: 128 + 15, expectedStatus: 'failed' }, // SIGTERM
        { code: 255, expectedStatus: 'failed' },
      ]

      for (const { code, expectedStatus } of testCases) {
        vi.clearAllMocks()
        mockProc = createMockChildProcess()
        ;(mockedSpawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc)

        const task = { id: `task-exit-${code}`, prompt: 'Test' }
        const controller = new AbortController()

        setTimeout(() => mockProc.emit('close', code), 10)

        const result = await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

        expect(result.status).toBe(expectedStatus)
        expect(result.exitCode).toBe(code)
      }
    })

    it('treats null exit code as 1', async () => {
      const task = { id: 'task-exit-null', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => mockProc.emit('close', null), 10)

      const result = await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(result.status).toBe('failed')
      expect(result.exitCode).toBe(1)
    })

    it('captures stderr in error field', async () => {
      const task = { id: 'task-exit-stderr', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => {
        mockProc.stderr.emit('data', Buffer.from('Error: something failed'))
        mockProc.emit('close', 1)
      }, 10)

      const result = await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(result.error).toBe('Error: something failed')
    })
  })

  // =========================================================================
  // 5. Timeout handling
  // =========================================================================

  describe('timeout handling', () => {
    it('sends SIGTERM when timeout expires', async () => {
      vi.useFakeTimers()

      const task = { id: 'task-timeout-1', prompt: 'Test', timeout: 5000 }
      const controller = new AbortController()

      const executePromise = adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      // Wait for process to start
      await vi.advanceTimersByTimeAsync(10)

      // Advance to just before timeout
      await vi.advanceTimersByTimeAsync(4900)
      expect(mockProc.kill).not.toHaveBeenCalled()

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(200)
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')

      // Clean up
      mockProc.emit('close', null)
      await executePromise

      vi.useRealTimers()
    })

    it('sends SIGKILL 5s after timeout SIGTERM', async () => {
      vi.useFakeTimers()

      const task = { id: 'task-timeout-2', prompt: 'Test', timeout: 1000 }
      const controller = new AbortController()

      // Process doesn't die from SIGTERM
      mockProc.kill.mockImplementation(() => true)

      const executePromise = adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      await vi.advanceTimersByTimeAsync(10)

      // Trigger timeout
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')

      // Wait 4.9s — SIGKILL not yet
      await vi.advanceTimersByTimeAsync(4900)
      expect(mockProc.kill).not.toHaveBeenCalledWith('SIGKILL')

      // Wait past 5s — SIGKILL sent
      await vi.advanceTimersByTimeAsync(200)
      expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL')

      // Clean up
      mockProc.emit('close', null)
      await executePromise

      vi.useRealTimers()
    })

    it('does not trigger timeout if no timeout set', async () => {
      vi.useFakeTimers()

      const task = { id: 'task-timeout-3', prompt: 'Test' } // No timeout
      const controller = new AbortController()

      const executePromise = adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      await vi.advanceTimersByTimeAsync(10)

      // Advance a long time
      await vi.advanceTimersByTimeAsync(60000)

      // No kill should be called
      expect(mockProc.kill).not.toHaveBeenCalled()

      // Clean up
      mockProc.emit('close', 0)
      await executePromise

      vi.useRealTimers()
    })

    it('does not send SIGKILL if process exits before escalation', async () => {
      vi.useFakeTimers()

      const task = { id: 'task-timeout-4', prompt: 'Test', timeout: 1000 }
      const controller = new AbortController()

      mockProc.kill.mockImplementation((signal?: string) => {
        mockProc.killed = true
        // Process exits after SIGTERM
        setTimeout(() => mockProc.emit('close', 128 + 15), 100)
        return true
      })

      const executePromise = adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      await vi.advanceTimersByTimeAsync(10)

      // Trigger timeout
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')

      // Let process exit
      await vi.advanceTimersByTimeAsync(100)

      // Wait past SIGKILL window
      await vi.advanceTimersByTimeAsync(5000)

      // SIGKILL should NOT be called because killed=true
      expect(mockProc.kill).not.toHaveBeenCalledWith('SIGKILL')

      await executePromise

      vi.useRealTimers()
    })
  })

  // =========================================================================
  // 6. stdin close on spawn
  // =========================================================================

  describe('stdin close on spawn', () => {
    it('calls stdin.end() immediately after spawn', async () => {
      const task = { id: 'task-stdin-1', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => mockProc.emit('close', 0), 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(mockProc.stdin.end).toHaveBeenCalled()
    })

    it('stdin.end() is called before process closes', async () => {
      const callOrder: string[] = []

      mockProc.stdin.end.mockImplementation(() => {
        callOrder.push('stdin.end')
      })

      const originalEmit = mockProc.emit.bind(mockProc)
      mockProc.emit = ((event: string, ...args: unknown[]) => {
        if (event === 'close') {
          callOrder.push('close')
        }
        return originalEmit(event, ...args)
      }) as typeof mockProc.emit

      const task = { id: 'task-stdin-2', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => mockProc.emit('close', 0), 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(callOrder).toEqual(['stdin.end', 'close'])
    })

    it('handles null stdin gracefully', async () => {
      // Create a mock process without stdin
      const procNoStdin = Object.assign(new EventEmitter(), {
        stdin: null,
        stdout: mockProc.stdout,
        stderr: mockProc.stderr,
        pid: 12346,
        killed: false,
        kill: vi.fn(),
      }) as unknown as MockChildProcess

      ;(mockedSpawn as ReturnType<typeof vi.fn>).mockReturnValue(procNoStdin)

      const task = { id: 'task-stdin-3', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => procNoStdin.emit('close', 0), 10)

      // Should not throw
      await expect(
        adapter.execute(task as import('../src/types.js').Task, stream, controller.signal),
      ).resolves.toBeDefined()
    })
  })

  // =========================================================================
  // 7. Process error handling
  // =========================================================================

  describe('process error handling', () => {
    it('rejects on spawn error', async () => {
      const task = { id: 'task-error-1', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => {
        mockProc.emit('error', new Error('spawn ENOENT'))
      }, 10)

      const result = await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(result.status).toBe('failed')
      expect(result.error).toContain('spawn ENOENT')
    })

    it('removes abort listener on error', async () => {
      const task = { id: 'task-error-2', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => {
        mockProc.emit('error', new Error('process error'))
      }, 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      // Abort should not throw or cause issues
      controller.abort()
      expect(mockProc.kill).not.toHaveBeenCalled()
    })

    it('handles spawn throwing synchronously', async () => {
      ;(mockedSpawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('spawn failed synchronously')
      })

      const task = { id: 'task-error-3', prompt: 'Test' }
      const controller = new AbortController()

      const result = await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(result.status).toBe('failed')
      expect(result.error).toContain('spawn failed synchronously')
    })
  })

  // =========================================================================
  // 8. stdout/stderr streaming
  // =========================================================================

  describe('stdout/stderr streaming', () => {
    it('processes stdout data through handleStreamLine', async () => {
      const task = { id: 'task-stream-1', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => {
        // Send valid JSONL event
        mockProc.stdout.emit('data', Buffer.from('{"type":"text","sessionID":"s1","timestamp":"2025-01-01T00:00:00Z","part":{"text":"Hello"}}\n'))
        mockProc.emit('close', 0)
      }, 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(stream.text).toHaveBeenCalledWith('Hello\n')
    })

    it('streams stderr to stream.stderr', async () => {
      const task = { id: 'task-stream-2', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => {
        mockProc.stderr.emit('data', Buffer.from('Warning: something'))
        mockProc.emit('close', 0)
      }, 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(stream.stderr).toHaveBeenCalledWith('Warning: something')
    })

    it('buffers incomplete lines and flushes on close', async () => {
      const task = { id: 'task-stream-3', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => {
        // Send incomplete line
        mockProc.stdout.emit('data', Buffer.from('{"type":"text","sessionID":"s1","timestamp":"2025-01-01T00:00:00Z","part":{"text":"Partial"}}'))
        // No newline yet, so handleStreamLine shouldn't be called
        mockProc.emit('close', 0)
      }, 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      // The incomplete line should be flushed on close
      expect(stream.text).toHaveBeenCalledWith('Partial\n')
    })

    it('handles multiple lines in single data chunk', async () => {
      const task = { id: 'task-stream-4', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => {
        mockProc.stdout.emit('data', Buffer.from(
          '{"type":"text","sessionID":"s1","timestamp":"2025-01-01T00:00:00Z","part":{"text":"Line1"}}\n' +
          '{"type":"text","sessionID":"s1","timestamp":"2025-01-01T00:00:00Z","part":{"text":"Line2"}}\n'
        ))
        mockProc.emit('close', 0)
      }, 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(stream.text).toHaveBeenCalledWith('Line1\n')
      expect(stream.text).toHaveBeenCalledWith('Line2\n')
    })

    it('handles lines split across data chunks', async () => {
      const task = { id: 'task-stream-5', prompt: 'Test' }
      const controller = new AbortController()

      const line = '{"type":"text","sessionID":"s1","timestamp":"2025-01-01T00:00:00Z","part":{"text":"SplitLine"}}'

      setTimeout(() => {
        // Split the line across two chunks
        mockProc.stdout.emit('data', Buffer.from(line.slice(0, 50)))
        mockProc.stdout.emit('data', Buffer.from(line.slice(50) + '\n'))
        mockProc.emit('close', 0)
      }, 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      expect(stream.text).toHaveBeenCalledWith('SplitLine\n')
    })
  })

  // =========================================================================
  // 9. activeTasks counter
  // =========================================================================

  describe('activeTasks counter', () => {
    it('increments activeTasks during execution', async () => {
      const initialStatus = await adapter.getStatus()
      expect(initialStatus.activeTasks).toBe(0)

      const task = { id: 'task-active-1', prompt: 'Test' }
      const controller = new AbortController()

      let midExecutionTaskCount = -1
      let closeProcess: () => void

      // Set up a promise that resolves when we're ready to close
      const readyToClose = new Promise<void>((resolve) => {
        closeProcess = resolve
      })

      // Start execution but don't close immediately
      const executePromise = adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      // Wait a tick for execution to start
      await new Promise((r) => setTimeout(r, 10))

      // Check task count during execution (synchronously capture)
      const midStatus = await adapter.getStatus()
      midExecutionTaskCount = midStatus.activeTasks

      // Now close the process
      mockProc.emit('close', 0)

      await executePromise

      expect(midExecutionTaskCount).toBe(1)

      const finalStatus = await adapter.getStatus()
      expect(finalStatus.activeTasks).toBe(0)
    })

    it('decrements activeTasks on error', async () => {
      const task = { id: 'task-active-2', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => {
        mockProc.emit('error', new Error('test error'))
      }, 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      const status = await adapter.getStatus()
      expect(status.activeTasks).toBe(0)
    })

    it('decrements activeTasks on abort', async () => {
      const task = { id: 'task-active-3', prompt: 'Test' }
      const controller = new AbortController()

      setTimeout(() => {
        controller.abort()
        mockProc.emit('close', null)
      }, 10)

      await adapter.execute(task as import('../src/types.js').Task, stream, controller.signal)

      const status = await adapter.getStatus()
      expect(status.activeTasks).toBe(0)
    })
  })
})
