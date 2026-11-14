Cancel the target's current run: its active turn, its queued turns, and any in-flight message-delivery run are all cancelled.

Stopping does not detach the target's name or make it unreachable; send it a message to resume it. An agent cannot stop itself, and no agent can stop `main`.

Stopping is destructive control, not a message: it is not auto-approved, and it is blocked in plan mode. Use `InterruptAgent` instead when the target should finish its current step before it stops.
