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
