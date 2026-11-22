Wait for a whole cohort of background tasks to finish under one shared deadline.

Use this to fan in after dispatching several tasks or subagents: WaitForAll waits for every task in the cohort, then reports which ones finished and which are still running. It is the barrier to use before you synthesize their results.

Parameters:
- `timeout` — required, in seconds, capped at 1800. The deadline is shared by the whole cohort, not spent per task.
- `agent_ids` — one or more agent ids whose latest tasks form the cohort.
- `task_ids` — one or more background task ids that form the cohort. Provide `agent_ids` or `task_ids`, not both; omit both to wait for every task that is running at call time.

Behavior:
- The cohort is fixed when the call starts. Tasks started during the wait are not covered; their completion arrives via the usual automatic notification.
- A timeout is not an error: the result reports `completed`, `partial`, or `timed_out`, lists the finished tasks, and lists whatever is still running. Call WaitForAll again to keep waiting.
- Finished tasks are marked as delivered via the wait, so they do not also produce an automatic completion notification.
- An unknown task id or agent id is an error.
- WaitForAll is read-only with respect to the tasks: it never stops one, and interrupting the wait leaves every task running.
- Use AgentResult with an agent id or TaskOutput with a task id to read each finished result.
