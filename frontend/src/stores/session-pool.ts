import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AgentUiEvent, ChatMessage, ClientMessage, FeatureSettings, ModelInfo, ProviderInfo, ServerMessage,
  SessionSnapshot, SessionSummary, SessionUiState, SubagentProfileInfo, ThinkingLevel, ToolCall, WorkspaceInfo, DirectoryListing
} from '@/types'
import type { PrimaryAgentInfo, PermissionRequest, PermissionDecision } from '@/types'
import { PROTOCOL_VERSION } from '@/types'

type Sender = (message: ClientMessage) => boolean
type AuthChallenge = Extract<ServerMessage, { type: 'auth_challenge' }>
type AuthStatus = Extract<ServerMessage, { type: 'auth_status' }>

function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function fromSnapshot(snapshot: SessionSnapshot): SessionUiState {
  const lastMessage = snapshot.messages.at(-1)
  return {
    summary: snapshot.summary,
    messages: [...snapshot.messages],
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    isStreaming: snapshot.isStreaming,
    contextUsage: snapshot.contextUsage,
    primaryAgentId: snapshot.primaryAgentId ?? 'build',
    epoch: snapshot.epoch,
    sequence: snapshot.sequence,
    review: snapshot.review,
    revision: 0,
    streamMessageId: snapshot.isStreaming && lastMessage?.role === 'assistant' ? lastMessage.id : undefined
  }
}

export const useSessionPool = defineStore('session-pool', () => {
  const sessions = ref<SessionSummary[]>([])
  const sessionStates = ref<Record<string, SessionUiState>>({})
  const activeSessionId = ref<string | null>(null)
  const models = ref<ModelInfo[]>([])
  const primaryAgents = ref<PrimaryAgentInfo[]>([])
  const primaryAgentChanging = ref<Record<string, boolean>>({})
  const primaryAgentRequests = new Map<string, string>()
  const permissionRequests = ref<PermissionRequest[]>([])
  const permissionResponding = ref<Record<string, boolean>>({})
  const providers = ref<ProviderInfo[]>([])
  const modelsConfig = ref('')
  const configLoaded = ref(false)
  const configSaving = ref(false)
  const modelDiscovery = ref<{ providerName: string; loading: boolean; models: Array<{ id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }>; endpoint?: string }>({ providerName: '', loading: false, models: [] })
  const modelTest = ref<{ providerName: string; modelId: string; loading: boolean; result?: { ok: boolean; error?: string; latencyMs?: number; status?: number; responseText?: string } }>({ providerName: '', modelId: '', loading: false })
  let savingContent = ''
  const authChallenge = ref<AuthChallenge | null>(null)
  const authStatus = ref<AuthStatus | null>(null)
  const featureSettings = ref<FeatureSettings | null>(null)
  const featureSettingsLoading = ref(false)
  const featureAction = ref<string | null>(null)
  const notice = ref<{ id: string; text: string; kind: 'error' | 'success' } | null>(null)
  const pendingEvents = new Map<string, AgentUiEvent[]>()
  const loadingSessions = new Set<string>()
  const sessionLoading = ref<Record<string, boolean>>({})
  const loadRequests = new Map<string, string>()
  const overflowed = new Set<string>()
  const pendingRequests = new Map<string, { message: ClientMessage; timer: ReturnType<typeof setTimeout> }>()
  const promptRequests = new Map<string, { requestId: string; optimisticId: string }>()
  const recoveredDrafts = ref<Record<string, string>>({})
  const workspace = ref<WorkspaceInfo | null>(null)
  const workspaceChanging = ref(false)
  const directoryListing = ref<DirectoryListing | null>(null)
  const directoriesLoading = ref(false)
  let browseRequest: string | undefined
  let sender: Sender = () => false

  const activeSession = computed(() => activeSessionId.value ? sessionStates.value[activeSessionId.value] : undefined)
  const sortedSessions = computed(() => [...sessions.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))

  function setSender(send: Sender) { sender = send }

  function tell(text: string, kind: 'error' | 'success' = 'error') {
    notice.value = { id: id('notice'), text, kind }
    const currentId = notice.value.id
    setTimeout(() => { if (notice.value?.id === currentId) notice.value = null }, 5200)
  }

  function dispatch(message: ClientMessage) {
    const command = { ...message, requestId: message.requestId ?? id('request') }
    if (!sender(command)) { tell('连接尚未建立，请稍后重试'); return false }
    const timer = setTimeout(() => {
      failRequest(command.requestId, '请求超时，结果尚未确认，请检查连接后重试')
    }, command.type === 'plugin_action' || command.type === 'set_workspace' ? 120_000 : 30_000)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    pendingRequests.set(command.requestId, { message: command, timer })
    return true
  }

  function settleRequest(requestId?: string) {
    if (!requestId) return
    const pending = pendingRequests.get(requestId)
    if (pending) clearTimeout(pending.timer)
    pendingRequests.delete(requestId)
    return pending?.message
  }

  function failRequest(requestId: string | undefined, reason: string, sessionId?: string) {
    const command = settleRequest(requestId)
    const prompt = [...promptRequests.entries()].find(([key, value]) => value.requestId === requestId || (!requestId && key === sessionId))
    if (prompt) {
      const [key, value] = prompt
      const state = sessionStates.value[key]
      if (state) {
        const optimistic = state.messages.find((message) => message.id === value.optimisticId)
        if (optimistic) recoveredDrafts.value[key] = optimistic.text
        state.messages = state.messages.filter((message) => message.id !== value.optimisticId)
        state.isStreaming = false
        state.streamMessageId = undefined
        state.revision++
      }
      promptRequests.delete(key)
      loadSession(key)
    }
    if (command?.type === 'load_session') {
      loadingSessions.delete(command.sessionId)
      delete sessionLoading.value[command.sessionId]
      loadRequests.delete(command.sessionId)
      pendingEvents.delete(command.sessionId)
    }
    if (command?.type === 'set_primary_agent') {
      delete primaryAgentChanging.value[command.sessionId]
      primaryAgentRequests.delete(command.sessionId)
    }
    if (command?.type === 'save_models_config') configSaving.value = false
    if (command?.type === 'discover_provider_models') modelDiscovery.value.loading = false
    if (command?.type === 'test_model_config') modelTest.value.loading = false
    if (command?.type === 'browse_directories' && command.requestId === browseRequest) directoriesLoading.value = false
    if (command?.type === 'set_workspace') workspaceChanging.value = false
    if (command?.type === 'get_feature_settings') featureSettingsLoading.value = false
    if (command && ['create_skill', 'set_skill_enabled', 'plugin_action', 'set_plugin_enabled', 'set_subagent_settings', 'set_subagent_profile_enabled', 'create_subagent_profile', 'delete_subagent_profile', 'save_mcp_config'].includes(command.type)) featureAction.value = null
    if (command?.type === 'permission_response') delete permissionResponding.value[command.permissionId]
    tell(reason)
  }

  function browseDirectories(path?: string) {
    const requestId = id('browse')
    browseRequest = requestId
    directoriesLoading.value = true
    if (!dispatch({ type: 'browse_directories', path, requestId })) directoriesLoading.value = false
  }
  function setWorkspace(path: string) {
    workspaceChanging.value = true
    if (!dispatch({ type: 'set_workspace', path })) workspaceChanging.value = false
  }

  function refreshSessions() { return dispatch({ type: 'list_sessions' }) }
  function initialize() { return dispatch({ type: 'init', protocolVersion: PROTOCOL_VERSION }) }
  function refreshModels() { return dispatch({ type: 'list_models' }) }
  function refreshProviders() { return dispatch({ type: 'list_providers' }) }
  function fetchModelsConfig() { configLoaded.value = false; return dispatch({ type: 'get_models_config' }) }
  function saveModelsConfig(content: string) {
    try { JSON.parse(content) } catch { tell('JSON 格式有误，请检查后再保存'); return false }
    configSaving.value = true
    savingContent = content
    if (!dispatch({ type: 'save_models_config', content })) { configSaving.value = false; return false }
    return true
  }
  function discoverProviderModels(providerName: string, provider: Record<string, unknown>) {
    modelDiscovery.value = { providerName, loading: true, models: [] }
    if (!dispatch({ type: 'discover_provider_models', providerName, provider })) { modelDiscovery.value.loading = false; return false }
    return true
  }
  function testModelConfig(providerName: string, provider: Record<string, unknown>, model: Record<string, unknown>) {
    const modelId = typeof model.id === 'string' ? model.id : ''
    modelTest.value = { providerName, modelId, loading: true }
    if (!dispatch({ type: 'test_model_config', providerName, provider, model })) { modelTest.value.loading = false; return false }
    return true
  }

  function createSession() { return dispatch({ type: 'create_session' }) }
  function loadSession(sessionId: string) {
    if (loadingSessions.has(sessionId)) return true
    loadingSessions.add(sessionId)
    sessionLoading.value[sessionId] = true
    const requestId = id('load')
    loadRequests.set(sessionId, requestId)
    if (!dispatch({ type: 'load_session', sessionId, requestId })) { loadingSessions.delete(sessionId); delete sessionLoading.value[sessionId]; loadRequests.delete(sessionId); return false }
    return true
  }
  function onTransportDisconnected() {
    loadingSessions.clear()
    sessionLoading.value = {}
    loadRequests.clear()
    pendingEvents.clear()
    overflowed.clear()
    for (const pending of pendingRequests.values()) clearTimeout(pending.timer)
    pendingRequests.clear()
    workspaceChanging.value = false
    directoriesLoading.value = false
    authChallenge.value = null
    authStatus.value = null
    configSaving.value = false
    modelDiscovery.value.loading = false
    modelTest.value.loading = false
    featureSettingsLoading.value = false
    featureAction.value = null
    primaryAgentChanging.value = {}
    primaryAgentRequests.clear()
    permissionRequests.value = []
    permissionResponding.value = {}
  }
  function selectSession(sessionId: string) {
    activeSessionId.value = sessionId
    loadSession(sessionId)
  }
  function deleteSession(sessionId: string) { return dispatch({ type: 'delete_session', sessionId }) }
  function prompt(sessionId: string, text: string) {
    if (loadingSessions.has(sessionId)) { tell('正在同步对话，请稍后发送'); return false }
    const trimmed = text.trim()
    if (!trimmed) return false
    const requestId = id('prompt')
    const optimisticId = `optimistic-${requestId}`
    if (!dispatch({ type: 'prompt', sessionId, text: trimmed, requestId })) return false
    promptRequests.set(sessionId, { requestId, optimisticId })
    const state = sessionStates.value[sessionId]
    if (state) {
      state.messages.push({ id: optimisticId, role: 'user', text: trimmed, timestamp: new Date().toISOString() })
      state.isStreaming = true
      state.summary.title = state.summary.title || trimmed.slice(0, 48)
      state.revision++
    }
    return true
  }
  function abort(sessionId: string) { return dispatch({ type: 'abort', sessionId }) }
  function setModel(sessionId: string, provider: string, modelId: string) {
    return dispatch({ type: 'set_model', sessionId, provider, modelId })
  }
  function setThinkingLevel(sessionId: string, level: ThinkingLevel) {
    return dispatch({ type: 'set_thinking_level', sessionId, level })
  }
  function setPrimaryAgent(sessionId: string, agentId: string) {
    if (primaryAgentChanging.value[sessionId] || sessionStates.value[sessionId]?.isStreaming) return false
    primaryAgentChanging.value[sessionId] = true
    const requestId = id('role')
    primaryAgentRequests.set(sessionId, requestId)
    if (!dispatch({ type: 'set_primary_agent', sessionId, agentId, requestId })) { delete primaryAgentChanging.value[sessionId]; primaryAgentRequests.delete(sessionId); return false }
    return true
  }
  function respondPermission(permissionId: string, decision: PermissionDecision) {
    if (permissionResponding.value[permissionId]) return false
    permissionResponding.value[permissionId] = true
    if (!dispatch({ type: 'permission_response', permissionId, decision })) { delete permissionResponding.value[permissionId]; return false }
    return true
  }
  function login(providerId: string, methodId?: string) {
    authChallenge.value = null
    authStatus.value = null
    return dispatch({ type: 'provider_login', providerId, methodId })
  }
  function submitAuth(challengeId: string, value: string) {
    if (!dispatch({ type: 'auth_response', challengeId, value })) return false
    authChallenge.value = null
    return true
  }
  function cancelAuth(challengeId: string) {
    if (!dispatch({ type: 'auth_cancel', challengeId })) return false
    authChallenge.value = null
    return true
  }

  function refreshFeatureSettings() {
    featureSettingsLoading.value = true
    if (!dispatch({ type: 'get_feature_settings' })) { featureSettingsLoading.value = false; return false }
    return true
  }
  function createSkill(input: { name: string; description: string; instructions: string; scope: 'global' | 'project' }) {
    featureAction.value = 'skill:create'
    if (!dispatch({ type: 'create_skill', ...input })) { featureAction.value = null; return false }
    return true
  }
  function setSkillEnabled(filePath: string, enabled: boolean) {
    featureAction.value = `skill:${filePath}`
    if (!dispatch({ type: 'set_skill_enabled', filePath, enabled })) { featureAction.value = null; return false }
    return true
  }
  function runPluginAction(action: 'install' | 'remove' | 'update', source: string, scope: 'global' | 'project' = 'global') {
    featureAction.value = `plugin:${action}:${source}`
    if (!dispatch({ type: 'plugin_action', action, source, scope })) { featureAction.value = null; return false }
    return true
  }
  function setPluginEnabled(source: string, scope: 'global' | 'project', enabled: boolean) {
    featureAction.value = `plugin:toggle:${scope}:${source}`
    if (!dispatch({ type: 'set_plugin_enabled', source, scope, enabled })) { featureAction.value = null; return false }
    return true
  }
  function setSubagentSettings(patch: { enabled?: boolean; maxConcurrent?: number }) {
    featureAction.value = 'subagents:settings'
    if (!dispatch({ type: 'set_subagent_settings', ...patch })) { featureAction.value = null; return false }
    return true
  }
  function setSubagentProfileEnabled(profileId: SubagentProfileInfo['id'], enabled: boolean) {
    featureAction.value = `subagents:${profileId}`
    if (!dispatch({ type: 'set_subagent_profile_enabled', profileId, enabled })) { featureAction.value = null; return false }
    return true
  }
  function createSubagentProfile(input: { id: string; name: string; description: string; systemPrompt: string; tools: string[]; scope: 'global' | 'project' }) {
    featureAction.value = 'subagents:create'
    if (!dispatch({ type: 'create_subagent_profile', ...input })) { featureAction.value = null; return false }
    return true
  }
  function deleteSubagentProfile(profileId: string) {
    featureAction.value = `subagents:delete:${profileId}`
    if (!dispatch({ type: 'delete_subagent_profile', profileId })) { featureAction.value = null; return false }
    return true
  }
  function saveMcpConfig(content: string) {
    featureAction.value = 'mcp:save'
    if (!dispatch({ type: 'save_mcp_config', content })) { featureAction.value = null; return false }
    return true
  }

  function ensureAssistant(state: SessionUiState): ChatMessage {
    let message = state.messages.at(-1)
    if (!state.streamMessageId || message?.id !== state.streamMessageId) message = state.messages.find((m) => m.id === state.streamMessageId)
    if (!message) {
      message = { id: id('stream'), role: 'assistant', text: '', thinking: '', tools: [], timestamp: new Date().toISOString() }
      state.messages.push(message)
      state.streamMessageId = message.id
    }
    return message
  }

  function upsertTool(message: ChatMessage, tool: ToolCall) {
    const tools = message.tools ?? (message.tools = [])
    const index = tools.findIndex((item) => item.id === tool.id)
    if (index >= 0) tools[index] = { ...tools[index], ...tool }
    else tools.push(tool)
  }

  function applyEvent(state: SessionUiState, event: AgentUiEvent) {
    if (event.epoch && event.epoch === state.epoch && event.sequence !== undefined && event.sequence <= (state.sequence ?? -1)) return
    if (event.epoch) state.epoch = event.epoch
    if (event.sequence !== undefined) state.sequence = event.sequence
    state.revision++
    switch (event.type) {
      case 'agent_start':
        state.isStreaming = true
        break
      case 'text_delta':
        state.isStreaming = true
        ensureAssistant(state).text += event.delta
        break
      case 'thinking_delta':
        state.isStreaming = true
        const assistant = ensureAssistant(state)
        assistant.thinking = (assistant.thinking ?? '') + event.delta
        break
      case 'tool_start':
        state.isStreaming = true
        upsertTool(ensureAssistant(state), event.tool)
        break
      case 'tool_update':
      case 'tool_end': {
        const message = state.messages.findLast((item) => item.tools?.some((tool) => tool.id === event.toolCallId))
        const tool = message?.tools?.find((item) => item.id === event.toolCallId)
        if (tool) {
          if (event.output !== undefined) tool.output = event.output
          if (event.subagent) tool.subagent = event.subagent
          if (event.type === 'tool_end') tool.status = event.isError ? 'error' : 'done'
        }
        break
      }
      case 'message_end': {
        const incoming = event.message
        if (incoming.role === 'user') {
          const index = state.messages.findLastIndex((m) => m.id.startsWith('optimistic-') && m.text === incoming.text)
          if (index >= 0) { state.messages[index] = incoming; promptRequests.delete(state.summary.id); break }
        }
        if (incoming.role === 'assistant' && state.streamMessageId) {
          const index = state.messages.findIndex((m) => m.id === state.streamMessageId)
          if (index >= 0) {
            state.messages[index] = incoming
            // A Pi agent run can contain several assistant messages separated by
            // tool calls. Keep one live bubble until agent_end so later tool
            // results and the final answer stay attached to the same turn.
            state.streamMessageId = incoming.id
            break
          }
        }
        if (!state.messages.some((m) => m.id === incoming.id)) state.messages.push(incoming)
        break
      }
      case 'agent_end':
        promptRequests.delete(state.summary.id)
        state.isStreaming = false
        if (state.streamMessageId) {
          const message = state.messages.find((item) => item.id === state.streamMessageId)
          for (const tool of message?.tools ?? []) {
            if (tool.status === 'running') tool.status = event.error ? 'error' : 'done'
          }
        }
        state.streamMessageId = undefined
        if (event.contextUsage) state.contextUsage = event.contextUsage
        if (event.error) {
          const last = state.messages.findLast((m) => m.role === 'assistant')
          if (last) last.error = event.error
          else state.messages.push({ id: id('error'), role: 'assistant', text: '', error: event.error })
        }
        break
      case 'run_review': state.review = event.review; break
      case 'session_updated':
        if (event.primaryAgentId) state.primaryAgentId = event.primaryAgentId
        if (event.summary) {
          state.summary = event.summary
          upsertSummary(event.summary)
        }
        if (event.model) state.model = event.model
        if (event.thinkingLevel) state.thinkingLevel = event.thinkingLevel
        if (event.contextUsage) state.contextUsage = event.contextUsage
        break
    }
  }

  function upsertSummary(summary: SessionSummary) {
    const index = sessions.value.findIndex((item) => item.id === summary.id)
    if (index >= 0) sessions.value[index] = summary
    else sessions.value.push(summary)
  }

  function installSnapshot(snapshot: SessionSnapshot, requestId?: string) {
    const sessionId = snapshot.summary.id
    const existing = sessionStates.value[sessionId]
    if (requestId?.startsWith('load-') && loadRequests.get(sessionId) !== requestId) return
    // A snapshot is authoritative through sequence N; replay only queued events after N.
    const newerExisting = snapshot.epoch && existing?.epoch === snapshot.epoch && (existing.sequence ?? -1) > (snapshot.sequence ?? -1)
    const state = newerExisting ? existing : fromSnapshot(snapshot)
    state.revision = (existing?.revision ?? 0) + 1
    if (requestId && primaryAgentRequests.get(sessionId) === requestId) {
      delete primaryAgentChanging.value[sessionId]
      primaryAgentRequests.delete(sessionId)
    }
    sessionStates.value[sessionId] = state
    upsertSummary(state.summary)
    loadingSessions.delete(sessionId)
    delete sessionLoading.value[sessionId]
    loadRequests.delete(sessionId)
    const backlog = pendingEvents.get(sessionId)
    if (backlog) {
      for (const event of backlog) {
        if (snapshot.epoch && event.epoch !== snapshot.epoch) continue
        if (event.sequence !== undefined && state.sequence !== undefined && event.sequence > state.sequence + 1) { overflowed.add(sessionId); break }
        applyEvent(state, event)
      }
      pendingEvents.delete(sessionId)
    }
    if (!state.isStreaming) promptRequests.delete(sessionId)
    if (overflowed.delete(sessionId)) loadSession(sessionId)
  }

  function handleServerMessage(message: ServerMessage) {
    if (message.type === 'error') failRequest(message.requestId, message.message, message.sessionId)
    else settleRequest(message.requestId)
    switch (message.type) {
      case 'init': {
        if (message.workspace) workspace.value = message.workspace
        sessions.value = message.sessions
        models.value = message.models
        primaryAgents.value = message.primaryAgents ?? []
        permissionRequests.value = []
        permissionResponding.value = {}
        providers.value = message.providers
        featureSettings.value = message.settings
        featureSettingsLoading.value = false
        const known = new Set(message.sessions.map((session) => session.id))
        for (const sessionId of Object.keys(sessionStates.value)) {
          if (!known.has(sessionId)) delete sessionStates.value[sessionId]
          else loadSession(sessionId)
        }
        const current = activeSessionId.value
        if (current && message.sessions.some((session) => session.id === current)) loadSession(current)
        else if (message.sessions.length) selectSession([...message.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id)
        else activeSessionId.value = null
        break
      }
      case 'sessions':
        sessions.value = message.sessions
        if (activeSessionId.value && !message.sessions.some((s) => s.id === activeSessionId.value)) activeSessionId.value = null
        if (!activeSessionId.value && message.sessions.length) selectSession([...message.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id)
        break
      case 'session_created':
        installSnapshot(message.session, message.requestId)
        activeSessionId.value = message.session.summary.id
        break
      case 'session_state':
        installSnapshot(message.session, message.requestId)
        break
      case 'session_deleted':
        sessions.value = sessions.value.filter((s) => s.id !== message.sessionId)
        delete sessionStates.value[message.sessionId]
        pendingEvents.delete(message.sessionId)
        loadingSessions.delete(message.sessionId)
        delete sessionLoading.value[message.sessionId]
        loadRequests.delete(message.sessionId)
        primaryAgentRequests.delete(message.sessionId)
        for (const [requestId, pending] of pendingRequests) if ('sessionId' in pending.message && pending.message.sessionId === message.sessionId) settleRequest(requestId)
        promptRequests.delete(message.sessionId)
        delete recoveredDrafts.value[message.sessionId]
        delete primaryAgentChanging.value[message.sessionId]
        permissionRequests.value = permissionRequests.value.filter((item) => item.sessionId !== message.sessionId)
        if (activeSessionId.value === message.sessionId) {
          activeSessionId.value = null
          if (sessions.value.length) selectSession(sortedSessions.value[0].id)
        }
        break
      case 'agent_start':
      case 'text_delta':
      case 'thinking_delta':
      case 'tool_start':
      case 'tool_update':
      case 'tool_end':
      case 'message_end':
      case 'agent_end':
      case 'run_review':
      case 'session_updated': {
        const state = sessionStates.value[message.sessionId]
        const gap = state && message.epoch && (message.epoch !== state.epoch || (message.sequence !== undefined && message.sequence > (state.sequence ?? 0) + 1))
        if (state && !loadingSessions.has(message.sessionId) && !gap) applyEvent(state, message)
        else {
          const backlog = pendingEvents.get(message.sessionId) ?? []
          backlog.push(message)
          if (backlog.length > 500) { backlog.shift(); overflowed.add(message.sessionId) }
          pendingEvents.set(message.sessionId, backlog)
          if (!loadingSessions.has(message.sessionId)) loadSession(message.sessionId)
        }
        break
      }
      case 'models': models.value = message.models; break
      case 'primary_agents': primaryAgents.value = message.agents; break
      case 'permission_request':
        if (!permissionRequests.value.some((item) => item.id === message.permission.id)) permissionRequests.value.push(message.permission)
        break
      case 'permission_resolved':
        permissionRequests.value = permissionRequests.value.filter((item) => item.id !== message.permissionId)
        delete permissionResponding.value[message.permissionId]
        if (message.reason && message.reason.includes('超时')) tell(message.reason)
        break
      case 'providers': providers.value = message.providers; break
      case 'models_config': modelsConfig.value = message.content; configLoaded.value = true; break
      case 'models_saved':
        configSaving.value = false
        modelsConfig.value = savingContent
        tell('模型配置已保存', 'success')
        refreshModels(); refreshProviders()
        break
      case 'provider_models_discovered':
        modelDiscovery.value = { providerName: message.providerName, loading: false, models: message.models, endpoint: message.endpoint }
        break
      case 'model_config_tested':
        modelTest.value = { providerName: message.providerName, modelId: message.modelId, loading: false, result: message.result }
        break
      case 'auth_challenge': authChallenge.value = message; break
      case 'auth_status':
        authStatus.value = message
        if (message.status === 'complete') { authChallenge.value = null; refreshProviders(); refreshModels(); tell(message.message || '认证已完成', 'success') }
        else if (message.status === 'error') tell(message.message || '认证失败')
        break
      case 'feature_settings':
        featureSettings.value = message.settings
        featureSettingsLoading.value = false
        break
      case 'feature_action_complete':
        featureSettings.value = message.settings
        featureSettingsLoading.value = false
        featureAction.value = null
        tell(`${({ skills: '技能', plugins: '插件', subagents: '子代理', mcp: 'MCP' } as const)[message.category]}设置已更新`, 'success')
        break
      case 'error':
        if (message.sessionId && message.requestId === primaryAgentRequests.get(message.sessionId)) {
          delete primaryAgentChanging.value[message.sessionId]
          primaryAgentRequests.delete(message.sessionId)
        }
        break
      case 'workspace': {
        const changed = workspace.value?.path !== message.workspace.path
        workspace.value = message.workspace
        workspaceChanging.value = false
        if (changed) {
          onTransportDisconnected()
          promptRequests.clear()
          recoveredDrafts.value = {}
          sessionStates.value = {}
          sessions.value = []
          activeSessionId.value = null
          directoryListing.value = null
          configLoaded.value = false
        }
        break
      }
      case 'directories':
        if (!message.requestId || message.requestId === browseRequest) {
          directoryListing.value = message.listing
          directoriesLoading.value = false
        }
        break
      case 'ack':
        if (message.command === 'set_workspace') workspaceChanging.value = false
        break
      case 'pong': break
    }
  }

  return {
    workspace, workspaceChanging, directoryListing, directoriesLoading, browseDirectories, setWorkspace, recoveredDrafts, sessionLoading,
    sessions, sortedSessions, sessionStates, activeSessionId, activeSession, models, providers,
    primaryAgents, primaryAgentChanging, permissionRequests, permissionResponding, setPrimaryAgent, respondPermission,
    modelsConfig, configLoaded, configSaving, modelDiscovery, modelTest, authChallenge, authStatus,
    featureSettings, featureSettingsLoading, featureAction, notice, setSender,
    initialize, refreshSessions, refreshModels, refreshProviders, fetchModelsConfig, saveModelsConfig, discoverProviderModels, testModelConfig,
    createSession, loadSession, selectSession, deleteSession, prompt, abort, setModel, setThinkingLevel,
    login, submitAuth, cancelAuth, refreshFeatureSettings, createSkill, setSkillEnabled, runPluginAction, setPluginEnabled,
    setSubagentSettings, setSubagentProfileEnabled, createSubagentProfile, deleteSubagentProfile, saveMcpConfig,
    handleServerMessage, onTransportDisconnected
  }
})
