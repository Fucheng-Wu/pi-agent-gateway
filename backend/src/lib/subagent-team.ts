import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CollaborationMessage, SubagentRun } from "../../../shared/types.js";
import { trackSubagent } from "./subagent-progress.js";
import { convertMessages } from "./message-converter.js";

export const ROOT_AGENT = "/root";
const MAX_MESSAGES = 200;
type ChildSession = Pick<AgentSession, "messages" | "subscribe" | "prompt" | "steer" | "followUp" | "sendCustomMessage" | "abort" | "dispose">;
interface Member {
  run: SubagentRun;
  create: (signal: AbortSignal, currentSignal: () => AbortSignal, identity: SubagentRun) => Promise<ChildSession>;
  session?: ChildSession;
  ready?: Promise<ChildSession>;
  task?: Promise<void>;
  controller?: AbortController;
  release?: () => void;
  delivered: Set<string>;
  pendingTasks: string[];
  suspensions: number;
  phase?: SubagentRun["phase"];
  closing?: boolean;
  stopping?: boolean;
}
interface Mailbox { pending: CollaborationMessage[]; dropped: number }

export function subagentResult(run: SubagentRun): string {
  return run.error || [...run.messages].reverse().find((message) => message.role === "assistant" && message.text)?.text || "子代理没有返回文本。";
}

export function collaborationContent(message: CollaborationMessage): string {
  return `[协作${message.kind === "result" ? "结果" : "消息"}] ${message.sender} → ${message.recipient}\n${message.text}`;
}

/** All descendants share this registry, budget and message routing; each keeps its own context. */
export class SubagentTeam {
  private readonly members = new Map<string, Member>();
  private readonly mailboxes = new Map<string, Mailbox>([[ROOT_AGENT, { pending: [], dropped: 0 }]]);
  private readonly changed = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly acquire: (signal: AbortSignal) => Promise<() => void>,
    private readonly publish: (run: SubagentRun, settled: boolean) => void,
    private readonly onRootMessage: (message: CollaborationMessage) => void = () => {},
  ) {}

  list(): SubagentRun[] { return [...this.members.values()].map((member) => member.run); }

  resolve(target: string, caller = ROOT_AGENT): string {
    if (target === ROOT_AGENT) return ROOT_AGENT;
    if (this.members.has(target)) return target;
    const path = target.startsWith("/") ? target : `${this.identity(caller).path}/${target}`;
    const member = [...this.members.values()].find((item) => item.run.path === path);
    if (!member) throw new Error(`当前团队中不存在代理：${target}`);
    return member.run.id;
  }

  identity(id: string): { id: string; path: string } {
    if (id === ROOT_AGENT) return { id, path: ROOT_AGENT };
    const run = this.member(id).run;
    return { id: run.id, path: run.path! };
  }

  signal(id: string): AbortSignal {
    const controller = this.member(id).controller;
    if (!controller) throw new Error("子代理尚未启动");
    return controller.signal;
  }

  private member(id: string): Member {
    const member = this.members.get(id);
    if (!member) throw new Error(`当前会话中不存在子代理：${id}`);
    return member;
  }

  private update(member: Member, run: SubagentRun, settled = false): void {
    member.run = { ...member.run, ...run, phase: member.phase, communications: member.run.communications };
    if (!this.disposed) this.publish(member.run, settled);
    this.notify();
  }
  private notify(): void { for (const notify of [...this.changed]) notify(); }
  private isDescendant(id: string, ancestor: string): boolean { return this.identity(id).path.startsWith(`${this.identity(ancestor).path}/`); }

  private manageable(target: string, caller: string): Member {
    const id = this.resolve(target, caller);
    if (id === ROOT_AGENT || !this.isDescendant(id, caller)) throw new Error("只能管理自己创建的后代代理；同伴之间请使用 send_message 沟通");
    return this.member(id);
  }

  spawn(info: Pick<SubagentRun, "profile" | "name" | "task">, create: Member["create"], signal: AbortSignal, parentId = ROOT_AGENT, taskName?: string): SubagentRun {
    if (this.disposed || signal.aborted) throw new Error("子代理任务已取消");
    if (parentId !== ROOT_AGENT) {
      const parent = this.member(parentId);
      if (!parent.task || parent.closing || parent.stopping || parent.controller?.signal.aborted) throw new Error("父代理未在执行任务");
    }
    if (this.members.size >= 64) throw new Error("每个会话最多创建 64 个协作子代理，请复用已有子代理");
    const parentPath = this.identity(parentId).path;
    const segment = taskName ?? (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(info.name) ? info.name : info.profile);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(segment)) throw new Error("task_name 必须是有效的代理路径名称");
    let path = `${parentPath}/${segment}`;
    for (let index = 2; this.list().some((run) => run.path === path); index++) {
      if (taskName) throw new Error(`代理路径已存在：${path}`);
      path = `${parentPath}/${segment}-${index}`;
    }
    const member: Member = {
      run: { ...info, id: randomUUID(), path, parentId, parentPath, status: "running", messages: [], communications: [] },
      create, suspensions: 0, delivered: new Set(), pendingTasks: [],
    };
    this.members.set(member.run.id, member);
    this.mailboxes.set(member.run.id, { pending: [], dropped: 0 });
    this.start(member, info.task, signal);
    return member.run;
  }

  private async reserve(member: Member): Promise<void> {
    member.phase = "queued"; this.update(member, member.run);
    member.release = await this.acquire(member.controller!.signal);
    if (member.controller!.signal.aborted) {
      member.release(); member.release = undefined;
      throw new Error("子代理任务已取消");
    }
    member.phase = "working"; this.update(member, member.run);
  }

  /** Waiting yields the slot, letting descendants run even with a budget of one. */
  async suspend<T>(caller: string, operation: () => Promise<T>): Promise<T> {
    if (caller === ROOT_AGENT) return operation();
    const member = this.member(caller);
    if (!member.task || member.phase === "queued") return operation();
    member.suspensions++;
    member.release?.(); member.release = undefined;
    member.phase = "waiting"; this.update(member, member.run);
    try { return await operation(); }
    finally {
      member.suspensions--;
      if (!member.suspensions && member.run.status === "running" && !member.controller!.signal.aborted && !member.closing && !member.stopping) await this.reserve(member);
    }
  }

  private start(member: Member, task: string, rootSignal: AbortSignal): void {
    if (this.disposed || member.run.closed || member.closing) throw new Error("子代理已关闭，请创建新的子代理");
    if (rootSignal.aborted) throw new Error("任务已取消");
    const controller = new AbortController();
    member.controller = controller;
    const ancestors = this.list().filter((run) => this.isDescendant(member.run.id, run.id));
    const parentSignal = AbortSignal.any([rootSignal, ...ancestors.map((run) => this.signal(run.id))]);
    const abort = () => { controller.abort(); void member.session?.abort(); };
    parentSignal.addEventListener("abort", abort, { once: true });
    if (parentSignal.aborted) controller.abort();
    this.update(member, { ...member.run, task, status: "running", error: undefined });
    const ready = member.ready = (async () => {
      await this.reserve(member);
      return member.session ?? member.create(controller.signal, () => member.controller!.signal, member.run);
    })();
    member.task = (async () => {
      let progress: ReturnType<typeof trackSubagent> | undefined;
      let error: string | undefined;
      try {
        member.session = await ready;
        if (controller.signal.aborted) throw new Error("子代理任务已取消");
        for (const message of member.run.communications ?? []) if (message.recipient === member.run.path && !member.delivered.has(message.id)) await this.deliverToSession(member, message, false);
        const { id, name, profile, path, parentId, parentPath } = member.run;
        progress = trackSubagent(member.session, { id, name, profile, task, path, parentId, parentPath }, (run) => this.update(member, run));
        await member.session.prompt(task, { expandPromptTemplates: false });
        while (member.pendingTasks.length || this.hasRunningDescendants(member.run.id)) {
          if (controller.signal.aborted) break;
          if (member.pendingTasks.length) {
            await member.session.prompt(member.pendingTasks.shift()!, { expandPromptTemplates: false });
            continue;
          }
          await this.suspend(member.run.id, () => this.drain(member.run.id));
          if (controller.signal.aborted) break;
          await member.session.sendCustomMessage({ customType: "collaboration-summary", display: false, content: "你的后代代理已完成。请读取收到的协作结果，核验后向父代理汇总。" }, { triggerTurn: true });
        }
        if (controller.signal.aborted) throw new Error("子代理任务已取消");
        const last = [...member.session.messages].reverse().find((message) => message.role === "assistant");
        if (last?.role === "assistant" && ["error", "aborted"].includes(last.stopReason)) throw new Error(last.errorMessage || "子代理执行中断");
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        controller.abort();
        await this.drain(member.run.id);
      } finally {
        parentSignal.removeEventListener("abort", abort);
        member.release?.(); member.release = undefined;
        member.pendingTasks = [];
        member.phase = undefined;
        const run = progress?.finish(error) ?? { ...member.run, status: "error" as const, error };
        this.update(member, run, true);
        try {
          if (!this.disposed && !parentSignal.aborted && !member.closing) await this.deliver(member.run.parentId!, subagentResult(member.run), member.run.id, "result");
        } finally { member.task = undefined; this.notify(); }
      }
    })();
  }

  async followup(target: string, task: string, signal: AbortSignal, caller = ROOT_AGENT): Promise<SubagentRun> {
    this.assertCaller(caller);
    const member = this.manageable(target, caller);
    if (member.run.closed || member.closing || member.stopping) throw new Error("子代理已关闭或正在停止");
    if (signal.aborted) throw new Error("任务已取消");
    if (member.task) {
      if (member.phase === "queued" || !member.session) {
        if (member.pendingTasks.length >= 32) throw new Error("子代理待执行任务过多，请等待完成后继续追加");
        member.pendingTasks.push(task);
      } else await member.session.followUp(task);
    } else this.start(member, task, signal);
    return member.run;
  }
  private assertCaller(caller: string): void {
    if (this.disposed) throw new Error("团队已关闭");
    if (caller !== ROOT_AGENT) {
      const member = this.member(caller);
      if (!member.task || member.closing || member.stopping || member.controller?.signal.aborted) throw new Error("调用代理已停止");
    }
  }

  async message(target: string, text: string, caller = ROOT_AGENT): Promise<SubagentRun | undefined> {
    this.assertCaller(caller);
    const recipient = this.resolve(target, caller);
    if (recipient === caller) throw new Error("不能给自己发送协作消息");
    await this.deliver(recipient, text, caller, "message");
    return recipient === ROOT_AGENT ? undefined : this.member(recipient).run;
  }

  private async deliverToSession(member: Member, message: CollaborationMessage, steer = true): Promise<void> {
    member.delivered.add(message.id);
    if (member.delivered.size > MAX_MESSAGES) {
      const retained = new Set(member.run.communications?.map((entry) => entry.id));
      for (const id of member.delivered) if (!retained.has(id)) member.delivered.delete(id);
    }
    await member.session!.sendCustomMessage({ customType: "collaboration-message", content: collaborationContent(message), display: true, details: { collaboration: message } }, steer ? undefined : { triggerTurn: false });
  }

  private async deliver(recipient: string, text: string, sender: string, kind: CollaborationMessage["kind"]): Promise<void> {
    if (this.disposed) throw new Error("团队已关闭");
    const member = recipient === ROOT_AGENT ? undefined : this.member(recipient);
    if (member?.run.closed || member?.closing || member?.stopping) {
      if (kind === "result") return;
      throw new Error("子代理已关闭或正在停止");
    }
    const message: CollaborationMessage = { id: randomUUID(), kind, sender: this.identity(sender).path, recipient: this.identity(recipient).path, text, createdAt: new Date().toISOString() };
    const mailbox = this.mailboxes.get(recipient)!;
    mailbox.pending.push(message);
    if (mailbox.pending.length > MAX_MESSAGES) { mailbox.pending.shift(); mailbox.dropped++; }
    for (const id of new Set([sender, recipient])) if (id !== ROOT_AGENT) {
      const participant = this.member(id);
      participant.run.communications = [...participant.run.communications ?? [], message].slice(-MAX_MESSAGES);
      this.update(participant, participant.run);
    }
    this.notify();
    if (!member) { this.onRootMessage(message); return; }
    // Mail for queued agents is flushed during initialization; sending never waits for a slot.
    if (!member.session) return;
    await this.deliverToSession(member, message);
    if (!member.task) this.update(member, { ...member.run, messages: convertMessages(member.session.messages) });
  }

  async waitMailbox(caller: string, timeoutMs: number, signal?: AbortSignal): Promise<{ messages: CollaborationMessage[]; timedOut: boolean; dropped: number }> {
    this.identity(caller);
    const mailbox = this.mailboxes.get(caller)!;
    await this.suspend(caller, () => this.waitUntil(() => mailbox.pending.length > 0, timeoutMs, signal));
    const messages = mailbox.pending.splice(0);
    const dropped = mailbox.dropped; mailbox.dropped = 0;
    return { messages, timedOut: !messages.length, dropped };
  }

  async close(target: string, caller = ROOT_AGENT): Promise<SubagentRun> {
    this.assertCaller(caller);
    const member = this.manageable(target, caller);
    if (member.run.closed) return member.run;
    member.closing = true;
    await this.interrupt(member.run.id, caller);
    for (const run of this.list().filter((run) => this.isDescendant(run.id, member.run.id))) await this.close(run.id);
    member.session?.dispose(); member.session = undefined;
    this.update(member, { ...member.run, closed: true }, true);
    return member.run;
  }

  async interrupt(target: string, caller = ROOT_AGENT): Promise<SubagentRun> {
    this.assertCaller(caller);
    const member = this.manageable(target, caller);
    member.stopping = true;
    try {
      member.controller?.abort();
      await member.session?.abort();
      await member.task;
      await this.drain(member.run.id);
    } finally { member.stopping = false; }
    return member.run;
  }

  private async waitUntil(done: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("等待已取消");
    if (done() || timeoutMs === 0) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); this.changed.delete(check); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const check = () => { if (done()) finish(); };
      const abort = () => finish(new Error("等待已取消"));
      const timer = setTimeout(() => finish(), Math.min(60_000, timeoutMs));
      this.changed.add(check); signal?.addEventListener("abort", abort, { once: true }); check();
    });
  }

  async wait(targets: string[], timeoutMs: number, signal?: AbortSignal, caller = ROOT_AGENT): Promise<{ runs: SubagentRun[]; timedOut: boolean }> {
    if (!targets.length) throw new Error("至少需要一个子代理 ID");
    const ids = [...new Set(targets.map((id) => this.resolve(id, caller)))];
    if (ids.some((id) => id === ROOT_AGENT || id === caller || this.isDescendant(caller, id))) throw new Error("不能等待自己或祖先代理完成");
    const selected = ids.map((id) => this.member(id));
    const done = () => selected.some((member) => !member.task);
    await this.suspend(caller, () => this.waitUntil(done, timeoutMs, signal));
    return { runs: selected.map((member) => member.run), timedOut: !done() };
  }

  hasRunningDescendants(caller = ROOT_AGENT): boolean { return [...this.members.values()].some((member) => member.task && this.isDescendant(member.run.id, caller)); }
  async drain(caller = ROOT_AGENT): Promise<void> {
    while (this.hasRunningDescendants(caller)) await Promise.all([...this.members.values()].filter((member) => this.isDescendant(member.run.id, caller)).map((member) => member.task));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const member of this.members.values()) member.controller?.abort();
    await Promise.all([...this.members.values()].map(async (member) => { await member.session?.abort(); await member.task; member.session?.dispose(); member.session = undefined; }));
  }
}
