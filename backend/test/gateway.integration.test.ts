import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../../shared/types.js";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}

class Client {
  readonly messages: ServerMessage[] = [];
  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => this.messages.push(JSON.parse(data.toString())));
  }
  async wait(predicate: (message: ServerMessage) => boolean, from = 0): Promise<ServerMessage> {
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      const found = this.messages.slice(from).find(predicate);
      if (found) return found;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    throw new Error(`No matching WebSocket message; recent types: ${this.messages.slice(-15).map((item) => item.type)}`);
  }
  send(message: ClientMessage): void { this.socket.send(JSON.stringify(message)); }
  async request(message: ClientMessage, type: ServerMessage["type"]): Promise<ServerMessage> {
    const requestId = crypto.randomUUID();
    this.send({ ...message, requestId });
    const response = await this.wait((item) => item.requestId === requestId && (item.type === type || item.type === "error"));
    if (response.type === "error") throw new Error(response.message);
    return response;
  }
}

test("WebSocket roles and approvals govern real SDK tool execution, including child sessions", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gateway-e2e-"));
  const agentDir = join(root, "agent");
  await promisify(execFile)("git", ["init"], { cwd: root, windowsHide: true });
  await writeFile(join(root, ".gitignore"), "agent/\n");
  await mkdir(agentDir);
  await mkdir(join(agentDir, "primary-agents"));
  await writeFile(join(agentDir, "primary-agents/confirm.md"), '---\nname: confirm\ntools: ["*"]\npermissions: [{"action":"*","resource":"*","effect":"ask"},{"action":"Agent","resource":"*","effect":"allow"}]\n---\nAsk before modifying files.');
  let receivedImageContent: unknown;
  let modelCalls = 0;
  const modelServer = createServer(async (request, response) => {
    modelCalls++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const lastUser = [...messages].reverse().find((item) => item.role === "user");
    const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
    const afterTool = messages.at(-1)?.role === "tool";
    const imageQuestion = Array.isArray(lastUser?.content) && lastUser.content.some((part) => part.type === "image_url");
    if (imageQuestion) receivedImageContent = lastUser?.content;
    let name = "write";
    let args: Record<string, unknown> = { path: "approved.txt", content: "approved" };
    if (text.includes("plan-write")) args.path = "blocked.txt";
    if (text.includes("cancel-write")) args.path = "cancelled.txt";
    if (text.includes("child-write")) args.path = "child.txt";
    if (text.includes("confirm-write")) args.path = "confirmed.txt";
    if (text.includes("delegate-write")) { name = "Agent"; args = { profile: "general-purpose", task: "child-write" }; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = imageQuestion ? { content: "A small image." } : afterTool ? { content: "Finished." } : { tool_calls: [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
    response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: {}, finish_reason: afterTool || imageQuestion ? "stop" : "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const modelPort = await listen(modelServer);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolvePromise) => reservation.close(() => resolvePromise()));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "gateway-test": { baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", apiKey: "test-only", models: [{ id: "test", input: ["text", "image"], contextWindow: 32000, maxTokens: 1024 }, { id: "text-only", input: ["text"], contextWindow: 32000, maxTokens: 1024 }] } } }));
  const backend = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PI_AGENT_DIR: agentDir, PI_WORKSPACE_DIR: root },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  backend.stdout.on("data", (data) => { logs += data; });
  backend.stderr.on("data", (data) => { logs += data; });
  const sockets: WebSocket[] = [];
  try {
    const started = Date.now();
    while (true) {
      if (backend.exitCode !== null || Date.now() - started > 30_000) throw new Error(`Backend did not start: ${logs}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; }
      catch { /* The startup log can arrive before the socket starts accepting connections. */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    }
    async function connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      sockets.push(socket);
      const client = new Client(socket);
      await once(socket, "open");
      await client.request({ type: "init", protocolVersion: 1 }, "init");
      return client;
    }
    const client = await connect();
    const observer = await connect();
    const init = client.messages.find((item) => item.type === "init");
    assert.ok(init?.type === "init" && init.primaryAgents?.some((item) => item.id === "plan"));
    assert.ok(init?.type === "init" && init.workspace?.path === root);
    assert.ok(init.models.some((model) => model.id === "test" && model.supportsImages));
    client.socket.send(JSON.stringify({ type: "set_model", sessionId: 42, requestId: "invalid-command" }));
    const invalid = await client.wait((item) => item.type === "error" && item.requestId === "invalid-command");
    assert.ok(invalid.type === "error" && invalid.code === "BAD_REQUEST");
    const created = await client.request({ type: "create_session" }, "session_created");
    assert.equal(created.type, "session_created");
    if (created.type !== "session_created") throw new Error("No session");
    const sessionId = created.session.summary.id;
    const image = { mimeType: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVBhXY/jPwPCfARkAAB7zAf+x9MCaAAAAAElFTkSuQmCC" };
    await client.request({ type: "set_model", sessionId, provider: "gateway-test", modelId: "text-only" }, "ack");
    const callsBefore = modelCalls;
    await assert.rejects(client.request({ type: "prompt", sessionId, text: "", images: [image] }, "ack"), /不支持图片/);
    assert.equal(modelCalls, callsBefore, "unsupported images are rejected before calling the provider");
    client.send({ type: "set_model", sessionId, provider: "gateway-test", modelId: "test" });
    await client.wait((item) => item.type === "session_updated" && item.model?.id === "test");
    const imageFrom = client.messages.length;
    client.send({ type: "prompt", sessionId, text: "", images: [image] });
    await client.wait((item) => item.type === "agent_end", imageFrom);
    assert.ok(Array.isArray(receivedImageContent) && receivedImageContent.some((part) => part.type === "image_url" && part.image_url.url === `data:image/png;base64,${image.data}`), `image bytes reach the actual SDK provider request: ${JSON.stringify({ receivedImageContent, events: client.messages.slice(imageFrom) })}`);
    const imageSnapshot = await client.request({ type: "load_session", sessionId }, "session_state");
    assert.ok(imageSnapshot.type === "session_state");
    assert.deepEqual(imageSnapshot.session.messages.find((message) => message.role === "user")?.images, [image]);
    assert.ok(imageSnapshot.session.messages.some((message) => message.text === "A small image."));
    const plan = await client.request({ type: "set_primary_agent", sessionId, agentId: "plan" }, "session_state");
    assert.ok(plan.type === "session_state" && plan.session.primaryAgentId === "plan" && plan.session.model?.provider === "gateway-test");
    let from = client.messages.length;
    client.send({ type: "prompt", sessionId, text: "plan-write" });
    await client.wait((item) => item.type === "agent_end", from);
    assert.equal(client.messages.slice(from).filter((item) => item.type === "permission_request").length, 0);
    await assert.rejects(access(join(root, "blocked.txt")));
    const build = await client.request({ type: "set_primary_agent", sessionId, agentId: "build" }, "session_state");
    assert.ok(build.type === "session_state" && build.session.messages.some((item) => item.text === "plan-write"));

    from = client.messages.length;
    client.send({ type: "prompt", sessionId, text: "build-write" });
    await client.wait((item) => item.type === "agent_end", from);
    assert.equal(client.messages.slice(from).filter((item) => item.type === "permission_request").length, 0);
    assert.equal(await readFile(join(root, "approved.txt"), "utf8"), "approved");
    const review = client.messages.slice(from).find((item) => item.type === "run_review");
    assert.ok(review?.type === "run_review" && review.review.files.some((file) => file.path === "approved.txt" && file.status === "added" && file.diff?.includes("+approved")));
    const snapshot = await client.request({ type: "load_session", sessionId }, "session_state");
    assert.ok(snapshot.type === "session_state" && snapshot.session.epoch && typeof snapshot.session.sequence === "number" && snapshot.session.review?.files.length);

    from = client.messages.length;
    client.send({ type: "prompt", sessionId, text: "delegate-write" });
    await client.wait((item) => item.type === "agent_end", from);
    assert.equal(client.messages.slice(from).filter((item) => item.type === "permission_request").length, 0);
    assert.equal(await readFile(join(root, "child.txt"), "utf8"), "approved");
    const childUpdates = client.messages.slice(from).filter((item) => item.type === "tool_update" && item.subagent);
    assert.ok(childUpdates.some((item) => item.type === "tool_update" && item.subagent?.status === "running"), "child starts streaming before completion");
    const childEnd = client.messages.slice(from).find((item) => item.type === "tool_end" && item.subagent);
    assert.ok(childEnd?.type === "tool_end" && childEnd.subagent?.status === "done");
    assert.ok(childEnd.subagent.messages.some((message) => message.tools?.some((tool) => tool.name === "write" && tool.status === "done")), "child tools are visible in the transcript");
    assert.ok(childEnd.subagent.messages.some((message) => message.text === "Finished."));
    const childSnapshot = await client.request({ type: "load_session", sessionId }, "session_state");
    assert.ok(childSnapshot.type === "session_state" && childSnapshot.session.messages.some((message) => message.tools?.some((tool) => tool.subagent?.id === childEnd.subagent?.id)), "reconnect snapshots keep the child transcript");
    await rm(join(root, "child.txt"));

    await client.request({ type: "set_primary_agent", sessionId, agentId: "confirm" }, "session_state");
    from = client.messages.length;
    client.send({ type: "prompt", sessionId, text: "confirm-write" });
    const approval = await client.wait((item) => item.type === "permission_request", from);
    if (approval.type !== "permission_request") throw new Error("No approval");
    assert.equal(approval.permission.action, "edit");
    assert.deepEqual(approval.permission.patterns, ["*"]);
    await assert.rejects(access(join(root, "confirmed.txt")));
    await assert.rejects(client.request({ type: "set_workspace", path: root }, "ack"), /等待所有任务/);
    observer.send({ type: "permission_response", permissionId: approval.permission.id, decision: "allow_once" });
    await observer.wait((item) => item.type === "error");
    assert.equal(observer.messages.filter((item) => item.type === "permission_request").length, 0);
    client.send({ type: "permission_response", permissionId: approval.permission.id, decision: "allow_once" });
    await client.wait((item) => item.type === "agent_end", from);
    assert.equal(await readFile(join(root, "confirmed.txt"), "utf8"), "approved");

    from = client.messages.length;
    client.send({ type: "prompt", sessionId, text: "delegate-write" });
    const delegated = await client.wait((item) => item.type === "permission_request", from);
    assert.ok(delegated.type === "permission_request" && delegated.permission.agentId.includes("general-purpose"));
    if (delegated.type !== "permission_request") throw new Error("No child approval");
    const liveChild = await client.request({ type: "load_session", sessionId }, "session_state");
    assert.ok(liveChild.type === "session_state" && liveChild.session.messages.at(-1)?.tools?.some((tool) => tool.subagent?.status === "running"), "a snapshot during child execution retains progress");
    client.send({ type: "permission_response", permissionId: delegated.permission.id, decision: "deny" });
    await client.wait((item) => item.type === "agent_end", from);
    await assert.rejects(access(join(root, "child.txt")));

    from = client.messages.length;
    client.send({ type: "prompt", sessionId, text: "delegate-write" });
    await client.wait((item) => item.type === "permission_request", from);
    client.send({ type: "abort", sessionId });
    await client.wait((item) => item.type === "agent_end", from);
    const cancelledChild = await client.request({ type: "load_session", sessionId }, "session_state");
    assert.ok(cancelledChild.type === "session_state");
    const cancelledRun = cancelledChild.session.messages.at(-1)?.tools?.find((tool) => tool.name === "Agent")?.subagent;
    assert.equal(cancelledRun?.status, "error", "cancelling the parent settles the delegated conversation");
    assert.ok(cancelledRun.error);

    from = client.messages.length;
    client.send({ type: "prompt", sessionId, text: "cancel-write" });
    await client.wait((item) => item.type === "permission_request", from);
    client.send({ type: "abort", sessionId });
    await client.wait((item) => item.type === "permission_resolved" && item.decision === "deny", from);
    await client.wait((item) => item.type === "agent_end", from);
    await assert.rejects(access(join(root, "cancelled.txt")));

    const otherProject = join(root, "other-project");
    await mkdir(otherProject);
    const switched = await client.request({ type: "set_workspace", path: otherProject }, "ack");
    assert.equal(switched.type, "ack");
    await observer.wait((item) => item.type === "workspace" && item.workspace.path === otherProject);
    const catalog = await client.request({ type: "list_sessions" }, "sessions");
    assert.ok(catalog.type === "sessions" && !catalog.sessions.some((item) => item.id === sessionId));
    const returned = await client.request({ type: "set_workspace", path: root }, "ack");
    assert.equal(returned.type, "ack");
    const resumed = await client.request({ type: "load_session", sessionId }, "session_state");
    assert.ok(resumed.type === "session_state" && resumed.session.messages.length && resumed.session.review?.finishedAt);
    assert.deepEqual(resumed.session.messages.find((message) => message.images?.length)?.images, [image], "image bytes restore from saved Pi history after session disposal");
    assert.ok(resumed.session.messages.some((message) => message.tools?.some((tool) => tool.subagent?.status === "done")), "persisted parent history restores delegated conversations");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack : error}\nBackend logs:\n${logs}`);
  } finally {
    for (const socket of sockets) socket.terminate();
    backend.kill();
    if (backend.exitCode === null) await once(backend, "exit");
    modelServer.closeAllConnections();
    await new Promise<void>((resolvePromise) => modelServer.close(() => resolvePromise()));
    await rm(root, { recursive: true, force: true });
  }
});
