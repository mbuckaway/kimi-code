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
| ACP internal-turn updates | `fix/acp-headless-regressions` | Forward internally-triggered turns (cron, background-task notifications) as `session/update` notifications over ACP even with no client prompt in flight | — | [#2878](https://github.com/MoonshotAI/kimi-code/issues/2878) | local |
| ACP mode from engine | `fix/acp-headless-regressions` | Seed ACP `currentModeId` from the engine's live permission/plan state (init, load, resume) instead of a hardcoded `default` | — | [#2828](https://github.com/MoonshotAI/kimi-code/issues/2828) | local |
| context-limit 401 classification | `fix/acp-headless-regressions` | Classify message-matched context-limit 401s as context overflow (both engines); skip the pointless OAuth refresh; preserve the provider message to the ACP wire | — | [#2613](https://github.com/MoonshotAI/kimi-code/issues/2613) | local |
| stream stall timeout | `fix/acp-headless-regressions` | Streaming idle/stall watchdog at the kosong stream-iteration layer (`KIMI_CODE_STREAM_STALL_TIMEOUT_MS`, default 300s) — a stalled provider stream aborts like a cancel and persists the partial content | — | [#2762](https://github.com/MoonshotAI/kimi-code/issues/2762) | local |
| wire flush before dispose | `fix/acp-headless-regressions` | Flush the replayable wire before agent dispose on session close so tail assistant records are never dropped (adopts upstream PR #2812) | [#2812](https://github.com/MoonshotAI/kimi-code/pull/2812) | [#2727](https://github.com/MoonshotAI/kimi-code/issues/2727) | local |
| block turns during compaction | `fix/acp-headless-regressions` | Block turns while auto compaction is in flight so the commit-time history-safety race cannot cancel the compaction and kill the turn (adapts upstream PR #2755) | [#2755](https://github.com/MoonshotAI/kimi-code/pull/2755) | [#2720](https://github.com/MoonshotAI/kimi-code/issues/2720) | local |
| Bash sub-command rules | `fix/acp-headless-regressions` | Evaluate Bash permission rules per sub-command (tree-sitter-bash decomposition; both engines) so compound commands cannot over-grant allows or bypass denies (adapts upstream PR #2757) | [#2757](https://github.com/MoonshotAI/kimi-code/pull/2757) | [#2756](https://github.com/MoonshotAI/kimi-code/issues/2756) | local |
| glob slash-crossing | `fix/acp-headless-regressions` | Match permission-rule glob subjects as opaque text so `*` crosses `/` for commands/URLs/search; path subjects keep path semantics (adapts upstream PR #2747; both engines) | [#2747](https://github.com/MoonshotAI/kimi-code/pull/2747) | [#2728](https://github.com/MoonshotAI/kimi-code/issues/2728) | local |
| -p env provider key | `fix/acp-headless-regressions` | The auth gate falls back to `process.env` via the provider's declared `apiKeyEnv` (two-stage resolution; adapts upstream PR #2746) | [#2746](https://github.com/MoonshotAI/kimi-code/pull/2746) | [#2745](https://github.com/MoonshotAI/kimi-code/issues/2745) | local |
| hooks config reload | `fix/acp-headless-regressions` | Rebuild the external-hooks index on `onDidChangeConfiguration` (coalesced) so late `[[hooks]]` fire and the heartbeat arms (adapts upstream PR #2822) | [#2822](https://github.com/MoonshotAI/kimi-code/pull/2822) | [#2779](https://github.com/MoonshotAI/kimi-code/issues/2779) | local |
| select_tools always registered | `fix/acp-headless-regressions` | Always register the `select_tools` disclosure tool under an allowlist-bound profile so the announced MCP selector is callable | — | [#2381](https://github.com/MoonshotAI/kimi-code/issues/2381) | local |
| TUI wire staleness guard | `fix/acp-headless-regressions` | TUI detects external wire-journal appends, blocks forking input, reloads + re-hydrates on session re-select (adapts upstream PR #2851) | [#2851](https://github.com/MoonshotAI/kimi-code/pull/2851) | [#2835](https://github.com/MoonshotAI/kimi-code/issues/2835) | local |
| non-TTY upgrade | `fix/acp-headless-regressions` | Non-TTY `kimi upgrade` runs the auto-install (or exits non-zero when unsupported) instead of silently exiting 0 | — | [#2629](https://github.com/MoonshotAI/kimi-code/issues/2629) | local |
| prompt plan_mode | `fix/acp-headless-regressions` | The prompt submit route applies `plan_mode` enter/exit-if-different so a new web session's first message enters plan mode (adapts upstream PR #2869) | [#2869](https://github.com/MoonshotAI/kimi-code/pull/2869) | [#2658](https://github.com/MoonshotAI/kimi-code/issues/2658) | local |
| session profile bind | `fix/acp-headless-regressions` | Session create binds the requested `--agent`/`--agent-file` profile and threads `agentFiles` through the harness so the profile's tools apply (adapts upstream PRs #2832, #2770) | [#2832](https://github.com/MoonshotAI/kimi-code/pull/2832) | [#2765](https://github.com/MoonshotAI/kimi-code/issues/2765), [#2767](https://github.com/MoonshotAI/kimi-code/issues/2767) | local |

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
