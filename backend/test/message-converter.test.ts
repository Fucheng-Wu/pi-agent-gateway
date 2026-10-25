import assert from "node:assert/strict";
import test from "node:test";
import { convertMessages, titleFromMessages } from "../src/lib/message-converter.js";

test("converting only a recent turn preserves IDs from the complete history", () => {
  const messages = [
    { role: "user", content: "earlier" }, { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
    { role: "user", content: "current" }, { role: "assistant", content: [{ type: "text", text: "current answer" }] },
  ];
  assert.deepEqual(convertMessages(messages.slice(2), 2), convertMessages(messages).slice(2));
});

test("user images survive live conversion and JSON history restoration", () => {
  const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
  const raw = [{ role: "user", content: [{ type: "text", text: "Describe this" }, image, { type: "image", mimeType: "image/svg+xml", data: "invalid" }] },
    { role: "user", content: [image] }];
  const converted = convertMessages(JSON.parse(JSON.stringify(raw)));
  assert.equal(converted[0].text, "Describe this");
  assert.deepEqual(converted[0].images, [{ mimeType: image.mimeType, data: image.data }]);
  assert.equal(converted[1].text, "");
  assert.deepEqual(converted[1].images, converted[0].images);
  assert.equal(titleFromMessages([converted[1]]), "图片问答");
});

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
