## Agent personas (experimental)

A persona adds a role on top of a capability profile. It is gated by the `agent_persona` experimental flag. When the flag is off, `persona` is not advertised, and a call that passes it is rejected.

Pass `persona` as a catalog agent name (preferred) or a workspace `.md` file path. A persona declares `mode` and `extends`. `mode: overlay` is the default and adds the persona text to the base profile. `mode: replace` uses the persona text as the system prompt and keeps the base capabilities. `extends` is required and names the base profile. When you also pass `subagent_type`, it must match `extends`; otherwise the call is rejected. When you omit `subagent_type`, the persona's `extends` becomes the profile.

A persona can narrow `tools`, `disallowedTools`, and `subagents`. It never widens them. The effective set is the base profile's set, narrowed by the persona. A persona is bound when the agent starts, so `persona` is rejected with `resume` and with `fork`.
