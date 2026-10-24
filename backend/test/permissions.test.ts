import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { PermissionBroker, createPermissionExtension, permissionEffect, type RoleRuntime } from "../src/lib/permissions.js";
import { BUILTIN_PRIMARY_AGENTS } from "../src/lib/primary-agents.js";
import type { PermissionRequest } from "../../shared/types.js";

const input = { sessionId: "root", agentId: "build:primary", agentName: "Build", toolName: "write", resource: "src/app.ts", input: { path: "src/app.ts" } };

test("approval is owned by the requesting connection, one-shot, and scoped to the exact resource", async () => {
  const broker = new PermissionBroker();
  let request!: PermissionRequest;
  broker.setNotifier((_owner, message) => { if (message.type === "permission_request") request = message.permission; });
  broker.setOwner("root", "client-a");
  const signal = new AbortController().signal;
  const first = broker.ask(input, signal);
  assert.throws(() => broker.respond("client-b", request.id, "allow_session"));
  broker.respond("client-a", request.id, "allow_session");
  assert.equal(await first, true);
  assert.throws(() => broker.respond("client-a", request.id, "allow_once"));
  assert.equal(await broker.ask(input, signal), true);
  const second = broker.ask({ ...input, resource: "src/other.ts" }, signal);
  broker.respond("client-a", request.id, "deny");
  assert.equal(await second, false);
  broker.cancelSession("root", "switch", true);
  assert.equal(await broker.ask(input, signal), false);
});

test("abort and disconnect settle pending approvals without granting access", async () => {
  const broker = new PermissionBroker();
  broker.setOwner("root", "client");
  const controller = new AbortController();
  const pending = broker.ask(input, controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(broker.list("client").length, 0);
  const next = broker.ask(input, new AbortController().signal);
  broker.closeOwner("client");
  assert.equal(await next, false);
  assert.equal(await broker.ask(input, new AbortController().signal), false);
});

test("approvals time out and allow-once never becomes a session grant", async () => {
  const broker = new PermissionBroker(20);
  broker.setOwner("root", "client");
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const first = broker.ask(input, new AbortController().signal);
    broker.respond("client", broker.list("client")[0].id, "allow_once");
    assert.equal(await first, true);
    assert.equal(await broker.ask(input, new AbortController().signal), false);
  } finally { clearTimeout(keepAlive); }
});

async function guard(runtime: RoleRuntime, cwd: string, broker: PermissionBroker, child?: Parameters<typeof createPermissionExtension>[3]) {
  let handler!: (event: ToolCallEvent, context?: unknown) => Promise<unknown>;
  await createPermissionExtension(runtime, broker, cwd, child)({ on: (_event: string, callback: typeof handler) => { handler = callback; } } as unknown as ExtensionAPI);
  return (toolName: string, input: Record<string, unknown>) => handler({ type: "tool_call", toolName, input, toolCallId: "call" } as ToolCallEvent);
}

test("Plan denies project writes including delegated calls, but asks before saving plans", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-policy-"));
  const broker = new PermissionBroker();
  broker.setOwner("root", "client");
  const runtime: RoleRuntime = { sessionId: "root", profile: BUILTIN_PRIMARY_AGENTS[1], controller: new AbortController() };
  try {
    const root = await guard(runtime, cwd, broker);
    assert.deepEqual(await root("write", { path: "app.ts", content: "bad" }), { block: true, reason: "Plan 不允许 write：app.ts" });
    const child = await guard(runtime, cwd, broker, { id: "general", name: "General", tools: ["write"], permissions: [{ action: "*", resource: "*", effect: "allow" }] });
    assert.ok((await child("write", { path: "app.ts" }) as { block: boolean }).block);
    broker.setNotifier((_owner, message) => {
      if (message.type === "permission_request") broker.respond("client", message.permission.id, "allow_once");
    });
    assert.equal(await root("write", { path: ".pi/plans/task.md" }), undefined);
    assert.ok((await root("write", { path: ".pi/plans/../../app.ts" }) as { block: boolean }).block);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Plan does not treat a junction to external files as its plan directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-plan-link-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-outside-"));
  try {
    await mkdir(join(cwd, ".pi"));
    await symlink(outside, join(cwd, ".pi/plans"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(outside, "existing.md"), "private");
    const root = await guard({ sessionId: "root", profile: BUILTIN_PRIMARY_AGENTS[1], controller: new AbortController() }, cwd, new PermissionBroker());
    assert.ok((await root("write", { path: ".pi/plans/existing.md" }) as { block: boolean }).block);
    assert.ok((await root("write", { path: ".pi/plans/new.md" }) as { block: boolean }).block);
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("external search paths require approval and a primary tool allowlist blocks hidden calls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-external-search-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-external-target-"));
  const broker = new PermissionBroker();
  broker.setOwner("root", "client");
  const requests: PermissionRequest[] = [];
  broker.setNotifier((_owner, message) => {
    if (message.type === "permission_request") {
      requests.push(message.permission);
      broker.respond("client", message.permission.id, "deny");
    }
  });
  try {
    const root = await guard({ sessionId: "root", profile: BUILTIN_PRIMARY_AGENTS[1], controller: new AbortController() }, cwd, broker);
    for (const tool of ["ls", "find", "grep"]) {
      assert.ok((await root(tool, { path: outside, pattern: "*" }) as { block: boolean }).block);
    }
    assert.equal(requests.length, 3);
    for (const path of [`@${outside}`, pathToFileURL(outside).href, "~/pi-permission-check.txt"]) {
      assert.ok((await root("read", { path }) as { block: boolean }).block);
    }
    assert.equal(requests.length, 6);
    const child = await guard({ sessionId: "root", profile: BUILTIN_PRIMARY_AGENTS[0], controller: new AbortController() }, cwd, broker, {
      id: "reader", name: "Reader", tools: ["read"],
      permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "external_directory", resource: "*", effect: "deny" }],
    });
    assert.ok((await child("read", { path: outside }) as { block: boolean }).block);
    assert.ok((await root("bash", { command: "echo forbidden" }) as { block: boolean }).block);
    assert.equal(requests.length, 6);
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("permission matching uses ordered rules and literal metacharacters", () => {
  assert.equal(permissionEffect([{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "src/[a].ts", effect: "allow" }], "read", "src/[a].ts"), "allow");
  assert.equal(permissionEffect([{ action: "read", resource: "src/[a].ts", effect: "allow" }], "read", "src/a.ts"), "ask");
});
