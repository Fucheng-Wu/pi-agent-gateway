import { join } from "node:path";
import { createAgentSession, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { contextUsageFromSession } from "./message-converter.js";
import type { SharedResources } from "./shared-resources.js";
import type { ActiveSession } from "./types.js";
import type { RoleRuntime } from "./permissions.js";

async function buildSession(resources: SharedResources, manager: SessionManager, role: RoleRuntime, previous?: ActiveSession) {
  const resourceLoader = await resources.features.createResourceLoader(role);
  const { session } = await createAgentSession({
    cwd: resources.cwd, agentDir: resources.agentDir, sessionManager: manager,
    modelRuntime: resources.modelRuntime, settingsManager: resources.settingsManager, resourceLoader,
    tools: role.profile.tools,
    ...(previous ? { model: previous.session.model, thinkingLevel: previous.session.thinkingLevel } : {}),
  });
  try { await session.bindExtensions({}); }
  catch (error) { session.dispose(); throw error; }
  return session;
}

export function runSessionOperation<T>(active: ActiveSession, operation: () => Promise<T>): Promise<T> {
  if (active.operationTask || active.promptTask || !active.session.isIdle) throw new Error("会话正在工作，请等待完成或先取消");
  const task = operation();
  active.operationTask = task;
  return task.finally(() => { if (active.operationTask === task) active.operationTask = undefined; });
}

export async function switchPrimaryAgent(resources: SharedResources, active: ActiveSession, agentId: string): Promise<void> {
  const profile = await resources.primaryAgents.get(agentId);
  if (active.role.profile.id === agentId) return;
  const role: RoleRuntime = { sessionId: active.id, profile, controller: new AbortController() };
  const session = await buildSession(resources, active.manager, role, active);
  const old = active.session;
  active.unsubscribe?.();
  active.manager.appendCustomEntry("primary-agent", { profileId: profile.id });
  active.session = session;
  active.role = role;
  active.contextUsage = contextUsageFromSession(session);
  resources.permissions.cancelSession(active.id, "主代理已切换", true);
  old.dispose();
}

export function sessionDir(resources: SharedResources): string {
  // Matches Pi's getDefaultSessionDir encoding, while respecting PI_AGENT_DIR.
  const safePath = `--${resources.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resources.agentDir, "sessions", safePath);
}

export async function listStoredSessions(resources: SharedResources): Promise<SessionInfo[]> {
  return SessionManager.list(resources.cwd, sessionDir(resources));
}

export async function createSession(resources: SharedResources): Promise<ActiveSession> {
  const manager = SessionManager.create(resources.cwd, sessionDir(resources));
  const role: RoleRuntime = { sessionId: manager.getSessionId(), profile: await resources.primaryAgents.get("build"), controller: new AbortController() };
  const session = await buildSession(resources, manager, role);
  const now = new Date().toISOString();
  return {
    id: session.sessionId,
    session,
    manager,
    role,
    onDispose: () => resources.permissions.cancelSession(session.sessionId, "会话已关闭", true),
    summary: { id: session.sessionId, title: "新对话", createdAt: now, updatedAt: now, messageCount: 0 },
    contextUsage: contextUsageFromSession(session),
    lastAccessAt: Date.now(),
  };
}

export async function resumeSession(resources: SharedResources, info: SessionInfo): Promise<ActiveSession> {
  const manager = SessionManager.open(info.path, sessionDir(resources), resources.cwd);
  const selected = [...manager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === "primary-agent");
  const profileId = selected?.type === "custom" && selected.data && typeof selected.data === "object" && "profileId" in selected.data
    ? String(selected.data.profileId) : "build";
  const role: RoleRuntime = { sessionId: manager.getSessionId(), profile: await resources.primaryAgents.get(profileId), controller: new AbortController() };
  const session = await buildSession(resources, manager, role);
  return {
    id: session.sessionId,
    session,
    manager,
    role,
    onDispose: () => resources.permissions.cancelSession(session.sessionId, "会话已关闭", true),
    summary: {
      id: session.sessionId,
      title: info.name || info.firstMessage.replace(/\s+/g, " ").trim().slice(0, 64) || "新对话",
      createdAt: info.created.toISOString(),
      updatedAt: info.modified.toISOString(),
      messageCount: info.messageCount,
    },
    contextUsage: contextUsageFromSession(session),
    lastAccessAt: Date.now(),
  };
}
