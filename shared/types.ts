/** Messages exchanged over /ws. Every command can carry a requestId for error correlation. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "ask" | "deny";
}

export interface PrimaryAgentInfo {
  id: string;
  name: string;
  description: string;
  mode: "primary" | "all";
  systemPrompt: string;
  tools: string[];
  skills: string[];
  extensions: string[];
  permissions: PermissionRule[];
  builtIn: boolean;
  filePath?: string;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  toolName: string;
  resource: string;
  /** Normalized permission, e.g. edit for both write/edit, or external_directory. */
  action?: string;
  /** Suggested patterns covered by allow_session. Omitted means the exact resource only. */
  patterns?: string[];
  input: unknown;
  createdAt: string;
  expiresAt: string;
}

export type PermissionDecision = "allow_once" | "allow_session" | "deny";

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
  subagent?: SubagentRun;
}

/** A delegated conversation, stored with its Agent tool result. */
export interface SubagentRun {
  id: string;
  profile: string;
  name: string;
  task: string;
  status: "running" | "done" | "error";
  messages: ChatMessage[];
  error?: string;
}

/** Raw base64 image bytes (without a data URL prefix). */
export interface ImageAttachment {
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  name?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  images?: ImageAttachment[];
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
  supportsImages?: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  authenticated: boolean;
  authMethods?: Array<{ id: string; name: string }>;
  modelCount?: number;
}

export interface DiscoveredModelInfo {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelConnectionTestResult {
  ok: boolean;
  error?: string;
  latencyMs?: number;
  status?: number;
  responseText?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  scope: "global" | "project" | "package";
  modelInvocable: boolean;
}

export interface PluginInfo {
  source: string;
  scope: "global" | "project";
  installed: boolean;
  installedPath?: string;
  filtered: boolean;
  enabled: boolean;
}

export interface SubagentProfileInfo {
  id: string;
  name: string;
  description: string;
  tools: string[];
  /** Skill names available to this subagent. Use ["*"] to allow every discovered skill. */
  skills: string[];
  /** Extension modules, resolved relative to the profile file, that register custom tools. */
  extensions: string[];
  enabled: boolean;
  systemPrompt: string;
  builtIn: boolean;
  scope: "builtin" | "global" | "project";
  filePath?: string;
  permissions?: PermissionRule[];
  managedByPrimary?: boolean;
}

export interface SubagentSettingsInfo {
  enabled: boolean;
  maxConcurrent: number;
  active: number;
  profiles: SubagentProfileInfo[];
}

export interface McpConfigInfo {
  path: string;
  content: string;
  serverCount: number;
  enabledServerCount: number;
}

export interface FeatureSettings {
  skills: SkillInfo[];
  plugins: PluginInfo[];
  subagents: SubagentSettingsInfo;
  mcp: McpConfigInfo;
}

export interface SessionSnapshot {
  summary: SessionSummary;
  messages: ChatMessage[];
  model?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  contextUsage?: ContextUsage;
  primaryAgentId?: string;
  epoch?: string;
  sequence?: number;
  review?: RunReview;
}

export interface WorkspaceInfo {
  path: string;
  recent: string[];
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: Array<{ name: string; path: string }>;
}

export interface RunReview {
  startedAt: string;
  finishedAt?: string;
  workspace: string;
  files: Array<{ path: string; status: "added" | "modified" | "deleted"; diff?: string; omitted?: string }>;
  commands: Array<{ id: string; command: string; status: "running" | "done" | "error"; output?: string }>;
  note?: string;
}

export const PROTOCOL_VERSION = 1 as const;

/**
 * Agent events are top-level WebSocket messages. Keeping sessionId on every
 * event lets clients route interleaved output from multiple sessions without
 * unpacking a nested event envelope.
 */
export type AgentUiEvent = (
  | { type: "agent_start"; sessionId: string }
  | { type: "text_delta"; sessionId: string; delta: string }
  | { type: "thinking_delta"; sessionId: string; delta: string }
  | { type: "tool_start"; sessionId: string; tool: ToolCall }
  | { type: "tool_update"; sessionId: string; toolCallId: string; output?: string; subagent?: SubagentRun }
  | { type: "tool_end"; sessionId: string; toolCallId: string; output?: string; isError?: boolean; subagent?: SubagentRun }
  | { type: "message_end"; sessionId: string; message: ChatMessage }
  | { type: "agent_end"; sessionId: string; contextUsage?: ContextUsage; error?: string }
  | { type: "run_review"; sessionId: string; review: RunReview }
  | { type: "session_updated"; sessionId: string; summary?: SessionSummary; model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel; contextUsage?: ContextUsage; primaryAgentId?: string }
) & { epoch?: string; sequence?: number };

type CommandBase = { requestId?: string };

export type ClientMessage = CommandBase & (
  | { type: "init"; protocolVersion: typeof PROTOCOL_VERSION }
  | { type: "ping" }
  | { type: "get_workspace" }
  | { type: "browse_directories"; path?: string }
  | { type: "set_workspace"; path: string }
  | { type: "list_sessions" }
  | { type: "create_session" }
  | { type: "list_primary_agents" }
  | { type: "set_primary_agent"; sessionId: string; agentId: string }
  | { type: "permission_response"; permissionId: string; decision: PermissionDecision }
  | { type: "load_session"; sessionId: string }
  | { type: "delete_session"; sessionId: string }
  | { type: "prompt"; sessionId: string; text: string; images?: ImageAttachment[] }
  | { type: "abort"; sessionId: string }
  | { type: "set_model"; sessionId: string; provider: string; modelId: string }
  | { type: "set_thinking_level"; sessionId: string; level: ThinkingLevel }
  | { type: "list_models" }
  | { type: "get_models_config" }
  | { type: "save_models_config"; content: string }
  | { type: "discover_provider_models"; providerName: string; provider: Record<string, unknown> }
  | { type: "test_model_config"; providerName: string; provider: Record<string, unknown>; model: Record<string, unknown> }
  | { type: "list_providers" }
  | { type: "provider_login"; providerId: string; methodId?: string }
  | { type: "auth_response"; challengeId: string; value: string }
  | { type: "auth_cancel"; challengeId: string }
  | { type: "get_feature_settings" }
  | { type: "create_skill"; name: string; description: string; instructions: string; scope: "global" | "project" }
  | { type: "set_skill_enabled"; filePath: string; enabled: boolean }
  | { type: "plugin_action"; action: "install" | "remove" | "update"; source: string; scope?: "global" | "project" }
  | { type: "set_plugin_enabled"; source: string; scope: "global" | "project"; enabled: boolean }
  | { type: "set_subagent_settings"; enabled?: boolean; maxConcurrent?: number }
  | { type: "set_subagent_profile_enabled"; profileId: SubagentProfileInfo["id"]; enabled: boolean }
  | { type: "create_subagent_profile"; id: string; name: string; description: string; systemPrompt: string; tools: string[]; skills?: string[]; extensions?: string[]; scope: "global" | "project" }
  | { type: "delete_subagent_profile"; profileId: string }
  | { type: "save_mcp_config"; content: string }
);

export type ServerMessage = (
  | { type: "init"; protocolVersion: typeof PROTOCOL_VERSION; sessions: SessionSummary[]; models: ModelInfo[]; providers: ProviderInfo[]; settings: FeatureSettings; primaryAgents?: PrimaryAgentInfo[]; workspace?: WorkspaceInfo }
  | { type: "ack"; command: ClientMessage["type"]; sessionId?: string }
  | { type: "workspace"; workspace: WorkspaceInfo }
  | { type: "directories"; listing: DirectoryListing }
  | { type: "primary_agents"; agents: PrimaryAgentInfo[] }
  | { type: "permission_request"; permission: PermissionRequest }
  | { type: "permission_resolved"; permissionId: string; sessionId: string; decision: PermissionDecision; reason?: string }
  | { type: "pong" }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session_created"; session: SessionSnapshot }
  | { type: "session_state"; session: SessionSnapshot }
  | { type: "session_deleted"; sessionId: string }
  | { type: "models"; models: ModelInfo[] }
  | { type: "models_config"; content: string }
  | { type: "models_saved" }
  | { type: "provider_models_discovered"; providerName: string; models: DiscoveredModelInfo[]; endpoint: string }
  | { type: "model_config_tested"; providerName: string; modelId: string; result: ModelConnectionTestResult }
  | { type: "providers"; providers: ProviderInfo[] }
  | { type: "auth_challenge"; challengeId: string; providerId: string; prompt: string; mode: "input" | "select" | "confirm"; options?: string[]; placeholder?: string; allowEmpty?: boolean }
  | { type: "auth_status"; providerId: string; status: "started" | "complete" | "cancelled" | "error"; message?: string; url?: string }
  | { type: "feature_settings"; settings: FeatureSettings }
  | { type: "feature_action_complete"; category: "skills" | "plugins" | "subagents" | "mcp"; settings: FeatureSettings }
  | { type: "error"; message: string; code?: string; sessionId?: string }
  | AgentUiEvent
) & { requestId?: string };
