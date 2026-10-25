import assert from "node:assert/strict";
import test from "node:test";
import { validateClientMessage } from "../../shared/validation.js";
import { MAX_IMAGE_BYTES, MAX_IMAGES } from "../../shared/images.js";

test("wire validation rejects malformed commands before handlers and preserves valid correlation", () => {
  for (const value of [null, [], { type: "unknown" }, { type: "init", protocolVersion: 2 }, { type: "prompt", sessionId: 1, text: "hi" }, { type: "provider_login", providerId: "test", methodId: 3 }, { type: "set_subagent_settings", maxConcurrent: Infinity }, { type: "set_subagent_settings", maxConcurrent: 0 }, { type: "create_subagent_profile", tools: [3] }, { type: "ping", requestId: "x".repeat(129) }]) {
    assert.throws(() => validateClientMessage(value));
  }
  const message = { type: "prompt", sessionId: "session", text: "Hello", requestId: "correlation" };
  assert.deepEqual(validateClientMessage(message), message);
  assert.deepEqual(validateClientMessage({ type: "auth_response", challengeId: "challenge", value: "" }), { type: "auth_response", challengeId: "challenge", value: "" });
});

test("image prompts accept image-only input and enforce format, encoding, size and count limits", () => {
  const image = { mimeType: "image/png", data: "aGVsbG8=" };
  const prompt = { type: "prompt", sessionId: "session", text: "", images: [image] };
  assert.deepEqual(validateClientMessage(prompt), prompt);
  assert.doesNotThrow(() => validateClientMessage({ ...prompt, text: "What is this?" }));
  for (const images of [null, {}, [null], [{ ...image, mimeType: "image/svg+xml" }], [{ ...image, data: "data:image/png;base64,aGVsbG8=" }],
    [{ ...image, data: "" }], [{ ...image, data: "a!??" }], [{ ...image, data: "abc" }], [{ ...image, data: "a===" }],
    [{ ...image, name: 4 }], Array(MAX_IMAGES + 1).fill(image), [{ ...image, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64") }]]) {
    assert.throws(() => validateClientMessage({ ...prompt, images }));
  }
  assert.doesNotThrow(() => validateClientMessage({ ...prompt, images: [{ ...image, data: Buffer.alloc(MAX_IMAGE_BYTES).toString("base64") }] }));
  assert.throws(() => validateClientMessage({ ...prompt, images: [] }));
  assert.throws(() => validateClientMessage({ ...prompt, text: "  ", images: undefined }));
});
