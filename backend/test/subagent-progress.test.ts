import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentRun } from "../../shared/types.js";
import { trackSubagent } from "../src/lib/subagent-progress.js";
import { convertMessages } from "../src/lib/message-converter.js";

test("child snapshots include unfinished text, thinking, tool output and failure; completed details survive conversion", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const raw: unknown[] = [{ role: "user", content: "inspect" }];
  let receive!: (event: AgentSessionEvent) => void;
  let unsubscribed = false;
  const session = { messages: raw, subscribe(callback: typeof receive) { receive = callback; return () => { unsubscribed = true; }; } } as unknown as Pick<AgentSession, "messages" | "subscribe">;
  const updates: SubagentRun[] = [];
  const progress = trackSubagent(session, { id: "child-1", name: "Explore", profile: "explore", task: "inspect" }, run => updates.push(run));
  const message = { role: "assistant", content: [{ type: "thinking", thinking: "checking" }, { type: "text", text: "partial" }, { type: "toolCall", id: "read-1", name: "read", arguments: { path: "file" } }] };
  receive({ type: "message_update", message } as AgentSessionEvent);
  receive({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "file" } } as AgentSessionEvent);
  receive({ type: "tool_execution_update", toolCallId: "read-1", toolName: "read", partialResult: { content: [{ type: "text", text: "chunk" }] } } as AgentSessionEvent);
  assert.equal(updates.length, 1, "rapid child events are batched");
  context.mock.timers.tick(80);
  const live = updates.at(-1)!;
  assert.equal(live.messages[1].text, "partial");
  assert.equal(live.messages[1].thinking, "checking");
  assert.equal(live.messages[1].tools?.[0].output, "chunk");
  raw.push(message);
  receive({ type: "message_end", message } as AgentSessionEvent);
  const finished = progress.finish("cancelled");
  assert.equal(unsubscribed, true);
  assert.equal(finished.messages.length, 2, "finished message is not duplicated");
  assert.equal(finished.messages[1].tools?.[0].status, "error");
  assert.equal(finished.status, "error");
  context.mock.timers.tick(100);
  assert.equal(updates.at(-1)?.status, "error", "a pending timer cannot overwrite completion");
  const restored = convertMessages([
    { role: "assistant", content: [{ type: "toolCall", id: "delegate", name: "Agent", arguments: {} }] },
    { role: "toolResult", toolCallId: "delegate", content: [], details: { subagent: finished }, isError: true },
  ]);
  assert.deepEqual(restored[0].tools?.[0].subagent, finished);
});
