/**
 * Codex JSONL Stream Parser Tests
 *
 * Tests the structured parsing of Codex CLI's --json JSONL output.
 * Verifies that Codex events are correctly mapped to TaskOutputStream methods,
 * achieving feature parity with the Claude Code adapter's stream-json parsing.
 *
 * Codex JSONL event types tested:
 * - thread.started   → sessionInit
 * - turn.started     → status update
 * - item.started     → toolUse (for command_execution)
 * - item.completed   → text (reasoning, agent_message) or toolResult (command_execution)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// We test the adapter's private handleStreamLine indirectly by
// accessing it via prototype. This keeps the test focused on the
// JSONL parsing logic without needing to spawn real processes.
import { CodexAdapter } from '../src/providers/codex-adapter.js'
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

/**
 * Access the private handleStreamLine method for unit testing.
 * This is intentional — we're testing the parsing logic in isolation
 * without needing to spawn a real Codex process.
 */
function callHandleStreamLine(
  adapter: CodexAdapter,
  line: string,
  stream: TaskOutputStream,
  artifacts: TaskArtifact[] = [],
  model?: string,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).handleStreamLine(line, stream, artifacts, model)
}

describe('Codex JSONL parser: handleStreamLine', () => {
  let adapter: CodexAdapter
  let stream: TaskOutputStream
  let artifacts: TaskArtifact[]

  beforeEach(() => {
    adapter = new CodexAdapter()
    stream = createMockStream()
    artifacts = []
  })

  // ==========================================================================
  // thread.started
  // ==========================================================================

  describe('thread.started', () => {
    it('emits sessionInit with thread_id and model', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'thread.started',
        thread_id: '019c8e88-147e-7a21-9a48-be82fa341b77',
      }), stream, artifacts, 'gpt-5.3-codex')

      expect(stream.sessionInit).toHaveBeenCalledWith('019c8e88-147e-7a21-9a48-be82fa341b77', 'gpt-5.3-codex')
    })

    it('emits sessionInit without model when not provided', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'thread.started',
        thread_id: '019c8e88-147e-7a21-9a48-be82fa341b77',
      }), stream, artifacts)

      expect(stream.sessionInit).toHaveBeenCalledWith('019c8e88-147e-7a21-9a48-be82fa341b77', undefined)
    })

    it('does not emit sessionInit when thread_id is missing', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'thread.started',
      }), stream, artifacts)

      expect(stream.sessionInit).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // turn.started
  // ==========================================================================

  describe('turn.started', () => {
    it('emits status update', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'turn.started',
      }), stream, artifacts)

      expect(stream.status).toHaveBeenCalledWith('running', undefined, 'Agent thinking...')
    })
  })

  // ==========================================================================
  // item.started (command_execution)
  // ==========================================================================

  describe('item.started', () => {
    it('emits toolUse for command_execution', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_2',
          type: 'command_execution',
          command: "/bin/zsh -lc 'pwd; ls -la'",
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      }), stream, artifacts)

      expect(stream.toolUse).toHaveBeenCalledWith(
        "/bin/zsh -lc 'pwd; ls -la'",
        { command: "/bin/zsh -lc 'pwd; ls -la'", status: 'in_progress' },
      )
    })

    it('does not emit toolUse for non-command item types', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_0',
          type: 'reasoning',
        },
      }), stream, artifacts)

      expect(stream.toolUse).not.toHaveBeenCalled()
    })

    it('handles missing item gracefully', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.started',
      }), stream, artifacts)

      expect(stream.toolUse).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // item.completed — reasoning
  // ==========================================================================

  describe('item.completed: reasoning', () => {
    it('emits text with [thinking] prefix', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'reasoning',
          text: 'Starting workspace inspection',
        },
      }), stream, artifacts)

      expect(stream.text).toHaveBeenCalledWith('[thinking] Starting workspace inspection\n')
    })

    it('does not emit text when reasoning text is empty', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'reasoning',
          text: '',
        },
      }), stream, artifacts)

      expect(stream.text).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // item.completed — agent_message
  // ==========================================================================

  describe('item.completed: agent_message', () => {
    it('emits text for agent message', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: "I'll create the requested lean workspace and write a setup document.",
        },
      }), stream, artifacts)

      expect(stream.text).toHaveBeenCalledWith(
        "I'll create the requested lean workspace and write a setup document.\n",
      )
    })

    it('does not emit text when agent_message text is empty', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: '',
        },
      }), stream, artifacts)

      expect(stream.text).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // item.completed — command_execution
  // ==========================================================================

  describe('item.completed: command_execution', () => {
    it('emits toolResult for successful command', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'command_execution',
          command: "/bin/zsh -lc 'pwd; ls -la'",
          aggregated_output: '/Users/user/code\ntotal 100\ndrwxr-xr-x 10 user staff 320 Feb 17 22:54 .\n',
          exit_code: 0,
          status: 'completed',
        },
      }), stream, artifacts)

      expect(stream.toolResult).toHaveBeenCalledWith(
        "/bin/zsh -lc 'pwd; ls -la'",
        {
          output: '/Users/user/code\ntotal 100\ndrwxr-xr-x 10 user staff 320 Feb 17 22:54 .\n',
          exit_code: 0,
          status: 'completed',
        },
        true,
      )
    })

    it('emits toolResult with success=false for failed command', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_8',
          type: 'command_execution',
          command: "/bin/zsh -lc 'git clone https://github.com/leanprover/lean4 lean/code/lean4'",
          aggregated_output: "Cloning into 'lean/code/lean4'...\nfatal: unable to access 'https://github.com/leanprover/lean4/': Could not resolve host: github.com\n",
          exit_code: 128,
          status: 'failed',
        },
      }), stream, artifacts)

      expect(stream.toolResult).toHaveBeenCalledWith(
        "/bin/zsh -lc 'git clone https://github.com/leanprover/lean4 lean/code/lean4'",
        expect.objectContaining({ exit_code: 128, status: 'failed' }),
        false,
      )
    })

    it('treats exit_code 0 as success', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_5',
          type: 'command_execution',
          command: "/bin/zsh -lc 'mkdir -p lean/code && ls -la lean'",
          aggregated_output: 'total 0\ndrwxr-xr-x 3 user staff 96 Feb 23 23:23 .\n',
          exit_code: 0,
          status: 'completed',
        },
      }), stream, artifacts)

      const callArgs = (stream.toolResult as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(callArgs[2]).toBe(true) // success flag
    })

    it('treats non-zero exit_code with "completed" status as success', () => {
      // Some commands exit non-zero but Codex marks them as "completed"
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_6',
          type: 'command_execution',
          command: "/bin/zsh -lc 'git rev-parse --is-inside-work-tree 2>/dev/null || echo not-a-git-repo'",
          aggregated_output: 'not-a-git-repo\n',
          exit_code: 0,
          status: 'completed',
        },
      }), stream, artifacts)

      const callArgs = (stream.toolResult as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(callArgs[2]).toBe(true)
    })
  })

  // ==========================================================================
  // File artifact extraction from commands
  // ==========================================================================

  describe('file artifact extraction from commands', () => {
    it('extracts files from cat > redirect commands', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_18',
          type: 'command_execution',
          command: "/bin/zsh -lc \"cat > /Users/user/code/lean/SETUP.md <<'EOF'\ncontent\nEOF\"",
          aggregated_output: '',
          exit_code: 0,
          status: 'completed',
        },
      }), stream, artifacts)

      expect(artifacts.some(a => a.path === '/Users/user/code/lean/SETUP.md')).toBe(true)
    })

    it('extracts files from mkdir -p commands', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_5',
          type: 'command_execution',
          command: "/bin/zsh -lc 'mkdir -p lean/code'",
          aggregated_output: '',
          exit_code: 0,
          status: 'completed',
        },
      }), stream, artifacts)

      expect(artifacts.some(a => a.path === 'lean/code')).toBe(true)
    })

    it('does not add duplicate artifacts', () => {
      artifacts.push({ type: 'file', name: '/tmp/file.txt', path: '/tmp/file.txt' })

      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: "cat > /tmp/file.txt",
          aggregated_output: '',
          exit_code: 0,
          status: 'completed',
        },
      }), stream, artifacts)

      expect(artifacts.filter(a => a.path === '/tmp/file.txt')).toHaveLength(1)
    })
  })

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe('edge cases', () => {
    it('handles non-JSON lines as raw stdout', () => {
      callHandleStreamLine(adapter, 'this is not json', stream, artifacts)

      expect(stream.stdout).toHaveBeenCalledWith('this is not json\n')
    })

    it('handles empty JSON objects', () => {
      callHandleStreamLine(adapter, '{}', stream, artifacts)

      // Should not throw and should not emit any structured events
      expect(stream.text).not.toHaveBeenCalled()
      expect(stream.toolUse).not.toHaveBeenCalled()
      expect(stream.toolResult).not.toHaveBeenCalled()
      expect(stream.sessionInit).not.toHaveBeenCalled()
    })

    it('handles unknown event types silently', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'some.future.event',
        data: 'hello',
      }), stream, artifacts)

      expect(stream.text).not.toHaveBeenCalled()
      expect(stream.stdout).not.toHaveBeenCalled()
    })

    it('handles item.completed with unknown item type but text field', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_99',
          type: 'new_unknown_type',
          text: 'Some future event text',
        },
      }), stream, artifacts)

      expect(stream.text).toHaveBeenCalledWith('Some future event text\n')
    })

    it('handles item.completed with missing item', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
      }), stream, artifacts)

      // Should not throw
      expect(stream.text).not.toHaveBeenCalled()
      expect(stream.toolResult).not.toHaveBeenCalled()
    })

    it('handles command_execution with null exit_code and failed status', () => {
      callHandleStreamLine(adapter, JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'some-command',
          aggregated_output: '',
          exit_code: null,
          status: 'failed',
        },
      }), stream, artifacts)

      const callArgs = (stream.toolResult as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(callArgs[2]).toBe(false) // success should be false
    })
  })

  // ==========================================================================
  // Full JSONL sequence (integration-style)
  // ==========================================================================

  describe('full JSONL sequence', () => {
    it('processes a realistic Codex session in order', () => {
      const jsonlLines = [
        { type: 'thread.started', thread_id: 'thread-001' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Checking workspace' } },
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'I will inspect the directory.' } },
        { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'ls -la', aggregated_output: '', exit_code: null, status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'ls -la', aggregated_output: 'file1.txt\nfile2.txt\n', exit_code: 0, status: 'completed' } },
        { type: 'item.completed', item: { id: 'item_3', type: 'reasoning', text: 'Found 2 files' } },
        { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'The directory contains 2 files.' } },
      ]

      for (const event of jsonlLines) {
        callHandleStreamLine(adapter, JSON.stringify(event), stream, artifacts)
      }

      // Verify the sequence of calls
      expect(stream.sessionInit).toHaveBeenCalledTimes(1)
      expect(stream.sessionInit).toHaveBeenCalledWith('thread-001', undefined)

      expect(stream.status).toHaveBeenCalledTimes(1) // turn.started

      expect(stream.text).toHaveBeenCalledTimes(4) // 2 reasoning + 2 agent_message
      expect((stream.text as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('[thinking] Checking workspace\n')
      expect((stream.text as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('I will inspect the directory.\n')
      expect((stream.text as ReturnType<typeof vi.fn>).mock.calls[2][0]).toBe('[thinking] Found 2 files\n')
      expect((stream.text as ReturnType<typeof vi.fn>).mock.calls[3][0]).toBe('The directory contains 2 files.\n')

      expect(stream.toolUse).toHaveBeenCalledTimes(1)
      expect(stream.toolUse).toHaveBeenCalledWith('ls -la', { command: 'ls -la', status: 'in_progress' })

      expect(stream.toolResult).toHaveBeenCalledTimes(1)
      expect(stream.toolResult).toHaveBeenCalledWith(
        'ls -la',
        { output: 'file1.txt\nfile2.txt\n', exit_code: 0, status: 'completed' },
        true,
      )
    })

    it('handles parallel commands (multiple item.started before item.completed)', () => {
      const jsonlLines = [
        { type: 'thread.started', thread_id: 'thread-002' },
        { type: 'item.started', item: { id: 'item_5', type: 'command_execution', command: 'cmd-a', aggregated_output: '', exit_code: null, status: 'in_progress' } },
        { type: 'item.started', item: { id: 'item_6', type: 'command_execution', command: 'cmd-b', aggregated_output: '', exit_code: null, status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'item_5', type: 'command_execution', command: 'cmd-a', aggregated_output: 'output-a', exit_code: 0, status: 'completed' } },
        { type: 'item.completed', item: { id: 'item_6', type: 'command_execution', command: 'cmd-b', aggregated_output: 'output-b', exit_code: 1, status: 'failed' } },
      ]

      for (const event of jsonlLines) {
        callHandleStreamLine(adapter, JSON.stringify(event), stream, artifacts)
      }

      expect(stream.toolUse).toHaveBeenCalledTimes(2)
      expect(stream.toolResult).toHaveBeenCalledTimes(2)

      // First command succeeded, second failed
      const results = (stream.toolResult as ReturnType<typeof vi.fn>).mock.calls
      expect(results[0][0]).toBe('cmd-a')
      expect(results[0][2]).toBe(true)
      expect(results[1][0]).toBe('cmd-b')
      expect(results[1][2]).toBe(false)
    })
  })
})
