import { randomUUID } from "node:crypto";
import type { ServerMessage } from "../../../shared/types.js";
import type { SharedResources } from "./shared-resources.js";

interface Challenge {
  providerId: string;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  options?: Map<string, string>;
  cleanup?: () => void;
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
      const provider = this.resources.modelRuntime.getProvider(providerId);
      if (!provider) throw new Error(`未知 Provider：${providerId}`);
      const method: "api_key" | "oauth" = methodId === "api_key" || methodId === "oauth"
        ? methodId
        : provider.auth.oauth ? "oauth" : "api_key";
      if ((method === "api_key" && !provider.auth.apiKey?.login) || (method === "oauth" && !provider.auth.oauth)) {
        throw new Error(`不支持 ${providerId} 的 ${method} 登录方式`);
      }

      await this.resources.modelRuntime.login(providerId, method, {
        signal: controller.signal,
        prompt: async (prompt) => {
          const signal = prompt.signal
            ? AbortSignal.any([controller.signal, prompt.signal])
            : controller.signal;
          if (prompt.type === "select") {
            const mapping = new Map<string, string>();
            for (const option of prompt.options) {
              mapping.set(option.id, option.id);
              mapping.set(option.label, option.id);
            }
            return this.ask({
              providerId,
              prompt: prompt.message,
              mode: "select",
              options: prompt.options.map((option) => option.label),
            }, mapping, signal);
          }
          return this.ask({
            providerId,
            prompt: prompt.message,
            mode: "input",
            placeholder: prompt.placeholder,
          }, undefined, signal);
        },
        notify: (event) => {
          if (event.type === "auth_url") {
            this.send({ type: "auth_status", providerId, status: "started", url: event.url, message: event.instructions });
          } else if (event.type === "device_code") {
            this.send({
              type: "auth_status",
              providerId,
              status: "started",
              url: event.verificationUri,
              message: `请打开链接并输入设备码：${event.userCode}`,
            });
          } else if (event.type === "info") {
            this.send({
              type: "auth_status",
              providerId,
              status: "started",
              url: event.links?.[0]?.url,
              message: event.message,
            });
          } else {
            this.send({ type: "auth_status", providerId, status: "started", message: event.message });
          }
        },
      });
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
        if (challenge.providerId === providerId) {
          challenge.cleanup?.();
          this.challenges.delete(id);
        }
      }
    }
  }

  get isBusy(): boolean { return this.controllers.size > 0; }

  respond(challengeId: string, value: string): void {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new Error("登录请求已过期");
    this.challenges.delete(challengeId);
    challenge.cleanup?.();
    challenge.resolve(challenge.options?.get(value) ?? value);
  }

  cancel(challengeId: string): void {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return;
    this.challenges.delete(challengeId);
    challenge.cleanup?.();
    this.controllers.get(challenge.providerId)?.abort();
    challenge.reject(new Error("已取消登录"));
  }

  close(): void {
    for (const controller of this.controllers.values()) controller.abort();
    for (const [id, challenge] of this.challenges) {
      this.challenges.delete(id);
      challenge.cleanup?.();
      challenge.reject(new Error("连接已断开"));
    }
  }

  private ask(
    data: { providerId: string; prompt: string; mode: "input" | "select" | "confirm"; placeholder?: string; allowEmpty?: boolean; options?: string[] },
    options?: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    const challengeId = randomUUID();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("已取消登录"));
        return;
      }
      const onAbort = () => {
        this.challenges.delete(challengeId);
        reject(new Error("已取消登录"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.challenges.set(challengeId, {
        providerId: data.providerId,
        resolve,
        reject,
        options,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      this.send({ type: "auth_challenge", challengeId, ...data });
    });
  }
}
