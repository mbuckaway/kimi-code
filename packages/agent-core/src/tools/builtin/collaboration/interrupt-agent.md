Ask the target to stop gracefully. The target finishes its current step — including the tools it has already called — and then stops, instead of being cancelled mid-step.

Use `StopAgent` when you need an immediate kill: that cancels the target's active turn, its queued turns, and any in-flight message-delivery run. An agent cannot interrupt itself, and no agent can interrupt `main`.

Interrupting is destructive control, not a message: it is not auto-approved, and it is blocked in plan mode.
