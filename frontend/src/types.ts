export type {
  AgentUiEvent,
  ChatMessage,
  ClientMessage,
  ContextUsage,
  FeatureSettings,
  McpConfigInfo,
  ModelInfo,
  PluginInfo,
  ProviderInfo,
  ServerMessage,
  SessionSnapshot,
  SessionSummary,
  SkillInfo,
  SubagentProfileInfo,
  SubagentSettingsInfo,
  ThinkingLevel,
  ToolCall
} from '../../shared/types'
export { PROTOCOL_VERSION } from '../../shared/types'

import type { ChatMessage, ContextUsage, SessionSummary, ThinkingLevel } from '../../shared/types'

export interface SessionUiState {
  summary: SessionSummary
  messages: ChatMessage[]
  model?: { provider: string; id: string }
  thinkingLevel: ThinkingLevel
  isStreaming: boolean
  contextUsage?: ContextUsage
  streamMessageId?: string
}

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
