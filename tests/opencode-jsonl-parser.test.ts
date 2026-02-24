/**
 * OpenCode JSONL Stream Parser Tests
 *
 * Tests the structured parsing of OpenCode CLI's --output-format json output.
 * Verifies that OpenCode events are correctly mapped to TaskOutputStream methods.
 *
 * OpenCode JSONL event types tested:
 * - system          → sessionInit (session_id, model)
 * - assistant       → text + tool_use content blocks
 * - user/tool_result → tool results
 * - result          → final metrics (cost, tokens, turns)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { OpenCodeAdapter } from '../src/providers/opencode-adapter.js'
import type { TaskOutputStream } from '../src/providers/base-adapter.js'

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

describe('OpenCode JSONL parser: handleStreamLine', () => {
  let adapter: OpenCodeAdapter
  let stream: TaskOutputStream

  beforeEach(() => {
    adapter = new OpenCodeAdapter()
    stream = createMockStream()
  })

  // ==========================================================================
  // system
  // ==========================================================================

  describe('system', () => {
    it('emits sessionInit with session_id and model', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'system',
        session_id: 'oc-sess-123',
        model: 'gpt-4o-mini',
      }), stream)

      expect(stream.sessionInit).toHaveBeenCalledWith('oc-sess-123', 'gpt-4o-mini')
    })

    it('emits sessionInit without model when not provided', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'system',
        session_id: 'oc-sess-456',
      }), stream)

      expect(stream.sessionInit).toHaveBeenCalledWith('oc-sess-456', undefined)
    })

    it('does not emit sessionInit when session_id is missing', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'system',
        model: 'gpt-4o',
      }), stream)

      expect(stream.sessionInit).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // assistant — text content
  // ==========================================================================

  describe('assistant: text content', () => {
    it('emits text for text content blocks using content array', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'text', text: 'I will analyze the file structure.' },
        ],
      }), stream)

      expect(stream.text).toHaveBeenCalledWith('I will analyze the file structure.\n')
    })

    it('emits text for text content blocks using message.content', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Looking at the code now.' },
          ],
        },
      }), stream)

      expect(stream.text).toHaveBeenCalledWith('Looking at the code now.\n')
    })

    it('handles multiple content blocks', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'text', text: 'Step 1: Read files.' },
          { type: 'text', text: 'Step 2: Analyze.' },
        ],
      }), stream)

      expect(stream.text).toHaveBeenCalledTimes(2)
      expect((stream.text as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('Step 1: Read files.\n')
      expect((stream.text as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('Step 2: Analyze.\n')
    })

    it('does not emit text for empty text blocks', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'text', text: '' },
        ],
      }), stream)

      expect(stream.text).not.toHaveBeenCalled()
    })

    it('handles missing content gracefully', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
      }), stream)

      expect(stream.text).not.toHaveBeenCalled()
      expect(stream.toolUse).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // assistant — tool_use content
  // ==========================================================================

  describe('assistant: tool_use content', () => {
    it('emits toolUse for tool_use content blocks', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_001', name: 'bash', input: { command: 'ls -la' } },
        ],
      }), stream)

      expect(stream.toolUse).toHaveBeenCalledWith('bash', { command: 'ls -la' })
    })

    it('stores tool id-to-name mapping for later correlation', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_002', name: 'read_file', input: { path: 'index.ts' } },
        ],
      }), stream)

      // Now send a tool_result referencing the same id
      adapter.handleStreamLine(JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_002', content: 'file content here', is_error: false },
          ],
        },
      }), stream)

      expect(stream.toolResult).toHaveBeenCalledWith('read_file', 'file content here', true)
    })

    it('uses "unknown" when name is missing in tool_use', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_003', input: { data: 'test' } },
        ],
      }), stream)

      expect(stream.toolUse).toHaveBeenCalledWith('unknown', { data: 'test' })
    })

    it('handles mixed text and tool_use blocks', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'text', text: 'I will run a command.' },
          { type: 'tool_use', id: 'tu_004', name: 'bash', input: { command: 'pwd' } },
        ],
      }), stream)

      expect(stream.text).toHaveBeenCalledWith('I will run a command.\n')
      expect(stream.toolUse).toHaveBeenCalledWith('bash', { command: 'pwd' })
    })
  })

  // ==========================================================================
  // user/tool_result — tool results
  // ==========================================================================

  describe('tool results', () => {
    it('handles user event with tool_result content blocks', () => {
      // First set up the id-to-name mapping
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_010', name: 'bash', input: { command: 'echo hi' } },
        ],
      }), stream)

      adapter.handleStreamLine(JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_010', content: 'hi\n', is_error: false },
          ],
        },
      }), stream)

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'hi\n', true)
    })

    it('handles error tool results', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_011', name: 'bash', input: { command: 'bad-cmd' } },
        ],
      }), stream)

      adapter.handleStreamLine(JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_011', content: 'command not found', is_error: true },
          ],
        },
      }), stream)

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'command not found', false)
    })

    it('uses "unknown" when tool_use_id has no mapping', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_unknown', content: 'some result' },
          ],
        },
      }), stream)

      expect(stream.toolResult).toHaveBeenCalledWith('unknown', 'some result', true)
    })

    it('handles direct tool_result event type', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'tool_result',
        tool_name: 'write_file',
        content: 'File written successfully',
        is_error: false,
      }), stream)

      expect(stream.toolResult).toHaveBeenCalledWith('write_file', 'File written successfully', true)
    })

    it('handles direct tool_result with error', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'tool_result',
        tool_name: 'bash',
        content: 'Permission denied',
        is_error: true,
      }), stream)

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'Permission denied', false)
    })

    it('handles tool_result with content array (using top-level content)', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_020', content: 'result text' },
        ],
      }), stream)

      expect(stream.toolResult).toHaveBeenCalledWith('unknown', 'result text', true)
    })
  })

  // ==========================================================================
  // result — metrics
  // ==========================================================================

  describe('result', () => {
    it('extracts metrics with usage field', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'result',
        total_cost_usd: 0.0456,
        num_turns: 5,
        duration_ms: 15000,
        usage: { input_tokens: 2000, output_tokens: 1000 },
        model: 'claude-sonnet-4-20250514',
      }), stream)

      expect(stream.status).toHaveBeenCalledWith('running', 100, 'Completed (5 turns, $0.0456)')
    })

    it('extracts metrics with tokens field', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'result',
        cost: 0.03,
        turns: 2,
        tokens: { input: 500, output: 250 },
      }), stream)

      expect(stream.status).toHaveBeenCalledWith('running', 100, 'Completed (2 turns, $0.0300)')
    })

    it('handles result without cost', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'result',
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 50 },
      }), stream)

      expect(stream.status).toHaveBeenCalledWith('running', 100, 'Completed')
    })

    it('handles result with cost_usd variant', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'result',
        cost_usd: 0.0789,
        num_turns: 3,
      }), stream)

      expect(stream.status).toHaveBeenCalledWith('running', 100, 'Completed (3 turns, $0.0789)')
    })

    it('handles result with minimal fields', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'result',
      }), stream)

      expect(stream.status).toHaveBeenCalledWith('running', 100, 'Completed')
    })

    it('handles result with duration_api_ms variant', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'result',
        duration_api_ms: 8000,
        cost: 0.01,
      }), stream)

      expect(stream.status).toHaveBeenCalledWith('running', 100, 'Completed (0 turns, $0.0100)')
    })
  })

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe('edge cases', () => {
    it('handles non-JSON lines as raw stdout', () => {
      adapter.handleStreamLine('raw output line', stream)

      expect(stream.stdout).toHaveBeenCalledWith('raw output line')
    })

    it('handles empty JSON objects', () => {
      adapter.handleStreamLine('{}', stream)

      expect(stream.text).not.toHaveBeenCalled()
      expect(stream.toolUse).not.toHaveBeenCalled()
      expect(stream.toolResult).not.toHaveBeenCalled()
      expect(stream.sessionInit).not.toHaveBeenCalled()
    })

    it('handles unknown event types silently', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'new.future.event',
        data: 'hello',
      }), stream)

      expect(stream.text).not.toHaveBeenCalled()
      expect(stream.stdout).not.toHaveBeenCalled()
    })

    it('handles malformed JSON gracefully', () => {
      adapter.handleStreamLine('{malformed', stream)

      expect(stream.stdout).toHaveBeenCalledWith('{malformed')
    })

    it('handles JSON array (not object)', () => {
      adapter.handleStreamLine('[1,2,3]', stream)

      // Should not throw
      expect(stream.text).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Full JSONL sequence (integration-style)
  // ==========================================================================

  describe('full JSONL sequence', () => {
    it('processes a realistic OpenCode session in order', () => {
      const events = [
        { type: 'system', session_id: 'oc-001', model: 'gpt-4o' },
        {
          type: 'assistant',
          content: [
            { type: 'text', text: 'I will look at the project structure.' },
            { type: 'tool_use', id: 'tu_100', name: 'bash', input: { command: 'ls -la' } },
          ],
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tu_100', content: 'file1.txt\nfile2.txt', is_error: false },
            ],
          },
        },
        {
          type: 'assistant',
          content: [
            { type: 'text', text: 'Found 2 files. Creating module.' },
            { type: 'tool_use', id: 'tu_101', name: 'write_file', input: { path: 'mod.ts', content: 'export {}' } },
          ],
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tu_101', content: 'File written', is_error: false },
            ],
          },
        },
        {
          type: 'result',
          total_cost_usd: 0.0250,
          num_turns: 2,
          duration_ms: 10000,
          usage: { input_tokens: 1500, output_tokens: 700 },
          model: 'gpt-4o',
        },
      ]

      for (const event of events) {
        adapter.handleStreamLine(JSON.stringify(event), stream)
      }

      // Verify session init
      expect(stream.sessionInit).toHaveBeenCalledTimes(1)
      expect(stream.sessionInit).toHaveBeenCalledWith('oc-001', 'gpt-4o')

      // Verify text
      expect(stream.text).toHaveBeenCalledTimes(2)
      expect((stream.text as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('I will look at the project structure.\n')
      expect((stream.text as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('Found 2 files. Creating module.\n')

      // Verify tool use + result pairs
      expect(stream.toolUse).toHaveBeenCalledTimes(2)
      expect(stream.toolResult).toHaveBeenCalledTimes(2)

      // First tool: bash
      expect((stream.toolUse as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['bash', { command: 'ls -la' }])
      expect((stream.toolResult as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['bash', 'file1.txt\nfile2.txt', true])

      // Second tool: write_file
      expect((stream.toolUse as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual(['write_file', { path: 'mod.ts', content: 'export {}' }])
      expect((stream.toolResult as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual(['write_file', 'File written', true])

      // Verify completion status
      expect(stream.status).toHaveBeenCalledWith('running', 100, 'Completed (2 turns, $0.0250)')
    })

    it('handles error scenarios in a session', () => {
      const events = [
        { type: 'system', session_id: 'oc-err-001', model: 'gpt-4o' },
        {
          type: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_200', name: 'bash', input: { command: 'rm -rf /protected' } },
          ],
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tu_200', content: 'Permission denied', is_error: true },
            ],
          },
        },
        {
          type: 'assistant',
          content: [
            { type: 'text', text: 'The command failed due to permissions.' },
          ],
        },
        {
          type: 'result',
          cost_usd: 0.005,
          num_turns: 1,
        },
      ]

      for (const event of events) {
        adapter.handleStreamLine(JSON.stringify(event), stream)
      }

      expect(stream.toolResult).toHaveBeenCalledWith('bash', 'Permission denied', false)
      expect(stream.text).toHaveBeenCalledWith('The command failed due to permissions.\n')
    })
  })

  // ==========================================================================
  // Tool ID correlation
  // ==========================================================================

  describe('tool ID correlation', () => {
    it('correctly maps multiple tool_use IDs to tool names', () => {
      // Send two tool_use blocks in one message
      adapter.handleStreamLine(JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_300', name: 'read_file', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'tu_301', name: 'bash', input: { command: 'pwd' } },
        ],
      }), stream)

      // Results come back in order
      adapter.handleStreamLine(JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_300', content: 'export default {}', is_error: false },
            { type: 'tool_result', tool_use_id: 'tu_301', content: '/home/user', is_error: false },
          ],
        },
      }), stream)

      const resultCalls = (stream.toolResult as ReturnType<typeof vi.fn>).mock.calls
      expect(resultCalls[0]).toEqual(['read_file', 'export default {}', true])
      expect(resultCalls[1]).toEqual(['bash', '/home/user', true])
    })

    it('handles tool_result with missing mapping (returns "unknown")', () => {
      adapter.handleStreamLine(JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'unmapped_id', content: 'result', is_error: false },
          ],
        },
      }), stream)

      expect(stream.toolResult).toHaveBeenCalledWith('unknown', 'result', true)
    })
  })
})
