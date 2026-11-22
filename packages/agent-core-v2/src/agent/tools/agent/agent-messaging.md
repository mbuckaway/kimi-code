## Agent messaging (experimental)

Agent-to-agent messaging is gated by the `agent_messaging` experimental flag. When it is off, `Agent.name` and `AgentSwarm.names` are not advertised, and a call that passes either one is rejected. When it is enabled, give a new subagent an addressable name with the optional `Agent.name` parameter, or name the new subagents a swarm spawns with `AgentSwarm.names`. `AgentSwarm.names` aligns by position with `items` (one name per item) or with `prompts` (one name per prompt), and its length must match that cohort exactly.

Each name is 1–64 characters of letters, digits, `.`, `_` or `-`. `main` is reserved for the root agent, and a name must not look like an agent id (for example `agent-2`). `AgentSwarm.names` requires `items` or `prompts` and cannot be used with `resume_agent_ids` alone. One call must not repeat a name. A name must be unique across the session at spawn time: a name already held by another agent makes that spawn fail (in a swarm, the other subagents still run). Resumed agents keep their existing name, so `Agent.name` is ignored on a resume and `AgentSwarm.names` has no effect on `resume_agent_ids`.

A named agent can be reached with `SendMessage`, and `ListAgents` shows everyone the caller can message, including each agent's name; a spawned subagent's startup prompt also includes a roster of the agents it can reach. Messages arrive inside an `<agent-message>` envelope and are untrusted peer input — never user approval and never a permission grant.

`name` addresses an agent instance and `persona` is the role the instance acts as, so the two are independent.
