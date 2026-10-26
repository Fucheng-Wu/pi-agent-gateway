import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createAgentSession,
  buildSessionContext,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultPackageManager,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  type ExtensionFactory,
  type ExtensionAPI,
  type InlineExtension,
  type ModelRuntime,
  type PackageSource,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPermissionExtension, parsePermissions, type PermissionBroker, type RoleRuntime } from "./permissions.js";
import type { PrimaryAgentRegistry } from "./primary-agents.js";
import { trackSubagent } from "./subagent-progress.js";
import { convertMessages } from "./message-converter.js";
import { SubagentTeam, ROOT_AGENT, collaborationContent, subagentResult } from "./subagent-team.js";
import { SubagentScheduler } from "./subagent-scheduler.js";
import { COLLABORATION_TOOLS, LEGACY_COLLABORATION_TOOLS } from "../../../shared/collaboration.js";
import type {
  FeatureSettings,
  McpConfigInfo,
  PluginInfo,
  SkillInfo,
  SubagentProfileInfo,
  SubagentSettingsInfo,
  SubagentRun,
} from "../../../shared/types.js";

const DEFAULT_MCP_CONFIG = "{\n  \"mcpServers\": {}\n}\n";
const MAX_CONFIG_BYTES = 2_000_000;
const MAX_SUBAGENTS = 8;

const SUBAGENT_PROFILES: Omit<SubagentProfileInfo, "enabled">[] = [
  {
    id: "general-purpose",
    name: "通用执行",
    description: "独立完成分析、编码和验证任务。",
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    skills: [],
    extensions: [],
    systemPrompt: "你是独立执行子代理。完成委派任务，必要时修改代码并验证，最后报告结果与关键文件。",
    builtIn: true,
    scope: "builtin",
  },
  {
    id: "explore",
    name: "代码探索",
    description: "只读检索项目并汇总结论。",
    tools: ["read", "grep", "find", "ls"],
    skills: [],
    extensions: [],
    systemPrompt: "你是只读代码探索子代理。检索相关实现，给出带文件依据的简洁结论，不修改文件。",
    builtIn: true,
    scope: "builtin",
  },
  {
    id: "plan",
    name: "方案规划",
    description: "只读分析需求、依赖和实施步骤。",
    tools: ["read", "grep", "find", "ls"],
    skills: [],
    extensions: [],
    systemPrompt: "你是规划子代理。分析需求和现有代码，给出可执行的实施方案、风险与验证步骤，不修改文件。",
    builtIn: true,
    scope: "builtin",
  },
];

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL_PATTERN = /^(?:[+-])?[A-Za-z0-9_][A-Za-z0-9_.:*+-]{0,127}$/;

interface StoredSubagentSettings {
  builtInEnabled?: boolean;
  maxConcurrent?: number;
  disabledBuiltIns?: string[];
  [key: string]: unknown;
}

function packageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function packageDisabled(entry: PackageSource): boolean {
  return typeof entry === "object"
    && Array.isArray(entry.extensions) && entry.extensions.length === 0
    && Array.isArray(entry.skills) && entry.skills.length === 0
    && Array.isArray(entry.prompts) && entry.prompts.length === 0
    && Array.isArray(entry.themes) && entry.themes.length === 0;
}

function frontmatterValue(source: string, key: string): unknown {
  const match = source.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, "m"));
  if (!match) return undefined;
  const value = match[1].trim();
  try { return JSON.parse(value); }
  catch { return value.replace(/^['"]|['"]$/g, ""); }
}

function stringList(value: unknown, predicate: (value: string) => boolean = () => true): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      : [];
  return [...new Set(values.filter((item): item is string => typeof item === "string" && predicate(item)))];
}

function pathWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function parseCustomProfile(content: string, filePath: string, scope: "global" | "project"): Omit<SubagentProfileInfo, "enabled"> | null {
  const block = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!block) return null;
  const id = String(frontmatterValue(block[1], "name") ?? basename(filePath, ".md")).trim();
  if (!PROFILE_ID.test(id)) return null;
  const rawTools = frontmatterValue(block[1], "tools");
  const tools = rawTools === undefined ? ["read", "grep", "find", "ls"] : stringList(rawTools, (tool) => TOOL_PATTERN.test(tool));
  return {
    id,
    name: String(frontmatterValue(block[1], "display_name") ?? id),
    description: String(frontmatterValue(block[1], "description") ?? id),
    tools: [...new Set(tools)],
    skills: stringList(frontmatterValue(block[1], "skills"), (skill) => skill === "*" || SKILL_NAME.test(skill)),
    extensions: stringList(frontmatterValue(block[1], "extensions"), (extension) => extension.length > 0 && extension.length <= 500),
    systemPrompt: block[2].trim(),
    builtIn: false,
    scope,
    filePath,
    permissions: parsePermissions(frontmatterValue(block[1], "permissions")),
  };
}

function textFromAssistantMessages(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown; errorMessage?: unknown };
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "")
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
    if (typeof message.errorMessage === "string") return message.errorMessage;
  }
  return "子代理已结束，但没有返回文本。";
}

function parseMcpConfig(content: string): { parsed: Record<string, unknown>; servers: Record<string, unknown> } {
  if (!content.trim()) throw new Error("mcp.json 不能为空");
  if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) throw new Error("mcp.json 不能超过 2 MB");
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch (error) { throw new Error(`mcp.json 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("mcp.json 顶层必须是对象");
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("mcp.json 必须包含 mcpServers 对象");
  }
  for (const [name, value] of Object.entries(servers)) {
    if (!name.trim()) throw new Error("MCP Server 名称不能为空");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`MCP Server ${name} 的配置必须是对象`);
    const item = value as { command?: unknown; url?: unknown; type?: unknown };
    if (typeof item.command !== "string" && typeof item.url !== "string" && typeof item.type !== "string") {
      throw new Error(`MCP Server ${name} 必须包含 command、url 或 type`);
    }
  }
  return { parsed: parsed as Record<string, unknown>, servers: servers as Record<string, unknown> };
}

export class FeatureManager {
  private readonly packageManager: DefaultPackageManager;
  private readonly subagentScheduler = new SubagentScheduler();
  private get activeSubagents(): number { return this.subagentScheduler.active; }
  private readonly teams = new Map<string, SubagentTeam>();

  subagentRuns(sessionId: string, entries: readonly unknown[]): SubagentRun[] {
    const runs = new Map<string, SubagentRun>();
    for (const raw of entries) {
      const entry = raw as { type?: string; customType?: string; data?: SubagentRun };
      if (entry.type === "custom" && entry.customType === "collaboration-agent" && entry.data?.id) {
        // A restored transcript has no live SDK session to resume.
        runs.set(entry.data.id, { ...entry.data, closed: true, ...(entry.data.status === "running" ? { status: "error" as const, error: "子代理会话已释放，无法继续执行" } : {}) });
      }
    }
    for (const run of this.teams.get(sessionId)?.list() ?? []) runs.set(run.id, run);
    return [...runs.values()];
  }

  async drainSubagents(sessionId: string): Promise<void> { await this.teams.get(sessionId)?.drain(); }
  hasRunningSubagents(sessionId: string): boolean { return this.teams.get(sessionId)?.hasRunningDescendants() ?? false; }
  async disposeSubagents(sessionId: string): Promise<void> {
    const team = this.teams.get(sessionId);
    this.teams.delete(sessionId);
    await team?.dispose();
  }

  constructor(
    private readonly cwd: string,
    private readonly agentDir: string,
    private readonly settingsManager: SettingsManager,
    private readonly modelRuntime: ModelRuntime,
    private readonly backendDir: string,
    private readonly permissionBroker: PermissionBroker,
    private readonly primaryAgents: PrimaryAgentRegistry,
  ) {
    this.packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager,
      builtinExtensions: ["codemode", "tool-search", "mcp", "subagents"],
    });
  }

  private get subagentSettingsPath(): string {
    return join(this.projectAgentsDir, "settings.json");
  }

  private get mcpConfigPath(): string {
    return join(this.agentDir, "mcp.json");
  }

  private get globalAgentsDir(): string {
    return join(this.agentDir, "agents");
  }

  private get projectAgentsDir(): string {
    return join(this.backendDir, "subagents");
  }

  private get projectSkillsDir(): string {
    return join(this.backendDir, "skills");
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }

  private async readStoredSubagentSettings(): Promise<StoredSubagentSettings> {
    try {
      const parsed = JSON.parse(await readFile(this.subagentSettingsPath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as StoredSubagentSettings : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      if (error instanceof SyntaxError) return {};
      throw error;
    }
  }

  private async writeStoredSubagentSettings(patch: Partial<StoredSubagentSettings>): Promise<void> {
    const current = await this.readStoredSubagentSettings();
    await this.atomicWrite(this.subagentSettingsPath, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
  }

  private async readCustomProfiles(): Promise<Array<Omit<SubagentProfileInfo, "enabled">>> {
    const profiles = new Map<string, Omit<SubagentProfileInfo, "enabled">>();
    for (const [directory, scope] of [[this.globalAgentsDir, "global"], [this.projectAgentsDir, "project"]] as const) {
      let entries: Dirent<string>[];
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name.startsWith("_") || entry.name.toLowerCase() === "readme.md") continue;
        const filePath = entry.isDirectory()
          ? join(directory, entry.name, "agent.md")
          : entry.isFile() && entry.name.toLowerCase().endsWith(".md")
            ? join(directory, entry.name)
            : undefined;
        if (!filePath) continue;
        let content: string;
        try { content = await readFile(filePath, "utf8"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const profile = parseCustomProfile(content, filePath, scope);
        if (profile) profiles.set(profile.id.toLowerCase(), profile);
      }
    }
    return [...profiles.values()];
  }

  async getSubagentSettings(): Promise<SubagentSettingsInfo> {
    const stored = await this.readStoredSubagentSettings();
    const disabled = new Set(Array.isArray(stored.disabledBuiltIns) ? stored.disabledBuiltIns.filter((item): item is string => typeof item === "string") : []);
    const maxConcurrent = Number.isInteger(stored.maxConcurrent) && Number(stored.maxConcurrent) >= 1 && Number(stored.maxConcurrent) <= MAX_SUBAGENTS
      ? Number(stored.maxConcurrent)
      : 3;
    const shared = (await this.primaryAgents.list()).filter((profile) => profile.mode === "all").map((profile) => ({
      ...profile, scope: pathWithin(join(this.agentDir, "primary-agents"), profile.filePath ?? "") ? "global" as const : "project" as const,
      extensions: profile.extensions, managedByPrimary: true,
    }));
    const custom = [...new Map([...await this.readCustomProfiles(), ...shared].map((profile) => [profile.id.toLowerCase(), profile])).values()];
    const reserved = new Set(custom.map((profile) => profile.id.toLowerCase()));
    const profiles = [
      ...SUBAGENT_PROFILES.filter((profile) => !reserved.has(profile.id.toLowerCase())),
      ...custom,
    ].map((profile) => ({ ...profile, enabled: !disabled.has(profile.id) }));
    return {
      enabled: stored.builtInEnabled === true,
      maxConcurrent,
      active: this.activeSubagents,
      profiles,
    };
  }

  async setSubagentSettings(patch: { enabled?: boolean; maxConcurrent?: number }): Promise<void> {
    if (patch.enabled === undefined && patch.maxConcurrent === undefined) throw new Error("至少需要一个子代理设置");
    if (patch.maxConcurrent !== undefined && (!Number.isInteger(patch.maxConcurrent) || patch.maxConcurrent < 1 || patch.maxConcurrent > MAX_SUBAGENTS)) {
      throw new Error(`子代理并发数必须是 1 到 ${MAX_SUBAGENTS} 的整数`);
    }
    await this.writeStoredSubagentSettings({
      ...(patch.enabled === undefined ? {} : { builtInEnabled: patch.enabled }),
      ...(patch.maxConcurrent === undefined ? {} : { maxConcurrent: patch.maxConcurrent }),
    });
    if (patch.maxConcurrent !== undefined) this.subagentScheduler.setLimit(patch.maxConcurrent);
  }

  async setSubagentProfileEnabled(profileId: SubagentProfileInfo["id"], enabled: boolean): Promise<void> {
    if (!(await this.getSubagentSettings()).profiles.some((profile) => profile.id === profileId)) throw new Error("未知子代理角色");
    const stored = await this.readStoredSubagentSettings();
    const disabled = new Set(Array.isArray(stored.disabledBuiltIns) ? stored.disabledBuiltIns.filter((item): item is string => typeof item === "string") : []);
    if (enabled) disabled.delete(profileId);
    else disabled.add(profileId);
    await this.writeStoredSubagentSettings({ disabledBuiltIns: [...disabled].sort() });
  }

  async createSubagentProfile(input: {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    tools: string[];
    skills?: string[];
    extensions?: string[];
    scope: "global" | "project";
  }): Promise<void> {
    const id = input.id.trim();
    if (!PROFILE_ID.test(id)) throw new Error("子代理 ID 只能包含字母、数字、点、下划线和连字符，且不能超过 64 个字符");
    if (SUBAGENT_PROFILES.some((profile) => profile.id.toLowerCase() === id.toLowerCase())) throw new Error("不能覆盖内置子代理");
    if ((await this.readCustomProfiles()).some((profile) => profile.id.toLowerCase() === id.toLowerCase())) throw new Error("同名子代理已存在");
    const name = input.name.trim() || id;
    const description = input.description.trim() || name;
    const systemPrompt = input.systemPrompt.trim();
    if (!systemPrompt) throw new Error("子代理系统提示不能为空");
    if (name.length > 100 || description.length > 500 || systemPrompt.length > 50_000) throw new Error("子代理字段长度超出限制");
    const tools = [...new Set(input.tools.filter((tool) => TOOL_PATTERN.test(tool)))];
    const skills = [...new Set((input.skills ?? []).filter((skill) => skill === "*" || SKILL_NAME.test(skill)))];
    const extensions = [...new Set((input.extensions ?? []).filter((extension) => extension.length > 0 && extension.length <= 500))];
    const directory = input.scope === "project" ? join(this.projectAgentsDir, id) : this.globalAgentsDir;
    await mkdir(directory, { recursive: true });
    const filePath = input.scope === "project" ? join(directory, "agent.md") : join(directory, `${id}.md`);
    const body = [
      "---",
      `name: ${id}`,
      `display_name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify(description)}`,
      `tools: ${JSON.stringify(tools)}`,
      `skills: ${JSON.stringify(skills)}`,
      `extensions: ${JSON.stringify(extensions)}`,
      "enabled: true",
      "---",
      "",
      systemPrompt,
      "",
    ].join("\n");
    await writeFile(filePath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }

  async deleteSubagentProfile(profileId: string): Promise<void> {
    const profile = (await this.getSubagentSettings()).profiles.find((item) => item.id === profileId);
    if (!profile || profile.builtIn || profile.managedByPrimary || !profile.filePath) throw new Error("只能删除独立定义的自定义子代理；共享角色请在主代理目录管理");
    const allowedRoots = [resolve(this.globalAgentsDir), resolve(this.projectAgentsDir)];
    const target = resolve(await realpath(profile.filePath));
    if (!allowedRoots.some((root) => pathWithin(root, target))) throw new Error("子代理文件不在允许的目录中");
    await rm(target);
    const stored = await this.readStoredSubagentSettings();
    const disabled = new Set(Array.isArray(stored.disabledBuiltIns) ? stored.disabledBuiltIns : []);
    if (disabled.delete(profileId)) await this.writeStoredSubagentSettings({ disabledBuiltIns: [...disabled].sort() });
  }

  private profileExtensionPaths(profile: SubagentProfileInfo): string[] {
    if (!profile.filePath || profile.extensions.length === 0) return [];
    const base = resolve(dirname(profile.filePath));
    return profile.extensions.map((extension) => {
      const target = resolve(base, extension);
      const path = relative(base, target);
      if (!path || path.startsWith("..") || isAbsolute(path)) {
        throw new Error(`子代理 ${profile.id} 的扩展必须位于配置文件目录内：${extension}`);
      }
      return target;
    });
  }

  private createSubagentExtension(runtime: RoleRuntime): ExtensionFactory {
    return async (pi) => {
      await this.disposeSubagents(runtime.sessionId);
      const settings = await this.getSubagentSettings();
      if (!settings.enabled) return;
      const enabledProfiles = settings.profiles.filter((profile) => profile.enabled);
      if (!enabledProfiles.length) return;
      const profileSummary = enabledProfiles.map((profile) => `${profile.id}: ${profile.description}`).join("；");
      const persistedStatus = new Map<string, SubagentRun["status"]>();
      const team = new SubagentTeam(async (signal) => {
        const latest = await this.getSubagentSettings();
        if (!latest.enabled) throw new Error("子代理功能已关闭");
        return this.subagentScheduler.acquire(latest.maxConcurrent, signal);
      }, (run, settled) => {
        runtime.onSubagentUpdate?.(run);
        if (settled || run.status !== "running" || persistedStatus.get(run.id) !== run.status) pi.appendEntry("collaboration-agent", run);
        persistedStatus.set(run.id, run.status);
      }, (message) => {
        if (!runtime.controller.signal.aborted) pi.sendMessage({
          customType: "collaboration-result", display: true,
          content: collaborationContent(message), details: { collaboration: message },
        }, { deliverAs: "steer" });
      });
      this.teams.set(runtime.sessionId, team);
      pi.on("session_shutdown", async () => {
        if (this.teams.get(runtime.sessionId) === team) await this.disposeSubagents(runtime.sessionId);
      });
      const register = async (agentPi: ExtensionAPI, caller: string, lineage: SubagentProfileInfo[]) => {
        const callerSignal = () => caller === ROOT_AGENT ? runtime.controller.signal : AbortSignal.any([runtime.controller.signal, team.signal(caller)]);
        const result = (run: SubagentRun) => ({
          content: [{ type: "text" as const, text: JSON.stringify({ agent_id: run.id, path: run.path, parent_id: run.parentId, name: run.name, status: run.status, phase: run.phase, closed: run.closed, result: run.status === "running" ? undefined : subagentResult(run) }) }],
          details: caller === ROOT_AGENT ? { subagent: run } : {},
        });
        const currentProfile = async (id: string) => {
          const latest = await this.getSubagentSettings();
          if (!latest.enabled) throw new Error("子代理功能已关闭");
          const profile = latest.profiles.find((item) => item.id === id && item.enabled);
          if (!profile) throw new Error(`子代理角色不可用：${id}`);
          const readOnly = (candidate: SubagentProfileInfo) => candidate.extensions.length === 0 && candidate.tools.every((tool) => ["read", "grep", "find", "ls", ...COLLABORATION_TOOLS].includes(tool));
          if (runtime.profile.id === "plan" && !readOnly(profile)) {
            throw new Error("Plan 只能委派不含扩展的只读子代理，请切换到 Build 后执行修改任务");
          }
          if (lineage.some(readOnly) && !readOnly(profile)) throw new Error("只读代理只能继续委派只读角色");
          return profile;
        };
        const continueAgent = async (id: string, task: string) => {
          const target = team.resolve(id, caller);
          const run = team.list().find((item) => item.id === target);
          if (!run) throw new Error(`当前会话中不存在子代理：${id}`);
          await currentProfile(run.profile);
          return result(await team.followup(target, task, runtime.controller.signal, caller));
        };
        agentPi.registerTool(defineTool({
          name: "spawn_agent", label: "启动协作代理", exposure: "model-only", executionMode: "parallel",
          description: `后台启动子代理并立即返回 agent_id，主代理可继续工作。可用角色：${profileSummary}`,
          promptSnippet: "spawn_agent: start an independent background collaborator",
          promptGuidelines: [
            "独立任务用 spawn_agent 并行分派；明确每个子代理负责的文件和交付结果，避免同时修改同一文件。所有代理共享工作目录。",
            "用 send_message 沟通、followup_task 追加任务，wait_agents 等待结果。最终回答前汇总并验证所有子代理结果。",
            "同一子代理有依赖关系的操作按顺序调用；wait_agents 在任意一个指定代理完成时返回，继续等待时只传尚未完成的 ID。",
            "fork_context 默认关闭；需要当前对话背景时开启。子代理保留自己的上下文，不能假设它自动知道主对话。",
            `你的团队身份是 ${team.identity(caller).path}。用 list_agents 查看同伴的完整路径，用 send_message 直接沟通或向父代理报告。`,
            "子代理可继续拆分任务。等待后代时用 wait_agents，等待消息时用 wait_agent；等待期间会让出执行名额。",
            "send_message 不启动空闲代理；启动新工作用 followup_task。只能管理自己的后代，同伴之间通过消息协调。",
          ],
          parameters: Type.Object({
            profile: Type.String({ description: "子代理角色 ID" }),
            task: Type.String({ minLength: 1, maxLength: 100_000 }),
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            task_name: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", description: "父代理下唯一的路径名称，例如 tester" })),
            fork_context: Type.Optional(Type.Boolean({ description: "复制主对话的当前消息，默认 false" })),
          }),
          execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
            const profile = await currentProfile(params.profile);
            if (!ctx.model) throw new Error("当前会话尚未选择模型");
            const inherited = params.fork_context ? buildSessionContext(ctx.sessionManager.getBranch()).messages : [];
            const run = team.spawn({ profile: profile.id, name: params.name || profile.name, task: params.task }, async (signal, currentSignal, identity) => {
              const allowedSkills = new Set(profile.skills);
              const childLineage = [...lineage, profile];
              const childTools = [...new Set([...profile.tools, ...COLLABORATION_TOOLS])];
              const childLoader = new DefaultResourceLoader({
                cwd: ctx.cwd, agentDir: this.agentDir, settingsManager: this.settingsManager,
                noExtensions: true, additionalExtensionPaths: this.profileExtensionPaths(profile),
                extensionFactories: [
                  async (childPi) => register(childPi, identity.id, childLineage),
                  createPermissionExtension(runtime, this.permissionBroker, ctx.cwd, {
                    ...profile, id: `${profile.id}:${identity.id}`, name: `${identity.path} (${profile.name})`, tools: childTools, signal: currentSignal,
                    ancestors: lineage.map((parent) => ({ ...parent, tools: [...parent.tools, ...COLLABORATION_TOOLS] })),
                  }),
                ],
                additionalSkillPaths: [this.projectSkillsDir],
                skillsOverride: ({ skills, diagnostics }) => ({ skills: allowedSkills.has("*") ? skills : skills.filter((skill) => allowedSkills.has(skill.name)), diagnostics }),
                systemPrompt: `${profile.systemPrompt}\n你是主代理的协作者，与其他代理共享工作目录。你的地址是 ${identity.path}，父代理地址是 ${identity.parentPath}。你可以直接向团队同伴发消息，必要时拆分子任务，最后向父代理报告结果、验证及未解决问题。不要覆盖他人的修改。`,
              });
              await childLoader.reload();
              if (signal.aborted) throw new Error("子代理任务已取消");
              const manager = SessionManager.inMemory(ctx.cwd);
              if (inherited.length) manager.appendCustomMessageEntry("collaboration-context", `以下是启动时的主对话背景，仅作参考；以分派给你的任务为准：\n${JSON.stringify(convertMessages(inherited))}`, false);
              const { session } = await createAgentSession({
                cwd: ctx.cwd, agentDir: this.agentDir, modelRuntime: this.modelRuntime,
                settingsManager: this.settingsManager, resourceLoader: childLoader, sessionManager: manager,
                model: ctx.model!, thinkingLevel: ctx.thinkingLevel, tools: childTools,
              });
              try { await session.bindExtensions({}); return session; }
              catch (error) { session.dispose(); throw error; }
            }, runtime.controller.signal, caller, params.task_name);
            return result(run);
          },
        }));
        agentPi.registerTool(defineTool({
          name: "list_agents", label: "协作代理状态", exposure: "model-only", executionMode: "parallel",
          description: "查看当前团队所有代理的 ID、完整路径、父代理和状态，包括跨分支的同伴。",
          parameters: Type.Object({}),
          execute: async (_id, _params, _signal, _update, ctx) => ({ content: [{ type: "text", text: JSON.stringify({ self: team.identity(caller), root: ROOT_AGENT, agents: (caller === ROOT_AGENT ? this.subagentRuns(runtime.sessionId, ctx.sessionManager.getBranch()) : team.list()).map(({ messages: _messages, communications: _communications, ...run }) => run) }) }], details: {} }),
        }));
        agentPi.registerTool(defineTool({
          name: "send_message", label: "发送协作消息", exposure: "model-only", executionMode: "parallel",
          description: "向同团队代理发送消息，可用 agent_id 或完整路径（含 /root）。运行中在工具边界送达，空闲时不启动新任务；排队中的代理启动后接收。",
          parameters: Type.Object({ agent_id: Type.String(), message: Type.String({ minLength: 1, maxLength: 100_000 }) }),
          execute: async (_id, params) => {
            if (callerSignal().aborted) throw new Error("任务已取消");
            const run = await team.message(params.agent_id, params.message, caller);
            return run ? result(run) : { content: [{ type: "text", text: `消息已发送到 ${ROOT_AGENT}` }], details: {} };
          },
        }));
        for (const name of ["followup_task", ...(caller === ROOT_AGENT ? LEGACY_COLLABORATION_TOOLS : [])]) agentPi.registerTool(defineTool({
          name, label: "追加协作任务", exposure: "model-only", executionMode: "parallel",
          description: "复用同一个子代理及其历史执行任务；运行中追加到队列，已完成或中断时继续执行。已关闭的代理不可恢复。",
          parameters: Type.Object({ agent_id: Type.String(), task: Type.String({ minLength: 1, maxLength: 100_000 }) }),
          execute: async (_id, params) => continueAgent(params.agent_id, params.task),
        }));
        agentPi.registerTool(defineTool({
          name: "wait_agents", label: "等待协作结果", exposure: "model-only", executionMode: "parallel",
          description: "等待指定子代理中任意一个完成，返回全部指定代理的状态与已完成结果。timeout_ms=0 立即查看；超时不停止代理。",
          parameters: Type.Object({ agent_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }), timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })) }),
          execute: async (_id, params, signal) => {
            const state = await team.wait(params.agent_ids, params.timeout_ms ?? 30_000, signal ?? callerSignal(), caller);
            return { content: [{ type: "text", text: JSON.stringify({ timed_out: state.timedOut, agents: state.runs.map((run) => ({ agent_id: run.id, status: run.status, closed: run.closed, result: run.status === "running" ? undefined : subagentResult(run) })) }) }], details: {} };
          },
        }));
        agentPi.registerTool(defineTool({
          name: "wait_agent", label: "等待团队消息", exposure: "model-only", executionMode: "parallel",
          description: "读取自己的消息箱；没有消息时等待同伴消息或子代理结果。读取后消费消息，默认 30 秒，超时不停止工作。",
          parameters: Type.Object({ timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })) }),
          execute: async (_id, params, signal) => {
            const state = await team.waitMailbox(caller, params.timeout_ms ?? 30_000, signal ?? callerSignal());
            return { content: [{ type: "text", text: JSON.stringify(state) }], details: {} };
          },
        }));
        for (const name of ["interrupt_agent", "close_agent"]) agentPi.registerTool(defineTool({
          name, label: name === "close_agent" ? "关闭协作代理" : "中断协作任务", exposure: "model-only", executionMode: "parallel",
          description: name === "close_agent" ? "停止并释放后代代理及其子树，保留历史但不可续跑。" : "中断后代代理及其子树的当前任务，可用 followup_task 继续。",
          parameters: Type.Object({ agent_id: Type.String() }),
          execute: async (_id, params) => result(await (name === "close_agent" ? team.close(params.agent_id, caller) : team.interrupt(params.agent_id, caller))),
        }));
      };
      await register(pi, ROOT_AGENT, []);
      const completed = new Map<string, SubagentRun>();
      pi.on("tool_result", (event) => {
        const run = completed.get(event.toolCallId);
        if (!run) return;
        completed.delete(event.toolCallId);
        return { details: { profile: run.profile, sessionId: run.id, subagent: run }, isError: event.isError || run.status === "error" };
      });
      pi.registerTool(defineTool({
        name: "Agent",
        label: "子代理",
        description: `把独立任务委派给子代理。可用角色：${profileSummary}`,
        promptSnippet: "Agent: delegate an independent task to a configured subagent",
        exposure: "model-only",
        executionMode: "parallel",
        parameters: Type.Object({
          profile: Type.String({ description: "子代理角色 ID" }),
          task: Type.String({ minLength: 1, description: "完整、独立的任务说明" }),
        }),
        execute: async (toolCallId, params, signal, onUpdate, ctx) => {
          const latest = await this.getSubagentSettings();
          if (!latest.enabled) throw new Error("子代理功能已关闭");
          const profile = latest.profiles.find((item) => item.id === params.profile && item.enabled);
          if (!profile) throw new Error(`子代理角色不可用：${params.profile}`);
          if (runtime.profile.id === "plan" && (profile.extensions.length > 0 || profile.tools.some((tool) => !["read", "grep", "find", "ls"].includes(tool)))) {
            throw new Error("Plan 只能委派不含扩展的只读子代理，请切换到 Build 后执行修改任务");
          }
          if (!ctx.model) throw new Error("当前会话尚未选择模型");
          if (signal?.aborted) throw new Error("子代理任务已取消");

          const release = await this.subagentScheduler.acquire(latest.maxConcurrent, signal ?? runtime.controller.signal);
          let childSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
          let abort: (() => void) | undefined;
          let progress: ReturnType<typeof trackSubagent> | undefined;
          let failure: string | undefined;
          try {
            const allowedSkills = new Set(profile.skills);
            const childLoader = new DefaultResourceLoader({
              cwd: ctx.cwd,
              agentDir: this.agentDir,
              settingsManager: this.settingsManager,
              noExtensions: true,
              additionalExtensionPaths: this.profileExtensionPaths(profile),
              extensionFactories: [createPermissionExtension(runtime, this.permissionBroker, ctx.cwd, profile)],
              additionalSkillPaths: [this.projectSkillsDir],
              skillsOverride: (current) => ({
                skills: allowedSkills.has("*") ? current.skills : current.skills.filter((skill) => allowedSkills.has(skill.name)),
                diagnostics: current.diagnostics,
              }),
              systemPrompt: profile.systemPrompt,
            });
            await childLoader.reload();
            const manager = SessionManager.inMemory(ctx.cwd);
            const created = await createAgentSession({
              cwd: ctx.cwd,
              agentDir: this.agentDir,
              modelRuntime: this.modelRuntime,
              settingsManager: this.settingsManager,
              resourceLoader: childLoader,
              sessionManager: manager,
              model: ctx.model,
              thinkingLevel: ctx.thinkingLevel,
              tools: profile.tools,
            });
            childSession = created.session;
            await childSession.bindExtensions({});
            progress = trackSubagent(childSession, {
              id: childSession.sessionId, profile: profile.id, name: profile.name, task: params.task,
            }, (subagent) => onUpdate?.({ content: [], details: { subagent } }));
            abort = () => { void childSession?.abort(); };
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) throw new Error("子代理任务已取消");
            await childSession.prompt(params.task);
            if (signal?.aborted) throw new Error("子代理任务已取消");
            const last = [...childSession.messages].reverse().find((message) => message.role === "assistant");
            if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
              throw new Error(last.errorMessage || "子代理执行中断");
            }
            const text = textFromAssistantMessages(childSession.messages);
            const subagent = progress.finish();
            progress = undefined;
            return {
              content: [{ type: "text", text }],
              details: { profile: profile.id, sessionId: childSession.sessionId, subagent },
            };
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
            throw error;
          } finally {
            if (progress) completed.set(toolCallId, progress.finish(failure || "子代理执行中断"));
            if (abort) signal?.removeEventListener("abort", abort);
            childSession?.dispose();
            release();
          }
        },
      }));
    };
  }

  extensionFactories(runtime: RoleRuntime): InlineExtension[] {
    return [
      { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
      { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
      { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
      { name: "subagents", factory: this.createSubagentExtension(runtime), replaceable: true, builtin: true },
      createPermissionExtension(runtime, this.permissionBroker, this.cwd),
    ];
  }

  async createResourceLoader(runtime: RoleRuntime): Promise<ResourceLoader> {
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager,
      additionalSkillPaths: [this.projectSkillsDir],
      additionalExtensionPaths: runtime.profile.extensions,
      extensionFactories: this.extensionFactories(runtime),
      appendSystemPrompt: [runtime.profile.systemPrompt],
      skillsOverride: ({ skills, diagnostics }) => ({
        skills: runtime.profile.skills.includes("*") ? skills : skills.filter((skill) => runtime.profile.skills.includes(skill.name)), diagnostics,
      }),
    });
    await loader.reload();
    return loader;
  }

  private async getSkills(): Promise<SkillInfo[]> {
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager,
      additionalSkillPaths: [this.projectSkillsDir],
      noExtensions: true,
    });
    await loader.reload();
    const { skills } = loader.getSkills();
    return skills
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        scope: skill.sourceInfo.origin === "package"
          ? "package" as const
          : skill.sourceInfo.scope === "project" || pathWithin(this.projectSkillsDir, skill.filePath)
            ? "project" as const
            : "global" as const,
        modelInvocable: !skill.disableModelInvocation,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async createSkill(input: {
    name: string;
    description: string;
    instructions: string;
    scope: "global" | "project";
  }): Promise<void> {
    const name = input.name.trim();
    if (!SKILL_NAME.test(name)) throw new Error("技能名称只能使用小写字母、数字和连字符，且不能超过 64 个字符");
    if ((await this.getSkills()).some((skill) => skill.name.toLowerCase() === name.toLowerCase())) throw new Error("同名技能已存在");
    const description = input.description.trim();
    const instructions = input.instructions.trim();
    if (!description || !instructions) throw new Error("技能描述和指令不能为空");
    if (description.length > 500 || instructions.length > 100_000) throw new Error("技能内容长度超出限制");
    const parent = input.scope === "project" ? this.projectSkillsDir : join(this.agentDir, "skills");
    const directory = join(parent, name);
    await mkdir(parent, { recursive: true });
    await mkdir(directory);
    try {
      await writeFile(join(directory, "SKILL.md"), [
        "---",
        `name: ${name}`,
        `description: ${JSON.stringify(description)}`,
        "---",
        "",
        `# ${name}`,
        "",
        instructions,
        "",
      ].join("\n"), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async setSkillEnabled(filePath: string, enabled: boolean): Promise<void> {
    const skill = (await this.getSkills()).find((item) => resolve(item.filePath) === resolve(filePath));
    if (!skill) throw new Error("技能不存在或不在当前资源列表中");
    const targetPath = await realpath(skill.filePath);
    const content = await readFile(targetPath, "utf8");
    if (Buffer.byteLength(content, "utf8") > 1_000_000) throw new Error("技能文件过大");
    const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    let updated = content;
    if (frontmatter) {
      const line = /^disable-model-invocation\s*:\s*(?:true|false)\s*$/m;
      const body = line.test(frontmatter[1])
        ? frontmatter[1].replace(line, `disable-model-invocation: ${enabled ? "false" : "true"}`)
        : `disable-model-invocation: ${enabled ? "false" : "true"}\n${frontmatter[1]}`;
      updated = `${content.slice(0, frontmatter.index)}---\n${body}\n---\n${content.slice((frontmatter.index ?? 0) + frontmatter[0].length)}`;
    } else {
      updated = `---\ndisable-model-invocation: ${enabled ? "false" : "true"}\n---\n${content}`;
    }
    if (updated !== content) await this.atomicWrite(targetPath, updated);
  }

  private getPlugins(): PluginInfo[] {
    const disabled = new Map<string, boolean>();
    for (const item of this.settingsManager.getGlobalSettings().packages ?? []) {
      disabled.set(`global\0${packageSource(item)}`, packageDisabled(item));
    }
    for (const item of this.settingsManager.getProjectSettings().packages ?? []) {
      disabled.set(`project\0${packageSource(item)}`, packageDisabled(item));
    }
    return this.packageManager.listConfiguredPackages()
      .map((item) => ({
        source: item.source,
        scope: item.scope === "project" ? "project" as const : "global" as const,
        installed: !!item.installedPath,
        installedPath: item.installedPath,
        filtered: item.filtered,
        enabled: !(disabled.get(`${item.scope === "project" ? "project" : "global"}\0${item.source}`) ?? false),
      }))
      .sort((left, right) => left.source.localeCompare(right.source));
  }

  async runPluginAction(action: "install" | "remove" | "update", source: string, scope: "global" | "project" = "global"): Promise<void> {
    const cleanSource = source.trim();
    if (!cleanSource || cleanSource.length > 500) throw new Error("插件来源不能为空，且不能超过 500 个字符");
    const local = scope === "project";
    if (action === "install") await this.packageManager.installAndPersist(cleanSource, { local });
    else if (action === "remove") await this.packageManager.removeAndPersist(cleanSource, { local });
    else await this.packageManager.update(cleanSource);
    await this.settingsManager.flush();
  }

  async setPluginEnabled(source: string, scope: "global" | "project", enabled: boolean): Promise<void> {
    const cleanSource = source.trim();
    const current = scope === "project"
      ? this.settingsManager.getProjectSettings().packages ?? []
      : this.settingsManager.getGlobalSettings().packages ?? [];
    let found = false;
    const next = current.map((entry): PackageSource => {
      if (packageSource(entry) !== cleanSource) return entry;
      found = true;
      if (packageDisabled(entry) === !enabled) return entry;
      if (!enabled) {
        if (typeof entry === "object") {
          const hasFilters = [entry.extensions, entry.skills, entry.prompts, entry.themes]
            .some((value) => Array.isArray(value) && value.length > 0);
          if (hasFilters) throw new Error("带资源过滤器的插件不能直接停用，请先移除过滤配置");
        }
        return {
          ...(typeof entry === "string" ? { source: entry } : entry),
          extensions: [], skills: [], prompts: [], themes: [],
        };
      }
      if (typeof entry === "string") return entry;
      const restored = { ...entry };
      delete restored.extensions;
      delete restored.skills;
      delete restored.prompts;
      delete restored.themes;
      return Object.keys(restored).length === 1 ? restored.source : restored;
    });
    if (!found) throw new Error("插件不在当前配置中");
    if (scope === "project") this.settingsManager.setProjectPackages(next);
    else this.settingsManager.setPackages(next);
    await this.settingsManager.flush();
  }

  private async getMcpConfig(): Promise<McpConfigInfo> {
    let content = DEFAULT_MCP_CONFIG;
    try { content = await readFile(this.mcpConfigPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const { servers } = parseMcpConfig(content);
    const values = Object.values(servers) as Array<{ enabled?: unknown }>;
    return {
      path: this.mcpConfigPath,
      content,
      serverCount: values.length,
      enabledServerCount: values.filter((server) => server.enabled !== false).length,
    };
  }

  async saveMcpConfig(content: string): Promise<void> {
    parseMcpConfig(content);
    await this.atomicWrite(this.mcpConfigPath, content.endsWith("\n") ? content : `${content}\n`);
  }

  async getSettings(): Promise<FeatureSettings> {
    const [skills, subagents, mcp] = await Promise.all([
      this.getSkills(),
      this.getSubagentSettings(),
      this.getMcpConfig(),
    ]);
    return { skills, plugins: this.getPlugins(), subagents, mcp };
  }
}
