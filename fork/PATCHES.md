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
| ACP socket transport | `feat/acp-socket-transport` | `kimi acp --socket` — Unix-socket / named-pipe transport alongside stdio, in `acp-adapter`; the `acp-server` port landed with the 0.33.0 sync | — | — | local |
| fork infrastructure | `fork/infra` | Fork identity (npm name, update CDN → gh-pages), fork-sync / fork-release workflows, this tracking doc | — | — | not-submitting |
| security review hardening | `review/fork-security-audit` | typescript-review pass over the fork delta: fs-watch logging + bounded path set, ACP socket error handler / connection cap / Windows boundary warning, provider quota status plumbing, module-hook path normalization, dependency CVE refresh | — | — | local |

Changesets under `.changeset/` deliberately name the upstream package
`@moonshot-ai/kimi-code`, not the fork's `@mbuckaway/kimi-code`, so a change can
be cherry-picked into an upstream PR verbatim. The fork's release pipeline
(`fork-release.yml`) computes versions from `package.json` and does not consume
changesets, so the stale name is harmless here.

## Release log

| Fork version | Upstream base | Changes shipped |
|--------------|---------------|-----------------|
| 0.31.1-MB.1.0 | 0.31.1 | fsevents fd exhaustion, usage-limit surfacing, fork infrastructure |
| 0.31.1-MB.1.1 | 0.31.1 | Native-build pnpm filters pointed at the renamed fork package |
| 0.31.1-MB.1.2 | 0.31.1 | ACP socket transport; release-manifest test aligned with the fork tag format |
| 0.32.0-MB.1.0 | 0.32.0 | Upstream 0.32.0 sync (manual conflict resolution) |
| 0.33.0-MB.1.0 | 0.33.0 | Upstream 0.33.0 sync, fork patches ported |
| 0.33.0-MB.1.1 | 0.33.0 | Release auto-merge falls back to a direct merge when rejected |
| 0.33.0-MB.1.2 | 0.33.0 | Releases published from drafts; feedback tests aligned with fork identity |
| 0.33.0-MB.1.3 | 0.33.0 | Upstream sync via the scheduled `fork-sync` workflow |
