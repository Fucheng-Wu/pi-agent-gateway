import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSharedResources } from "../src/lib/shared-resources.js";
import { createSession, resumeSession, switchPrimaryAgent, runSessionOperation } from "../src/lib/session-factory.js";
import { PrimaryAgentRegistry } from "../src/lib/primary-agents.js";

test("custom primary agents load separately and support shared all roles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-profiles-"));
  try {
    const directory = join(root, "backend/primary-agents/reviewer");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "agent.md"), '---\nname: reviewer\nmode: all\ntools: ["read"]\nskills: []\npermissions: [{"action":"read","resource":"*","effect":"allow"}]\n---\nReview carefully.');
    const registry = new PrimaryAgentRegistry(join(root, "backend"), join(root, "global"));
    assert.deepEqual((await registry.list()).map((item) => item.id), ["build", "plan", "reviewer"]);
    assert.equal((await registry.get("reviewer")).mode, "all");
    await assert.rejects(registry.get("missing"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("switching Plan/Build keeps session identity, history and thinking, and restores the role", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-primary-session-"));
  const previousDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = join(root, "agent");
  try {
    const resources = await createSharedResources(root);
    const active = await createSession(resources);
    try {
      const sessionId = active.id;
      const model = active.session.model;
      const thinking = active.session.thinkingLevel;
      active.manager.appendMessage({ role: "user", content: "Existing question", timestamp: Date.now() });
      active.manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "Existing answer" }],
        api: "openai-responses", provider: "openai", model: "gpt-4.1", stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      await runSessionOperation(active, () => switchPrimaryAgent(resources, active, "plan"));
      assert.equal(active.id, sessionId);
      assert.equal(active.session.sessionId, sessionId);
      assert.equal(active.role.profile.id, "plan");
      assert.equal(active.session.model, model);
      assert.equal(active.session.thinkingLevel, thinking);
      assert.ok(active.session.messages.some((item) => item.role === "user"));
      assert.ok(active.session.systemPrompt.includes("Plan 模式"));
      assert.ok(!active.session.getActiveToolNames().includes("bash"));
      const reopened = await resumeSession(resources, {
        id: sessionId, path: active.manager.getSessionFile()!, name: "Existing question", created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "Existing question",
      } as Parameters<typeof resumeSession>[1]);
      assert.equal(reopened.role.profile.id, "plan");
      assert.ok(reopened.session.messages.some((item) => item.role === "assistant"));
      reopened.session.dispose();
      await runSessionOperation(active, () => switchPrimaryAgent(resources, active, "build"));
      assert.equal(active.session.sessionId, sessionId);
      assert.ok(active.session.systemPrompt.includes("只读约束已解除"));
      assert.ok(active.session.getActiveToolNames().includes("write"));
      assert.ok(active.session.messages.some((item) => item.role === "user"));
      active.operationTask = Promise.resolve();
      assert.throws(() => runSessionOperation(active, async () => {}));
      active.operationTask = undefined;
    } finally { active.session.dispose(); active.onDispose?.(); }
  } finally {
    if (previousDir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  }
});
