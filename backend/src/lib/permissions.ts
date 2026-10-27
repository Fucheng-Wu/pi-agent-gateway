import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PermissionDecision, PermissionRequest, PermissionRule, PrimaryAgentInfo, ServerMessage } from "../../../shared/types.js";

export function matches(pattern: string, value: string): boolean {
  const expression = pattern.split("*").map((part) => part.split("?").map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".")).join(".*");
  return new RegExp(`^${expression}$`, process.platform === "win32" ? "is" : "s").test(value);
}

export function permissionEffect(rules: PermissionRule[], action: string, resource: string): PermissionRule["effect"] {
  return [...rules].reverse().find((rule) => matches(rule.action, action) && matches(rule.resource, resource))?.effect ?? "ask";
}

export function parsePermissions(value: unknown): PermissionRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 200) throw new Error("permissions 必须是权限规则数组（最多 200 条）");
  return value.map((rule) => {
    if (!rule || typeof rule !== "object" || typeof rule.action !== "string" || typeof rule.resource !== "string"
      || !["allow", "ask", "deny"].includes(rule.effect) || rule.action.length > 256 || rule.resource.length > 4096) {
      throw new Error("权限规则必须包含 action、resource 和 allow/ask/deny effect");
    }
    return { action: rule.action, resource: rule.resource, effect: rule.effect };
  });
}

interface Pending {
  request: PermissionRequest;
  owner: string;
  finish: (allowed: boolean, decision: PermissionDecision, reason?: string) => void;
}

type PermissionInput = Omit<PermissionRequest, "id" | "createdAt" | "expiresAt">;
type SessionGrant = Pick<PermissionRequest, "agentId" | "action" | "toolName" | "resource" | "patterns">;
const shellActions = new Set(["bash", "powershell", "shell"]);

// Generalize only commands whose syntax cannot contain chaining, substitution,
// redirection or quoting. Complex commands keep exact-command approvals.
function simpleCommand(command: string): boolean {
  return /^[a-zA-Z0-9_./:@=+,\-]+(?:[ \t]+[a-zA-Z0-9_./:@=+,\-]+)*$/.test(command);
}

function approvalPatterns(action: string, resource: string, directoryTool: boolean): string[] | undefined {
  if (action === "edit") return ["*"];
  if (action === "external_directory" && !/[*?]/.test(resource)) {
    const directory = directoryTool ? resource.replace(/\/$/, "") : resource.slice(0, resource.lastIndexOf("/"));
    return [directory || "/", `${directory}/*`];
  }
  if (!shellActions.has(action) || !simpleCommand(resource)) return undefined;
  const [command, subcommand, script] = resource.split(/[ \t]+/);
  let prefix: string | undefined;
  if (command === "git" && ["status", "diff", "log", "show"].includes(subcommand)) prefix = `${command} ${subcommand}`;
  if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
    if (["test", "build", "lint", "typecheck"].includes(subcommand)) prefix = `${command} ${subcommand}`;
    else if (subcommand === "run" && script && !script.startsWith("-")) prefix = `${command} run ${script}`;
  }
  return prefix ? [prefix, `${prefix} *`] : undefined;
}

export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly owners = new Map<string, string>();
  private readonly grants = new Map<string, SessionGrant[]>();
  private notify: (owner: string, message: ServerMessage) => void = () => {};

  constructor(private readonly timeoutMs = 5 * 60_000) {}

  setNotifier(notify: (owner: string, message: ServerMessage) => void): void { this.notify = notify; }
  setOwner(sessionId: string, owner: string): void { this.owners.set(sessionId, owner); }
  list(owner: string): PermissionRequest[] { return [...this.pending.values()].filter((item) => item.owner === owner).map((item) => item.request); }

  private isGranted(input: PermissionInput): boolean {
    const action = input.action ?? input.toolName;
    return this.grants.get(input.sessionId)?.some((grant) => grant.agentId === input.agentId
      && (grant.action ?? grant.toolName) === action
      && (grant.resource === input.resource || (grant.patterns?.some((pattern) => matches(pattern, input.resource))
        && (!shellActions.has(action) || simpleCommand(input.resource))))) ?? false;
  }

  async ask(input: PermissionInput, signal: AbortSignal): Promise<boolean> {
    const owner = this.owners.get(input.sessionId);
    if (!owner || signal.aborted) return false;
    if (this.isGranted(input)) return true;
    return new Promise<boolean>((resolvePromise) => {
      const request: PermissionRequest = {
        ...input, id: randomUUID(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
      };
      const finish: Pending["finish"] = (allowed, decision, reason) => {
        if (!this.pending.delete(request.id)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.notify(owner, { type: "permission_resolved", permissionId: request.id, sessionId: input.sessionId, decision, reason });
        resolvePromise(allowed);
      };
      const abort = () => finish(false, "deny", "操作已取消");
      const timer = setTimeout(() => finish(false, "deny", "确认请求已超时"), this.timeoutMs);
      timer.unref();
      this.pending.set(request.id, { request, owner, finish });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else this.notify(owner, { type: "permission_request", permission: request });
    });
  }

  respond(owner: string, permissionId: string, decision: PermissionDecision): void {
    const item = this.pending.get(permissionId);
    if (!item || item.owner !== owner) throw new Error("确认请求不存在、已失效或属于其他连接");
    if (decision === "allow_session") {
      const grants = this.grants.get(item.request.sessionId) ?? [];
      grants.push(item.request);
      this.grants.set(item.request.sessionId, grants);
    }
    item.finish(decision !== "deny", decision);
    if (decision === "allow_session" || decision === "deny") {
      for (const pending of [...this.pending.values()]) {
        if (pending.owner !== owner || pending.request.sessionId !== item.request.sessionId) continue;
        if (decision === "deny") pending.finish(false, "deny", "用户已拒绝本会话的待确认操作");
        else if (this.isGranted(pending.request)) pending.finish(true, "allow_session");
      }
    }
  }

  cancelSession(sessionId: string, reason = "会话已取消", clearGrants = false): void {
    for (const item of [...this.pending.values()]) if (item.request.sessionId === sessionId) item.finish(false, "deny", reason);
    if (clearGrants) { this.grants.delete(sessionId); this.owners.delete(sessionId); }
  }

  closeOwner(owner: string): void {
    for (const item of [...this.pending.values()]) if (item.owner === owner) item.finish(false, "deny", "连接已断开");
    for (const [sessionId, current] of this.owners) if (current === owner) this.owners.delete(sessionId);
  }
}

export interface RoleRuntime {
  sessionId: string;
  profile: PrimaryAgentInfo;
  controller: AbortController;
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await canonicalPath(parent), basename(path));
  }
}

async function toolResource(toolName: string, input: Record<string, unknown>, cwd: string): Promise<{ action: string; resource: string; external: boolean }> {
  const action = ["edit", "write", "apply_patch"].includes(toolName) ? "edit" : toolName;
  const path = input.path ?? input.filePath;
  if (["read", "edit", "write", "apply_patch", "grep", "find", "ls"].includes(toolName) && typeof path === "string") {
    // Match Pi's tool path syntax before checking directory boundaries.
    let normalized = path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
    if (process.platform === "win32" && !normalized.includes("\\")) {
      normalized = normalized.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i, (_match, drive: string, suffix = "") => `${drive.toUpperCase()}:/${suffix}`);
    }
    if (normalized === "~") normalized = homedir();
    else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) normalized = join(homedir(), normalized.slice(2));
    if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
    const absolute = await canonicalPath(resolve(cwd, normalized));
    const rel = relative(await canonicalPath(cwd), absolute);
    const external = rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel);
    return { action, resource: (external ? absolute : rel).replaceAll("\\", "/"), external };
  }
  const value = input.command ?? input.code ?? input.pattern ?? input.query ?? input.url ?? input.profile;
  return { action, resource: typeof value === "string" ? value : JSON.stringify(input), external: false };
}

/** Shared by root and child sessions, so delegation cannot bypass the root policy. */
export function createPermissionExtension(
  runtime: RoleRuntime, broker: PermissionBroker, cwd: string,
  child?: { id: string; name: string; permissions?: PermissionRule[]; tools: string[] },
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (runtime.controller.signal.aborted) return { block: true, reason: "任务已取消" };
      if (!child && !runtime.profile.tools.some((pattern) => matches(pattern, event.toolName))) {
        return { block: true, reason: "主代理未获准调用此工具" };
      }
      const { action, resource, external } = await toolResource(event.toolName, event.input, cwd);
      if (child && !child.tools.some((pattern) => matches(pattern, event.toolName))) {
        return { block: true, reason: "子代理未获准调用此工具" };
      }
      const checks = (external ? [action, "external_directory"] : [action]).map((permission) => {
        const effects = [permissionEffect(runtime.profile.permissions, permission, resource)];
        if (child?.permissions) effects.push(permissionEffect(child.permissions, permission, resource));
        return { action: permission, effect: effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow" };
      });
      // Explicit restrictions are evaluated before any remembered approval.
      if (checks.some((check) => check.effect === "deny")) return { block: true, reason: `${runtime.profile.name} 不允许 ${event.toolName}：${resource}` };
      for (const check of checks) {
        if (check.effect !== "ask") continue;
        const allowed = await broker.ask({
          sessionId: runtime.sessionId,
          agentId: `${runtime.profile.id}:${child?.id ?? "primary"}`,
          agentName: child ? `${runtime.profile.name} / ${child.name}` : runtime.profile.name,
          toolName: event.toolName, resource, input: event.input, action: check.action,
          patterns: approvalPatterns(check.action, resource, ["grep", "find", "ls"].includes(event.toolName)),
        }, runtime.controller.signal);
        if (!allowed) return { block: true, reason: "用户未允许此次操作" };
      }
    });
  };
}
