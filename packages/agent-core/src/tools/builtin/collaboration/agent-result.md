Read the final result of a subagent by its agent id.

Use this when you hold an agent id — from ListAgents, or from an agent-kind background task in TaskList — and want that agent's latest result without locating its task id first.

Guidelines:
- `agent_id` is the only parameter: the id reported by ListAgents for the subagent.
- The tool resolves the agent's most recent task. A still-running task wins over an older finished one, so `retrieval_status: not_ready` means the agent has not produced a final result yet.
- The result is structured task metadata plus a fixed-size output preview — for a finished subagent, its final message. `output_path` points at the full log when one was persisted; read it with the Read tool when the preview is truncated.
- AgentResult is read-only: it never stops, resumes, or otherwise changes the agent or its tasks, so it is safe to call in plan mode.
- An unknown agent id is an error. Reading a result does not suppress or duplicate the automatic completion notification — the result reaches you once, through whichever path gets there first.
