import type { ClientMessage } from "./types.js";
import { isImageAttachment, MAX_IMAGES } from "./images.js";

type Rule = (value: unknown) => boolean;
const text = (max = 100_000): Rule => (value) => typeof value === "string" && !!value.trim() && value.length <= max;
const string: Rule = (value) => typeof value === "string" && value.length <= 100_000;
const optional = (rule: Rule): Rule => (value) => value === undefined || rule(value);
const choice = (...values: unknown[]): Rule => (value) => values.includes(value);
const boolean: Rule = (value) => typeof value === "boolean";
const record: Rule = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const strings: Rule = (value) => Array.isArray(value) && value.length <= 256 && value.every(text(4096));
const session = { sessionId: text(128) };
const scope = choice("global", "project");

/** All wire commands are checked here before entering a handler. Keep exhaustive. */
const commands = {
  init: { protocolVersion: choice(1) }, ping: {}, list_sessions: {}, create_session: {},
  get_workspace: {}, browse_directories: { path: optional(text(4096)) }, set_workspace: { path: text(4096) },
  list_primary_agents: {}, set_primary_agent: { ...session, agentId: text(64) },
  permission_response: { permissionId: text(128), decision: choice("allow_once", "allow_session", "deny") },
  load_session: session, delete_session: session, abort: session,
  prompt: { ...session, text: (value) => typeof value === "string" && value.length <= 500_000,
    images: optional((value) => Array.isArray(value) && value.length <= MAX_IMAGES && value.every(isImageAttachment)) },
  set_model: { ...session, provider: text(128), modelId: text(256) },
  set_thinking_level: { ...session, level: choice("off", "minimal", "low", "medium", "high", "xhigh", "max") },
  list_models: {}, get_models_config: {}, save_models_config: { content: text(2_000_000) },
  discover_provider_models: { providerName: text(128), provider: record },
  test_model_config: { providerName: text(128), provider: record, model: (value: unknown) => record(value) && text(256)((value as Record<string, unknown>).id) },
  list_providers: {}, provider_login: { providerId: text(128), methodId: optional(choice("api_key", "oauth")) },
  auth_response: { challengeId: text(128), value: string }, auth_cancel: { challengeId: text(128) },
  get_feature_settings: {}, create_skill: { name: text(64), description: text(500), instructions: text(), scope },
  set_skill_enabled: { filePath: text(4096), enabled: boolean },
  plugin_action: { action: choice("install", "remove", "update"), source: text(500), scope: optional(scope) },
  set_plugin_enabled: { source: text(500), scope, enabled: boolean },
  set_subagent_settings: { enabled: optional(boolean), maxConcurrent: optional((value) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 8) },
  set_subagent_profile_enabled: { profileId: text(64), enabled: boolean },
  create_subagent_profile: { id: text(64), name: text(100), description: text(500), systemPrompt: text(50_000), tools: strings, skills: optional(strings), extensions: optional(strings), scope },
  delete_subagent_profile: { profileId: text(64) }, save_mcp_config: { content: text(2_000_000) },
} satisfies Record<ClientMessage["type"], Record<string, Rule>>;

export function validateClientMessage(value: unknown): ClientMessage {
  if (!record(value)) throw new Error("消息必须是对象");
  const message = value as Record<string, unknown>;
  if (typeof message.type !== "string" || !Object.hasOwn(commands, message.type)) throw new Error("不支持的消息类型");
  if (!optional(text(128))(message.requestId)) throw new Error("requestId 无效");
  const rules: Record<string, Rule> = commands[message.type as keyof typeof commands];
  for (const [field, rule] of Object.entries(rules)) {
    if (!rule(message[field])) throw new Error(`${message.type}.${field} 无效`);
  }
  if (message.type === "prompt" && !(message.text as string).trim() && !(message.images as unknown[] | undefined)?.length) {
    throw new Error("请填写消息或上传图片");
  }
  return message as ClientMessage;
}
