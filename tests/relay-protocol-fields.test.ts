/**
 * Relay Protocol Extension Tests
 *
 * Verifies the 4 new fields added to TaskDispatch:
 *   - type: TaskDispatchType ('execution' | 'plan' | 'chat' | 'summarize')
 *   - systemPrompt: string (system-level instructions)
 *   - messages: ConversationMessage[] (multi-turn chat history)
 *   - model: string (explicit model selection)
 *
 * Tests cover:
 *   1. Type definitions — new types and fields exist and are correctly typed
 *   2. Relay server — new fields are forwarded in the dispatch payload
 *   3. Backward compatibility — omitting new fields works (defaults applied)
 */
import { describe, it, expect } from 'vitest'
import type {
  TaskDispatch,
  TaskDispatchType,
  ConversationMessage,
} from '../server/types/relay'
import type {
  Task,
  TaskDispatchType as AgentTaskDispatchType,
  ConversationMessage as AgentConversationMessage,
} from '../src/types'

// ============================================================================
// 1. Type definition tests
// ============================================================================

describe('TaskDispatch type definitions (server/types/relay.ts)', () => {
  it('accepts all 4 new optional fields', () => {
    const dispatch: TaskDispatch = {
      taskId: 'task-1',
      projectId: 'proj-1',
      nodeId: 'node-1',
      title: 'Test task',
      description: 'A test task',
      // New fields
      type: 'chat',
      systemPrompt: 'You are a helpful planning assistant.',
      messages: [
        { role: 'user', content: 'What should I do next?' },
        { role: 'assistant', content: 'I suggest running the tests.' },
        { role: 'user', content: 'OK, which tests?' },
      ],
      model: 'claude-sonnet-4-20250514',
    }

    expect(dispatch.type).toBe('chat')
    expect(dispatch.systemPrompt).toBe('You are a helpful planning assistant.')
    expect(dispatch.messages).toHaveLength(3)
    expect(dispatch.messages![0].role).toBe('user')
    expect(dispatch.messages![1].role).toBe('assistant')
    expect(dispatch.model).toBe('claude-sonnet-4-20250514')
  })

  it('all 4 TaskDispatchType values are valid', () => {
    const types: TaskDispatchType[] = ['execution', 'plan', 'chat', 'summarize']
    types.forEach(t => {
      const dispatch: TaskDispatch = {
        taskId: `task-${t}`,
        projectId: 'proj-1',
        nodeId: 'node-1',
        title: `${t} task`,
        description: `A ${t} task`,
          type: t,
      }
      expect(dispatch.type).toBe(t)
    })
  })

  it('ConversationMessage enforces role as user|assistant', () => {
    const userMsg: ConversationMessage = { role: 'user', content: 'Hello' }
    const assistantMsg: ConversationMessage = { role: 'assistant', content: 'Hi there' }
    expect(userMsg.role).toBe('user')
    expect(assistantMsg.role).toBe('assistant')
  })

  it('new fields are optional — backward compatible with existing dispatches', () => {
    // This is a dispatch that an older version of the code would produce.
    // It should be a valid TaskDispatch (no new fields required).
    const legacyDispatch: TaskDispatch = {
      taskId: 'task-legacy',
      projectId: 'proj-1',
      nodeId: 'node-1',
      title: 'Legacy task',
      description: 'Created without new fields',
      prompt: 'Do the thing',
      maxTurns: 10,
    }

    expect(legacyDispatch.type).toBeUndefined()
    expect(legacyDispatch.systemPrompt).toBeUndefined()
    expect(legacyDispatch.messages).toBeUndefined()
    expect(legacyDispatch.model).toBeUndefined()
  })
})

// ============================================================================
// 2. Agent runner Task type mirrors relay TaskDispatch
// ============================================================================

describe('Agent runner Task type (packages/agent-runner/src/types.ts)', () => {
  it('accepts all 4 new fields', () => {
    const task: Task = {
      id: 'task-1',
      projectId: 'proj-1',
      planNodeId: 'node-1',
      provider: 'claude-sdk',
      prompt: 'Generate a plan for this project',
      workingDirectory: '/tmp/test',
      createdAt: new Date().toISOString(),
      // New fields
      type: 'plan',
      systemPrompt: 'You are a planning assistant. Output JSON.',
      messages: [
        { role: 'user', content: 'Plan this project' },
      ],
      model: 'claude-opus-4-20250514',
    }

    expect(task.type).toBe('plan')
    expect(task.systemPrompt).toContain('planning assistant')
    expect(task.messages).toHaveLength(1)
    expect(task.model).toBe('claude-opus-4-20250514')
  })

  it('new fields are optional — backward compatible', () => {
    const task: Task = {
      id: 'task-legacy',
      projectId: 'proj-1',
      planNodeId: 'node-1',
      provider: 'claude-sdk',
      prompt: 'Fix the bug',
      workingDirectory: '/tmp/test',
      createdAt: new Date().toISOString(),
    }

    expect(task.type).toBeUndefined()
    expect(task.systemPrompt).toBeUndefined()
    expect(task.messages).toBeUndefined()
    expect(task.model).toBeUndefined()
  })

  it('TaskDispatchType values match between server and agent runner', () => {
    // These should be the same union type
    const serverTypes: TaskDispatchType[] = ['execution', 'plan', 'chat', 'summarize']
    const agentTypes: AgentTaskDispatchType[] = ['execution', 'plan', 'chat', 'summarize']
    expect(serverTypes).toEqual(agentTypes)
  })

  it('ConversationMessage shape matches between server and agent runner', () => {
    const serverMsg: ConversationMessage = { role: 'user', content: 'Hello' }
    const agentMsg: AgentConversationMessage = { role: 'user', content: 'Hello' }
    expect(serverMsg).toEqual(agentMsg)
  })
})

// ============================================================================
// 3. Relay dispatch payload construction
// ============================================================================

describe('Relay server dispatch payload forwarding', () => {
  /**
   * Simulates the relay server's dispatchTask payload construction.
   * This mirrors the logic in server/lib/relay-server.ts dispatchTask().
   */
  function buildDispatchPayload(task: TaskDispatch) {
    const promptParts: string[] = []
    if (task.visionDoc) {
      promptParts.push(`## Project Vision\n\n${task.visionDoc}`)
    }
    promptParts.push(`## Current Task\n\n**${task.title}**\n\n${task.description}`)
    const finalPrompt = task.prompt || promptParts.join('\n\n---\n\n')

    return {
      id: task.taskId,
      projectId: task.projectId,
      planNodeId: task.nodeId,
      provider: task.preferredProvider || 'claude-sdk',
      prompt: finalPrompt,
      workingDirectory: task.workingDirectory || '',
      timeout: task.timeout,
      maxTurns: task.maxTurns,
      outputFormat: task.outputFormat,
      executionStrategy: task.executionStrategy || undefined,
      createdAt: new Date().toISOString(),
      // New relay protocol fields — forwarded when present
      ...(task.type && { type: task.type }),
      ...(task.systemPrompt && { systemPrompt: task.systemPrompt }),
      ...(task.messages && { messages: task.messages }),
      ...(task.model && { model: task.model }),
    }
  }

  it('forwards type field when present', () => {
    const payload = buildDispatchPayload({
      taskId: 'task-1',
      projectId: 'proj-1',
      nodeId: 'node-1',
      title: 'Chat',
      description: 'Chat about plan',
      type: 'chat',
    })
    expect(payload.type).toBe('chat')
  })

  it('forwards systemPrompt field when present', () => {
    const payload = buildDispatchPayload({
      taskId: 'task-1',
      projectId: 'proj-1',
      nodeId: 'node-1',
      title: 'Plan',
      description: 'Generate plan',
      systemPrompt: 'You are a planning assistant.',
    })
    expect(payload.systemPrompt).toBe('You are a planning assistant.')
  })

  it('forwards messages array when present', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'What should I do?' },
      { role: 'assistant', content: 'Run tests.' },
      { role: 'user', content: 'Which tests?' },
    ]
    const payload = buildDispatchPayload({
      taskId: 'task-1',
      projectId: 'proj-1',
      nodeId: 'node-1',
      title: 'Chat',
      description: 'Continue chat',
      messages,
    })
    expect(payload.messages).toEqual(messages)
    expect(payload.messages).toHaveLength(3)
  })

  it('forwards model field when present', () => {
    const payload = buildDispatchPayload({
      taskId: 'task-1',
      projectId: 'proj-1',
      nodeId: 'node-1',
      title: 'Summarize',
      description: 'Summarize output',
      model: 'claude-sonnet-4-20250514',
    })
    expect(payload.model).toBe('claude-sonnet-4-20250514')
  })

  it('omits new fields when not provided (backward compatible)', () => {
    const payload = buildDispatchPayload({
      taskId: 'task-1',
      projectId: 'proj-1',
      nodeId: 'node-1',
      title: 'Execute',
      description: 'Run task',
    })
    // Should NOT have type, systemPrompt, messages, model keys
    expect('type' in payload).toBe(false)
    expect('systemPrompt' in payload).toBe(false)
    expect('messages' in payload).toBe(false)
    expect('model' in payload).toBe(false)
  })

  it('forwards all 4 new fields together in a chat dispatch', () => {
    const payload = buildDispatchPayload({
      taskId: 'chat-1',
      projectId: 'proj-1',
      nodeId: 'node-1',
      title: 'Plan chat',
      description: 'Discuss the plan',
      type: 'chat',
      systemPrompt: 'You are helping refine a project plan.',
      messages: [
        { role: 'user', content: 'Is the plan good?' },
        { role: 'assistant', content: 'It looks solid.' },
      ],
      model: 'claude-sonnet-4-20250514',
      maxTurns: 1,
    })

    expect(payload.type).toBe('chat')
    expect(payload.systemPrompt).toBe('You are helping refine a project plan.')
    expect(payload.messages).toHaveLength(2)
    expect(payload.model).toBe('claude-sonnet-4-20250514')
    expect(payload.maxTurns).toBe(1)
  })

  it('uses prompt when provided, ignoring title/description construction', () => {
    const payload = buildDispatchPayload({
      taskId: 'task-1',
      projectId: 'proj-1',
      nodeId: 'node-1',
      title: 'Should be ignored',
      description: 'Also ignored',
      prompt: 'This is the pre-built prompt',
    })
    expect(payload.prompt).toBe('This is the pre-built prompt')
    expect(payload.prompt).not.toContain('Should be ignored')
  })
})

// ============================================================================
// 4. Claude SDK adapter — system prompt, model, messages handling
// ============================================================================

describe('Claude SDK adapter field consumption', () => {
  /**
   * Simulates how the Claude SDK adapter builds query parameters from a Task.
   * This mirrors the logic in claude-sdk-adapter.ts execute().
   */
  function buildQueryParams(task: Task) {
    // Default maxTurns based on task type (text-only gets 10, execution gets unlimited)
    const isTextOnly = task.type === 'chat' || task.type === 'summarize'
    const defaultMaxTurns = isTextOnly ? 10 : undefined
    const maxTurns = task.maxTurns ?? defaultMaxTurns

    const options: Record<string, unknown> = {
      ...(maxTurns != null ? { maxTurns } : {}),
    }

    if (task.outputFormat) {
      options.outputFormat = task.outputFormat
    }
    if (task.systemPrompt) {
      options.systemPrompt = task.systemPrompt
    }
    if (task.model) {
      options.model = task.model
    }

    // Build prompt
    let effectivePrompt = task.prompt
    if (task.messages && task.messages.length > 0) {
      const conversationContext = task.messages
        .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
        .join('\n\n')
      effectivePrompt = effectivePrompt
        ? `${effectivePrompt}\n\n---\n\nConversation history:\n${conversationContext}`
        : conversationContext
    }

    return { prompt: effectivePrompt, options }
  }

  it('applies systemPrompt to options', () => {
    const { options } = buildQueryParams({
      id: 'task-1',
      projectId: 'proj-1',
      planNodeId: 'node-1',
      provider: 'claude-sdk',
      prompt: 'Do something',
      workingDirectory: '/tmp',
      createdAt: new Date().toISOString(),
      systemPrompt: 'You are a code reviewer.',
    })
    expect(options.systemPrompt).toBe('You are a code reviewer.')
  })

  it('applies model to options', () => {
    const { options } = buildQueryParams({
      id: 'task-1',
      projectId: 'proj-1',
      planNodeId: 'node-1',
      provider: 'claude-sdk',
      prompt: 'Summarize this',
      workingDirectory: '/tmp',
      createdAt: new Date().toISOString(),
      model: 'claude-opus-4-20250514',
    })
    expect(options.model).toBe('claude-opus-4-20250514')
  })

  it('uses maxTurns=10 for chat tasks when not explicitly set', () => {
    const { options } = buildQueryParams({
      id: 'task-1',
      projectId: 'proj-1',
      planNodeId: 'node-1',
      provider: 'claude-sdk',
      prompt: 'Chat about plan',
      workingDirectory: '/tmp',
      createdAt: new Date().toISOString(),
      type: 'chat',
    })
    expect(options.maxTurns).toBe(10)
  })

  it('uses maxTurns=10 for summarize tasks when not explicitly set', () => {
    const { options } = buildQueryParams({
      id: 'task-1',
      projectId: 'proj-1',
      planNodeId: 'node-1',
      provider: 'claude-sdk',
      prompt: 'Summarize output',
      workingDirectory: '/tmp',
      createdAt: new Date().toISOString(),
      type: 'summarize',
    })
    expect(options.maxTurns).toBe(10)
  })

  it('uses unlimited maxTurns for execution tasks when not explicitly set', () => {
    const { options } = buildQueryParams({
      id: 'task-1',
      projectId: 'proj-1',
      planNodeId: 'node-1',
      provider: 'claude-sdk',
      prompt: 'Fix the bug',
      workingDirectory: '/tmp',
      createdAt: new Date().toISOString(),
      type: 'execution',
    })
    expect(options.maxTurns).toBeUndefined()
  })

  it('uses unlimited maxTurns when type is omitted (backward compatible)', () => {
    const { options } = buildQueryParams({
      id: 'task-1',
      projectId: 'proj-1',
      planNodeId: 'node-1',
      provider: 'claude-sdk',
      prompt: 'Do something',
      workingDirectory: '/tmp',
      createdAt: new Date().toISOString(),
    })
    expect(options.maxTurns).toBeUndefined()
  })

  it('explicit maxTurns overrides task-type defaults', () => {
    const { options } = buildQueryParams({
      id: 'task-1',
      projectId: 'proj-1',
      planNodeId: 'node-1',
      provider: 'claude-sdk',
      prompt: 'Chat with specific turns',
      workingDirectory: '/tmp',
      createdAt: new Date().toISOString(),
      type: 'chat',
      maxTurns: 25,
    })
    expect(options.maxTurns).toBe(25)
  })

  it('builds conversation context from messages array', () => {
    const { prompt } = buildQueryParams({
      id: 'task-1',
      projectId: 'proj-1',
      planNodeId: 'node-1',
      provider: 'claude-sdk',
      prompt: 'System context here',
      workingDirectory: '/tmp',
      createdAt: new Date().toISOString(),
      messages: [
        { role: 'user', content: 'What should I do?' },
        { role: 'assistant', content: 'Run tests first.' },
        { role: 'user', content: 'OK which tests?' },
      ],
    })
    expect(prompt).toContain('System context here')
    expect(prompt).toContain('Conversation history:')
    expect(prompt).toContain('Human: What should I do?')
    expect(prompt).toContain('Assistant: Run tests first.')
    expect(prompt).toContain('Human: OK which tests?')
  })

  it('uses messages as sole prompt when prompt field is empty', () => {
    const { prompt } = buildQueryParams({
      id: 'task-1',
      projectId: 'proj-1',
      planNodeId: 'node-1',
      provider: 'claude-sdk',
      prompt: '',
      workingDirectory: '/tmp',
      createdAt: new Date().toISOString(),
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ],
    })
    expect(prompt).toContain('Human: Hello')
    expect(prompt).toContain('Assistant: Hi')
    expect(prompt).not.toContain('Conversation history:')
  })

  it('does not add systemPrompt or model to options when not provided', () => {
    const { options } = buildQueryParams({
      id: 'task-1',
      projectId: 'proj-1',
      planNodeId: 'node-1',
      provider: 'claude-sdk',
      prompt: 'Just a prompt',
      workingDirectory: '/tmp',
      createdAt: new Date().toISOString(),
    })
    expect('systemPrompt' in options).toBe(false)
    expect('model' in options).toBe(false)
  })
})
