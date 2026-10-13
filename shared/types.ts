/** Messages exchanged over /ws. Every command can carry a requestId for error correlation. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  createdAt?: string;
  messageCount?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  status: "running" | "done" | "error";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  thinking?: string;
  tools?: ToolCall[];
  timestamp?: string;
  error?: string;
}

export interface ContextUsage {
  usedTokens: number;
  contextWindow: number;
  percent: number;
}

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  authenticated: boolean;
  authMethods?: Array<{ id: string; name: string }>;
  modelCount?: number;
}

export interface SessionSnapshot {
  summary: SessionSummary;
  messages: ChatMessage[];
  model?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  contextUsage?: ContextUsage;
}

export type AgentUiEvent =
  | { type: "turn_started" }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_started"; tool: ToolCall }
  | { type: "tool_updated"; toolCallId: string; output?: string }
  | { type: "tool_finished"; toolCallId: string; output?: string; isError?: boolean }
  | { type: "message_end"; message: ChatMessage }
  | { type: "turn_finished"; contextUsage?: ContextUsage; error?: string }
  | { type: "session_updated"; summary?: SessionSummary; model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel; contextUsage?: ContextUsage };

type CommandBase = { requestId?: string };

export type ClientMessage = CommandBase & (
  | { type: "ping" }
  | { type: "list_sessions" }
  | { type: "create_session" }
  | { type: "load_session"; sessionId: string }
  | { type: "delete_session"; sessionId: string }
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "abort"; sessionId: string }
  | { type: "set_model"; sessionId: string; provider: string; modelId: string }
  | { type: "set_thinking_level"; sessionId: string; level: ThinkingLevel }
  | { type: "list_models" }
  | { type: "get_models_config" }
  | { type: "save_models_config"; content: string }
  | { type: "list_providers" }
  | { type: "provider_login"; providerId: string; methodId?: string }
  | { type: "auth_response"; challengeId: string; value: string }
  | { type: "auth_cancel"; challengeId: string }
);

export type ServerMessage = (
  | { type: "pong" }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session_created"; session: SessionSnapshot }
  | { type: "session_state"; session: SessionSnapshot }
  | { type: "session_deleted"; sessionId: string }
  | { type: "session_event"; sessionId: string; event: AgentUiEvent }
  | { type: "models"; models: ModelInfo[] }
  | { type: "models_config"; content: string }
  | { type: "models_saved" }
  | { type: "providers"; providers: ProviderInfo[] }
  | { type: "auth_challenge"; challengeId: string; providerId: string; prompt: string; mode: "input" | "select" | "confirm"; options?: string[]; placeholder?: string; allowEmpty?: boolean }
  | { type: "auth_status"; providerId: string; status: "started" | "complete" | "cancelled" | "error"; message?: string; url?: string }
  | { type: "error"; message: string; code?: string; sessionId?: string }
) & { requestId?: string };
