# Supermoon Mode

Supermoon mode is a maximum-thoroughness mode for Kimi Code. While it is active, the agent plans multi-agent work for every substantive task instead of waiting for you to ask: it decomposes the work, runs independent subagents in parallel, and adversarially verifies their results — aiming for the most thorough, correct outcome rather than the fastest or cheapest. Supermoon also pins the model's thinking effort to its highest supported level for the session, and restores your previous setting when the mode turns off.

## When to use Supermoon

Use Supermoon when the answer matters more than the cost:

- Auditing or reviewing a large change where a missed finding is expensive.
- Investigating a hard-to-reproduce bug across many files and platforms.
- Preparing a release or a design that needs broad coverage and cross-checks.
- Any task where you would otherwise run several review passes by hand.

You do not need to ask for multi-agent work while Supermoon is on — the mode is the standing instruction. Turn it off when a task is small or when you want to keep token usage predictable.

## Enabling and disabling

Supermoon mode is controlled through the `EnterSupermoonMode` and `ExitSupermoonMode` tools: the agent turns the mode on with `EnterSupermoonMode` and off with `ExitSupermoonMode`, so it can enable the mode itself whenever the task calls for maximum thoroughness. The mode persists across turns until it is explicitly exited. In the web UI you can also toggle it from the modes menu.

While Supermoon is on, the footer mode list shows a `supermoon` chip alongside `auto`, `yolo`, `plan`, and `swarm`.

Supermoon mode is session-scoped: it resets when you start a new session.

## What the agent is told

When Supermoon turns on, Kimi Code injects a standing instruction into the conversation. The agent is told that the mode itself is the instruction — the user does not need to ask for multi-agent orchestration:

- On every substantive task, orchestrate with subagents by default: use the `Agent` or `AgentSwarm` tools to split the work into distinct parts, run independent agents in parallel, and cross-check their results.
- Aim for the most thorough, correct outcome you can produce. Do not trade completeness for speed or cost; correctness and coverage come first.
- Handle a task directly only when it is conversational or a trivial mechanical change.
- Keep the user updated between phases of long tasks instead of chaining everything into one run.

### Quality patterns

While Supermoon is active, the agent applies these patterns to substantive work:

- **Adversarial verification** — spawn independent subagents to challenge and refute each important finding; keep a finding only when a majority of the refutation attempts fail.
- **Perspective diversity** — verify the work from more than one angle (correctness, security, performance, usability) using separate reviewers with different standpoints.
- **Judge panel** — when subagent findings disagree, run a small panel of subagents holding different views and converge on the best-supported resolution.
- **Loop until dry** — keep dispatching finder subagents until consecutive rounds return nothing new.
- **Coverage sweep** — cover the full surface of the task: every relevant file, every affected platform or modality, every input shape.
- **Completeness critic** — before finishing, run one subagent whose only job is to find what is missing: an unread source, an unrun check, an unverified claim.
- **No silent caps** — do not quietly stop at a round number of agents or findings; stop only when the work is genuinely exhausted or the user's constraints require it.

When Supermoon turns off, the standing instruction is removed and the default rules apply again: the agent orchestrates with subagents only when you explicitly ask, or when the normal `Agent`/`AgentSwarm` tool rules call for it.

## Thinking effort

On entry, Supermoon sets the current model's thinking effort to its highest supported level, so the model can spend more tokens reasoning before answering. On exit, your previous effort setting is restored. If the active model does not advertise configurable effort levels, the effort setting is left untouched.
