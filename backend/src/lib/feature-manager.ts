import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultPackageManager,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  type ExtensionFactory,
  type InlineExtension,
  type ModelRuntime,
  type PackageSource,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  FeatureSettings,
  McpConfigInfo,
  PluginInfo,
  SkillInfo,
  SubagentProfileInfo,
  SubagentSettingsInfo,
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
  private activeSubagents = 0;

  constructor(
    private readonly cwd: string,
    private readonly agentDir: string,
    private readonly settingsManager: SettingsManager,
    private readonly modelRuntime: ModelRuntime,
    private readonly backendDir: string,
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
    const custom = await this.readCustomProfiles();
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
    if (!profile || profile.builtIn || !profile.filePath) throw new Error("只能删除自定义子代理");
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

  private createSubagentExtension(): ExtensionFactory {
    return async (pi) => {
      const settings = await this.getSubagentSettings();
      if (!settings.enabled) return;
      const enabledProfiles = settings.profiles.filter((profile) => profile.enabled);
      if (!enabledProfiles.length) return;
      const profileSummary = enabledProfiles.map((profile) => `${profile.id}: ${profile.description}`).join("；");
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
        execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
          const latest = await this.getSubagentSettings();
          if (!latest.enabled) throw new Error("子代理功能已关闭");
          const profile = latest.profiles.find((item) => item.id === params.profile && item.enabled);
          if (!profile) throw new Error(`子代理角色不可用：${params.profile}`);
          if (!ctx.model) throw new Error("当前会话尚未选择模型");
          if (this.activeSubagents >= latest.maxConcurrent) throw new Error(`子代理并发已达到上限 ${latest.maxConcurrent}`);
          if (signal?.aborted) throw new Error("子代理任务已取消");

          this.activeSubagents += 1;
          let childSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
          let abort: (() => void) | undefined;
          try {
            const allowedSkills = new Set(profile.skills);
            const childLoader = new DefaultResourceLoader({
              cwd: ctx.cwd,
              agentDir: this.agentDir,
              settingsManager: this.settingsManager,
              noExtensions: true,
              additionalExtensionPaths: this.profileExtensionPaths(profile),
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
            abort = () => { void childSession?.abort(); };
            signal?.addEventListener("abort", abort, { once: true });
            await childSession.prompt(params.task);
            const text = textFromAssistantMessages(childSession.messages);
            return {
              content: [{ type: "text", text }],
              details: { profile: profile.id, sessionId: childSession.sessionId },
            };
          } finally {
            if (abort) signal?.removeEventListener("abort", abort);
            childSession?.dispose();
            this.activeSubagents -= 1;
          }
        },
      }));
    };
  }

  extensionFactories(): InlineExtension[] {
    return [
      { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
      { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
      { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
      { name: "subagents", factory: this.createSubagentExtension(), replaceable: true, builtin: true },
    ];
  }

  async createResourceLoader(): Promise<ResourceLoader> {
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager,
      additionalSkillPaths: [this.projectSkillsDir],
      extensionFactories: this.extensionFactories(),
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
