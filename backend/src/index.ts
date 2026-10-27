import { unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION, type AgentUiEvent, type ClientMessage, type ServerMessage, type SessionSnapshot, type SessionSummary, type ThinkingLevel } from "../../shared/types.js";
import { WsAuthInteraction } from "./lib/auth-bridge.js";
import { attachEventRelay, withSubagentProgress } from "./lib/event-relay.js";
import { contextUsageFromSession, convertMessages } from "./lib/message-converter.js";
import { ModelManager } from "./lib/model-manager.js";
import { createSession, listStoredSessions, resumeSession, sessionDir, runSessionOperation, switchPrimaryAgent } from "./lib/session-factory.js";
import { SessionPool } from "./lib/session-pool.js";
import { createSharedResources } from "./lib/shared-resources.js";
import type { ActiveSession } from "./lib/types.js";
import { validateClientMessage } from "../../shared/validation.js";
import { MAX_MESSAGE_BYTES } from "../../shared/images.js";
import type { ImageAttachment } from "../../shared/types.js";
import { WorkspaceManager } from "./lib/workspace-manager.js";
import { captureWorkspace, compareWorkspace, saveRunReview, deleteRunReview } from "./lib/run-review.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaces = new WorkspaceManager(process.env.PI_AGENT_DIR || getAgentDir());
const workspace = await workspaces.open(projectRoot, process.env.PI_WORKSPACE_DIR);
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");

const resources = await createSharedResources(workspace);
let models = new ModelManager(resources);
const pool = new SessionPool(5);
const clients = new Set<WebSocket>();
const initializedClients = new WeakSet<WebSocket>();
const pendingLoads = new Map<string, Promise<ActiveSession>>();
const clientIds = new WeakMap<WebSocket, string>();
const authInteractions = new Set<WsAuthInteraction>();
let switchingWorkspace = false;
let activeRequests = 0;
resources.permissions.setNotifier((owner, message) => {
  for (const ws of clients) if (clientIds.get(ws) === owner && initializedClients.has(ws)) send(ws, message);
});

function send(ws: WebSocket, message: ServerMessage): void {
  sendEncoded(ws, JSON.stringify(message));
}

function sendEncoded(ws: WebSocket, encoded: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 2 * MAX_MESSAGE_BYTES) { ws.close(1013, "Client too slow; reconnect and reload snapshots"); return; }
  ws.send(encoded);
}

function broadcast(message: ServerMessage): void {
  const encoded = JSON.stringify(message);
  for (const ws of clients) {
    if (initializedClients.has(ws)) sendEncoded(ws, encoded);
  }
}

function broadcastEvent(event: AgentUiEvent): void {
  const active = pool.values().find((item) => item.id === event.sessionId);
  if (active) {
    active.sequence = (active.sequence ?? 0) + 1;
    broadcast({ ...event, epoch: active.epoch, sequence: active.sequence });
  }
}

function notifyCatalogChanged(): void {
  broadcast({ type: "models", models: models.getModelsInfo() });
  broadcast({ type: "providers", providers: models.getProvidersInfo() });
}

async function reloadIdleSessions(): Promise<void> {
  const results = await Promise.allSettled(
    pool.values()
      .filter((active) => active.session.isIdle && !active.promptTask && !active.operationTask)
      .map((active) => runSessionOperation(active, () => active.session.reload())),
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
  active.epoch = randomUUID();
  active.sequence = 0;
  pool.add(active);
  attachEventRelay(
    active,
    broadcastEvent,
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
    messages: withSubagentProgress(active, convertMessages(active.session.messages)),
    model: model ? { provider: model.provider, id: model.id } : undefined,
    thinkingLevel: active.session.thinkingLevel as ThinkingLevel,
    isStreaming: active.session.isStreaming || !!active.promptTask,
    contextUsage: contextUsageFromSession(active.session),
    primaryAgentId: active.role.profile.id,
    epoch: active.epoch,
    sequence: active.sequence,
    review: active.review,
    subagents: resources.features.subagentRuns(active.id, active.manager.getBranch()),
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
  return validateClientMessage(parsed);
}

function lastPromptError(active: ActiveSession): string | undefined {
  const last = [...active.session.messages].reverse().find((item) => item.role === "assistant");
  return last?.role === "assistant" && last.stopReason === "error"
    ? last.errorMessage || "模型调用失败"
    : undefined;
}

function startPrompt(ws: WebSocket, active: ActiveSession, text: string, requestId?: string, images?: ImageAttachment[]): void {
  if (active.promptTask || active.operationTask || !active.session.isIdle) throw new Error("此会话正在工作，请等待或先取消");
  if (images?.length && !active.session.model?.input.includes("image")) throw new Error("当前模型不支持图片，请切换到支持图像输入的模型");
  active.role.controller = new AbortController();
  resources.permissions.setOwner(active.id, clientIds.get(ws)!);
  active.review = { startedAt: new Date().toISOString(), workspace: resources.cwd, files: [], commands: [] };
  const task = (async () => {
    const before = await captureWorkspace(resources.cwd);
    try {
      if (active.role.controller.signal.aborted) throw new Error("任务已取消");
      await active.session.prompt(text, { images: images?.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })) });
      while (resources.features.hasRunningSubagents(active.id)) {
        await resources.features.drainSubagents(active.id);
        if (active.role.controller.signal.aborted) break;
        await active.session.sendCustomMessage({
          customType: "collaboration-summary", display: false,
          content: "后台子代理已结束。请结合收到的协作结果，检查错误与未完成事项，验证并汇总后再向用户报告。",
        }, { triggerTurn: true });
      }
    }
    finally {
      if (resources.features.hasRunningSubagents(active.id)) active.role.controller.abort();
      await resources.features.drainSubagents(active.id);
      const review = active.review!;
      Object.assign(review, compareWorkspace(before, await captureWorkspace(resources.cwd)));
      review.finishedAt = new Date().toISOString();
      for (const command of review.commands) if (command.status === "running") command.status = "error";
      broadcastEvent({ type: "run_review", sessionId: active.id, review });
      try { await saveRunReview(resources.agentDir, active.id, review); }
      catch (error) { console.error("Failed to save run review", error); }
    }
  })()
    .then(() => {
      active.contextUsage = contextUsageFromSession(active.session);
      broadcastEvent({
        type: "agent_end", sessionId: active.id, contextUsage: active.contextUsage, error: lastPromptError(active),
      });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      send(ws, { type: "error", message, sessionId: active.id, requestId });
      broadcastEvent({
        type: "agent_end", sessionId: active.id, contextUsage: contextUsageFromSession(active.session), error: message,
      });
    })
    .finally(() => { resources.permissions.cancelSession(active.id, "本轮任务已结束"); active.promptTask = undefined; });
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
  await active?.operationTask;
  if (!info && !active) throw new Error("会话不存在");
  active?.role.controller.abort();
  resources.permissions.cancelSession(sessionId);
  if (active?.session.isStreaming) await active.session.abort();
  await active?.promptTask;
  pool.remove(sessionId);
  if (info) {
    if (!validDeletePath(info.path)) throw new Error("会话文件路径无效");
    await unlink(info.path);
  }
  await deleteRunReview(resources.agentDir, sessionId);
  broadcast({ type: "session_deleted", sessionId });
  broadcast({ type: "sessions", sessions: await listSessions() });
}

async function route(ws: WebSocket, auth: WsAuthInteraction, message: ClientMessage): Promise<void> {
  const requestId = message.requestId;
  switch (message.type) {
    case "init": {
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`协议版本不兼容：客户端 ${message.protocolVersion}，服务端 ${PROTOCOL_VERSION}`);
      }
      const [sessions, settings, primaryAgents] = await Promise.all([listSessions(), resources.features.getSettings(), resources.primaryAgents.list()]);
      send(ws, {
        type: "init",
        protocolVersion: PROTOCOL_VERSION,
        sessions,
        models: models.getModelsInfo(),
        providers: models.getProvidersInfo(),
        settings,
        primaryAgents,
        workspace: workspaces.info(),
        requestId,
      });
      initializedClients.add(ws);
      for (const permission of resources.permissions.list(clientIds.get(ws)!)) send(ws, { type: "permission_request", permission });
      return;
    }
    case "ping": send(ws, { type: "pong", requestId }); return;
    case "get_workspace": send(ws, { type: "workspace", workspace: workspaces.info(), requestId }); return;
    case "browse_directories": send(ws, { type: "directories", listing: await workspaces.browse(message.path), requestId }); return;
    case "set_workspace": {
      if (activeRequests > 1 || pendingLoads.size || pool.values().some((active) => active.promptTask || active.operationTask || !active.session.isIdle) || [...authInteractions].some((item) => item.isBusy)) {
        throw new Error("请等待所有任务、设置操作和登录完成后再切换项目");
      }
      switchingWorkspace = true;
      try {
        const path = await workspaces.validate(message.path);
        const next = await createSharedResources(path);
        // Prepare every fallible catalog read before committing the workspace switch.
        const [stored, settings, primaryAgents] = await Promise.all([listStoredSessions(next), next.features.getSettings(), next.primaryAgents.list()]);
        const sessions = stored.map((item) => ({ id: item.id, title: item.name || item.firstMessage.replace(/\s+/g, " ").trim().slice(0, 64) || "新对话", createdAt: item.created.toISOString(), updatedAt: item.modified.toISOString(), messageCount: item.messageCount }));
        await workspaces.select(path);
        pool.close();
        for (const auth of authInteractions) auth.close();
        Object.assign(resources, next);
        resources.permissions.setNotifier((owner, notification) => {
          for (const client of clients) if (clientIds.get(client) === owner && initializedClients.has(client)) send(client, notification);
        });
        models = new ModelManager(resources);
        broadcast({ type: "workspace", workspace: workspaces.info() });
        // All connected consoles share one workspace and replace their catalogs together.
        broadcast({ type: "init", protocolVersion: PROTOCOL_VERSION, sessions, settings, primaryAgents, models: models.getModelsInfo(), providers: models.getProvidersInfo(), workspace: workspaces.info() });
      } finally { switchingWorkspace = false; }
      return;
    }
    case "list_sessions": send(ws, { type: "sessions", sessions: await listSessions(), requestId }); return;
    case "create_session": {
      const active = attach(await createSession(resources));
      send(ws, { type: "session_created", session: snapshot(active), requestId });
      broadcast({ type: "sessions", sessions: await listSessions() });
      return;
    }
    case "list_primary_agents":
      send(ws, { type: "primary_agents", agents: await resources.primaryAgents.list(), requestId });
      return;
    case "set_primary_agent": {
      const active = await getSession(requireText(message.sessionId, "sessionId", 128));
      const agentId = requireText(message.agentId, "agentId", 64);
      await runSessionOperation(active, async () => {
        await switchPrimaryAgent(resources, active, agentId);
        active.unsubscribe?.();
        attachEventRelay(active, broadcastEvent, () => broadcast({ type: "session_state", session: snapshot(active) }));
        broadcastEvent({ type: "session_updated", sessionId: active.id, primaryAgentId: active.role.profile.id });
        send(ws, { type: "session_state", session: snapshot(active), requestId });
      });
      return;
    }
    case "permission_response": {
      if (!["allow_once", "allow_session", "deny"].includes(message.decision)) throw new Error("权限决定无效");
      resources.permissions.respond(clientIds.get(ws)!, requireText(message.permissionId, "permissionId", 128), message.decision);
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
      startPrompt(ws, active, message.text, requestId, message.images);
      return;
    }
    case "abort": {
      const active = await getSession(requireText(message.sessionId, "sessionId", 128));
      active.role.controller.abort();
      resources.permissions.cancelSession(active.id);
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
      await runSessionOperation(active, () => active.session.setModel(model));
      broadcastEvent({
        type: "session_updated", sessionId: active.id, model: { provider, id: modelId }, thinkingLevel: active.session.thinkingLevel as ThinkingLevel,
      });
      return;
    }
    case "set_thinking_level": {
      const active = await getSession(requireText(message.sessionId, "sessionId", 128));
      const allowed: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      if (!allowed.includes(message.level)) throw new Error("思考强度无效");
      await runSessionOperation(active, async () => { active.session.setThinkingLevel(message.level); });
      broadcastEvent({
        type: "session_updated", sessionId: active.id, thinkingLevel: active.session.thinkingLevel as ThinkingLevel,
      });
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
      if (message.skills !== undefined && (!Array.isArray(message.skills) || !message.skills.every((skill) => typeof skill === "string"))) throw new Error("skills 必须是字符串数组");
      if (message.extensions !== undefined && (!Array.isArray(message.extensions) || !message.extensions.every((extension) => typeof extension === "string"))) throw new Error("extensions 必须是字符串数组");
      await resources.features.createSubagentProfile({
        id: requireText(message.id, "id", 64),
        name: requireText(message.name, "name", 100),
        description: requireText(message.description, "description", 500),
        systemPrompt: requireText(message.systemPrompt, "systemPrompt", 50_000),
        tools: message.tools,
        skills: message.skills,
        extensions: message.extensions,
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
app.get("/api/health", (context) => context.json({ ok: true, service: "pi-agent-gateway" }));
const webRoot = resolve(projectRoot, "frontend/dist");
if (existsSync(resolve(webRoot, "index.html"))) app.get("/*", serveStatic({ root: webRoot }));
else app.get("/", (context) => context.text("Pi Agent Gateway is running. Run pnpm build to serve the web console."));

const server = serve({ fetch: app.fetch, hostname: host, port });
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

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
  clientIds.set(ws, randomUUID());
  const auth = new WsAuthInteraction(resources, (message) => send(ws, message), notifyCatalogChanged);
  authInteractions.add(auth);
  ws.on("message", (data) => {
    let message: ClientMessage;
    try { message = parseClientMessage(data); }
    catch (error) {
      let requestId: string | undefined;
      try { const raw = JSON.parse(data.toString()); if (typeof raw?.requestId === "string" && raw.requestId.length <= 128) requestId = raw.requestId; } catch { /* Invalid JSON cannot be correlated. */ }
      send(ws, { type: "error", code: "BAD_REQUEST", requestId, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (message.type !== "init" && !initializedClients.has(ws)) {
      send(ws, {
        type: "error",
        code: "INIT_REQUIRED",
        requestId: message.requestId,
        message: `请先发送 init（protocolVersion: ${PROTOCOL_VERSION}）完成握手`,
      });
      return;
    }
    if (switchingWorkspace) { send(ws, { type: "error", code: "WORKSPACE_SWITCHING", requestId: message.requestId, message: "正在切换项目，请稍后重试" }); return; }
    activeRequests++;
    void route(ws, auth, message).then(() => {
      if (message.requestId) send(ws, { type: "ack", command: message.type, requestId: message.requestId, ...("sessionId" in message ? { sessionId: message.sessionId } : {}) });
    }).catch((error) => {
      send(ws, {
        type: "error",
        code: "REQUEST_FAILED",
        requestId: message.requestId,
        sessionId: "sessionId" in message ? message.sessionId : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => { activeRequests--; });
  });
  ws.on("close", () => { resources.permissions.closeOwner(clientIds.get(ws)!); clients.delete(ws); auth.close(); authInteractions.delete(auth); });
  ws.on("error", (error) => console.error("WebSocket error", error));
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  switchingWorkspace = true;
  for (const client of clients) client.close(1001, "Server shutting down");
  for (const auth of authInteractions) auth.close();
  const active = pool.values();
  for (const item of active) { item.role.controller.abort(); resources.permissions.cancelSession(item.id); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(active.map(async (item) => { await item.session.abort(); await item.promptTask; await item.operationTask; })),
    new Promise<void>((done) => { timer = setTimeout(done, 5000); }),
  ]);
  clearTimeout(timer);
  pool.close();
  const forceClose = setTimeout(() => { for (const client of clients) client.terminate(); }, 1000);
  forceClose.unref();
  wss.close();
  server.close();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
console.log(`Pi Agent Gateway listening on http://${host}:${port} (Pi cwd: ${workspace})`);
