import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentRun, ToolCall } from "../../../shared/types.js";
import { convertMessages, toolOutput } from "./message-converter.js";

/** Publishes bounded-frequency snapshots, including the unfinished assistant message. */
export function trackSubagent(session: Pick<AgentSession, "messages" | "subscribe">, info: Omit<SubagentRun, "messages" | "status">, publish: (run: SubagentRun) => void) {
  let live: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tools = new Map<string, ToolCall>();
  function snapshot(status: SubagentRun["status"], error?: string): SubagentRun {
    const raw = [...session.messages];
    if (live && !raw.includes(live as never)) raw.push(live as never);
    const messages = convertMessages(raw);
    for (const message of messages) {
      for (const tool of message.tools ?? []) {
        const update = tools.get(tool.id);
        if (update) Object.assign(tool, update);
      }
    }
    return { ...info, messages, status, ...(error ? { error } : {}) };
  }
  function flush() {
    timer = undefined;
    publish(snapshot("running"));
  }
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "message_update": live = event.message; break;
      case "message_end": live = undefined; break;
      case "tool_execution_start":
        tools.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, input: event.args, status: "running" });
        break;
      case "tool_execution_update": {
        const tool = tools.get(event.toolCallId);
        if (tool) tool.output = toolOutput(event.partialResult);
        break;
      }
      case "tool_execution_end": {
        const tool = tools.get(event.toolCallId);
        if (tool) { tool.output = toolOutput(event.result); tool.status = event.isError ? "error" : "done"; }
        break;
      }
      default: return;
    }
    if (!timer) timer = setTimeout(flush, 80);
  });
  flush();
  return {
    finish(error?: string) {
      clearTimeout(timer);
      unsubscribe();
      const run = snapshot(error ? "error" : "done", error);
      for (const message of run.messages) for (const tool of message.tools ?? []) {
        if (tool.status === "running") tool.status = error ? "error" : "done";
      }
      publish(run);
      return run;
    },
  };
}
