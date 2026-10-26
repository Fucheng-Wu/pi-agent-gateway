import type { ChatMessage, SubagentRun, ToolCall } from '@/types'

export function refreshCollaborationTools(messages: ChatMessage[], runs: SubagentRun[]): void {
  const latest = new Map(runs.map((run) => [run.id, run]))
  for (const message of messages) for (const tool of message.tools ?? []) {
    const run = tool.subagent && latest.get(tool.subagent.id)
    if (run) tool.subagent = run
  }
}

/** One sidebar entry per collaborator, even when several tools refer to it. */
export function collaborationTools(messages: ChatMessage[], runs: SubagentRun[]): ToolCall[] {
  const agents = new Map<string, ToolCall>()
  for (const message of messages) for (const tool of message.tools ?? []) {
    if (tool.name !== 'Agent' && tool.name !== 'spawn_agent' && !tool.subagent) continue
    const key = tool.subagent?.id ?? tool.id
    if (!agents.has(key)) agents.set(key, tool)
  }
  for (const run of runs) {
    const tool = agents.get(run.id)
    agents.set(run.id, { ...(tool ?? { id: `agent:${run.id}`, name: 'spawn_agent' }), status: run.status, subagent: run })
  }
  const entries = [...agents.values()]
  return [...entries.filter(tool => !tool.subagent?.path), ...entries.filter(tool => tool.subagent?.path).sort((a, b) => a.subagent!.path!.localeCompare(b.subagent!.path!))]
}
