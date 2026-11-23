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
| supermoon tools | `fix/supermoon-tools` | Replace the `/supermoon` slash command (TUI + web) with `EnterSupermoonMode` / `ExitSupermoonMode` agent tools (feature-contributed, `'tool'` trigger persists like `manual`); apply `swarm_mode`/`supermoon_mode` on prompt submit so a new web session's first prompt enters them — fixes the desktop Mode-menu toggle snap-back on fresh sessions | — | — | local |
| plan-review gate + options off prompts | `feat/plan-review-gate` | Plan-mode prompts (both engines) add the default directive "do not make shit up, do your research, ask for clarification" to the reminders, EnterPlanMode message, and plan subagent role; the EnterPlanMode message gains a plan-review gate and AskUserQuestion-based approach selection; prompts stop instructing ExitPlanMode options (tool code unchanged) | — | — | local |
| plan-review gate in reminders | `feat/plan-gate-reminders` | The plan-review gate now also rides the plan-mode reminders (full/sparse/reentry + inline twins, both engines) so every plan-mode entry path (/plan, Shift-Tab, --plan, default_plan_mode, resume) runs the plan-review skill once before ExitPlanMode | — | — | local |
| planning-model switching | `feat/planning-model-switching` | `planning_model` config + v1/v2 plan-mode model flip, `modelquery`/`modellist`/`modelset` tools with a context-window switch guard, `/planning-model` TUI command; web "Planning model" setting in `kimi-code-web` | — | — | local |
| disable kimi OAuth by default | `feat/disable-kimi-oauth-by-default` | Kimi OAuth login (kimi.com/kimi.ai device-code) disabled by default; opt-in via `[experimental] kimi_oauth` / `KIMI_CODE_EXPERIMENTAL_KIMI_OAUTH` / `kimi web --enable-kimi-oauth`; token/apiKey auth stays the default; web + TUI hide the login unless enabled | — | — | not-submitting |
| Windows native installer | `feat/windows-installer` | Fork-style `install.ps1` (win32-x64/arm64, GitHub Releases + gh-pages channel); publish `install.ps1` to the update channel; point `README.md` + `README.zh-CN.md` + `fork/README.md` at the fork install commands | — | — | not-submitting |
| swarm-task preference + default_swarm_mode | `fix/swarm-task-preference` | Restore the #3028-removed proactiveness/action directives and add explicit swarm-preference + subagent-rules guidance to both engines' system prompts; add a `default_swarm_mode` config (v1 + v2 + protocol) so new sessions can start in swarm mode | — | [#3433](https://github.com/MoonshotAI/kimi-code/issues/3433) | local |
| swarm preference round 2 (MUST + un-gate) | `fix/swarm-must` | Make the swarm choice a MUST in `agent.md`, the `explore` profile, and both system prompts; delete the AgentSwarm "use separate `Agent` calls" redirect; add a `prompts` heterogeneous encoding to AgentSwarm; flip `default_swarm_mode` to true; drop the AgentSwarm sole-tool-call veto | — | [#3433](https://github.com/MoonshotAI/kimi-code/issues/3433) | local |
| merge text across empty reasoning | `topic/fix-stream-text-fragmentation` | Back-port upstream #3601 into agent-core-v2 (fork base 0.39.1 predates it): in the response accumulator (`kosong/contract/generate.ts`) defer a vacuous (empty, unsigned) reasoning part that follows an open text run so consecutive text deltas merge into one part instead of one per SSE chunk; the first empty think still survives for the #1676 outbound gateway echo. Also merge the interrupted-turn drain in `loopService`. Adds a local `isVacuousThinkPart` in `kosong/contract/message.ts` (the `#/kosong` layer cannot import `#/agent`), which `contextMemory/vacuousContent.ts` now delegates to. Drops on the next sync past #3601 | [#3601](https://github.com/MoonshotAI/kimi-code/pull/3601) | [#2226](https://github.com/MoonshotAI/kimi-code/issues/2226), [#2506](https://github.com/MoonshotAI/kimi-code/issues/2506) | merged-upstream |
| coalesce replayed assistant frames | `topic/fix-transcript-frame-coalescing` | Cold transcript rebuild merges a contiguous run of assistant text parts, and of thinking parts, into one frame instead of emitting one frame per recorded part — so sessions journaled before the reasoning-merge fix replay correctly. Paired with a live-path guard that stops an empty thinking delta from minting a frame: without it the cold frame count no longer matches the live one and the post-turn heal renders the reply twice | [#3388](https://github.com/MoonshotAI/kimi-code/pull/3388) | [#2505](https://github.com/MoonshotAI/kimi-code/issues/2505), [#2323](https://github.com/MoonshotAI/kimi-code/issues/2323), [#3387](https://github.com/MoonshotAI/kimi-code/issues/3387) | local |
| web server signals + `[server]` config | `topic/web-server-signals-config` | `kimi web` shuts down on SIGINT/SIGTERM within a bounded wait and exits with the signal's code (130/143) instead of hanging on an unresponsive WebSocket peer; SIGHUP reloads `config.toml` in place with a `restart required for:` advisory; a new `[server]` config section backs every server option (`CLI > [server] > built-in`); IPv6 banner hints are off by default behind `--ipv6`, and an IPv6 bind prints a bracketed URL. The `preClose` / WebSocket-terminate half of the shutdown fix is an upstream bug too | — | — | local |
| API shutdown hook | `topic/api-shutdown-hook` | `POST /api/v1/shutdown` now runs the CLI's shutdown hook (Remote Control tunnel close plus telemetry flush) before kap-server closes, so a `--rc` server exits after an API shutdown instead of lingering on the tunnel's ref'd sockets; the hook is bounded and runs at most once across the signal and API paths | — | — | local |
| registry load hardening | `topic/load-hardening` | Cross-session registry coalesces heartbeat writes (at most one queued per session) and bounds registry-file I/O to 8 concurrent operations so a large registry cannot saturate the libuv threadpool; server close now has an 8s total budget, so shutdown finishes predictably on a loaded machine instead of waiting on unbounded post-drain flush | — | — | local |
| cross-session messaging | `topic/cross-session-messaging` | Add cross-session messaging between sessions' main agents: the `session_message` tool, per-session inbox transport and discovery, inbound policy, held-message drain on accept, and the SDK surface | — | — | local |
| win32 stage flake | `topic/fix-win32-stage-flake` | Make the win32 `Expand-Archive` fallback deterministic in the native release staging test | — | — | local |
| single-commit update channel | `topic/gh-pages-single-commit` | Publish the gh-pages update channel as a single-commit branch so each release replaces the channel instead of appending a full history | — | — | local |
| patch ledger maintenance | `topic/patches-ledger` | Backfill the three missing change rows (cross-session messaging, win32 stage flake, single-commit update channel) and the 0.39.1-MB.1.27–1.65 release log | — | — | local |
| agent fleet visibility tools | `feat/agent-fleet-and-persona` | Add read-only fleet tools — `AgentResult`, `AgentHealth`, `WaitForAll`, enriched `ListAgents`, and `IAgentTaskService.capacity()`; auto-approved, riding `agent_messaging` | — | — | local |
| agent messaging coordination | `feat/agent-fleet-and-persona` | Add `ListMessages` (inbox), `ReplyMessage`, `BroadcastMessage`, and roster-change notifications; push delivery at the receiver's next step boundary | — | — | local |
| agent lifecycle control | `feat/agent-fleet-and-persona` | Add `agent_fleet_control` (default off): `StopAgent`, `StopAgents`, `DismissAgents`, `TagAgent`, `RenameAgent`, `InterruptAgent`; destructive tools, not auto-approved, plan-mode vetoed, ownership-gated | — | — | local |
| AgentSwarm names | `feat/agent-fleet-and-persona` | Add per-item `names` to `AgentSwarm` with length/duplicate validation and flag-gated schema stripping; resumed members keep their name | — | — | local |
| agent persona | `feat/agent-fleet-and-persona` | Add `agent_persona` (default off): `persona`/`personas` on `Agent`/`AgentSwarm` with overlay/replace, `extends` base-match, skills, capability clamping, and realpath-checked path personas | — | — | local |
| enable agent fleet control by default | `feat/agent-defaults-on` | Flip `agent_fleet_control` to default on (v2); the config/env off-switch stays | — | — | local |
| enable agent persona by default | `feat/agent-defaults-on` | Flip `agent_persona` to default on (v2); the config/env off-switch stays | — | — | local |
| enable tool-select by default | `feat/agent-defaults-on` | Flip `tool-select` to default on in both engines (`agent-core` v1 + `agent-core-v2`); the config/env off-switch stays | — | — | local |
| document experimental flags in config | `feat/agent-defaults-on` | Document all experimental `[experimental]` flags with their defaults in `config-files.md` and `env-vars.md` (en + zh) | — | — | local |
| port fleet-control tools to v1 | `feat/agent-defaults-on` | Add `StopAgent`, `StopAgents`, `InterruptAgent`, `DismissAgents`, `TagAgent`, `RenameAgent` to `agent-core` v1 behind a new `agent_fleet_control` flag (default on) so v1 and v2 expose the same tool set and the v1↔v2 parity test passes | — | — | local |
| fleet coordination fixes | `feat/fleet-fixes` | Fix the live-test findings: subtree reach for messaging/lifecycle, child-first dismiss cascade, `AgentSwarm` per-item `subagent_types`, resume keeps the bound profile, raw-id messaging scoped to the subtree, and the agent-resume subtree alignment | — | — | local |
| server messaging performance | `perf/server-messaging-regression` | Session create/resume no longer waits for the cross-session inbox bind (fire-and-forget + one retry + a bind-window retry on send), one shared inbox server per process replaces one socket per session, the proactive agent-roster fan-out is removed from v2 (the per-step provider is the single injection point), the tool registry/`Agent`/`AgentSwarm` descriptions are memoised on a catalog revision, the tool array is symbolised once per request, session-metadata agent writes are coalesced, the reminder injection index is built once per step, the WS broadcaster serialises each global event once, `AgentSwarm` members launch immediately, finished subagents are retained in a bounded LRU, and tower tools are loaded only while tower mode is active with the per-agent hooks flag-gated. Also fixes pre-existing cross-session defects: `session_message` parity across protocol/search/transcript, a visible refusal instead of a silent held-queue drop, serialised registry writes, temp-file reaping, and the tested flaky paths (node-sdk logging/parity, MCP startup, search p99) | — | — | local |
| web Safari resilience + memory bounds | `topic/web-bundle-safari-fixes` | Rebuild `dist-web` from merged `kimi-code-web` commit [`f950aac`](https://github.com/mbuckaway/kimi-code-web/commit/f950aac) ([#31](https://github.com/mbuckaway/kimi-code-web/pull/31), head `bb4c12a`, identical tree): root error boundary + 404-verified lazy-chunk recovery, WS stall watch, required post-render `MutationObserver` init, composer layout-read coalescing, a 60-turn transcript window (Chromium heap 91.6 → 71.7 MB on a 100-turn session), bounded loaded-session LRU plus per-session map purge, and a capped event-batcher queue | — | — | local |
| agent task test teardown | `topic/fix-taskmanager-test-teardown` | Drain pending session-metadata writes before removing the temp home in `taskManager.test.ts` (and retry the recursive remove), fixing the intermittent CI `ENOTEMPTY` teardown failure | — | — | local |

The agent fleet/messaging features above ship in both engines (`agent-core` v1 and `agent-core-v2`).

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
| 0.36.0-MB.1.16 (pending) | 0.36.0 | Supermoon tools (replace `/supermoon` slash command with `EnterSupermoonMode` / `ExitSupermoonMode`); prompt submit applies `swarm_mode`/`supermoon_mode` (Mode-menu fix); fork web bundle ship |
| 0.39.1-MB.1.27 | 0.39.1 | Upstream 0.39.1 sync (via `main` mirror → `fork/main`): all fork patches re-ported, supermoon migrated to the Event2 model, planning-model preserved, `dist-web` kept fork-side; upstream search/cron/workspace-lifecycle refactors adopted; ACP socket transport, TUI wire-staleness guard, usage-limit surfacing, and language directive retained |
| 0.39.1-MB.1.28 | 0.39.1 | Fork web bundle ship (port W1-W10) |
| 0.39.1-MB.1.29 | 0.39.1 | Kimi OAuth login disabled by default (opt-in via `kimi_oauth`) |
| 0.39.1-MB.1.30 | 0.39.1 | Windows native installer wired up (#83) |
| 0.39.1-MB.1.31 | 0.39.1 | Web bundle with the WS subprotocol fix; regenerate a malformed server token on load |
| 0.39.1-MB.1.32 | 0.39.1 | Web bundle with tablet scroll, planning-model, and task-notice fixes |
| 0.39.1-MB.1.33 | 0.39.1 | Publish native binaries to the gh-pages update channel |
| 0.39.1-MB.1.34 | 0.39.1 | Release bump |
| 0.39.1-MB.1.35 | 0.39.1 | Publish bare native binaries in the update-channel manifest |
| 0.39.1-MB.1.36 | 0.39.1 | Handle `kimi.exe` when publishing bare native binaries |
| 0.39.1-MB.1.37 | 0.39.1 | Extract native zips in the staged updater |
| 0.39.1-MB.1.38 | 0.39.1 | Windows release sync; preflight excluded from the Windows job |
| 0.39.1-MB.1.39 | 0.39.1 | Recover from image rejections; Files API image upload (#101) |
| 0.39.1-MB.1.40 | 0.39.1 | Stop cross-provider thinking blocks from bricking a session (#103) |
| 0.39.1-MB.1.41 | 0.39.1 | Restore swarm preference; add `default_swarm_mode` (#105) |
| 0.39.1-MB.1.42 | 0.39.1 | Make `AgentSwarm` the preferred parallel path (#107) |
| 0.39.1-MB.1.43 | 0.39.1 | TUI live progress for subagents and background tasks (#109) |
| 0.39.1-MB.1.44 | 0.39.1 | Web bundle with live agent-task progress (#111) |
| 0.39.1-MB.1.45 | 0.39.1 | `[services.search]` selects the web search provider (#113) |
| 0.39.1-MB.1.46 | 0.39.1 | Fetch timeouts hardened, error stacks redacted, type-safety lint enabled (#115) |
| 0.39.1-MB.1.47 | 0.39.1 | QwenCloud web search provider; OpenAI Responses reasoning settings (#117) |
| 0.39.1-MB.1.48 | 0.39.1 | Merge text deltas across empty reasoning stream parts (#119) |
| 0.39.1-MB.1.49 | 0.39.1 | Coalesce replayed assistant frames (#121) |
| 0.39.1-MB.1.50 | 0.39.1 | Default web search to DeepSeek; bound hung ACP turns (#124) |
| 0.39.1-MB.1.52 | 0.39.1 | Agent-to-agent messaging tools (#126); darwin-arm64 cross-build on ARM Linux (#128) |
| 0.39.1-MB.1.53 | 0.39.1 | Agent fleet tools and persona support (#130) |
| 0.39.1-MB.1.54 | 0.39.1 | Agent fleet control, persona, and tool-select default on (#132) |
| 0.39.1-MB.1.55 | 0.39.1 | Agent-fleet coordination across the subtree (#134) |
| 0.39.1-MB.1.56 | 0.39.1 | Upstream tower mode improvements, enabled by default (#136) |
| 0.39.1-MB.1.57 | 0.39.1 | Cross-session messaging between sessions' main agents (#138) |
| 0.39.1-MB.1.58 | 0.39.1 | Deterministic win32 `Expand-Archive` fallback test (#140) |
| 0.39.1-MB.1.59 | 0.39.1 | Gh-pages update channel published as a single-commit branch (#142) |
| 0.39.1-MB.1.60 | 0.39.1 | Session-metadata teardown drain for the task-manager tests (#146) |
| 0.39.1-MB.1.61 | 0.39.1 | Fork web bundle with Safari resilience and memory bounds (#145) |
| 0.39.1-MB.1.62 | 0.39.1 | Server session-open, fleet-spawn, and per-request overhead cut (#144) |
| 0.39.1-MB.1.63 | 0.39.1 | Web `[server]` config section, bounded shutdown, SIGHUP reload, IPv6 hints (#122) |
| 0.39.1-MB.1.64 | 0.39.1 | API shutdown runs the CLI shutdown hook (#151) |
| 0.39.1-MB.1.65 | 0.39.1 | Registry I/O and server close time bounded under load (#153) |
