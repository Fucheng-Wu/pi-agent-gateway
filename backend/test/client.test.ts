import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer, WebSocket } from "ws";
import { GatewayClient, GatewayError } from "../../client/src/index.js";

test("client correlates responses, handles rejection/timeouts and refreshes watched sessions after reconnect", { timeout: 10_000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const loads: number[] = [];
  let connectionCount = 0;
  let promptCount = 0;
  let permissionDecision: string | undefined;
  let current: WebSocket;
  server.on("connection", (socket) => {
    current = socket;
    const connection = ++connectionCount;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const respond = (payload: object) => socket.send(JSON.stringify({ ...payload, requestId: message.requestId }));
      if (message.type === "init") respond({ type: "init", protocolVersion: 1, sessions: [], models: [], providers: [], settings: {} });
      else if (message.type === "load_session") { loads.push(connection); respond({ type: "session_state", session: { summary: { id: message.sessionId }, messages: [], isStreaming: false, epoch: String(connection), sequence: 0 } }); }
      else if (message.type === "set_model") respond({ type: "error", code: "REQUEST_FAILED", message: "Model unavailable", sessionId: message.sessionId });
      else if (message.type === "prompt") { promptCount++; respond({ type: "ack", command: "prompt" }); }
      else if (message.type === "permission_response") { permissionDecision = message.decision; respond({ type: "ack", command: message.type }); }
      // list_models deliberately never responds.
    });
  });
  const client = new GatewayClient(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`, { requestTimeoutMs: 250, onPermission: () => "deny" });
  try {
    await client.connect();
    const snapshot = await client.watchSession("session");
    assert.equal(snapshot.session.summary.id, "session");
    await assert.rejects(client.request({ type: "set_model", sessionId: "session", provider: "missing", modelId: "missing" }), (error: unknown) => error instanceof GatewayError && error.code === "REQUEST_FAILED");
    await assert.rejects(client.request({ type: "list_models" }, "models"), (error: unknown) => error instanceof GatewayError && error.code === "TIMEOUT");
    await client.request({ type: "prompt", sessionId: "session", text: "hello" });
    const permissionResolved = new Promise<void>((resolve) => {
      const off = client.onMessage((message) => { if (message.type === "ack" && message.command === "permission_response") { off(); resolve(); } });
    });
    current!.send(JSON.stringify({ type: "permission_request", permission: { id: "permission", sessionId: "session" } }));
    await permissionResolved;
    assert.equal(permissionDecision, "deny");
    const reconnected = new Promise<void>((resolve) => {
      const off = client.onState((state) => { if (state === "connected" && connectionCount > 1) { off(); resolve(); } });
    });
    current!.close();
    await reconnected;
    assert.ok(loads.includes(2));
    assert.equal(promptCount, 1, "mutating commands must not replay after reconnect");
  } finally {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
