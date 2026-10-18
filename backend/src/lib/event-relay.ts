import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentUiEvent, ChatMessage } from "../../../shared/types.js";
import { contextUsageFromSession, convertMessages, titleFromMessages } from "./message-converter.js";
import type { ActiveSession } from "./types.js";

type SendEvent = (event: AgentUiEvent) => void;

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const item = value as { content?: unknown; details?: unknown };
    if (Array.isArray(item.content)) {
      const text = item.content
        .map((block) => block && typeof block === "object" && "text" in block ? String(block.text ?? "") : "")
        .filter(Boolean).join("\n");
      if (text) return text;
    }
    if (item.details !== undefined) {
      try { return JSON.stringify(item.details, null, 2); } catch { /* ignored */ }
    }
  }
  return "";
}

function finishedMessage(active: ActiveSession, raw: unknown): ChatMessage | undefined {
  const index = active.session.messages.lastIndexOf(raw as never);
  const role = raw && typeof raw === "object" && "role" in raw ? raw.role : undefined;
  if (index < 0 || (role !== "user" && role !== "assistant")) return undefined;
  return convertMessages(active.session.messages.slice(0, index + 1)).at(-1);
}

export function attachEventRelay(active: ActiveSession, send: SendEvent, sendSnapshot?: () => void): void {
  active.unsubscribe = active.session.subscribe((event: AgentSessionEvent) => {
    try {
      switch (event.type) {
        case "agent_start":
          send({ type: "agent_start", sessionId: active.id });
          break;
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            send({ type: "text_delta", sessionId: active.id, delta: event.assistantMessageEvent.delta });
          } else if (event.assistantMessageEvent.type === "thinking_delta") {
            send({ type: "thinking_delta", sessionId: active.id, delta: event.assistantMessageEvent.delta });
          }
          break;
        case "tool_execution_start":
          send({
            type: "tool_start",
            sessionId: active.id,
            tool: {
              id: event.toolCallId,
              name: event.toolName,
              input: event.args,
              status: "running",
            },
          });
          break;
        case "tool_execution_update":
          send({
            type: "tool_update",
            sessionId: active.id,
            toolCallId: event.toolCallId,
            output: resultText(event.partialResult),
          });
          break;
        case "tool_execution_end":
          send({
            type: "tool_end",
            sessionId: active.id,
            toolCallId: event.toolCallId,
            output: resultText(event.result),
            isError: event.isError,
          });
          break;
        case "message_end": {
          const message = finishedMessage(active, event.message);
          if (!message) break;
          send({ type: "message_end", sessionId: active.id, message });
          if (message.role === "user" && active.summary.title === "新对话") {
            const title = titleFromMessages([message]);
            if (title !== "新对话") {
              active.summary.title = title;
              active.manager.appendSessionInfo(title);
            }
          }
          active.summary.updatedAt = new Date().toISOString();
          active.summary.messageCount = active.session.messages.length;
          send({ type: "session_updated", sessionId: active.id, summary: active.summary });
          break;
        }
        case "thinking_level_changed":
          send({ type: "session_updated", sessionId: active.id, thinkingLevel: active.session.thinkingLevel });
          break;
        case "compaction_end":
          // Compaction can replace/prune messages, invalidating index-based UI IDs.
          sendSnapshot?.();
          break;
        case "agent_end": {
          active.contextUsage = contextUsageFromSession(active.session);
          send({ type: "session_updated", sessionId: active.id, summary: active.summary, contextUsage: active.contextUsage });
          break;
        }
      }
    } catch (error) {
      console.error("Failed to relay Pi event", error);
    }
  });
}
