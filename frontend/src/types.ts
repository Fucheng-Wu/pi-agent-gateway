export type {
  AgentUiEvent,
  ChatMessage,
  ClientMessage,
  ContextUsage,
  ModelInfo,
  ProviderInfo,
  ServerMessage,
  SessionSnapshot,
  SessionSummary,
  ThinkingLevel,
  ToolCall
} from '../../shared/types'

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
