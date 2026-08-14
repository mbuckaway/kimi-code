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
| language system-prompt fix | `fix/language-system-prompt` | Remove misleading "even after long stretches of English tool output" from system.md (both engines); add `[language]` config section with `reply_language` defaulting to `"en"`; inject `language_directive` template variable into every system prompt. See `fork/LANGUAGE-BUG.md` | — | [#1998](https://github.com/MoonshotAI/kimi-code/issues/1998) | local |
| esc-interrupt thinking drop | `fix/esc-interrupt-thinking-drop` | Drop thinking-only assistant messages at the projector layer in **both** engines (`agent-core` v1 + `agent-core-v2`) so an ESC-interrupted turn never leaves a content-less message that 400s the session. Upstream `#2819` fixes only the v2 OpenAI-legacy serializer, so the v1 half stays fork-only | — | [#2691](https://github.com/MoonshotAI/kimi-code/issues/2691) | local |

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
| 0.34.0-MB.1.0 | 0.34.0 | First 0.34.0-based release; upstream 0.34.0 sync |
| 0.34.0-MB.1.4 | 0.34.0 | Upstream 0.34.0 sync merge (PR #24); release-version guard (PR #23) |
| 0.34.0-MB.1.5 | 0.34.0 | Language system-prompt fix (#26) |
| 0.34.0-MB.1.6 | 0.34.0 | Scheduled `fork-sync` merge (2026-08-08) |
| 0.34.0-MB.1.7 | 0.34.0 | Esc-interrupt thinking drop, v1+v2 (#30) |
| 0.34.0-MB.1.8 | 0.34.0 | Fork web bundle ship (PR #32) |
| 0.34.0-MB.1.9 | 0.34.0 | Architecture docs (PR #34) |
| 0.34.0-MB.1.11 | 0.34.0 | Supermoon mode (#36) + supermoon web bundle ship (#37) |
| 0.34.0-MB.1.12 | 0.34.0 | Release self-heal CI (#38); web mode-menu fix bundle (#40); ci/release-independent-of-upstream merged (PR #41/#42) |
| 0.34.0-MB.1.13 | 0.34.0 | Fork web bundle ship (#44) |
| 0.36.0-MB.1.14 (pending) | 0.36.0 (upstream main tip `102984aa6`) | Upstream 0.36.0 sync: fork patches ported, `dist-web` bundle kept fork-side, supermoon `agent_config` behavior preserved at the kap-server edge (`sessionAgentConfig.ts`), esc-interrupt patch retained (v1 half has no upstream equivalent) |
