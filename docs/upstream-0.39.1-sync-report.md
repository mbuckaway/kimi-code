# Upstream Catch-up to 0.39.1 — Report

> Companion to the approved plan. This file is the durable record of what upstream added
> (0.36.1 → 0.39.1) and what the fork is missing. Execution phases live in the plan; see the
> "Plan summary" at the end.

## Baseline (verified)

| Fact | Value |
|------|-------|
| Fork mainline | `fork/main` — `mbuckaway/kimi-code` |
| Fork base | upstream 0.36.0, merge-base `102984aa660d752ba8dd7d1aba155575f32affe2` |
| Fork version | `0.36.0-MB.1.24` on `origin/fork/main` (`bdbd5065a`); local `fork/main` is `0.36.0-MB.1.23` (`4301c5f27`) |
| Upstream release | 0.39.1 tag peels to `5efca0c31`; upstream HEAD `44b40e685` is post-0.39.1 |
| Releases to absorb | 0.36.1, 0.37.0, 0.37.1, 0.37.2, 0.38.0, 0.39.0, 0.39.1 |
| Fork-only commits | 92 (365 non-bundle files) |
| Upstream delta | ~105 commits |

The upstream web UI source is not public (`MoonshotAI/code-app` 404); only the built
`dist-web` bundle and the `web:` release notes are public. The fork reimplements upstream web
features in `kimi-code-web`.

## What upstream added per release

### 0.36.1
- Non-web: HTTP-cache web assets (`#2865`); cancel in-flight `/init` with the turn (`#2916`);
  fix self-hosted provider tool-call id renumbering hangs (`#2911`); fix bare-URL/CJK (`#2917`);
  prevent background output disrupting terminal pane borders (`#2863`). (`#2884`/`#2899`/`#2876`
  already-fork.)
- Web (mostly `#2922`): timestamp = message time; slash/mention menu restyle; background Bash
  status filter; subagent card grid; plan/goal pills; plan viewer; session export toast + no 64 MiB
  limit; PR badge; slash pinyin fuzzy; auto session-title; recent-sort workspace view. (Most already
  in the fork's 0.36 port.)

### 0.37.0
- Non-web: multi-skill activation (`#2935`); Windows native auto-update (`#2994`); keep pasted
  image/video in history (`#2593`); Gemini tool-call fix (`#2914`); Chinese/emoji binary misdetect
  (`#2972`); print `kimi --resume` after `/fork` (`#2940`); `/goal` 4000-char warning (`#2928`);
  lazy search-index load (`#2633`); queue slash-skill while busy (`#2633`); removed-model startup
  fix (`#2985`); context-size estimate fix (`#2969`); `/undo` todo restore (`#3016`); legacy-engine
  live MCP/OAuth (`#2858`); `kimi web --web-title` (`#2989`).
- Web (`#3043`): Open/Done/Workspaces tabs + mark-done; session management page; @-mention pills;
  "Background Agent" rename; YAML-frontmatter/verbatim-text fixes; task-panel + copy-button rework;
  folder-paste skip; reduced-motion; plan-review feedback auto-grow; workspace search; browser title
  = workspace name; Ctrl+K vs Cmd+K fix.

### 0.37.1
- Pasted images (`#3053`) and videos (`#3047`) reach the model on first send.

### 0.37.2
- Web (`#3061`): subagent detail panel rework; Settings "Lab" tab + multi-tab sidebar toggle.

### 0.38.0
- Non-web: kimi.ai + kimi.com OAuth (`#2862`); **WaitFor** tool (`#3060`); config.toml loss fix
  (`#3121`); Datasource plugin data sources (`#3119`); **Edit/Write read-before-write enforcement**
  (`#3096`); stop retrying content-filter blocks (`#3101`); OpenAI 422 fix (`#3052`); OAuth MCP
  authenticate tool (`#3083`); collapse long `!` output (`#3054`); sub-agents stop nesting by
  default (`#3012`); background-agent row fixes (`#3005`); image/binary tool routing (`#3046`).
- Web (`#3135`): subagent card foreground/background labels; settings copy buttons; @-mention menu
  file+skill merge; chat-header Pin + draggable divider; prompt-queue per-row steer; kimi.com/kimi.ai
  OAuth login entries; remove cross-client archived sessions; undoable skill-activation turns;
  WaitFor quiet-line display; goal/attachment transcript fixes; viewport/clipping fixes.

### 0.39.0
- Non-web: **Remote Control** (`#3034`); **subagent/swarm `fork` param** (`#3007`); **tower mode**
  (`#3099`); MaxListeners silence (`#3241`); archive when workspace gone (`#3139`); cross-client
  broadcast fix (`#3034`); preserve session/model on logout (`#3212`); CloudBase plugin (`#3136`);
  cron reply-loss fix (`#3154`); remove `--allow-remote-terminals` / loopback-only PTY (`#3034`);
  ACP regressions (`#3183`); device-code flash fix (`#3294`); mid-turn-resume crash fix (`#3206`);
  AskUserQuestion task-control guard (`#3159`); MCP structuredContent dedup (`#3234`); plugins catalog
  load (`#3219`); MCP trust/config-readiness (`#3002`); secondary-model thinking-effort fix (`#3191`);
  stale context-% fix (`#3164`); `[swarm] timeout_ms` (`#3198`); foreground/background task
  classification (`#3239`); oversized tool output / partial responses (`#3227`); transcript rebuild
  fix (`#3102`); attached-image fix (`#3271`); "manually stopped" undo fix (`#3278`); Git Bash path
  fix (`#2200`); truncated-journal resume fix (`#3281`).
- Web (`#3157`, `#3296`, `#3152`): mobile bottom sheets for slash/@/+; mobile flat/workspace tab;
  **multi-tab right sidebar**; **move-to-background**; collapsible thinking blocks; composer +
  code-block rework; background-task notification restyle; many mobile/sidebar styling fixes.

### 0.39.1
- Non-web: `kimi update` timeout (`#3307`); resume background-task warning (`#3292`); Skill-tool
  transcript fix (`#3328`).
- Web (`#3333`): command tool row height; composer IME/placeholder fixes; **per-session permission
  mode scoping**; attachment-preview popover fix; stuck-upload fix; right-panel header unify +
  OpenIn file mode; send-gate model pick; many-workspaces "Connecting…" fix.

## Non-web gap (high-value subset)

`#3096` read-before-write enforcement · `#3121` config.toml loss · `#3227` oversized tool output /
partial responses · `#3281` truncated-journal resume · `#3206` mid-turn resume crash · `#3183` ACP
regressions · `#3012` sub-agent nesting default · `#3007` subagent `fork` param · `#3099` tower mode
· `#3060` WaitFor tool · `#2862` kimi.ai/kimi.com OAuth · `#3083` OAuth MCP authenticate · `#3002`
MCP trust/config-readiness · `#3034` loopback-only PTY + Remote Control · `#3198` `[swarm] timeout_ms`.

## Web gap (big-ticket)

Multi-tab right sidebar · move-to-background · Open/Done/Workspaces tabs + session management page
· Background Agent panel rework · @-mention pills in transcript · WaitFor display · Settings Lab
tab · session pinning rework · @-mention menu file+skill merge · kimi.ai/kimi.com OAuth · mobile
bottom sheets + flat/workspace tab · `--web-title` browser title · prompt-queue per-row steer ·
0.39.1 `#3333` fixes.

## Fork "keep" inventory

See `fork/PATCHES.md`. All 25 rows are fork-only; none are superseded by upstream 0.36.1→0.39.1
(the "adapts/adopts upstream PR" rows reference PRs that are still open upstream). Key groups:
ACP socket + headless regressions, fsevents/usage-limit/security hardening, supermoon + plan-review
gate + language fix, esc-interrupt thinking drop (both engines), and the fork-original
**planning-model switching** feature (backend on `feat/planning-model-switching`, web source merged
to `kimi-code-web` `main`, bundle on `chore/ship-web-bundle-planning-model`).

## Merge-conflict risk

Heaviest overlap in `kap-server` (plugins/capabilities/rest-plugin/prompts/sessionAgentConfig/
sessionEventBroadcaster), `agent-core-v2` (marketplace/contextProjector/fullCompaction/capability/
toolActivation/bashTool/profile), `apps/kimi-code` (kimi-tui/session-event-handler/acp/preflight),
and `protocol` (events/rest/*). Clean: `packages/transcript/**` (take upstream wholesale) and
`apps/kimi-code/dist-web/**` (re-ship fork bundle, never merge upstream's).

## Plan summary

1. **Phase 1 (first):** complete + ship planning-model-switching (register `PLANNING_MODEL_SECTION`,
   merge backend + web bundle atomically into `fork/main`, pass the release gate, cut a release).
2. **Phase 2:** single-jump merge of upstream 0.39.1 tag `5efca0c31` into `fork/main`, re-porting
   all fork patches.
3. **Phase 3:** port the 0.37→0.39.1 web features into `kimi-code-web` and re-ship `dist-web`.
4. **Phase 4:** verification + release.
