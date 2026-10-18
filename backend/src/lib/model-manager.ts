import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DiscoveredModelInfo, ModelConnectionTestResult, ModelInfo, ProviderInfo } from "../../../shared/types.js";
import type { SharedResources } from "./shared-resources.js";

const DISCOVERY_MODEL_ID = "__pi_web_model_discovery__";
const MODEL_TEST_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = value[key];
    const number = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) return number;
  }
  return undefined;
}

function parseDiscoveredModels(payload: unknown): DiscoveredModelInfo[] {
  let items: unknown[] = [];
  if (Array.isArray(payload)) items = payload;
  else if (isRecord(payload)) {
    for (const key of ["data", "models", "results", "items"]) {
      const candidate = payload[key];
      if (Array.isArray(candidate)) { items = candidate; break; }
      if (isRecord(candidate)) { items = Object.values(candidate); break; }
    }
  }
  const seen = new Set<string>();
  const models: DiscoveredModelInfo[] = [];
  for (const item of items) {
    const record = typeof item === "string" ? { id: item } : isRecord(item) ? item : null;
    if (!record) continue;
    const rawId = cleanString(record.id) ?? cleanString(record.model) ?? cleanString(record.name);
    if (!rawId) continue;
    const id = rawId.startsWith("models/") ? rawId.slice(7) : rawId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = cleanString(record.display_name) ?? cleanString(record.displayName)
      ?? (cleanString(record.id) || cleanString(record.model) ? cleanString(record.name) : undefined);
    const reasoning = ["supports_reasoning", "supportsReasoning", "reasoning", "thinking"].some((key) => record[key] === true);
    const contextWindow = positiveInteger(record, ["context_length", "contextLength", "context_window", "contextWindow", "max_model_len", "max_input_tokens", "inputTokenLimit"]);
    const maxTokens = positiveInteger(record, ["max_output_tokens", "maxOutputTokens", "max_completion_tokens", "outputTokenLimit"]);
    models.push({ id, ...(name && name !== id ? { name } : {}), ...(reasoning ? { reasoning: true } : {}), ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}) });
  }
  return models.sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id, undefined, { numeric: true, sensitivity: "base" }));
}

function modelsListUrl(baseUrl: string, api: string): URL {
  const url = new URL(baseUrl.trim());
  const trimmed = url.pathname.replace(/\/+$/, "");
  if (!/\/models$/i.test(trimmed)) {
    let path = trimmed;
    if (api === "anthropic-messages" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1";
    if (api === "google-generative-ai" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1beta";
    url.pathname = `${path}/models`.replace(/\/+/g, "/");
  }
  if (api === "anthropic-messages") url.searchParams.set("limit", "1000");
  if (api === "google-generative-ai") url.searchParams.set("pageSize", "1000");
  return url;
}

function discoveryHeaders(api: string, apiKey: string | undefined, configured: Record<string, string>): Headers {
  const headers = new Headers(configured);
  if (!headers.has("accept")) headers.set("Accept", "application/json");
  if (!apiKey) return headers;
  if (api === "anthropic-messages") {
    if (!headers.has("x-api-key")) headers.set("x-api-key", apiKey);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (api === "google-generative-ai") {
    if (!headers.has("x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
  } else if (!headers.has("authorization")) headers.set("Authorization", `Bearer ${apiKey}`);
  return headers;
}

function assistantText(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("").slice(0, 300);
}

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
    const runtime = this.resources.modelRuntime;
    return [...runtime.getProviders()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((provider) => ({
        id: provider.id,
        name: provider.name || provider.id,
        authenticated: runtime.getProviderAuthStatus(provider.id).configured,
        modelCount: runtime.getModels(provider.id).length,
        authMethods: [
          ...(provider.auth.apiKey?.login ? [{ id: "api_key", name: provider.auth.apiKey.name || "API Key" }] : []),
          ...(provider.auth.oauth ? [{ id: "oauth", name: provider.auth.oauth.loginLabel || provider.auth.oauth.name || "OAuth 登录" }] : []),
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

  private async createDraftRuntime(providerName: string, provider: Record<string, unknown>, model: Record<string, unknown>): Promise<{ runtime: ModelRuntime; tempDir: string }> {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-gateway-model-config-"));
    const modelsPath = join(tempDir, "models.json");
    try {
      await writeFile(modelsPath, JSON.stringify({ providers: { [providerName]: { ...provider, models: [model] } } }, null, 2), "utf8");
      const runtime = await ModelRuntime.create({ authPath: join(this.resources.agentDir, "auth.json"), modelsPath });
      const error = runtime.getError();
      if (error) throw new Error(error);
      return { runtime, tempDir };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async discoverProviderModels(providerName: string, provider: Record<string, unknown>): Promise<{ models: DiscoveredModelInfo[]; endpoint: string }> {
    const cleanName = providerName.trim();
    if (!cleanName) throw new Error("Provider 名称不能为空");
    const { runtime, tempDir } = await this.createDraftRuntime(cleanName, provider, { id: DISCOVERY_MODEL_ID });
    try {
      const model = runtime.getModel(cleanName, DISCOVERY_MODEL_ID);
      if (!model) throw new Error(`无法加载 Provider：${cleanName}`);
      const resolved = await runtime.getAuth(model);
      const baseUrl = model.baseUrl?.trim() || runtime.getProvider(cleanName)?.baseUrl?.trim();
      if (!baseUrl) throw new Error("Base URL 不能为空");
      const api = model.api || runtime.getModels(cleanName)[0]?.api || "openai-completions";
      const endpoint = modelsListUrl(baseUrl, api);
      const configuredHeaders = Object.fromEntries(Object.entries(resolved?.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const response = await fetch(endpoint, {
        headers: discoveryHeaders(api, resolved?.auth.apiKey, configuredHeaders),
        signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS),
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(responseText.slice(0, 500) || `上游返回 HTTP ${response.status}`);
      let payload: unknown;
      try { payload = JSON.parse(responseText); }
      catch { throw new Error("上游模型列表不是有效 JSON"); }
      const models = parseDiscoveredModels(payload);
      if (!models.length) throw new Error("上游响应中没有发现模型");
      return { models, endpoint: endpoint.toString() };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async testModelConfig(providerName: string, provider: Record<string, unknown>, modelInput: Record<string, unknown>): Promise<ModelConnectionTestResult> {
    const modelId = cleanString(modelInput.id);
    if (!providerName.trim()) throw new Error("Provider 名称不能为空");
    if (!modelId) throw new Error("模型 ID 不能为空");
    const { runtime, tempDir } = await this.createDraftRuntime(providerName, provider, { ...modelInput, id: modelId });
    try {
      const model = runtime.getModel(providerName, modelId);
      if (!model) throw new Error(`模型不存在：${providerName}/${modelId}`);
      const resolved = await runtime.getAuth(model);
      if (!resolved?.auth.apiKey) return { ok: false, error: `Provider ${providerName} 没有可用的 API Key` };
      let status: number | undefined;
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MODEL_TEST_TIMEOUT_MS);
      try {
        const message = await completeSimple(model, {
          messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }],
        }, {
          apiKey: resolved.auth.apiKey,
          headers: resolved.auth.headers,
          maxTokens: 16,
          timeoutMs: MODEL_TEST_TIMEOUT_MS,
          maxRetries: 0,
          cacheRetention: "none",
          signal: controller.signal,
          onResponse: (response) => { status = response.status; },
        });
        const latencyMs = Date.now() - startedAt;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          return { ok: false, error: message.errorMessage ?? (controller.signal.aborted ? "连接测试超时" : "模型返回错误"), latencyMs, status };
        }
        return { ok: true, latencyMs, status, responseText: assistantText(message) };
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
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
    await this.resources.modelRegistry.refresh({ allowNetwork: false });
    const validationError = this.resources.modelRegistry.getError();
    if (validationError) {
      if (previous === undefined) await rm(this.configPath, { force: true });
      else await this.atomicWrite(previous);
      await this.resources.modelRegistry.refresh({ allowNetwork: false });
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
