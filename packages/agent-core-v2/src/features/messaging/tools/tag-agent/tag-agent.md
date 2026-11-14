Set the tags on an agent you own. Tags are stored comma-joined in the agent's labels, so a tag must not contain a comma; each tag is at most 32 characters and one agent carries at most 20 tags.

Pass `tags: []` to clear every tag.

Only an agent you own can be tagged; `main`, yourself, and another agent's subagents are refused. Tagging changes labels only — it never interrupts or stops the agent. Tagging is not auto-approved; it stays available in plan mode.
