Stop several background tasks or agents at once.

Use this when you dispatched a cohort and need to cancel all of it. For a single task or agent, TaskStop or StopAgent is simpler.

Parameters:
- `task_ids` — one or more background task ids to stop.
- `agent_ids` — one or more agent ids whose latest tasks to stop.
- `all` — stop every running background task.
- `include_foreground` — also stop foreground tasks. Defaults to false.
- `reason` — short reason recorded when each task is stopped.

Provide exactly one of `agent_ids`, `task_ids`, or `all: true`.

Behavior:
- Foreground tasks are excluded unless `include_foreground` is true, because the caller may be waiting on them.
- Tasks that already reached a terminal state are reported as-is and are not stopped or suppressed again.
- The result reports one section per requested task with `stopped`, `already_terminal`, `skipped_foreground`, or `not_found`.
- Stopping a task does not detach names: an agent keeps the name it was spawned with, so it can still be addressed.
- StopAgents is destructive: it is not auto-approved and is blocked in plan mode.
