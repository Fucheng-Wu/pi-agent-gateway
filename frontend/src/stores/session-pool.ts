import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AgentUiEvent, ChatMessage, ClientMessage, FeatureSettings, ModelInfo, ProviderInfo, ServerMessage,
  SessionSnapshot, SessionSummary, SessionUiState, SubagentProfileInfo, ThinkingLevel, ToolCall
} from '@/types'

type Sender = (message: ClientMessage) => boolean
type AuthChallenge = Extract<ServerMessage, { type: 'auth_challenge' }>
type AuthStatus = Extract<ServerMessage, { type: 'auth_status' }>

function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function fromSnapshot(snapshot: SessionSnapshot): SessionUiState {
  return {
    summary: snapshot.summary,
    messages: [...snapshot.messages],
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    isStreaming: snapshot.isStreaming,
    contextUsage: snapshot.contextUsage,
    streamMessageId: snapshot.isStreaming ? snapshot.messages.findLast((m) => m.role === 'assistant')?.id : undefined
  }
}

export const useSessionPool = defineStore('session-pool', () => {
  const sessions = ref<SessionSummary[]>([])
  const sessionStates = ref<Record<string, SessionUiState>>({})
  const activeSessionId = ref<string | null>(null)
  const models = ref<ModelInfo[]>([])
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
  const revisions = new Map<string, number>()
  const loadRevisions = new Map<string, number>()
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
    if (!sender(message)) { tell('连接尚未建立，请稍后重试'); return false }
    return true
  }

  function refreshSessions() { return dispatch({ type: 'list_sessions' }) }
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
    loadRevisions.set(sessionId, revisions.get(sessionId) ?? 0)
    if (!dispatch({ type: 'load_session', sessionId })) { loadingSessions.delete(sessionId); loadRevisions.delete(sessionId); return false }
    return true
  }
  function onTransportDisconnected() {
    loadingSessions.clear()
    loadRevisions.clear()
    configSaving.value = false
    modelDiscovery.value.loading = false
    modelTest.value.loading = false
    featureSettingsLoading.value = false
    featureAction.value = null
  }
  function selectSession(sessionId: string) {
    activeSessionId.value = sessionId
    loadSession(sessionId)
  }
  function deleteSession(sessionId: string) { return dispatch({ type: 'delete_session', sessionId }) }
  function prompt(sessionId: string, text: string) {
    const trimmed = text.trim()
    if (!trimmed) return false
    if (!dispatch({ type: 'prompt', sessionId, text: trimmed })) return false
    const state = sessionStates.value[sessionId]
    if (state) {
      state.messages.push({ id: id('optimistic'), role: 'user', text: trimmed, timestamp: new Date().toISOString() })
      state.isStreaming = true
      state.summary.title = state.summary.title || trimmed.slice(0, 48)
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
    let message = state.streamMessageId && state.messages.find((m) => m.id === state.streamMessageId)
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
    switch (event.type) {
      case 'turn_started':
        state.isStreaming = true
        break
      case 'text_delta':
        state.isStreaming = true
        ensureAssistant(state).text += event.delta
        break
      case 'thinking_delta':
        state.isStreaming = true
        ensureAssistant(state).thinking = (ensureAssistant(state).thinking ?? '') + event.delta
        break
      case 'tool_started':
        state.isStreaming = true
        upsertTool(ensureAssistant(state), event.tool)
        break
      case 'tool_updated':
      case 'tool_finished': {
        const message = ensureAssistant(state)
        const tool = message.tools?.find((item) => item.id === event.toolCallId)
        if (tool) {
          if (event.output !== undefined) tool.output = event.output
          if (event.type === 'tool_finished') tool.status = event.isError ? 'error' : 'done'
        }
        break
      }
      case 'message_end': {
        const incoming = event.message
        if (incoming.role === 'user') {
          const index = state.messages.findLastIndex((m) => m.id.startsWith('optimistic-') && m.text === incoming.text)
          if (index >= 0) { state.messages[index] = incoming; break }
        }
        if (incoming.role === 'assistant' && state.streamMessageId) {
          const index = state.messages.findIndex((m) => m.id === state.streamMessageId)
          if (index >= 0) {
            state.messages[index] = incoming
            state.streamMessageId = undefined
            break
          }
        }
        if (!state.messages.some((m) => m.id === incoming.id)) state.messages.push(incoming)
        break
      }
      case 'turn_finished':
        state.isStreaming = false
        state.streamMessageId = undefined
        if (event.contextUsage) state.contextUsage = event.contextUsage
        if (event.error) {
          const last = state.messages.findLast((m) => m.role === 'assistant')
          if (last) last.error = event.error
          else state.messages.push({ id: id('error'), role: 'assistant', text: '', error: event.error })
        }
        break
      case 'session_updated':
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

  function installSnapshot(snapshot: SessionSnapshot) {
    const sessionId = snapshot.summary.id
    const existing = sessionStates.value[sessionId]
    const hasLiveEventsSinceRequest = (revisions.get(sessionId) ?? 0) > (loadRevisions.get(sessionId) ?? Number.POSITIVE_INFINITY)
    // WS events can overtake a load response. In that case the live state is newer,
    // even if both arrays happen to contain the same number of messages.
    const state = existing && hasLiveEventsSinceRequest ? existing : fromSnapshot(snapshot)
    if (state !== existing) sessionStates.value[sessionId] = state
    else if (!existing?.summary.updatedAt || snapshot.summary.updatedAt > existing.summary.updatedAt) state.summary = snapshot.summary
    upsertSummary(state.summary)
    loadingSessions.delete(sessionId)
    loadRevisions.delete(sessionId)
    const backlog = pendingEvents.get(sessionId)
    if (backlog) {
      for (const event of backlog) applyEvent(state, event)
      pendingEvents.delete(sessionId)
    }
  }

  function handleServerMessage(message: ServerMessage) {
    switch (message.type) {
      case 'sessions':
        sessions.value = message.sessions
        if (activeSessionId.value && !message.sessions.some((s) => s.id === activeSessionId.value)) activeSessionId.value = null
        if (!activeSessionId.value && message.sessions.length) selectSession([...message.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id)
        break
      case 'session_created':
        installSnapshot(message.session)
        activeSessionId.value = message.session.summary.id
        break
      case 'session_state':
        installSnapshot(message.session)
        break
      case 'session_deleted':
        sessions.value = sessions.value.filter((s) => s.id !== message.sessionId)
        delete sessionStates.value[message.sessionId]
        pendingEvents.delete(message.sessionId)
        loadingSessions.delete(message.sessionId)
        if (activeSessionId.value === message.sessionId) {
          activeSessionId.value = null
          if (sessions.value.length) selectSession(sortedSessions.value[0].id)
        }
        break
      case 'session_event': {
        revisions.set(message.sessionId, (revisions.get(message.sessionId) ?? 0) + 1)
        const state = sessionStates.value[message.sessionId]
        if (state) applyEvent(state, message.event)
        else {
          const backlog = pendingEvents.get(message.sessionId) ?? []
          backlog.push(message.event)
          if (backlog.length > 500) backlog.shift()
          pendingEvents.set(message.sessionId, backlog)
          if (!loadingSessions.has(message.sessionId)) loadSession(message.sessionId)
        }
        break
      }
      case 'models': models.value = message.models; break
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
        configSaving.value = false
        modelDiscovery.value.loading = false
        modelTest.value.loading = false
        featureSettingsLoading.value = false
        featureAction.value = null
        if (message.sessionId) loadingSessions.delete(message.sessionId)
        tell(message.message)
        break
      case 'pong': break
    }
  }

  return {
    sessions, sortedSessions, sessionStates, activeSessionId, activeSession, models, providers,
    modelsConfig, configLoaded, configSaving, modelDiscovery, modelTest, authChallenge, authStatus,
    featureSettings, featureSettingsLoading, featureAction, notice, setSender,
    refreshSessions, refreshModels, refreshProviders, fetchModelsConfig, saveModelsConfig, discoverProviderModels, testModelConfig,
    createSession, loadSession, selectSession, deleteSession, prompt, abort, setModel, setThinkingLevel,
    login, submitAuth, cancelAuth, refreshFeatureSettings, createSkill, setSkillEnabled, runPluginAction, setPluginEnabled,
    setSubagentSettings, setSubagentProfileEnabled, createSubagentProfile, deleteSubagentProfile, saveMcpConfig,
    handleServerMessage, onTransportDisconnected
  }
})
