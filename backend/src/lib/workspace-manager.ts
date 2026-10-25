import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DirectoryListing, WorkspaceInfo } from "../../../shared/types.js";

export class WorkspaceManager {
  private recent: string[] = [];
  private current = "";
  constructor(private readonly agentDir: string) {}

  async open(fallback: string, explicit?: string): Promise<string> {
    try {
      const data = JSON.parse(await readFile(join(this.agentDir, "gateway.json"), "utf8"));
      if (Array.isArray(data.recent)) this.recent = data.recent.filter((path: unknown): path is string => typeof path === "string" && isAbsolute(path)).slice(0, 10);
      if (!explicit && typeof data.workspace === "string") {
        try { return this.current = await this.validate(data.workspace); } catch { /* A moved/deleted project falls back to the startup directory. */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Could not load gateway workspace preferences");
    }
    return this.current = await this.validate(explicit || fallback);
  }

  info(): WorkspaceInfo { return { path: this.current, recent: [...new Set([this.current, ...this.recent])].slice(0, 10) }; }

  async validate(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error("请选择项目的绝对路径");
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("项目路径必须是目录");
    return canonical;
  }

  async select(path: string): Promise<void> {
    const recent = [...new Set([path, this.current, ...this.recent])].filter(Boolean).slice(0, 10);
    await mkdir(this.agentDir, { recursive: true });
    const temp = join(this.agentDir, `.gateway-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify({ workspace: path, recent }, null, 2), { mode: 0o600 });
      await rename(temp, join(this.agentDir, "gateway.json"));
    } finally { await rm(temp, { force: true }); }
    this.current = path;
    this.recent = recent;
  }

  async browse(path = this.current || homedir()): Promise<DirectoryListing> {
    const canonical = await this.validate(path);
    const entries = await readdir(canonical, { withFileTypes: true });
    return {
      path: canonical, parent: dirname(canonical) === canonical ? null : dirname(canonical),
      directories: entries.filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git")
        .sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({ name: entry.name, path: join(canonical, entry.name) })),
    };
  }
}
