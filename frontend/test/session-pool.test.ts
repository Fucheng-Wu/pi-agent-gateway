import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionPool } from '../src/stores/session-pool'
import type { SubagentRun } from '../src/types'
import { collaborationTools } from '../src/lib/subagents'

test('background collaboration updates survive parent message replacement and reconnect without duplicate agents', () => {
  setActivePinia(createPinia())
  const store = useSessionPool()
  const summary = { id: 'team', title: 'Collaborate', updatedAt: new Date(1).toISOString() }
  const run: SubagentRun = { id: 'worker', name: 'Worker', profile: 'explore', task: 'inspect', status: 'running', messages: [] }
  store.handleServerMessage({ type: 'session_state', session: { summary, messages: [], thinkingLevel: 'medium', isStreaming: true } })
  store.handleServerMessage({ type: 'subagent_update', sessionId: 'team', subagent: run })
  store.handleServerMessage({ type: 'tool_start', sessionId: 'team', tool: { id: 'spawn', name: 'spawn_agent', status: 'running' } })
  store.handleServerMessage({ type: 'tool_end', sessionId: 'team', toolCallId: 'spawn', subagent: run })
  store.handleServerMessage({ type: 'subagent_update', sessionId: 'team', subagent: { ...run, status: 'done' } })
  store.handleServerMessage({ type: 'message_end', sessionId: 'team', message: { id: 'parent-final', role: 'assistant', text: 'done', tools: [{ id: 'spawn', name: 'spawn_agent', status: 'done', subagent: run }, { id: 'followup', name: 'followup_agent', status: 'done', subagent: run }] } })
  let agents = collaborationTools(store.sessionStates.team.messages, store.sessionStates.team.subagents!)
  assert.equal(agents.length, 1)
  assert.equal(agents[0].subagent?.status, 'done', 'the latest background state wins over stale tool snapshots')
  store.handleServerMessage({ type: 'session_state', session: { summary, messages: store.sessionStates.team.messages, subagents: [{ ...run, status: 'error', closed: true }], thinkingLevel: 'medium', isStreaming: false } })
  agents = collaborationTools(store.sessionStates.team.messages, store.sessionStates.team.subagents!)
  assert.equal(agents[0].subagent?.closed, true)
  assert.equal(store.sessionStates.team.isStreaming, false)
})

test('interleaved delegated conversations update independently and survive a reconnect snapshot', () => {
  setActivePinia(createPinia())
  const store = useSessionPool()
  const summary = { id: 'parent', title: 'Delegate', updatedAt: new Date(1).toISOString() }
  store.handleServerMessage({ type: 'session_state', session: { summary, messages: [], thinkingLevel: 'medium', isStreaming: true } })
  const run = (id: string): SubagentRun => ({ id, name: id, profile: 'explore', task: id, status: 'running', messages: [{ id: 'answer', role: 'assistant', text: id }] })
  for (const id of ['one', 'two']) store.handleServerMessage({ type: 'tool_start', sessionId: 'parent', tool: { id, name: 'Agent', status: 'running' } })
  store.handleServerMessage({ type: 'tool_update', sessionId: 'parent', toolCallId: 'two', subagent: run('two') })
  store.handleServerMessage({ type: 'tool_update', sessionId: 'parent', toolCallId: 'one', subagent: run('one') })
  store.handleServerMessage({ type: 'tool_end', sessionId: 'parent', toolCallId: 'two', subagent: { ...run('two'), status: 'done' }, output: 'two complete' })
  const tools = store.sessionStates.parent.messages[0].tools!
  assert.equal(tools[0].subagent?.messages[0].text, 'one')
  assert.equal(tools[0].status, 'running')
  assert.equal(tools[1].subagent?.status, 'done')
  store.handleServerMessage({ type: 'session_state', session: { summary, messages: JSON.parse(JSON.stringify(store.sessionStates.parent.messages)), thinkingLevel: 'medium', isStreaming: true } })
  assert.equal(store.sessionStates.parent.messages[0].tools?.[1].subagent?.messages[0].text, 'two')
})

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

function recoveryStore() {
  setActivePinia(createPinia())
  const store = useSessionPool()
  const sent: any[] = []
  store.setSender((message) => { sent.push(message); return true })
  const snapshot = (text = '', sequence = 0, isStreaming = false, epoch = 'server-1') => ({
    summary: { id: 'recovery', title: 'Recovery', updatedAt: new Date(1).toISOString() },
    messages: text ? [{ id: 'answer', role: 'assistant' as const, text }] : [],
    thinkingLevel: 'medium' as const, isStreaming, epoch, sequence
  })
  store.handleServerMessage({ type: 'session_state', session: snapshot() })
  return { store, sent, snapshot }
}

test('a rejected prompt removes only its optimistic message and restores an actionable session', () => {
  const { store, sent } = recoveryStore()
  store.prompt('recovery', 'hello')
  assert.equal(store.sessionStates.recovery.isStreaming, true)
  store.handleServerMessage({ type: 'error', requestId: sent[0].requestId, sessionId: 'recovery', message: 'Rejected' })
  assert.equal(store.sessionStates.recovery.isStreaming, false)
  assert.equal(store.sessionStates.recovery.messages.length, 0)
  assert.equal(store.recoveredDrafts.recovery, 'hello')
  assert.ok(sent.some((message) => message.type === 'load_session'))
  store.onTransportDisconnected()
})

test('image-only prompts keep attachments through optimistic messages, rejection and snapshots', () => {
  const { store, sent, snapshot } = recoveryStore()
  const images = [{ mimeType: 'image/png' as const, data: 'aGVsbG8=', name: 'example.png' }]
  assert.equal(store.prompt('recovery', '', images), true)
  assert.deepEqual(sent[0].images, images)
  assert.deepEqual(store.sessionStates.recovery.messages[0].images, images)
  store.handleServerMessage({ type: 'error', requestId: sent[0].requestId, sessionId: 'recovery', message: 'Model does not support images' })
  assert.deepEqual(store.recoveredImages.recovery, images)
  assert.equal(store.recoveredDrafts.recovery, '')
  assert.equal(store.sessionStates.recovery.messages.length, 0)
  store.handleServerMessage({ type: 'session_state', requestId: sent.at(-1).requestId, session: snapshot() })
  assert.equal(store.prompt('recovery', 'Describe', images), true)
  const incoming = { id: 'persisted', role: 'user' as const, text: 'Describe\n[Image: resized]', images: [{ ...images[0], data: 'cmVzaXplZA==' }] }
  store.handleServerMessage({ type: 'message_end', sessionId: 'recovery', message: incoming })
  assert.equal(store.sessionStates.recovery.messages.length, 1)
  assert.equal(store.sessionStates.recovery.messages[0].id, 'persisted')
  store.handleServerMessage({ type: 'session_state', session: { ...snapshot(), messages: [incoming] } })
  assert.deepEqual(store.sessionStates.recovery.messages[0].images, incoming.images)
  store.onTransportDisconnected()
})

test('authoritative snapshots fill missing text and replay only events after their sequence', () => {
  const { store, sent, snapshot } = recoveryStore()
  store.handleServerMessage({ type: 'session_state', session: snapshot('A', 1, true) })
  store.loadSession('recovery')
  store.handleServerMessage({ type: 'text_delta', sessionId: 'recovery', delta: 'C', epoch: 'server-1', sequence: 3 })
  store.handleServerMessage({ type: 'text_delta', sessionId: 'recovery', delta: 'D', epoch: 'server-1', sequence: 4 })
  store.handleServerMessage({ type: 'session_state', requestId: sent.at(-1).requestId, session: snapshot('ABC', 3, true) })
  assert.equal(store.sessionStates.recovery.messages[0].text, 'ABCD')
  store.handleServerMessage({ type: 'text_delta', sessionId: 'recovery', delta: 'D', epoch: 'server-1', sequence: 4 })
  assert.equal(store.sessionStates.recovery.messages[0].text, 'ABCD', 'duplicate sequence must not append twice')
  store.onTransportDisconnected()
})

test('reconnect refreshes cached background sessions and accepts a new server epoch', () => {
  const { store, sent, snapshot } = recoveryStore()
  store.handleServerMessage({ type: 'session_state', session: snapshot('old', 100, true) })
  store.activeSessionId = 'other'
  store.handleServerMessage({ type: 'session_state', session: { ...snapshot(), summary: { ...snapshot().summary, id: 'other' } } })
  store.onTransportDisconnected()
  sent.length = 0
  store.handleServerMessage({ type: 'init', protocolVersion: 1, sessions: [snapshot().summary, { ...snapshot().summary, id: 'other' }], models: [], providers: [], settings: {} as any })
  assert.deepEqual(sent.filter((message) => message.type === 'load_session').map((message) => message.sessionId).sort(), ['other', 'recovery'])
  const request = sent.find((message) => message.sessionId === 'recovery')
  store.handleServerMessage({ type: 'session_state', requestId: request.requestId, session: snapshot('complete', 0, false, 'server-2') })
  assert.equal(store.sessionStates.recovery.isStreaming, false)
  assert.equal(store.sessionStates.recovery.messages[0].text, 'complete')
  store.onTransportDisconnected()
})

test('request deadlines restore prompt controls without automatically sending the prompt again', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { store, sent } = recoveryStore()
  store.prompt('recovery', 'only once')
  context.mock.timers.tick(30_001)
  assert.equal(store.sessionStates.recovery.isStreaming, false)
  assert.equal(sent.filter((message) => message.type === 'prompt').length, 1)
  store.onTransportDisconnected()
})

test('event buffer overflow requests another snapshot instead of silently accepting incomplete text', () => {
  const { store, sent, snapshot } = recoveryStore()
  store.loadSession('recovery')
  const requestId = sent.at(-1).requestId
  for (let sequence = 1; sequence <= 501; sequence++) store.handleServerMessage({ type: 'text_delta', sessionId: 'recovery', delta: 'x', epoch: 'server-1', sequence })
  store.handleServerMessage({ type: 'session_state', requestId, session: snapshot('', 0, true) })
  assert.equal(sent.filter((message) => message.type === 'load_session').length, 2)
  store.handleServerMessage({ type: 'session_state', requestId: sent.at(-1).requestId, session: snapshot('complete', 501, false) })
  assert.equal(store.sessionStates.recovery.messages[0].text, 'complete')
  store.onTransportDisconnected()
})
