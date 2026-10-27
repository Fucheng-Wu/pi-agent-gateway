import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PermissionRule, PrimaryAgentInfo } from "../../../shared/types.js";
import { parsePermissions } from "./permissions.js";

const sensitiveReadPermissions: PermissionRule[] = [
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
];
const readPermissions: PermissionRule[] = [
  ...["read", "grep", "find", "ls"].map((action): PermissionRule => ({ action, resource: "*", effect: "allow" })),
  ...sensitiveReadPermissions,
];

export const BUILTIN_PRIMARY_AGENTS: PrimaryAgentInfo[] = [
  {
    id: "build", name: "Build", description: "实施方案、修改代码并验证结果", mode: "primary", builtIn: true,
    systemPrompt: "你现在处于 Build 模式。之前 Plan 模式的只读约束已解除。根据用户授权实施工作，使用工具并验证结果；需要审批的操作等待用户决定。",
    tools: ["*"], skills: ["*"], extensions: [],
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "ask" },
      ...sensitiveReadPermissions,
    ],
  },
  {
    id: "plan", name: "Plan", description: "只读探索、讨论需求和制定实施计划", mode: "primary", builtIn: true,
    systemPrompt: "你现在处于 Plan 模式。与用户讨论方案，不实施项目修改。仅在用户明确要求保存计划时，可以申请写入 .pi/plans/ 下的计划文档。只委派只读探索任务。用户要求实施时，提示其切换到 Build；不要自行切换角色。",
    tools: ["read", "grep", "find", "ls", "write", "edit", "Agent", "spawn_agent", "send_message", "followup_agent", "resume_agent", "wait_agents", "list_agents", "interrupt_agent", "close_agent"], skills: ["*"], extensions: [],
    permissions: [
      { action: "*", resource: "*", effect: "deny" }, ...readPermissions,
      { action: "Agent", resource: "*", effect: "allow" },
      ...["spawn_agent", "send_message", "followup_agent", "resume_agent", "wait_agents", "list_agents", "interrupt_agent", "close_agent"].map((action): PermissionRule => ({ action, resource: "*", effect: "allow" })),
      { action: "edit", resource: ".pi/plans/*.md", effect: "ask" },
      { action: "external_directory", resource: "*", effect: "ask" },
    ],
  },
];

export function frontmatterValue(source: string, key: string): unknown {
  const raw = source.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, "m"))?.[1]?.trim();
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { return raw.replace(/^['"]|['"]$/g, ""); }
}

export class PrimaryAgentRegistry {
  constructor(private readonly backendDir: string, private readonly agentDir: string) {}

  async list(): Promise<PrimaryAgentInfo[]> {
    const profiles = new Map(BUILTIN_PRIMARY_AGENTS.map((profile) => [profile.id, profile]));
    for (const directory of [join(this.agentDir, "primary-agents"), join(this.backendDir, "primary-agents")]) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        if (entry.name.startsWith("_") || entry.name.toLowerCase() === "readme.md") continue;
        const path = entry.isDirectory() ? join(directory, entry.name, "agent.md") : entry.name.endsWith(".md") ? join(directory, entry.name) : undefined;
        if (!path) continue;
        let source;
        try { source = await readFile(path, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        const block = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
        if (!block) throw new Error(`主代理配置缺少 frontmatter：${path}`);
        const get = (key: string) => frontmatterValue(block[1], key);
        const id = String(get("name") ?? (entry.isDirectory() ? entry.name : basename(path, ".md")));
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error(`主代理 ID 无效：${path}`);
        // Built-in Plan/Build policies remain stable. Custom roles use their own IDs.
        if (["plan", "build"].includes(id)) throw new Error("自定义主代理请使用 plan/build 以外的 ID");
        const mode = get("mode") ?? "primary";
        if (mode !== "primary" && mode !== "all") throw new Error(`主代理 mode 必须是 primary 或 all：${id}`);
        const list = (key: string, fallback: string[]) => {
          const value = get(key) ?? fallback;
          if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0 && item.length < 500 && !/^[+-]/.test(item))) {
            throw new Error(`${id}.${key} 必须是字符串数组`);
          }
          return value as string[];
        };
        const extensions = list("extensions", []);
        for (let index = 0; index < extensions.length; index++) {
          const base = await realpath(dirname(path));
          const target = await realpath(resolve(base, extensions[index]));
          const rel = relative(base, target);
          if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("角色扩展必须位于角色目录内");
          extensions[index] = target;
        }
        profiles.set(id, {
          id, name: String(get("display_name") ?? id), description: String(get("description") ?? id), mode,
          systemPrompt: block[2].trim(), tools: list("tools", ["read", "grep", "find", "ls"]), skills: list("skills", []), extensions,
          permissions: parsePermissions(get("permissions")) ?? [{ action: "*", resource: "*", effect: "ask" }, ...readPermissions],
          builtIn: false, filePath: path,
        });
      }
    }
    return [...profiles.values()];
  }

  async get(id: string): Promise<PrimaryAgentInfo> {
    const profile = (await this.list()).find((item) => item.id === id);
    if (!profile) throw new Error(`主代理不存在：${id}`);
    return profile;
  }
}
