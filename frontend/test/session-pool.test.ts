import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionPool } from '../src/stores/session-pool'

test('keeps a tool loop and its final answer in one assistant bubble', () => {
  setActivePinia(createPinia())
  const store = useSessionPool()
  store.handleServerMessage({
    type: 'session_state',
    session: {
      summary: { id: 'session-1', title: 'Search', updatedAt: new Date(1).toISOString() },
      messages: [{ id: 'message-0', role: 'user', text: 'Can you search?' }],
      thinkingLevel: 'medium',
      isStreaming: false
    }
  })

  store.handleServerMessage({ type: 'agent_start', sessionId: 'session-1' })
  store.handleServerMessage({ type: 'thinking_delta', sessionId: 'session-1', delta: 'I will check.' })
  store.handleServerMessage({
    type: 'message_end',
    sessionId: 'session-1',
    message: {
      id: 'message-1',
      role: 'assistant',
      text: '',
      thinking: 'I will check.',
      tools: [{ id: 'call-1', name: 'bash', input: { command: 'search' }, status: 'running' }]
    }
  })
  store.handleServerMessage({
    type: 'tool_start',
    sessionId: 'session-1',
    tool: { id: 'call-1', name: 'bash', input: { command: 'search' }, status: 'running' }
  })
  store.handleServerMessage({
    type: 'tool_end',
    sessionId: 'session-1',
    toolCallId: 'call-1',
    output: 'result',
    isError: false
  })
  store.handleServerMessage({ type: 'text_delta', sessionId: 'session-1', delta: 'Yes, I can.' })
  store.handleServerMessage({
    type: 'message_end',
    sessionId: 'session-1',
    message: {
      id: 'message-1',
      role: 'assistant',
      text: 'Yes, I can.',
      thinking: 'I will check.',
      tools: [{ id: 'call-1', name: 'bash', input: { command: 'search' }, output: 'result', status: 'done' }]
    }
  })
  store.handleServerMessage({ type: 'agent_end', sessionId: 'session-1' })

  const state = store.sessionStates['session-1']
  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[1]?.text, 'Yes, I can.')
  assert.equal(state.messages[1]?.thinking, 'I will check.')
  assert.equal(state.messages[1]?.tools?.[0]?.status, 'done')
  assert.equal(state.streamMessageId, undefined)
  assert.equal(state.isStreaming, false)
})
