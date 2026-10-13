import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelInfo, ProviderInfo } from "../../../shared/types.js";
import type { SharedResources } from "./shared-resources.js";

export class ModelManager {
  readonly configPath: string;
  private writeBarrier: Promise<void> = Promise.resolve();

  constructor(private readonly resources: SharedResources) {
    this.configPath = join(resources.agentDir, "models.json");
  }

  getModelsInfo(): ModelInfo[] {
    return this.resources.modelRegistry.getAvailable().map((model) => ({
      id: model.id,
      provider: model.provider,
      name: model.name || model.id,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
    }));
  }

  getProvidersInfo(): ProviderInfo[] {
    const registry = this.resources.modelRegistry;
    const auth = this.resources.authStorage;
    const all = registry.getAll();
    const oauth = new Map(auth.getOAuthProviders().map((provider) => [provider.id, provider]));
    const ids = new Set([...all.map((model) => model.provider), ...oauth.keys(), ...auth.list()]);

    return [...ids].sort().map((id) => ({
      id,
      name: registry.getProviderDisplayName(id) || oauth.get(id)?.name || id,
      authenticated: auth.hasAuth(id) || registry.getProviderAuthStatus(id).configured,
      modelCount: all.filter((model) => model.provider === id).length,
      authMethods: [
        { id: "api_key", name: "API Key" },
        ...(oauth.has(id) ? [{ id: "oauth", name: "OAuth 登录" }] : []),
      ],
    }));
  }

  async readConfig(): Promise<string> {
    try {
      return await readFile(this.configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{\n  \"providers\": {}\n}\n";
      throw error;
    }
  }

  saveConfig(content: string): Promise<void> {
    const action = this.writeBarrier.then(() => this.saveConfigOnce(content));
    this.writeBarrier = action.catch(() => {});
    return action;
  }

  private async saveConfigOnce(content: string): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch (error) {
      throw new Error(`models.json 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("models.json 顶层必须是对象");
    }
    const providers = (parsed as { providers?: unknown }).providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      throw new Error("models.json 必须包含 providers 对象");
    }

    let previous: string | undefined;
    try { previous = await readFile(this.configPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

    await mkdir(this.resources.agentDir, { recursive: true });
    await this.atomicWrite(content);
    this.resources.modelRegistry.refresh();
    const validationError = this.resources.modelRegistry.getError();
    if (validationError) {
      if (previous === undefined) await rm(this.configPath, { force: true });
      else await this.atomicWrite(previous);
      this.resources.modelRegistry.refresh();
      throw new Error(`models.json 配置无效：${validationError}`);
    }
  }

  private async atomicWrite(content: string): Promise<void> {
    const temp = join(this.resources.agentDir, `.models-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.configPath);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
