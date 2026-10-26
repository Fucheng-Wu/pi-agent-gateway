import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SubagentTeam } from "../src/lib/subagent-team.js";
import type { SubagentRun } from "../../shared/types.js";
import { SubagentScheduler } from "../src/lib/subagent-scheduler.js";

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
  assert.ok(one.messages.some((message: any) => message.details?.collaboration?.text === "focus on entry points" && message.details.collaboration.sender === "/root"));
  assert.deepEqual(two.queued, ["then check tests"]);
  const waiting = team.wait([a.id, b.id], 1000);
  one.finish();
  const state = await waiting;
  assert.equal(state.timedOut, false);
  assert.deepEqual(state.runs.map((run) => run.status), ["done", "running"]);
  await team.message(a.id, "additional context");
  assert.ok(team.list()[0].messages.some((message) => message.text.includes("additional context")));
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

test("siblings exchange attributed mail across branches, while management stays within descendants", async () => {
  const team = new SubagentTeam(async () => () => {}, () => {});
  const otherTeam = new SubagentTeam(async () => () => {}, () => {});
  const controller = new AbortController();
  const backend = child();
  const frontend = child();
  try {
    const a = team.spawn({ profile: "explore", name: "Backend", task: "api" }, async () => backend.api, controller.signal, "/root", "backend");
    const b = team.spawn({ profile: "explore", name: "Frontend", task: "ui" }, async () => frontend.api, controller.signal, "/root", "frontend");
    await Promise.all([backend.started, frontend.started]);
    const waiting = team.waitMailbox(b.id, 1000, controller.signal);
    await team.message("/root/frontend", "POST /login returns token", a.id);
    const received = await waiting;
    assert.equal(received.messages[0].sender, "/root/backend");
    assert.equal(received.messages[0].recipient, "/root/frontend");
    assert.equal(received.messages[0].text, "POST /login returns token");
    assert.equal((await team.waitMailbox(b.id, 0)).timedOut, true, "mail is consumed exactly once");
    await team.message("/root", "API is ready", a.id);
    assert.equal((await team.waitMailbox("/root", 0)).messages[0].sender, "/root/backend");
    await assert.rejects(team.interrupt(b.id, a.id), /后代/);
    await assert.rejects(team.followup(b.id, "take over", controller.signal, a.id), /后代/);
    await assert.rejects(team.wait([a.id], 0, controller.signal, a.id), /自己/);
    await assert.rejects(otherTeam.message(b.id, "outside team"), /不存在/);
    assert.throws(() => team.spawn({ profile: "explore", name: "Duplicate", task: "duplicate" }, async () => child().api, controller.signal, "/root", "frontend"), /路径已存在/);
    backend.finish(); frontend.finish();
    await team.drain();
    assert.ok((await team.waitMailbox("/root", 0)).messages.every((message) => message.kind === "result"));
    assert.equal(team.list()[0].communications?.[0].id, team.list()[1].communications?.[0].id, "both participants retain the same envelope");
  } finally { controller.abort(); await team.dispose(); await otherTeam.dispose(); }
});

test("nested waits yield their global slot and queued mail/tasks do not block a budget of one", { timeout: 2000 }, async () => {
  const scheduler = new SubagentScheduler();
  let peak = 0;
  const team = new SubagentTeam(async (signal) => {
    const release = await scheduler.acquire(1, signal);
    peak = Math.max(peak, scheduler.active);
    return release;
  }, () => {});
  const controller = new AbortController();
  let parentId = "";
  const tester = child();
  tester.api.prompt = async (task) => {
    tester.messages.push({ role: "user", content: task }, { role: "assistant", content: [{ type: "text", text: `tested ${task}` }], stopReason: "stop" });
  };
  const parent = child();
  parent.api.prompt = async () => {
    const nested = team.spawn({ profile: "explore", name: "Tester", task: "initial" }, async () => tester.api, controller.signal, parentId, "tester");
    await team.followup(nested.id, "queued follow-up", controller.signal, parentId);
    await team.message(nested.id, "queued context", parentId);
    const result = await team.wait([nested.id], 1000, team.signal(parentId), parentId);
    assert.equal(result.runs[0].status, "done");
    assert.equal(result.runs[0].path, "/root/backend/tester");
    assert.equal(result.runs[0].parentId, parentId);
    assert.ok(tester.messages.some((message: any) => message.content === "queued follow-up"));
    assert.ok(tester.messages.some((message: any) => message.details?.collaboration?.text === "queued context"));
    assert.equal((await team.waitMailbox(parentId, 0, team.signal(parentId))).messages[0].sender, "/root/backend/tester");
    parent.messages.push({ role: "assistant", content: [{ type: "text", text: "Nested work complete" }], stopReason: "stop" });
  };
  try {
    parentId = team.spawn({ profile: "explore", name: "Backend", task: "coordinate" }, async () => parent.api, controller.signal, "/root", "backend").id;
    await team.drain();
    assert.equal(team.list()[0].status, "done");
    assert.equal(peak, 1);
    assert.equal(scheduler.active, 0);
    const rootMail = await team.waitMailbox("/root", 0);
    assert.equal(rootMail.messages.length, 1, "nested results go to their direct parent");
    assert.equal(rootMail.messages[0].sender, "/root/backend");
  } finally { controller.abort(); await team.dispose(); }
});

test("interrupting a parent cancels queued descendants and removes their scheduler requests", { timeout: 2000 }, async () => {
  const scheduler = new SubagentScheduler();
  const team = new SubagentTeam((signal) => scheduler.acquire(1, signal), () => {});
  const controller = new AbortController();
  const parent = child();
  const a = team.spawn({ profile: "explore", name: "Parent", task: "coordinate" }, async () => parent.api, controller.signal);
  await parent.started;
  let initialized = false;
  const b = team.spawn({ profile: "explore", name: "Nested", task: "queued" }, async () => { initialized = true; return child().api; }, controller.signal, a.id);
  await team.interrupt(a.id);
  assert.equal(initialized, false);
  assert.equal(team.list().find((run) => run.id === b.id)?.status, "error");
  assert.equal(scheduler.active, 0);
  const release = await scheduler.acquire(1, controller.signal);
  release(); release();
  assert.equal(scheduler.active, 0, "release is idempotent");
  await team.dispose();
});
