import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SubagentTeam } from "../src/lib/subagent-team.js";
import type { SubagentRun } from "../../shared/types.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function child() {
  const messages: unknown[] = [];
  let current = deferred();
  const started = deferred();
  const steering: string[] = [];
  const queued: string[] = [];
  let disposed = false;
  const subscribers = new Set<(event: AgentSessionEvent) => void>();
  const api = {
    messages,
    subscribe(callback: (event: AgentSessionEvent) => void) { subscribers.add(callback); return () => { subscribers.delete(callback); }; },
    async prompt(task: string) {
      current = deferred();
      messages.push({ role: "user", content: task });
      started.resolve();
      await current.promise;
      messages.push({ role: "assistant", content: [{ type: "text", text: `result ${task}` }], stopReason: "stop" });
    },
    async steer(text: string) { steering.push(text); },
    async followUp(text: string) { queued.push(text); },
    async sendCustomMessage(message: object) { messages.push({ role: "custom", ...message }); },
    async abort() { current.resolve(); },
    dispose() { disposed = true; },
  } as unknown as AgentSession;
  return { api, messages, started: started.promise, steering, queued, finish: () => current.resolve(), disposed: () => disposed };
}

test("background members run independently, receive messages, resume with history and close", async () => {
  const updates: SubagentRun[] = [];
  let active = 0;
  let peak = 0;
  const team = new SubagentTeam(async () => { active++; peak = Math.max(peak, active); return () => { active--; }; }, (run) => updates.push(run));
  const controller = new AbortController();
  const one = child();
  const two = child();
  let created = 0;
  const a = team.spawn({ profile: "explore", name: "one", task: "first" }, async () => { created++; return one.api; }, controller.signal);
  const b = team.spawn({ profile: "explore", name: "two", task: "second" }, async () => two.api, controller.signal);
  await Promise.all([one.started, two.started]);
  assert.equal(peak, 2);
  assert.equal((await team.wait([a.id, b.id], 0)).timedOut, true);
  await team.message(a.id, "focus on entry points");
  await team.followup(b.id, "then check tests", controller.signal);
  assert.deepEqual(one.steering, ["focus on entry points"]);
  assert.deepEqual(two.queued, ["then check tests"]);
  const waiting = team.wait([a.id, b.id], 1000);
  one.finish();
  const state = await waiting;
  assert.equal(state.timedOut, false);
  assert.deepEqual(state.runs.map((run) => run.status), ["done", "running"]);
  await team.message(a.id, "additional context");
  assert.ok(team.list()[0].messages.some((message) => message.text === "additional context"));
  const resumed = await team.followup(a.id, "third", controller.signal);
  assert.equal(resumed.id, a.id);
  assert.equal(created, 1, "resume keeps the same SDK session");
  assert.ok(one.messages.some((message: any) => message.content === "first"));
  await team.interrupt(a.id);
  assert.equal(team.list()[0].status, "error");
  assert.equal(one.disposed(), false, "interrupt preserves context");
  await team.close(a.id);
  assert.equal(one.disposed(), true);
  await assert.rejects(team.followup(a.id, "closed", controller.signal), /关闭/);
  await assert.rejects(team.wait(["other-session"], 0), /不存在/);
  controller.abort();
  await team.drain();
  assert.equal(team.list()[1].status, "error");
  assert.equal(active, 0);
  assert.ok(updates.some((run) => run.id === b.id && run.status === "running"));
  await team.dispose();
});

test("startup failure and cancellation release slots; waits time out or cancel without stopping work", async () => {
  let active = 0;
  const team = new SubagentTeam(async () => {
    if (active >= 1) throw new Error("concurrency limit");
    active++;
    return () => { active--; };
  }, () => {});
  const controller = new AbortController();
  const one = child();
  const a = team.spawn({ profile: "explore", name: "one", task: "slow" }, async () => one.api, controller.signal);
  await one.started;
  const b = team.spawn({ profile: "explore", name: "two", task: "overflow" }, async () => child().api, controller.signal);
  await team.wait([b.id], 1000);
  assert.match(team.list()[1].error!, /concurrency limit/);
  assert.equal(active, 1);
  assert.equal((await team.wait([a.id], 1)).timedOut, true);
  const waiting = new AbortController();
  const pending = team.wait([a.id], 1000, waiting.signal);
  waiting.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(team.list()[0].status, "running");
  controller.abort();
  await team.drain();
  assert.equal(active, 0);
  const boot = deferred<AgentSession>();
  const bootController = new AbortController();
  const c = team.spawn({ profile: "explore", name: "boot", task: "cancel initialization" }, async () => boot.promise, bootController.signal);
  await new Promise((done) => setImmediate(done));
  bootController.abort();
  const bootChild = child();
  boot.resolve(bootChild.api);
  await team.wait([c.id], 1000);
  assert.equal(team.list()[2].status, "error");
  assert.equal(active, 0);
  await team.dispose();
  assert.equal(bootChild.disposed(), true);
});
