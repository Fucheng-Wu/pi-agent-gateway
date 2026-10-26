/** Coordination capabilities installed for every member of a team. */
export const COLLABORATION_TOOLS = [
  "spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents",
  "wait_agents", "interrupt_agent", "close_agent",
] as const;
export const LEGACY_COLLABORATION_TOOLS = ["followup_agent", "resume_agent"] as const;
