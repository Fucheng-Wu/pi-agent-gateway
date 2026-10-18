import assert from "node:assert/strict";
import test from "node:test";
import { convertMessages } from "../src/lib/message-converter.js";

test("combines tool calls and the final answer into one assistant turn", () => {
  const messages = convertMessages([
    { role: "user", content: "Can you search?", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I will check." },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "first" } },
        { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "second" } },
      ],
      stopReason: "toolUse",
      timestamp: 2,
    },
    { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "one" }], timestamp: 3 },
    { role: "toolResult", toolCallId: "call-2", content: [{ type: "text", text: "two" }], timestamp: 4 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Yes, I can." }],
      stopReason: "stop",
      timestamp: 5,
    },
  ]);

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], {
    id: "message-1",
    role: "assistant",
    text: "Yes, I can.",
    thinking: "I will check.",
    tools: [
      { id: "call-1", name: "bash", input: { command: "first" }, output: "one", status: "done" },
      { id: "call-2", name: "bash", input: { command: "second" }, output: "two", status: "done" },
    ],
    timestamp: new Date(2).toISOString(),
  });
});
