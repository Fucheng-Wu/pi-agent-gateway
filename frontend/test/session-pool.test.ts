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

test('role changes await their own acknowledgement and preserve a live conversation', () => {
  setActivePinia(createPinia())
  const store = useSessionPool()
  const sent: Array<Record<string, unknown>> = []
  store.setSender((message) => { sent.push(message); return true })
  const snapshot = {
    summary: { id: 'session-role', title: 'Existing', updatedAt: new Date(1).toISOString() },
    messages: [{ id: 'question', role: 'user' as const, text: 'Keep this question' }],
    thinkingLevel: 'high' as const, isStreaming: false, primaryAgentId: 'build',
    model: { provider: 'test', id: 'model' }
  }
  store.handleServerMessage({ type: 'session_state', session: snapshot })
  assert.equal(store.setPrimaryAgent('session-role', 'plan'), true)
  assert.equal(store.primaryAgentChanging['session-role'], true)
  store.handleServerMessage({ type: 'session_state', session: snapshot, requestId: 'unrelated' })
  assert.equal(store.primaryAgentChanging['session-role'], true)
  store.handleServerMessage({ type: 'session_updated', sessionId: 'session-role', primaryAgentId: 'plan' })
  store.handleServerMessage({ type: 'session_state', session: { ...snapshot, primaryAgentId: 'plan' }, requestId: sent[0].requestId as string })
  assert.equal(store.sessionStates['session-role'].primaryAgentId, 'plan')
  assert.equal(store.sessionStates['session-role'].messages[0].text, 'Keep this question')
  assert.deepEqual(store.sessionStates['session-role'].model, snapshot.model)
  assert.equal(store.primaryAgentChanging['session-role'], undefined)
})

test('permission requests queue, resolve individually, and clear on disconnect', () => {
  setActivePinia(createPinia())
  const store = useSessionPool()
  store.setSender(() => true)
  const permission = {
    id: 'approval-1', sessionId: 'root', agentId: 'build:child', agentName: 'Build / Child',
    toolName: 'write', resource: 'file.txt', input: { path: 'file.txt' },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString()
  }
  store.handleServerMessage({ type: 'permission_request', permission })
  store.handleServerMessage({ type: 'permission_request', permission })
  store.handleServerMessage({ type: 'permission_request', permission: { ...permission, id: 'approval-2' } })
  assert.equal(store.permissionRequests.length, 2)
  assert.equal(store.respondPermission('approval-1', 'allow_once'), true)
  assert.equal(store.respondPermission('approval-1', 'allow_once'), false)
  store.handleServerMessage({ type: 'permission_resolved', permissionId: 'approval-1', sessionId: 'root', decision: 'allow_once' })
  assert.deepEqual(store.permissionRequests.map((item) => item.id), ['approval-2'])
  store.onTransportDisconnected()
  assert.equal(store.permissionRequests.length, 0)
})
