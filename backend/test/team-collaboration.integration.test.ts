import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeatureManager } from "../src/lib/feature-manager.js";
import { PrimaryAgentRegistry } from "../src/lib/primary-agents.js";
import { createSharedResources } from "../src/lib/shared-resources.js";
import { createSession } from "../src/lib/session-factory.js";
import { attachEventRelay } from "../src/lib/event-relay.js";
import { convertMessages } from "../src/lib/message-converter.js";
import type { ActiveSession } from "../src/lib/types.js";
import type { AgentUiEvent } from "../../shared/types.js";

test("real SDK agents discover peers, communicate directly and delegate grandchildren with a global budget of one", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-team-sdk-"));
  const agentDir = join(root, "agent");
  const backendDir = join(root, "backend");
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const requests: Array<{ actor: string; body: string }> = [];
  const mockErrors: string[] = [];
  let backendStarted!: () => void;
  const backendReady = new Promise<void>((done) => { backendStarted = done; });
  let frontendRegistered!: () => void;
  const frontendReady = new Promise<void>((done) => { frontendRegistered = done; });
  const modelServer = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const system = JSON.stringify(body.messages.filter((message: any) => message.role === "system"));
      const actor = system.match(/你的地址是 ([^，]+)/)?.[1] ?? "/root";
      requests.push({ actor, body: JSON.stringify(body) });
      if (requests.length > 50) throw new Error("Unexpected model loop");
      const calls = body.messages.flatMap((message: any) => message.tool_calls ?? []);
      const called = (name: string) => calls.some((item: any) => item.function.name === name);
      const count = (name: string) => calls.filter((item: any) => item.function.name === name).length;
      const call = (name: string, args: object) => ({ index: 0, id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } });
      let next: ReturnType<typeof call>[] | undefined;
      let answer = "Complete";
      if (actor === "/root") {
        if (!called("spawn_agent")) next = [call("spawn_agent", { profile: "explore", task_name: "backend", task: "Coordinate API and tests" })];
        else if (count("spawn_agent") === 1) {
          await backendReady;
          next = [call("spawn_agent", { profile: "explore", task_name: "frontend", task: "Coordinate the UI" })];
        } else if (!count("wait_agents")) {
          frontendRegistered();
          next = [call("wait_agents", { agent_ids: ["/root/backend"], timeout_ms: 10000 })];
        }
        else if (count("wait_agents") === 1) next = [call("wait_agents", { agent_ids: ["/root/frontend"], timeout_ms: 10000 })];
        else answer = "Backend and frontend coordinated directly; tests passed.";
      } else if (actor === "/root/backend") {
        backendStarted();
        if (!called("list_agents")) next = [call("list_agents", {})];
        else if (!count("spawn_agent")) next = [call("spawn_agent", { profile: "general-purpose", task_name: "escalation", task: "Try to escape read-only scope" })];
        else if (count("spawn_agent") === 1) next = [call("spawn_agent", { profile: "explore", task_name: "tester", task: "Check the API contract" })];
        else if (!called("send_message")) {
          await frontendReady;
          next = [call("send_message", { agent_id: "/root/frontend", message: "API contract: POST /login returns token" })];
        }
        else if (!called("wait_agents") && !JSON.stringify(body.messages).includes("你的后代代理已完成")) answer = "I delegated the tests; awaiting their result.";
        else if (!called("wait_agents")) next = [call("wait_agents", { agent_ids: ["tester"], timeout_ms: 10000 })];
        else if (!called("wait_agent")) next = [call("wait_agent", { timeout_ms: 0 })];
        else answer = "API validated with tester and frontend.";
      } else if (actor === "/root/frontend") {
        assert.ok(JSON.stringify(body.messages).includes("API contract: POST /login returns token"), "mail sent while queued is delivered before the first model request");
        if (!called("send_message")) next = [call("send_message", { agent_id: "/root/backend", message: "Frontend needs error response format" })];
        else if (!called("wait_agent")) next = [call("wait_agent", { timeout_ms: 0 })];
        else if (!called("close_agent")) next = [call("close_agent", { agent_id: "/root/backend" })];
        else answer = "UI follows the shared API contract.";
      } else if (actor === "/root/backend/tester") {
        if (!called("send_message")) next = [call("send_message", { agent_id: "/root/frontend", message: "Tester confirmed the contract" })];
        else answer = "API contract tests passed.";
      } else throw new Error(`Unexpected actor ${actor}`);
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const delta of [next ? { tool_calls: next } : { content: answer }, {}]) response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : next ? "tool_calls" : "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) {
      mockErrors.push(String(error));
      response.writeHead(500); response.end(String(error));
    }
  });
  let active: ActiveSession | undefined;
  let features: FeatureManager | undefined;
  try {
    modelServer.listen(0, "127.0.0.1"); await once(modelServer, "listening");
    const port = (modelServer.address() as { port: number }).port;
    await mkdir(agentDir);
    await mkdir(join(backendDir, "subagents"), { recursive: true });
    await writeFile(join(backendDir, "subagents/settings.json"), JSON.stringify({ builtInEnabled: true, maxConcurrent: 1 }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "team-test": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "test-only", models: [{ id: "test", contextWindow: 32000, maxTokens: 2048 }] } } }));
    process.env.PI_AGENT_DIR = agentDir;
    const resources = await createSharedResources(root);
    const primaryAgents = new PrimaryAgentRegistry(backendDir, agentDir);
    features = new FeatureManager(root, agentDir, resources.settingsManager, resources.modelRuntime, backendDir, resources.permissions, primaryAgents);
    active = await createSession({ ...resources, backendDir, features, primaryAgents });
    const events: AgentUiEvent[] = [];
    attachEventRelay(active, (event) => events.push(event));
    await active.session.setModel(resources.modelRegistry.find("team-test", "test")!);
    await active.session.prompt("Implement with peer collaboration");
    await features.drainSubagents(active.id);
    assert.deepEqual(mockErrors, []);
    const runs = features.subagentRuns(active.id, active.manager.getBranch());
    assert.deepEqual(runs.map((run) => run.path).sort(), ["/root/backend", "/root/backend/tester", "/root/frontend"]);
    assert.ok(runs.every((run) => run.status === "done"), JSON.stringify(runs.map(({ path, error }) => ({ path, error }))));
    const backend = runs.find((run) => run.path === "/root/backend")!;
    const frontend = runs.find((run) => run.path === "/root/frontend")!;
    const tester = runs.find((run) => run.path === "/root/backend/tester")!;
    assert.equal(tester.parentId, backend.id);
    assert.equal(tester.parentPath, backend.path);
    assert.ok(backend.communications?.some((message) => message.sender === frontend.path && message.recipient === backend.path));
    assert.ok(tester.communications?.some((message) => message.sender === tester.path && message.recipient === frontend.path), "a grandchild can address an agent on another branch");
    assert.ok(backend.messages.flatMap((message) => message.tools ?? []).some((tool) => tool.name === "spawn_agent" && tool.status === "error" && tool.output?.includes("只读")), "a read-only parent cannot spawn a writable role");
    assert.ok(frontend.messages.flatMap((message) => message.tools ?? []).some((tool) => tool.name === "close_agent" && tool.status === "error" && tool.output?.includes("后代")), "peers cannot close each other");
    assert.ok(requests.some((request) => request.actor === backend.path && request.body.includes("Frontend needs error response format")), "peer mail reaches the actual recipient model");
    assert.ok(requests.some((request) => request.actor === backend.path && request.body.includes("你的后代代理已完成")), "a coordinator that finishes early resumes to summarize its descendants");
    assert.ok(events.some((event) => event.type === "subagent_update" && event.subagent.path === tester.path && event.subagent.phase === "queued"));
    assert.ok(events.some((event) => event.type === "subagent_update" && event.subagent.path === backend.path && event.subagent.phase === "waiting"));
    const mainMessages = convertMessages(active.session.messages);
    assert.ok(mainMessages.some((message) => message.collaboration?.sender === backend.path && message.collaboration.recipient === "/root"));
    assert.ok(!mainMessages.some((message) => message.collaboration?.sender === tester.path), "completion goes to the immediate parent");
    assert.ok(events.some((event) => event.type === "message_end" && event.message.collaboration?.sender === backend.path), "attributed root notifications stream live");
    assert.equal((await features.getSubagentSettings()).active, 0);
    await features.disposeSubagents(active.id);
    const restored = features.subagentRuns(active.id, active.manager.getBranch());
    assert.ok(restored.every((run) => run.closed && run.path));
    assert.ok(restored.find((run) => run.id === tester.id)?.communications?.length);
  } finally {
    active?.role.controller.abort();
    await active?.session.abort();
    if (active) await features?.disposeSubagents(active.id);
    active?.unsubscribe?.(); active?.session.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previousAgentDir;
    modelServer.closeAllConnections();
    await new Promise<void>((done) => modelServer.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
