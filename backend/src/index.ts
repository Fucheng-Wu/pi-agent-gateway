import { unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage, SessionSnapshot, SessionSummary, ThinkingLevel } from "../../shared/types.js";
import { WsAuthInteraction } from "./lib/auth-bridge.js";
import { attachEventRelay } from "./lib/event-relay.js";
import { contextUsageFromSession, convertMessages } from "./lib/message-converter.js";
import { ModelManager } from "./lib/model-manager.js";
import { createSession, listStoredSessions, resumeSession, sessionDir } from "./lib/session-factory.js";
import { SessionPool } from "./lib/session-pool.js";
import { createSharedResources } from "./lib/shared-resources.js";
import type { ActiveSession } from "./lib/types.js";

const workspace = resolve(process.env.PI_WORKSPACE_DIR || process.cwd());
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");

const resources = await createSharedResources(workspace);
const models = new ModelManager(resources);
const pool = new SessionPool(5);
const clients = new Set<WebSocket>();
const pendingLoads = new Map<string, Promise<ActiveSession>>();

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage): void {
  for (const ws of clients) send(ws, message);
}

function notifyCatalogChanged(): void {
  broadcast({ type: "models", models: models.getModelsInfo() });
  broadcast({ type: "providers", providers: models.getProvidersInfo() });
}

async function reloadIdleSessions(): Promise<void> {
  const results = await Promise.allSettled(
    pool.values()
      .filter((active) => active.session.isIdle && !active.promptTask)
      .map((active) => active.session.reload()),
  );
  for (const result of results) {
    if (result.status === "rejected") console.error("Failed to reload session resources", result.reason);
  }
}

async function sendFeatureSettings(
  ws: WebSocket,
  type: "feature_settings" | "feature_action_complete",
  requestId?: string,
  category?: "skills" | "plugins" | "subagents" | "mcp",
): Promise<void> {
  const settings = await resources.features.getSettings();
  if (type === "feature_settings") send(ws, { type, settings, requestId });
  else if (category) send(ws, { type, category, settings, requestId });
}

function attach(active: ActiveSession): ActiveSession {
  pool.add(active);
  attachEventRelay(
    active,
    (sessionId, event) => broadcast({ type: "session_event", sessionId, event }),
    () => broadcast({ type: "session_state", session: snapshot(active) }),
  );
  return active;
}

async function getSession(sessionId: string): Promise<ActiveSession> {
  const loaded = pool.get(sessionId);
  if (loaded) return loaded;
  const pending = pendingLoads.get(sessionId);
  if (pending) return pending;
  const task = (async () => {
    const info = (await listStoredSessions(resources)).find((item) => item.id === sessionId);
    if (!info) throw new Error("会话不存在");
    return attach(await resumeSession(resources, info));
  })();
  pendingLoads.set(sessionId, task);
  try { return await task; }
  finally { pendingLoads.delete(sessionId); }
}

function snapshot(active: ActiveSession): SessionSnapshot {
  const model = active.session.model;
  return {
    summary: active.summary,
    messages: convertMessages(active.session.messages),
    model: model ? { provider: model.provider, id: model.id } : undefined,
    thinkingLevel: active.session.thinkingLevel as ThinkingLevel,
    isStreaming: active.session.isStreaming || !!active.promptTask,
    contextUsage: contextUsageFromSession(active.session),
  };
}

async function listSessions(): Promise<SessionSummary[]> {
  const stored = await listStoredSessions(resources);
  const byId = new Map<string, SessionSummary>();
  for (const item of stored) {
    byId.set(item.id, {
      id: item.id,
      title: item.name || item.firstMessage.replace(/\s+/g, " ").trim().slice(0, 64) || "新对话",
      createdAt: item.created.toISOString(),
      updatedAt: item.modified.toISOString(),
      messageCount: item.messageCount,
    });
  }
  for (const active of pool.values()) byId.set(active.id, active.summary);
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function requireText(value: unknown, field: string, maxLength = 500_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} 必须是非空字符串，且不超过 ${maxLength} 字符`);
  }
  return value;
}

function requireString(value: unknown, field: string, maxLength = 100_000): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`${field} 必须是字符串，且不超过 ${maxLength} 字符`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function parseClientMessage(data: WebSocket.RawData): ClientMessage {
  let parsed: unknown;
  try { parsed = JSON.parse(data.toString()); }
  catch { throw new Error("消息不是有效 JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { type?: unknown }).type !== "string") {
    throw new Error("消息缺少 type 字段");
  }
  const requestId = (parsed as { requestId?: unknown }).requestId;
  if (requestId !== undefined && (typeof requestId !== "string" || requestId.length > 128)) {
    throw new Error("requestId 无效");
  }
  return parsed as ClientMessage;
}

function lastPromptError(active: ActiveSession): string | undefined {
  const last = [...active.session.messages].reverse().find((item) => item.role === "assistant");
  return last?.role === "assistant" && last.stopReason === "error"
    ? last.errorMessage || "模型调用失败"
    : undefined;
}

function startPrompt(ws: WebSocket, active: ActiveSession, text: string, requestId?: string): void {
  if (active.promptTask || active.session.isStreaming) throw new Error("此会话正在回复，请等待或先取消");
  const task = active.session.prompt(text)
    .then(() => {
      active.contextUsage = contextUsageFromSession(active.session);
      broadcast({ type: "session_event", sessionId: active.id, event: {
        type: "turn_finished", contextUsage: active.contextUsage, error: lastPromptError(active),
      } });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      send(ws, { type: "error", message, sessionId: active.id, requestId });
      broadcast({ type: "session_event", sessionId: active.id, event: {
        type: "turn_finished", contextUsage: contextUsageFromSession(active.session), error: message,
      } });
    })
    .finally(() => { active.promptTask = undefined; });
  active.promptTask = task;
}

function validDeletePath(path: string): boolean {
  const base = resolve(sessionDir(resources));
  const target = resolve(path);
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && target.endsWith(".jsonl");
}

async function deleteSession(sessionId: string): Promise<void> {
  await pendingLoads.get(sessionId);
  const info = (await listStoredSessions(resources)).find((item) => item.id === sessionId);
  const active = pool.get(sessionId);
  if (!info && !active) throw new Error("会话不存在");
  if (active?.session.isStreaming) await active.session.abort();
  await active?.promptTask;
  pool.remove(sessionId);
  if (info) {
    if (!validDeletePath(info.path)) throw new Error("会话文件路径无效");
    await unlink(info.path);
  }
  broadcast({ type: "session_deleted", sessionId });
  broadcast({ type: "sessions", sessions: await listSessions() });
}

async function route(ws: WebSocket, auth: WsAuthInteraction, message: ClientMessage): Promise<void> {
  const requestId = message.requestId;
  switch (message.type) {
    case "ping": send(ws, { type: "pong", requestId }); return;
    case "list_sessions": send(ws, { type: "sessions", sessions: await listSessions(), requestId }); return;
    case "create_session": {
      const active = attach(await createSession(resources));
      send(ws, { type: "session_created", session: snapshot(active), requestId });
      broadcast({ type: "sessions", sessions: await listSessions() });
      return;
    }
    case "load_session": {
      const active = await getSession(requireText(message.sessionId, "sessionId", 128));
      send(ws, { type: "session_state", session: snapshot(active), requestId });
      return;
    }
    case "delete_session":
      await deleteSession(requireText(message.sessionId, "sessionId", 128));
      return;
    case "prompt": {
      const active = await getSession(requireText(message.sessionId, "sessionId", 128));
      startPrompt(ws, active, requireText(message.text, "text"), requestId);
      return;
    }
    case "abort": {
      const active = await getSession(requireText(message.sessionId, "sessionId", 128));
      await active.session.abort();
      return;
    }
    case "set_model": {
      const active = await getSession(requireText(message.sessionId, "sessionId", 128));
      const provider = requireText(message.provider, "provider", 128);
      const modelId = requireText(message.modelId, "modelId", 256);
      const model = resources.modelRegistry.find(provider, modelId);
      if (!model) throw new Error("模型不存在");
      if (!resources.modelRegistry.hasConfiguredAuth(model)) throw new Error("请先配置此模型的 Provider 认证");
      await active.session.setModel(model);
      broadcast({ type: "session_event", sessionId: active.id, event: {
        type: "session_updated", model: { provider, id: modelId }, thinkingLevel: active.session.thinkingLevel as ThinkingLevel,
      } });
      return;
    }
    case "set_thinking_level": {
      const active = await getSession(requireText(message.sessionId, "sessionId", 128));
      const allowed: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      if (!allowed.includes(message.level)) throw new Error("思考强度无效");
      active.session.setThinkingLevel(message.level);
      broadcast({ type: "session_event", sessionId: active.id, event: {
        type: "session_updated", thinkingLevel: active.session.thinkingLevel as ThinkingLevel,
      } });
      return;
    }
    case "list_models": send(ws, { type: "models", models: models.getModelsInfo(), requestId }); return;
    case "get_models_config": send(ws, { type: "models_config", content: await models.readConfig(), requestId }); return;
    case "save_models_config": {
      await models.saveConfig(requireText(message.content, "content", 2_000_000));
      send(ws, { type: "models_saved", requestId });
      notifyCatalogChanged();
      return;
    }
    case "discover_provider_models": {
      const providerName = requireText(message.providerName, "providerName", 128);
      const discovered = await models.discoverProviderModels(providerName, requireRecord(message.provider, "provider"));
      send(ws, { type: "provider_models_discovered", providerName, ...discovered, requestId });
      return;
    }
    case "test_model_config": {
      const providerName = requireText(message.providerName, "providerName", 128);
      const model = requireRecord(message.model, "model");
      const modelId = requireText(model.id, "model.id", 256);
      const result = await models.testModelConfig(providerName, requireRecord(message.provider, "provider"), model);
      send(ws, { type: "model_config_tested", providerName, modelId, result, requestId });
      return;
    }
    case "list_providers": send(ws, { type: "providers", providers: models.getProvidersInfo(), requestId }); return;
    case "provider_login":
      void auth.login(requireText(message.providerId, "providerId", 128), message.methodId)
        .catch((error) => send(ws, { type: "error", message: error instanceof Error ? error.message : String(error), requestId }));
      return;
    case "auth_response":
      auth.respond(requireText(message.challengeId, "challengeId", 128), requireString(message.value, "value"));
      return;
    case "auth_cancel": auth.cancel(requireText(message.challengeId, "challengeId", 128)); return;
    case "get_feature_settings":
      await sendFeatureSettings(ws, "feature_settings", requestId);
      return;
    case "create_skill":
      if (message.scope !== "global" && message.scope !== "project") throw new Error("技能作用域无效");
      await resources.features.createSkill({
        name: requireText(message.name, "name", 64),
        description: requireText(message.description, "description", 500),
        instructions: requireText(message.instructions, "instructions", 100_000),
        scope: message.scope,
      });
      await reloadIdleSessions();
      await sendFeatureSettings(ws, "feature_action_complete", requestId, "skills");
      return;
    case "set_skill_enabled":
      if (typeof message.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
      await resources.features.setSkillEnabled(requireText(message.filePath, "filePath", 4_096), message.enabled);
      await reloadIdleSessions();
      await sendFeatureSettings(ws, "feature_action_complete", requestId, "skills");
      return;
    case "plugin_action":
      if (!["install", "remove", "update"].includes(message.action)) throw new Error("插件操作无效");
      if (message.scope !== undefined && message.scope !== "global" && message.scope !== "project") throw new Error("插件作用域无效");
      await resources.features.runPluginAction(message.action, requireText(message.source, "source", 500), message.scope);
      await reloadIdleSessions();
      await sendFeatureSettings(ws, "feature_action_complete", requestId, "plugins");
      return;
    case "set_plugin_enabled":
      if (typeof message.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
      if (message.scope !== "global" && message.scope !== "project") throw new Error("插件作用域无效");
      await resources.features.setPluginEnabled(requireText(message.source, "source", 500), message.scope, message.enabled);
      await reloadIdleSessions();
      await sendFeatureSettings(ws, "feature_action_complete", requestId, "plugins");
      return;
    case "set_subagent_settings":
      if (message.enabled !== undefined && typeof message.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
      await resources.features.setSubagentSettings({ enabled: message.enabled, maxConcurrent: message.maxConcurrent });
      await reloadIdleSessions();
      await sendFeatureSettings(ws, "feature_action_complete", requestId, "subagents");
      return;
    case "set_subagent_profile_enabled":
      if (typeof message.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
      await resources.features.setSubagentProfileEnabled(message.profileId, message.enabled);
      await reloadIdleSessions();
      await sendFeatureSettings(ws, "feature_action_complete", requestId, "subagents");
      return;
    case "create_subagent_profile":
      if (message.scope !== "global" && message.scope !== "project") throw new Error("子代理作用域无效");
      if (!Array.isArray(message.tools) || !message.tools.every((tool) => typeof tool === "string")) throw new Error("tools 必须是字符串数组");
      await resources.features.createSubagentProfile({
        id: requireText(message.id, "id", 64),
        name: requireText(message.name, "name", 100),
        description: requireText(message.description, "description", 500),
        systemPrompt: requireText(message.systemPrompt, "systemPrompt", 50_000),
        tools: message.tools,
        scope: message.scope,
      });
      await reloadIdleSessions();
      await sendFeatureSettings(ws, "feature_action_complete", requestId, "subagents");
      return;
    case "delete_subagent_profile":
      await resources.features.deleteSubagentProfile(requireText(message.profileId, "profileId", 64));
      await reloadIdleSessions();
      await sendFeatureSettings(ws, "feature_action_complete", requestId, "subagents");
      return;
    case "save_mcp_config":
      await resources.features.saveMcpConfig(requireText(message.content, "content", 2_000_000));
      await reloadIdleSessions();
      await sendFeatureSettings(ws, "feature_action_complete", requestId, "mcp");
      return;
    default: throw new Error("不支持的消息类型");
  }
}

const app = new Hono();
app.get("/api/health", (context) => context.json({ ok: true, service: "learn-pi-backend" }));
app.get("/", (context) => context.text("learn-pi backend is running"));

const server = serve({ fetch: app.fetch, hostname: host, port });
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

function acceptedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // CLI clients have no browser Origin.
  try {
    const url = new URL(origin);
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const localPort = [String(port), "5173"].includes(url.port);
    return ["http:", "https:"].includes(url.protocol) && localHost && localPort;
  } catch { return false; }
}

server.on("upgrade", (request, socket, head) => {
  let pathname: string;
  try { pathname = new URL(request.url || "/", `http://${request.headers.host || host}`).pathname; }
  catch { socket.destroy(); return; }
  if (pathname !== "/ws" || !acceptedOrigin(request.headers.origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

wss.on("connection", (ws) => {
  clients.add(ws);
  const auth = new WsAuthInteraction(resources, (message) => send(ws, message), notifyCatalogChanged);
  ws.on("message", (data) => {
    let message: ClientMessage;
    try { message = parseClientMessage(data); }
    catch (error) {
      send(ws, { type: "error", code: "BAD_REQUEST", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    void route(ws, auth, message).catch((error) => {
      send(ws, {
        type: "error",
        code: "REQUEST_FAILED",
        requestId: message.requestId,
        sessionId: "sessionId" in message ? message.sessionId : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
  ws.on("close", () => { clients.delete(ws); auth.close(); });
  ws.on("error", (error) => console.error("WebSocket error", error));
});

function shutdown(): void {
  for (const client of clients) client.close(1001, "Server shutting down");
  pool.close();
  wss.close();
  server.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
console.log(`learn-pi backend listening on http://${host}:${port} (Pi cwd: ${workspace})`);
