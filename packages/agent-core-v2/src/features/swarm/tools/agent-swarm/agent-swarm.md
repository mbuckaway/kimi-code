Launch multiple subagents from one prompt template, existing agent resumes, or both.

Use AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly `{{item}}`. For example, with `prompt_template` set to `Review {{item}} for likely regressions.` and `items` set to `["src/a.ts", "src/b.ts"]`, AgentSwarm launches two new subagents with those two concrete prompts.

For 2 or more differently-shaped tasks, pass `prompts` instead: each entry is one subagent's full prompt, with no `{{item}}` placeholder. Do not combine `prompts` with `items` or `prompt_template`.

Use `resume_agent_ids` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually `continue` if no extra information is needed). You may combine `resume_agent_ids` with `items` or `prompts` in the same call to resume existing subagents and launch new ones. Do not duplicate resumed work in `items` or `prompts`.

Each of these is enforced — a violation is rejected before any subagent starts: provide at least 2 `items` or `prompts` unless you pass `resume_agent_ids`; `prompts` cannot be combined with `items` or `prompt_template`; whenever `items` are present, `prompt_template` is required and must contain `{{item}}`; and the resulting prompts must be distinct (two items that expand to the same prompt, or two identical `prompts` entries, are rejected).

Use enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.
