import { randomUUID } from "node:crypto";
import type { ServerMessage } from "../../../shared/types.js";
import type { SharedResources } from "./shared-resources.js";

interface Challenge {
  providerId: string;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  options?: Map<string, string>;
}

/** Bridges Pi's interactive OAuth callbacks (and API key entry) to one WS client. */
export class WsAuthInteraction {
  private readonly challenges = new Map<string, Challenge>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly resources: SharedResources,
    private readonly send: (message: ServerMessage) => void,
    private readonly onChanged: () => void,
  ) {}

  async login(providerId: string, methodId?: string): Promise<void> {
    if (this.controllers.has(providerId)) throw new Error(`${providerId} 正在登录中`);
    const controller = new AbortController();
    this.controllers.set(providerId, controller);
    this.send({ type: "auth_status", providerId, status: "started" });
    try {
      const oauthProvider = this.resources.authStorage.getOAuthProviders().find((item) => item.id === providerId);
      const method = methodId || (oauthProvider ? "oauth" : "api_key");
      if (method === "api_key") {
        const key = await this.ask({
          providerId,
          prompt: `请输入 ${providerId} 的 API Key`,
          mode: "input",
          placeholder: "API Key",
        });
        if (!key.trim()) throw new Error("API Key 不能为空");
        this.resources.authStorage.set(providerId, { type: "api_key", key: key.trim() });
      } else if (method === "oauth" && oauthProvider) {
        await this.resources.authStorage.login(providerId, {
          signal: controller.signal,
          onAuth: ({ url, instructions }) => {
            this.send({ type: "auth_status", providerId, status: "started", url, message: instructions });
          },
          onPrompt: ({ message, placeholder, allowEmpty }) => this.ask({ providerId, prompt: message, mode: "input", placeholder, allowEmpty }),
          onManualCodeInput: () => this.ask({ providerId, prompt: "请输入授权码", mode: "input" }),
          onSelect: async ({ message, options }) => {
            const mapping = new Map(options.flatMap((option) => [[option.id, option.id], [option.label, option.id]]));
            const value = await this.ask({
              providerId,
              prompt: message,
              mode: "select",
              options: options.map((option) => option.label),
            }, mapping);
            return mapping.get(value);
          },
          onProgress: (message) => {
            this.send({ type: "auth_status", providerId, status: "started", message });
          },
        });
      } else {
        throw new Error(`不支持 ${providerId} 的 ${method} 登录方式`);
      }
      this.resources.modelRegistry.refresh();
      this.onChanged();
      this.send({ type: "auth_status", providerId, status: "complete" });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      this.send({
        type: "auth_status",
        providerId,
        status: cancelled ? "cancelled" : "error",
        message: cancelled ? "已取消登录" : error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.controllers.delete(providerId);
      for (const [id, challenge] of this.challenges) {
        if (challenge.providerId === providerId) this.challenges.delete(id);
      }
    }
  }

  respond(challengeId: string, value: string): void {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new Error("登录请求已过期");
    this.challenges.delete(challengeId);
    challenge.resolve(challenge.options?.get(value) ?? value);
  }

  cancel(challengeId: string): void {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return;
    this.challenges.delete(challengeId);
    this.controllers.get(challenge.providerId)?.abort();
    challenge.reject(new Error("已取消登录"));
  }

  close(): void {
    for (const controller of this.controllers.values()) controller.abort();
    for (const [id, challenge] of this.challenges) {
      this.challenges.delete(id);
      challenge.reject(new Error("连接已断开"));
    }
  }

  private ask(
    data: { providerId: string; prompt: string; mode: "input" | "select" | "confirm"; placeholder?: string; allowEmpty?: boolean; options?: string[] },
    options?: Map<string, string>,
  ): Promise<string> {
    const challengeId = randomUUID();
    return new Promise((resolve, reject) => {
      this.challenges.set(challengeId, { providerId: data.providerId, resolve, reject, options });
      this.send({ type: "auth_challenge", challengeId, ...data });
    });
  }
}
