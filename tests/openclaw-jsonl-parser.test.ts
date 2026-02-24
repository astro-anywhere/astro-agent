/**
 * OpenClaw JSONL Stream Parser Tests
 *
 * Tests the structured parsing of OpenClaw CLI's --json JSONL output.
 * Verifies that OpenClaw events are correctly mapped to TaskOutputStream methods.
 *
 * OpenClaw JSONL event types tested:
 * - session.start    → sessionInit
 * - message.start    → status update (agent thinking)
 * - content.text     → text output
 * - tool_use.start   → toolUse
 * - tool_use.end     → toolResult
 * - file.change      → fileChange + artifact extraction
 * - message.end      → status update (turn complete)
 * - session.end      → metrics extraction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { OpenClawAdapter } from '../src/providers/openclaw-adapter.js'
import type { TaskOutputStream } from '../src/providers/base-adapter.js'
import type { TaskArtifact } from '../src/types.js'

/**
 * Create a mock TaskOutputStream with vi.fn() for each method
 */
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

describe('OpenClaw JSONL parser: handleStreamLine', () => {
  let adapter: OpenClawAdapter
  let stream: TaskOutputStream
  let artifacts: TaskArtifact[]

  beforeEach(() => {
    adapter = new OpenClawAdapter()
    stream = createMockStream()
    artifacts = []
  })

  // ==========================================================================
  // session.start
  // ==========================================================================

  describe('session.start', () => {
    it('emits sessionInit with session_id and model', () => {
      const result = adapter.handleStreamLine(JSON.stringify({
        type: 'session.start',
        session_id: 'sess-abc-123',
        model: 'claude-sonnet-4-20250514',
      }), stream, artifacts)

      expect(stream.sessionInit).toHaveBeenCalledWith('sess-abc-123', 'claude-sonnet-4-20250514')
      expect(result).toBeUndefined()
    })

    it('emits sessionInit without model when not provided', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'session.start',
        session_id: 'sess-abc-456',
      }), stream, artifacts)

      expect(stream.sessionInit).toHaveBeenCalledWith('sess-abc-456', undefined)
    })

    it('does not emit sessionInit when session_id is missing', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'session.start',
      }), stream, artifacts)

      expect(stream.sessionInit).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // message.start
  // ==========================================================================

  describe('message.start', () => {
    it('emits status update for agent thinking', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'message.start',
      }), stream, artifacts)

      expect(stream.status).toHaveBeenCalledWith('running', undefined, 'Agent thinking...')
    })
  })

  // ==========================================================================
  // content.text
  // ==========================================================================

  describe('content.text', () => {
    it('emits text content', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'content.text',
        text: 'I will analyze the codebase structure.',
      }), stream, artifacts)

      expect(stream.text).toHaveBeenCalledWith('I will analyze the codebase structure.')
    })

    it('does not emit text when text field is empty', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'content.text',
        text: '',
      }), stream, artifacts)

      expect(stream.text).not.toHaveBeenCalled()
    })

    it('does not emit text when text field is missing', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'content.text',
      }), stream, artifacts)

      expect(stream.text).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // tool_use.start
  // ==========================================================================

  describe('tool_use.start', () => {
    it('emits toolUse with tool name and input', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'tool_use.start',
        tool_name: 'bash',
        tool_input: { command: 'ls -la' },
      }), stream, artifacts)

      expect(stream.toolUse).toHaveBeenCalledWith('bash', { command: 'ls -la' })
    })

    it('uses "unknown" when tool_name is missing', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'tool_use.start',
        tool_input: { command: 'pwd' },
      }), stream, artifacts)

      expect(stream.toolUse).toHaveBeenCalledWith('unknown', { command: 'pwd' })
    })

    it('uses empty object when tool_input is missing', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'tool_use.start',
        tool_name: 'read_file',
      }), stream, artifacts)

      expect(stream.toolUse).toHaveBeenCalledWith('read_file', {})
    })
  })

  // ==========================================================================
  // tool_use.end
  // ==========================================================================

  describe('tool_use.end', () => {
    it('emits toolResult with name, result, and success', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'tool_use.end',
        tool_name: 'bash',
        result: 'file1.txt\nfile2.txt\n',
        success: true,
      }), stream, artifacts)

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'file1.txt\nfile2.txt\n', true)
    })

    it('handles failure result', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'tool_use.end',
        tool_name: 'bash',
        result: 'command not found',
        success: false,
      }), stream, artifacts)

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'command not found', false)
    })

    it('defaults success to true when not specified', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'tool_use.end',
        tool_name: 'bash',
        result: 'ok',
      }), stream, artifacts)

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'ok', true)
    })

    it('uses "unknown" when tool_name is missing', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'tool_use.end',
        result: 'some result',
        success: true,
      }), stream, artifacts)

      expect(stream.toolResult).toHaveBeenCalledWith('unknown', 'some result', true)
    })
  })

  // ==========================================================================
  // file.change
  // ==========================================================================

  describe('file.change', () => {
    it('emits fileChange and adds artifact', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'file.change',
        path: 'src/index.ts',
        action: 'modified',
        lines_added: 10,
        lines_removed: 3,
      }), stream, artifacts)

      expect(stream.fileChange).toHaveBeenCalledWith('src/index.ts', 'modified', 10, 3)
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0]).toEqual({ type: 'file', name: 'src/index.ts', path: 'src/index.ts' })
    })

    it('handles created action', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'file.change',
        path: 'new-file.ts',
        action: 'created',
        lines_added: 50,
      }), stream, artifacts)

      expect(stream.fileChange).toHaveBeenCalledWith('new-file.ts', 'created', 50, undefined)
    })

    it('handles deleted action', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'file.change',
        path: 'old-file.ts',
        action: 'deleted',
        lines_removed: 25,
      }), stream, artifacts)

      expect(stream.fileChange).toHaveBeenCalledWith('old-file.ts', 'deleted', undefined, 25)
    })

    it('does not add duplicate artifacts', () => {
      artifacts.push({ type: 'file', name: 'src/index.ts', path: 'src/index.ts' })

      adapter.handleStreamLine(JSON.stringify({
        type: 'file.change',
        path: 'src/index.ts',
        action: 'modified',
      }), stream, artifacts)

      expect(artifacts).toHaveLength(1)
    })

    it('ignores file.change when path is missing', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'file.change',
        action: 'modified',
      }), stream, artifacts)

      expect(stream.fileChange).not.toHaveBeenCalled()
      expect(artifacts).toHaveLength(0)
    })

    it('defaults action to modified when missing', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'file.change',
        path: 'test.ts',
      }), stream, artifacts)

      expect(stream.fileChange).toHaveBeenCalledWith('test.ts', 'modified', undefined, undefined)
    })
  })

  // ==========================================================================
  // message.end
  // ==========================================================================

  describe('message.end', () => {
    it('emits status update for turn complete', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'message.end',
      }), stream, artifacts)

      expect(stream.status).toHaveBeenCalledWith('running', undefined, 'Turn complete')
    })
  })

  // ==========================================================================
  // session.end
  // ==========================================================================

  describe('session.end', () => {
    it('returns metrics with cost and token counts', () => {
      const result = adapter.handleStreamLine(JSON.stringify({
        type: 'session.end',
        cost: 0.0523,
        input_tokens: 1500,
        output_tokens: 800,
        turns: 3,
        model: 'claude-sonnet-4-20250514',
        duration_ms: 12000,
      }), stream, artifacts)

      expect(result).toEqual({
        totalCost: 0.0523,
        inputTokens: 1500,
        outputTokens: 800,
        numTurns: 3,
        model: 'claude-sonnet-4-20250514',
        durationMs: 12000,
      })

      expect(stream.status).toHaveBeenCalledWith('running', 100, 'Completed (3 turns, $0.0523)')
    })

    it('handles session.end without cost', () => {
      const result = adapter.handleStreamLine(JSON.stringify({
        type: 'session.end',
        input_tokens: 500,
        output_tokens: 200,
        turns: 1,
      }), stream, artifacts)

      expect(result).toEqual({
        totalCost: undefined,
        inputTokens: 500,
        outputTokens: 200,
        numTurns: 1,
        model: undefined,
        durationMs: undefined,
      })

      expect(stream.status).toHaveBeenCalledWith('running', 100, 'Completed')
    })

    it('handles session.end with minimal fields', () => {
      const result = adapter.handleStreamLine(JSON.stringify({
        type: 'session.end',
      }), stream, artifacts)

      expect(result).toEqual({
        totalCost: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        numTurns: undefined,
        model: undefined,
        durationMs: undefined,
      })
    })
  })

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe('edge cases', () => {
    it('handles non-JSON lines as raw stdout', () => {
      adapter.handleStreamLine('this is not json', stream, artifacts)

      expect(stream.stdout).toHaveBeenCalledWith('this is not json\n')
    })

    it('handles empty JSON objects', () => {
      adapter.handleStreamLine('{}', stream, artifacts)

      expect(stream.text).not.toHaveBeenCalled()
      expect(stream.toolUse).not.toHaveBeenCalled()
      expect(stream.toolResult).not.toHaveBeenCalled()
      expect(stream.sessionInit).not.toHaveBeenCalled()
      expect(stream.fileChange).not.toHaveBeenCalled()
    })

    it('handles unknown event types silently', () => {
      const result = adapter.handleStreamLine(JSON.stringify({
        type: 'some.future.event',
        data: 'hello',
      }), stream, artifacts)

      expect(result).toBeUndefined()
      expect(stream.text).not.toHaveBeenCalled()
      expect(stream.stdout).not.toHaveBeenCalled()
    })

    it('handles malformed JSON gracefully', () => {
      adapter.handleStreamLine('{invalid json', stream, artifacts)

      expect(stream.stdout).toHaveBeenCalledWith('{invalid json\n')
    })

    it('handles JSON array (not object)', () => {
      adapter.handleStreamLine('[1,2,3]', stream, artifacts)

      // Should not throw, no structured events
      expect(stream.text).not.toHaveBeenCalled()
    })

    it('handles empty string', () => {
      // Empty strings should be filtered before calling handleStreamLine,
      // but test that it handles them gracefully
      adapter.handleStreamLine('', stream, artifacts)

      expect(stream.stdout).toHaveBeenCalledWith('\n')
    })
  })

  // ==========================================================================
  // Full JSONL sequence (integration-style)
  // ==========================================================================

  describe('full JSONL sequence', () => {
    it('processes a realistic OpenClaw session in order', () => {
      const events = [
        { type: 'session.start', session_id: 'sess-001', model: 'gpt-4o' },
        { type: 'message.start' },
        { type: 'content.text', text: 'I will analyze the codebase.' },
        { type: 'tool_use.start', tool_name: 'bash', tool_input: { command: 'ls -la' } },
        { type: 'tool_use.end', tool_name: 'bash', result: 'file1.txt\nfile2.txt', success: true },
        { type: 'content.text', text: 'Found 2 files. Creating new module.' },
        { type: 'tool_use.start', tool_name: 'write_file', tool_input: { path: 'src/mod.ts', content: 'export {}' } },
        { type: 'tool_use.end', tool_name: 'write_file', result: 'File written', success: true },
        { type: 'file.change', path: 'src/mod.ts', action: 'created', lines_added: 1 },
        { type: 'message.end' },
        { type: 'session.end', cost: 0.0312, input_tokens: 1200, output_tokens: 600, turns: 2 },
      ]

      let lastResult: ReturnType<typeof adapter.handleStreamLine>

      for (const event of events) {
        lastResult = adapter.handleStreamLine(JSON.stringify(event), stream, artifacts)
      }

      // Verify event sequence
      expect(stream.sessionInit).toHaveBeenCalledTimes(1)
      expect(stream.sessionInit).toHaveBeenCalledWith('sess-001', 'gpt-4o')

      expect(stream.text).toHaveBeenCalledTimes(2)
      expect((stream.text as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('I will analyze the codebase.')
      expect((stream.text as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('Found 2 files. Creating new module.')

      expect(stream.toolUse).toHaveBeenCalledTimes(2)
      expect(stream.toolResult).toHaveBeenCalledTimes(2)

      expect(stream.fileChange).toHaveBeenCalledTimes(1)
      expect(stream.fileChange).toHaveBeenCalledWith('src/mod.ts', 'created', 1, undefined)

      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].path).toBe('src/mod.ts')

      // status calls: message.start, message.end, session.end
      expect(stream.status).toHaveBeenCalledTimes(3)

      // session.end returns metrics
      expect(lastResult).toEqual({
        totalCost: 0.0312,
        inputTokens: 1200,
        outputTokens: 600,
        numTurns: 2,
        model: undefined,
        durationMs: undefined,
      })
    })

    it('handles multiple tool uses within a single message', () => {
      const events = [
        { type: 'session.start', session_id: 'sess-002', model: 'claude-3' },
        { type: 'message.start' },
        { type: 'tool_use.start', tool_name: 'read_file', tool_input: { path: 'a.ts' } },
        { type: 'tool_use.end', tool_name: 'read_file', result: 'content a', success: true },
        { type: 'tool_use.start', tool_name: 'read_file', tool_input: { path: 'b.ts' } },
        { type: 'tool_use.end', tool_name: 'read_file', result: 'content b', success: true },
        { type: 'tool_use.start', tool_name: 'write_file', tool_input: { path: 'c.ts', content: '...' } },
        { type: 'tool_use.end', tool_name: 'write_file', result: 'written', success: true },
        { type: 'file.change', path: 'c.ts', action: 'created', lines_added: 5 },
        { type: 'message.end' },
        { type: 'session.end', cost: 0.01, turns: 1 },
      ]

      for (const event of events) {
        adapter.handleStreamLine(JSON.stringify(event), stream, artifacts)
      }

      expect(stream.toolUse).toHaveBeenCalledTimes(3)
      expect(stream.toolResult).toHaveBeenCalledTimes(3)
      expect(stream.fileChange).toHaveBeenCalledTimes(1)
    })
  })
})
