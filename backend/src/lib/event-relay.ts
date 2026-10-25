import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentUiEvent, ChatMessage } from "../../../shared/types.js";
import { contextUsageFromSession, convertMessages, subagentFromResult, titleFromMessages } from "./message-converter.js";
import type { ActiveSession } from "./types.js";

type SendEvent = (event: AgentUiEvent) => void;

/** Retain live child progress across parent message replacement and reconnects. */
export function withSubagentProgress(active: ActiveSession, messages: ChatMessage[]): ChatMessage[] {
  for (const tool of active.subagentTools?.values() ?? []) {
    const existing = messages.flatMap((message) => message.tools ?? []).find((item) => item.id === tool.id);
    if (existing) Object.assign(existing, tool);
    else {
      const assistant = [...messages].reverse().find((message) => message.role === "assistant");
      if (assistant) (assistant.tools ??= []).push({ ...tool });
    }
  }
  return messages;
}

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
  let start = index;
  while (start > 0 && active.session.messages[start].role !== "user") start--;
  // Only rebuild this turn, while preserving IDs based on positions in the full branch.
  return withSubagentProgress(active, convertMessages(active.session.messages.slice(start, index + 1), start)).at(-1);
}

export function attachEventRelay(active: ActiveSession, send: SendEvent, sendSnapshot?: () => void): void {
  active.unsubscribe = active.session.subscribe((event: AgentSessionEvent) => {
    try {
      switch (event.type) {
        case "agent_start":
          active.subagentTools = new Map();
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
          if (event.toolName === "Agent") {
            (active.subagentTools ??= new Map()).set(event.toolCallId, { id: event.toolCallId, name: event.toolName, input: event.args, status: "running" });
          }
          if (active.review && event.toolName === "bash" && typeof event.args.command === "string" && active.review.commands.length < 100) {
            active.review.commands.push({ id: event.toolCallId, command: event.args.command.slice(0, 4000), status: "running" });
          }
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
        case "tool_execution_update": {
          const subagent = subagentFromResult(event.partialResult);
          const tool = active.subagentTools?.get(event.toolCallId);
          if (tool && subagent) tool.subagent = subagent;
          send({
            type: "tool_update",
            sessionId: active.id,
            toolCallId: event.toolCallId,
            output: subagent ? undefined : resultText(event.partialResult),
            ...(subagent ? { subagent } : {}),
          });
          break;
        }
        case "tool_execution_end": {
          const subagent = subagentFromResult(event.result);
          const tool = active.subagentTools?.get(event.toolCallId);
          if (tool) {
            tool.output = resultText(event.result);
            tool.status = event.isError ? "error" : "done";
            if (subagent) tool.subagent = subagent;
          }
          const command = active.review?.commands.find((item) => item.id === event.toolCallId);
          if (command) { command.status = event.isError ? "error" : "done"; command.output = resultText(event.result).slice(-4000); }
          send({
            type: "tool_end",
            sessionId: active.id,
            toolCallId: event.toolCallId,
            output: resultText(event.result),
            isError: event.isError,
            ...(tool?.subagent ? { subagent: tool.subagent } : {}),
          });
          break;
        }
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
