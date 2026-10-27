import type { ActiveSession } from "./types.js";

/** Keeps a small number of live AgentSessions; JSONL files remain on disk. */
export class SessionPool {
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(readonly maxActive = 5) {}

  get(id: string): ActiveSession | undefined {
    const active = this.sessions.get(id);
    if (active) active.lastAccessAt = Date.now();
    return active;
  }

  add(active: ActiveSession): void {
    if (this.sessions.has(active.id)) return;
    if (this.sessions.size >= this.maxActive) {
      const candidate = [...this.sessions.values()]
        .filter((item) => item.session.isIdle && !item.promptTask && !item.operationTask)
        .sort((a, b) => a.lastAccessAt - b.lastAccessAt)[0];
      if (!candidate) {
        active.unsubscribe?.();
        active.role.controller.abort();
        active.onDispose?.();
        active.session.dispose();
        throw new Error(`同时最多可运行 ${this.maxActive} 个会话，请等待一个对话完成`);
      }
      this.remove(candidate.id);
    }
    active.lastAccessAt = Date.now();
    this.sessions.set(active.id, active);
  }

  remove(id: string): ActiveSession | undefined {
    const active = this.sessions.get(id);
    if (!active) return undefined;
    this.sessions.delete(id);
    active.unsubscribe?.();
    active.role.controller.abort();
    active.onDispose?.();
    active.session.dispose();
    return active;
  }

  values(): ActiveSession[] {
    return [...this.sessions.values()];
  }

  close(): void {
    for (const id of this.sessions.keys()) this.remove(id);
  }
}
