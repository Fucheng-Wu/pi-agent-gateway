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

test("interrupting one collaborator cancels its approval without cancelling the root, and resumed work gets a fresh signal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-child-approval-"));
  const broker = new PermissionBroker();
  broker.setOwner("root", "client");
  const runtime: RoleRuntime = { sessionId: "root", profile: BUILTIN_PRIMARY_AGENTS[0], controller: new AbortController() };
  let childController = new AbortController();
  try {
    const check = await guard(runtime, cwd, broker, {
      id: "worker", name: "Worker", tools: ["write"],
      permissions: [{ action: "*", resource: "*", effect: "ask" }], signal: () => childController.signal,
    });
    const first = check("write", { path: "one.ts" });
    while (!broker.list("client").length) await new Promise((done) => setImmediate(done));
    childController.abort();
    assert.ok((await first as { block: boolean }).block);
    assert.equal(broker.list("client").length, 0);
    assert.equal(runtime.controller.signal.aborted, false);
    childController = new AbortController();
    const next = check("write", { path: "two.ts" });
    while (!broker.list("client").length) await new Promise((done) => setImmediate(done));
    broker.respond("client", broker.list("client")[0].id, "allow_once");
    assert.equal(await next, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("grandchildren cannot widen their ancestors' tool grants or permission rules", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lineage-policy-"));
  const broker = new PermissionBroker();
  const runtime: RoleRuntime = { sessionId: "root", profile: BUILTIN_PRIMARY_AGENTS[0], controller: new AbortController() };
  try {
    const child = { id: "grandchild", name: "Grandchild", tools: ["read", "write"], permissions: [{ action: "*", resource: "*", effect: "allow" as const }] };
    const readOnlyAncestor = await guard(runtime, cwd, broker, { ...child, ancestors: [{ tools: ["read"] }] });
    assert.ok((await readOnlyAncestor("write", { path: "app.ts" }) as { block: boolean }).block);
    assert.equal(await readOnlyAncestor("read", { path: "app.ts" }), undefined);
    const deniedAncestor = await guard(runtime, cwd, broker, { ...child, ancestors: [{ tools: ["*"], permissions: [{ action: "edit", resource: "*", effect: "deny" }] }] });
    assert.ok((await deniedAncestor("write", { path: "app.ts" }) as { block: boolean }).block);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

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
  assert.equal(permissionEffect([{ action: "*", resource: "*", effect: "allow" }], "bash", "git status\ngit diff"), "allow");
});

test("Build allows routine tools but asks for sensitive reads and external directories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-build-defaults-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-build-outside-"));
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
    const root = await guard({ sessionId: "root", profile: BUILTIN_PRIMARY_AGENTS[0], controller: new AbortController() }, cwd, broker);
    for (const [tool, args] of [
      ["read", { path: "src/app.ts" }], ["write", { path: "src/app.ts" }], ["edit", { path: "src/other.ts" }],
      ["bash", { command: "pnpm test" }], ["powershell", { command: "Get-ChildItem" }],
      ["bash", { command: "git status\ngit diff" }], ["codemode", { code: "const result = await tools.read({ path: 'app.ts' });\nreturn result;" }],
      ["Agent", { profile: "general-purpose", task: "Explore" }], ["read", { path: ".env.example" }],
    ] as const) assert.equal(await root(tool, args), undefined);
    assert.equal(requests.length, 0);
    for (const path of [".env", "config/.env.local"]) assert.ok((await root("read", { path }) as { block: boolean }).block);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].action, "read");
    assert.equal(requests[0].patterns, undefined);
    assert.ok((await root("read", { path: join(outside, "file.txt") }) as { block: boolean }).block);
    assert.equal(requests.at(-1)?.action, "external_directory");
    assert.deepEqual(requests.at(-1)?.patterns, [outside.replaceAll("\\", "/"), `${outside.replaceAll("\\", "/")}/*`]);
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("session grants resolve matching queued requests and stay scoped to their agent and session", async () => {
  const broker = new PermissionBroker();
  broker.setOwner("root", "client");
  broker.setOwner("other", "client");
  const scoped = { ...input, action: "edit", patterns: ["*"] };
  const signal = new AbortController().signal;
  const first = broker.ask(scoped, signal);
  const queued = broker.ask({ ...scoped, toolName: "edit", resource: "src/other.ts" }, signal);
  const child = broker.ask({ ...scoped, agentId: "build:child" }, signal);
  const otherSession = broker.ask({ ...scoped, sessionId: "other" }, signal);
  broker.respond("client", broker.list("client")[0].id, "allow_session");
  assert.deepEqual(await Promise.all([first, queued]), [true, true]);
  assert.equal(broker.list("client").length, 2);
  assert.equal(await broker.ask({ ...scoped, toolName: "edit", resource: "new.ts" }, signal), true);
  broker.cancelSession("root");
  broker.cancelSession("other");
  assert.deepEqual(await Promise.all([child, otherSession]), [false, false]);
  // Ending a turn keeps grants; switching roles/disposal explicitly clears them.
  assert.equal(await broker.ask({ ...scoped, resource: "later.ts" }, signal), true);
  broker.cancelSession("root", "switch", true);
  broker.setOwner("root", "client");
  const afterSwitch = broker.ask(scoped, signal);
  assert.equal(broker.list("client").length, 1);
  broker.respond("client", broker.list("client")[0].id, "deny");
  assert.equal(await afterSwitch, false);
});

test("reject clears the session's pending batch without affecting other sessions", async () => {
  const broker = new PermissionBroker();
  const signal = new AbortController().signal;
  broker.setOwner("root", "client");
  broker.setOwner("other", "client");
  const first = broker.ask(input, signal);
  const second = broker.ask({ ...input, agentId: "build:child" }, signal);
  const other = broker.ask({ ...input, sessionId: "other" }, signal);
  broker.respond("client", broker.list("client")[0].id, "deny");
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.deepEqual(broker.list("client").map((item) => item.sessionId), ["other"]);
  broker.respond("client", broker.list("client")[0].id, "allow_once");
  assert.equal(await other, true);
});

test("remembered edit and directory approvals cannot bypass explicit or child deny rules", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-scoped-grants-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-scoped-external-"));
  const broker = new PermissionBroker();
  broker.setOwner("root", "client");
  const requests: PermissionRequest[] = [];
  broker.setNotifier((_owner, message) => {
    if (message.type === "permission_request") {
      requests.push(message.permission);
      broker.respond("client", message.permission.id, "allow_session");
    }
  });
  const profile = { ...BUILTIN_PRIMARY_AGENTS[0], permissions: [
    { action: "*", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "ask" },
    { action: "edit", resource: "secret.txt", effect: "deny" },
    { action: "external_directory", resource: "*", effect: "ask" },
  ] as RoleRuntime["profile"]["permissions"] };
  try {
    const runtime = { sessionId: "root", profile, controller: new AbortController() };
    const root = await guard(runtime, cwd, broker);
    assert.equal(await root("write", { path: "src/first.ts" }), undefined);
    assert.equal(await root("edit", { path: "src/second.ts" }), undefined);
    assert.equal(requests.length, 1);
    assert.ok((await root("write", { path: "secret.txt" }) as { block: boolean }).block);
    assert.equal(await root("write", { path: join(outside, "one.txt") }), undefined);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].action, "external_directory");
    assert.equal(await root("read", { path: join(outside, "nested/two.txt") }), undefined);
    assert.equal(requests.length, 2);
    assert.equal(await root("read", { path: `${outside}-sibling/three.txt` }), undefined);
    assert.equal(requests.length, 3);
    const child = await guard(runtime, cwd, broker, { id: "reader", name: "Reader", tools: ["write"], permissions: [{ action: "*", resource: "*", effect: "deny" }] });
    assert.ok((await child("write", { path: "src/third.ts" }) as { block: boolean }).block);
    assert.equal(requests.length, 3);
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("shell session grants cover simple prefixes without approving chained or substituted commands", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-shell-grants-"));
  const broker = new PermissionBroker();
  broker.setOwner("root", "client");
  const requests: PermissionRequest[] = [];
  broker.setNotifier((_owner, message) => {
    if (message.type === "permission_request") {
      requests.push(message.permission);
      broker.respond("client", message.permission.id, requests.length === 1 ? "allow_session" : "deny");
    }
  });
  const profile = { ...BUILTIN_PRIMARY_AGENTS[0], permissions: [{ action: "*", resource: "*", effect: "ask" as const }] };
  try {
    const root = await guard({ sessionId: "root", profile, controller: new AbortController() }, cwd, broker);
    assert.equal(await root("bash", { command: "git status --short" }), undefined);
    assert.deepEqual(requests[0].patterns, ["git status", "git status *"]);
    assert.equal(await root("bash", { command: "git status --porcelain" }), undefined);
    assert.equal(await root("bash", { command: "git status" }), undefined);
    assert.equal(requests.length, 1);
    for (const command of ["git push", "git status; echo unexpected", "git status --short && echo unexpected", "git status $(echo unexpected)", "git status `echo unexpected`", "git status\necho unexpected", "git status > output.txt"]) {
      assert.ok((await root("bash", { command }) as { block: boolean }).block);
    }
    assert.equal(requests.length, 8);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
