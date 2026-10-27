import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SubagentRun } from "../../../shared/types.js";
import { trackSubagent } from "./subagent-progress.js";
import { convertMessages } from "./message-converter.js";

type ChildSession = Pick<AgentSession, "messages" | "subscribe" | "prompt" | "steer" | "followUp" | "sendCustomMessage" | "abort" | "dispose">;
interface Member {
  run: SubagentRun;
  create: (signal: AbortSignal, currentSignal: () => AbortSignal) => Promise<ChildSession>;
  session?: ChildSession;
  ready?: Promise<ChildSession>;
  task?: Promise<void>;
  controller?: AbortController;
  closing?: boolean;
  stopping?: boolean;
}

export function subagentResult(run: SubagentRun): string {
  return run.error || [...run.messages].reverse().find((message) => message.role === "assistant" && message.text)?.text || "子代理没有返回文本。";
}

/** A team belongs to one root conversation; members retain their sessions between tasks. */
export class SubagentTeam {
  private readonly members = new Map<string, Member>();
  private readonly changed = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly acquire: () => Promise<() => void>,
    private readonly publish: (run: SubagentRun, settled: boolean) => void,
  ) {}

  list(): SubagentRun[] { return [...this.members.values()].map((member) => member.run); }
  private member(id: string): Member {
    const member = this.members.get(id);
    if (!member) throw new Error(`当前会话中不存在子代理：${id}`);
    return member;
  }
  private update(member: Member, run: SubagentRun, settled = false): void {
    member.run = run;
    // Reload/disposal invalidates the extension API; final transcripts were already saved.
    if (!this.disposed) this.publish(run, settled);
    for (const notify of this.changed) notify();
  }

  spawn(info: Pick<SubagentRun, "profile" | "name" | "task">, create: Member["create"], signal: AbortSignal): SubagentRun {
    if (this.disposed || signal.aborted) throw new Error("子代理任务已取消");
    if (this.members.size >= 64) throw new Error("每个会话最多创建 64 个协作子代理，请复用已有子代理");
    const member: Member = { run: { ...info, id: randomUUID(), status: "running", messages: [] }, create };
    this.members.set(member.run.id, member);
    this.start(member, info.task, signal);
    return member.run;
  }

  private start(member: Member, task: string, parentSignal: AbortSignal): void {
    if (this.disposed || member.run.closed || member.closing) throw new Error("子代理已关闭，请创建新的子代理");
    if (parentSignal.aborted) throw new Error("任务已取消");
    const controller = new AbortController();
    member.controller = controller;
    const abort = () => { controller.abort(); void member.session?.abort(); };
    parentSignal.addEventListener("abort", abort, { once: true });
    this.update(member, { ...member.run, task, status: "running", error: undefined });
    let release: (() => void) | undefined;
    const ready = member.ready = (async () => {
      release = await this.acquire();
      if (controller.signal.aborted) throw new Error("子代理任务已取消");
      return member.session ?? member.create(controller.signal, () => member.controller!.signal);
    })();
    member.task = (async () => {
      let progress: ReturnType<typeof trackSubagent> | undefined;
      let error: string | undefined;
      try {
        member.session = await ready;
        if (controller.signal.aborted) throw new Error("子代理任务已取消");
        const { id, name, profile } = member.run;
        progress = trackSubagent(member.session, { id, name, profile, task }, (run) => this.update(member, run));
        await member.session.prompt(task, { expandPromptTemplates: false });
        if (controller.signal.aborted) throw new Error("子代理任务已取消");
        const last = [...member.session.messages].reverse().find((message) => message.role === "assistant");
        if (last?.role === "assistant" && ["error", "aborted"].includes(last.stopReason)) throw new Error(last.errorMessage || "子代理执行中断");
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        parentSignal.removeEventListener("abort", abort);
        release?.();
        // finish publishes the last transcript before emitting the completion notification.
        const run = progress?.finish(error) ?? { ...member.run, status: "error" as const, error };
        member.task = undefined;
        this.update(member, run, true);
      }
    })();
  }

  async followup(id: string, task: string, signal: AbortSignal): Promise<SubagentRun> {
    const member = this.member(id);
    if (member.run.closed || member.closing || member.stopping) throw new Error("子代理已关闭或正在停止");
    if (signal.aborted) throw new Error("任务已取消");
    if (member.task) {
      // Initialization may still be reserving a slot; wait for it before queuing input.
      await this.initialized(member);
      if (signal.aborted || member.closing || member.stopping) throw new Error("任务已取消");
      if (this.running(member)) await member.session!.followUp(task);
      else this.start(member, task, signal);
    } else this.start(member, task, signal);
    return member.run;
  }

  private async initialized(member: Member): Promise<void> {
    if (member.ready) await member.ready;
    if (!member.session) throw new Error(member.run.error || "子代理尚未启动");
  }
  private running(member: Member): boolean { return !!member.task; }

  async message(id: string, text: string): Promise<SubagentRun> {
    const member = this.member(id);
    if (member.run.closed || member.closing || member.stopping) throw new Error("子代理已关闭或正在停止");
    await this.initialized(member);
    if (member.run.closed || member.closing || member.stopping) throw new Error("子代理已关闭或正在停止");
    if (member.task) await member.session!.steer(text);
    else {
      await member.session!.sendCustomMessage({ customType: "collaboration-message", content: text, display: true }, { triggerTurn: false });
      this.update(member, { ...member.run, messages: convertMessages(member.session!.messages) });
    }
    return member.run;
  }

  async close(id: string): Promise<SubagentRun> {
    const member = this.member(id);
    if (member.run.closed) return member.run;
    member.closing = true;
    await this.interrupt(id);
    member.session?.dispose();
    member.session = undefined;
    this.update(member, { ...member.run, closed: true }, true);
    return member.run;
  }

  async interrupt(id: string): Promise<SubagentRun> {
    const member = this.member(id);
    member.stopping = true;
    try {
      member.controller?.abort();
      await member.session?.abort();
      await member.task;
    } finally { member.stopping = false; }
    return member.run;
  }

  async wait(ids: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ runs: SubagentRun[]; timedOut: boolean }> {
    if (!ids.length) throw new Error("至少需要一个子代理 ID");
    const selected = [...new Set(ids)].map((id) => this.member(id));
    const done = () => selected.some((member) => !member.task);
    if (signal?.aborted) throw new Error("等待已取消");
    let timedOut = false;
    if (!done() && timeoutMs > 0) await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.changed.delete(check);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const check = () => { if (done()) finish(); };
      const abort = () => finish(new Error("等待已取消"));
      const timer = setTimeout(() => { timedOut = true; finish(); }, Math.min(60_000, timeoutMs));
      this.changed.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      check();
    });
    return { runs: selected.map((member) => member.run), timedOut: timedOut || !done() };
  }

  async drain(): Promise<void> {
    while ([...this.members.values()].some((member) => member.task)) {
      await Promise.all([...this.members.values()].map((member) => member.task));
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.members.keys()].map((id) => this.close(id)));
  }
}
