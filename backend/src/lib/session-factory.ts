import { join } from "node:path";
import { createAgentSession, SessionManager, type SessionInfo } from "@mariozechner/pi-coding-agent";
import { contextUsageFromSession } from "./message-converter.js";
import type { SharedResources } from "./shared-resources.js";
import type { ActiveSession } from "./types.js";

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
  const { session } = await createAgentSession({
    cwd: resources.cwd,
    agentDir: resources.agentDir,
    sessionManager: manager,
    authStorage: resources.authStorage,
    modelRegistry: resources.modelRegistry,
    settingsManager: resources.settingsManager,
  });
  const now = new Date().toISOString();
  return {
    id: session.sessionId,
    session,
    manager,
    summary: { id: session.sessionId, title: "新对话", createdAt: now, updatedAt: now, messageCount: 0 },
    contextUsage: contextUsageFromSession(session),
    lastAccessAt: Date.now(),
  };
}

export async function resumeSession(resources: SharedResources, info: SessionInfo): Promise<ActiveSession> {
  const manager = SessionManager.open(info.path, sessionDir(resources), resources.cwd);
  const { session } = await createAgentSession({
    cwd: resources.cwd,
    agentDir: resources.agentDir,
    sessionManager: manager,
    authStorage: resources.authStorage,
    modelRegistry: resources.modelRegistry,
    settingsManager: resources.settingsManager,
  });
  return {
    id: session.sessionId,
    session,
    manager,
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
