Inspect one agent's derived health and current background capacity.

Use this when you need to know whether a single agent is running, stalled, orphaned, or finished, and how much of the background capacity is in use.

Parameters:
- `agent_id` — the agent id to inspect, as reported by ListAgents.

The result reports a derived `state`:
- `running` — the agent's loop is actively working on a turn.
- `stalled` — the agent has a live task but its loop is idle, so it is not making progress.
- `orphaned` — the agent has no live handle, so it can no longer be controlled; a task record may or may not remain.
- `lost` — the task survived a process restart and can no longer be inspected.
- `idle` — the agent is live and has no task.
- `completed` / `failed` / `timed_out` / `killed` — the agent's last task ended in that state.

The result also carries the task timestamps, the current turn phase and step, active tools, pending approvals, the reason the last turn ended, context size, accumulated input and output tokens, and background capacity as `running/max`.

AgentHealth is read-only: it never changes agent or task state, so it is always safe to call, including in plan mode.
