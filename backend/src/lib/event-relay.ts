import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentUiEvent, ChatMessage } from "../../../shared/types.js";
import { contextUsageFromSession, convertMessages, titleFromMessages } from "./message-converter.js";
import type { ActiveSession } from "./types.js";

type SendEvent = (sessionId: string, event: AgentUiEvent) => void;

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
  const message = convertMessages([raw])[0];
  if (!message || message.role === "tool") return undefined;
  const index = active.session.messages.lastIndexOf(raw as never);
  // Pi messages don't carry IDs. Index-based IDs stay stable across a reload.
  message.id = index >= 0 ? `message-${index}` : `message-live-${Date.now()}`;
  return message;
}

export function attachEventRelay(active: ActiveSession, send: SendEvent, sendSnapshot?: () => void): void {
  active.unsubscribe = active.session.subscribe((event: AgentSessionEvent) => {
    try {
      switch (event.type) {
        case "agent_start":
          send(active.id, { type: "turn_started" });
          break;
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            send(active.id, { type: "text_delta", delta: event.assistantMessageEvent.delta });
          } else if (event.assistantMessageEvent.type === "thinking_delta") {
            send(active.id, { type: "thinking_delta", delta: event.assistantMessageEvent.delta });
          }
          break;
        case "tool_execution_start":
          send(active.id, {
            type: "tool_started",
            tool: {
              id: event.toolCallId,
              name: event.toolName,
              input: event.args,
              status: "running",
            },
          });
          break;
        case "tool_execution_update":
          send(active.id, {
            type: "tool_updated",
            toolCallId: event.toolCallId,
            output: resultText(event.partialResult),
          });
          break;
        case "tool_execution_end":
          send(active.id, {
            type: "tool_finished",
            toolCallId: event.toolCallId,
            output: resultText(event.result),
            isError: event.isError,
          });
          break;
        case "message_end": {
          const message = finishedMessage(active, event.message);
          if (!message) break;
          send(active.id, { type: "message_end", message });
          if (message.role === "user" && active.summary.title === "新对话") {
            const title = titleFromMessages([message]);
            if (title !== "新对话") {
              active.summary.title = title;
              active.manager.appendSessionInfo(title);
            }
          }
          active.summary.updatedAt = new Date().toISOString();
          active.summary.messageCount = active.session.messages.length;
          send(active.id, { type: "session_updated", summary: active.summary });
          break;
        }
        case "thinking_level_changed":
          send(active.id, { type: "session_updated", thinkingLevel: active.session.thinkingLevel });
          break;
        case "compaction_end":
          // Compaction can replace/prune messages, invalidating index-based UI IDs.
          sendSnapshot?.();
          break;
        case "agent_end": {
          active.contextUsage = contextUsageFromSession(active.session);
          send(active.id, { type: "session_updated", summary: active.summary, contextUsage: active.contextUsage });
          break;
        }
      }
    } catch (error) {
      console.error("Failed to relay Pi event", error);
    }
  });
}
