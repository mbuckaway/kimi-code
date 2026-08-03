# Fork change tracking

Every change carried by `fork/main` on top of upstream (`MoonshotAI/kimi-code`)
is listed here. **Rule: every PR to `fork/main` adds or updates its row.**

Status lifecycle: `local` → `pr-open` → `merged-upstream` / `rejected` /
`superseded`. `not-submitting` marks changes that stay fork-only forever.
When a change lands upstream, drop it from `fork/main` on the next sync and
mark the row `merged-upstream` (keep the row as history).

| Change | Fork branch | Summary | Upstream PR | Upstream issue | Status |
|--------|-------------|---------|-------------|----------------|--------|
| fsevents fd exhaustion | `fix/fsevents-fd-exhaustion` | macOS file descriptor exhaustion in the agent-core-v2 workspace scanner | — | — | local |
| usage-limit surfacing | `fix/usage-limit-indication` | Surface provider usage-limit (quota) errors across CLI, web, and agents; wire code `provider.usage_limit`, never requeued as rate limit | — | — | local |
| fork infrastructure | `fork/infra` | Fork identity (npm name, update CDN → gh-pages), fork-sync / fork-release workflows, this tracking doc | — | — | not-submitting |

## Release log

| Fork version | Upstream base | Changes shipped |
|--------------|---------------|-----------------|
| 0.31.1-MB.1.0 | 0.31.1 | fsevents fd exhaustion, usage-limit surfacing, fork infrastructure |
