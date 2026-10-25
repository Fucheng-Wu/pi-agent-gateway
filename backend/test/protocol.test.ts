import assert from "node:assert/strict";
import test from "node:test";
import { validateClientMessage } from "../../shared/validation.js";

test("wire validation rejects malformed commands before handlers and preserves valid correlation", () => {
  for (const value of [null, [], { type: "unknown" }, { type: "init", protocolVersion: 2 }, { type: "prompt", sessionId: 1, text: "hi" }, { type: "provider_login", providerId: "test", methodId: 3 }, { type: "set_subagent_settings", maxConcurrent: Infinity }, { type: "set_subagent_settings", maxConcurrent: 0 }, { type: "create_subagent_profile", tools: [3] }, { type: "ping", requestId: "x".repeat(129) }]) {
    assert.throws(() => validateClientMessage(value));
  }
  const message = { type: "prompt", sessionId: "session", text: "Hello", requestId: "correlation" };
  assert.deepEqual(validateClientMessage(message), message);
  assert.deepEqual(validateClientMessage({ type: "auth_response", challengeId: "challenge", value: "" }), { type: "auth_response", challengeId: "challenge", value: "" });
});
