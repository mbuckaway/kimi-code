# Kimi Code Architecture

This document explains how Kimi Code works today and how its pieces fit together: the `kimi` CLI/TUI process, the in-process HTTP+WebSocket server (`kap-server`), the two agent engines behind it, and the browser web component. It is written from the current `fork/main` source (version `0.34.0-MB.1.8`). A companion diagram lives in [`architecture.svg`](./architecture.svg), and an assessment of porting the CLI to Rust and moving the web UI out of the main distribution is in [`rust-port-review.md`](./rust-port-review.md).

The map: there are two executable surfaces — a terminal UI and a browser UI — and both are driven by the same agent machinery. The `kimi` process itself runs the terminal UI, embeds the agent engines, and also runs a local HTTP/WebSocket server (`kimi web`) that serves the prebuilt web UI and exposes the same engine over `/api/v1`. The web UI is a separate codebase (`kimi-code-web` repo) that ships inside the CLI as a committed prebuilt bundle and is then served by that local server.

## 1. The two repositories

**`kimi-code`** (this repo) is a pnpm/TypeScript monorepo and a public fork of [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code). The fork relationship is described in the fork guide ([fork/README.md](https://github.com/mbuckaway/kimi-code/blob/fork/main/fork/README.md)):

- `main` is a pristine mirror of `upstream/main` (protected, rebase-only).
- `fork/main` is the fork mainline: upstream plus all fork changes; releases are cut from it.
- A scheduled workflow (`fork-sync.yml`) keeps both in sync with upstream roughly every 48 hours.
- Releases are versioned `<upstream-base>-MB.<x>.<y>` (e.g. `0.34.0-MB.1.7`) and published to npm as `@mbuckaway/kimi-code`; a `fork-release.yml` workflow also builds native single-executable binaries for six platforms.

**`kimi-code-web`** (a separate repo, `@mbuckaway/kimi-web`) is the browser web UI. It is not built by this repo: its source lives outside, and this repo ships the **prebuilt bundle** as a committed directory, `apps/kimi-code/dist-web` (see [§8 Web component](#8-web-component)). Upstream Moonshot produces that bundle from a private "code-app" repo; the fork can substitute its own bundle built from `kimi-code-web` (see [§8.4 Shipping the bundle](#84-shipping-the-bundle)).

## 2. Monorepo layout

Workspace members are defined in `pnpm-workspace.yaml` (`packages/*`, `apps/*`, plus `docs`). `flake.nix` hardcodes matching `workspacePaths`/`workspaceNames` lists for the Nix build of the native binary.

Apps:

| Path | What it is |
| --- | --- |
| `apps/kimi-code` | The CLI/TUI application, npm package `@mbuckaway/kimi-code`, `bin: kimi` → `dist/main.mjs`. |
| `apps/kimi-inspect` | Web inspector for the kap-server `/api/v1/debug` RPC surface (workspace/session browser, per-session transcript chat, per-scope Service panels). |
| `apps/vis` | Visual debugging tools for sessions and replays (`server` + `web`; `pnpm vis` at the root). |
| `apps/vscode` | VS Code extension (name `kimi-code`). |

Packages:

| Package | Role |
| --- | --- |
| `agent-core` | The v1 agent engine: flat VS Code-style DI, Agent/Session, skills, tools, permission, hooks. |
| `agent-core-v2` | The v2 agent engine: DI × Scope (LifecycleScope `App → Workspace → Session → Agent`), Service/Fiber units, features seam, LLM requesters, tool executors. |
| `kap-server` | The Kimi Code server: Fastify 5 app exposing sessions over REST `/api/v1` + WebSocket `/api/v1/ws`, backed by `agent-core-v2`. |
| `klient` | Contract-driven client facade over `agent-core-v2`, routable over IPC or in-memory transports. |
| `node-sdk` | The public TypeScript SDK (`@moonshot-ai/kimi-code-sdk`) the CLI is built on (`KimiHarness`, RPC clients, config, events). |
| `kosong` | The v1 LLM/provider abstraction layer (message types, `ChatProvider`, capability matrix). |
| `kaos` | Execution-environment abstraction (process/file ops, SSH, login-shell resolution) used by v1 and the SDK. |
| `oauth` | Kimi platform OAuth (device flow, token state/storage, userinfo/usage). |
| `telemetry` | Client-side telemetry (event client, sinks, crash handling). |
| `transcript` | Isomorphic transcript rendering data layer (agent-granular store, idempotent ops, subscriptions, view registry). |
| `pi-tui` | The in-repo terminal UI library ("TUI library with differential rendering"). |
| `minidb` | Embedded JSON document store (KV with WAL + snapshot persistence) used for the global search index and GUI store. |
| `protocol` | Shared REST+WS schemas (envelope, error codes, pagination, ws-control, approval). |
| `acp-adapter`, `acp-server` | Agent Client Protocol (ACP) host/adapter over both engines. |
| `tree-sitter-bash` | Pure-TypeScript bash parser (no native/wasm binding), used for bounded-budget bash analysis. |
| `migration-legacy` | Migration of `~/.kimi/` data into `~/.kimi-code/`. |

## 3. Runtime model: one process, two UI surfaces

The default way to run Kimi Code is `kimi` inside a project directory, which starts the terminal UI. The CLI runs the agent engine **in-process** — there is no background daemon. Two optional ways to surface the same engine:

- `kimi web` starts the local server **in the same process** (foreground, attached to the terminal) and opens the browser web UI pointed at it. The server is not a spawned subprocess.
- The engine can also be driven headlessly with `kimi -p "prompt"` (print mode) or `--output-format stream-json`.

Because the server is in-process, a `kimi web` session is one process hosting: the pi-tui terminal UI, the agent engines, the Fastify server, and the static web bundle.

## 4. The CLI process

### 4.1 Entry and boot

Entry point: `apps/kimi-code/src/main.ts`. The npm `bin` maps `kimi` to `dist/main.mjs` (the tsdown bundle).

1. `main()` installs crash handlers, a global proxy dispatcher (honors `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`), a native-module hook, and — in native (SEA) builds — extracts the MiniDb text-build and global-search worker scripts from the binary blob (best-effort; failure degrades to inline operation).
2. `createProgram()` (`apps/kimi-code/src/cli/commands.ts`) builds the Commander.js CLI. Global options include `-S/--session`, `-r/--resume`, `-c/--continue`, `-y/--yolo`, `--auto`, `-m/--model`, `-p/--prompt`, `--output-format {text,stream-json}`, `--skills-dir`, `--agent`, `--agent-file`, `--add-dir`, `--plan`. Subcommands: `export`, `provider`, `acp`, `web`, `login`, `doctor`, `vis`, `migrate`, `upgrade`, plus the hidden `__plugin_run_node` entry for plugin scripts.
3. `handleMainCommand()` (`main.ts:57`) validates options (`apps/kimi-code/src/cli/options.ts`), runs the update preflight, then dispatches: `runPrompt()` for print mode, `runShell()` for the TUI.

### 4.2 The terminal UI (pi-tui)

The TUI is **not** built on Ink/React. It uses the in-repo `pi-tui` package (`packages/pi-tui`), a terminal UI library with differential rendering. `KimiTUI` (`apps/kimi-code/src/tui/kimi-tui.ts`) composes pi-tui primitives (`Box`, `Markdown` via `marked`, `Input`, `SelectList`, `SettingsList`, `Loader`, `Editor`, `Image`), supports kitty-graphics image display, keybindings, autocomplete, and slash commands (`apps/kimi-code/src/tui/commands/`).

Boot flow (`apps/kimi-code/src/cli/run-shell.ts`): load `~/.kimi-code/tui.toml` (client preferences: theme, status line, notifications) → pick the theme palette → choose the engine via the v2 gate (`apps/kimi-code/src/cli/experimental-v2.ts`) — **v2 by default** through the SDK's `createKimiHarnessV2`, v1 via `createKimiHarness` when `KIMI_CODE_LEGACY_FLAG=1` → save/restore `stty -ixon` and install terminal-crash handlers → `tui.start()` (the pi-tui event loop) → `tui.onExit`.

### 4.3 The `web` subcommand and the local server

`kimi web` → `runServerInProcess` (`apps/kimi-code/src/cli/sub/web/run.ts`) → `startServer()` from `@moonshot-ai/kap-server`. Defaults come from `apps/kimi-code/src/cli/sub/web/shared.ts`:

- Host `127.0.0.1`, **port 58627** (`DEFAULT_SERVER_PORT`), overridable with `--port`/`--host`; on `EADDRINUSE` the port is bumped (`port + 1`, up to 100 retries) so multiple instances can coexist.
- A persistent bearer token is written to `<home>/server.token` (0600) on first boot and reused across restarts.
- Security flags: `--debug-endpoints` (mounts the `/api/v1/debug/*` RPC surface, loopback only), `--dangerous-bypass-auth`, `--allow-remote-shutdown` / `--allow-remote-terminals` (required for non-loopback binds), `--insecure-no-tls`, `--allowed-host`.
- Multi-instance coordination via an instance registry at `<home>/server/instances/*.json` (heartbeat files).

## 5. The agent engines

There are **two engines**, both in this repo. The CLI is mid-migration from v1 to v2; the v2 engine is the default.

### 5.1 v1 — `packages/agent-core`

Flat VS Code-style DI (`src/di/`, `IInstantiationService`). Key modules:

- Agent loop and Session (`src/agent/`, `src/session/`), subagents (`subagent-host.ts`, `subagent-batch.ts`), provider/model resolution (`src/session/provider-manager.ts`).
- Profile + Agentfile parsing (`src/profile/`), skills (`src/skill/`), tools (`src/tools/` — builtin, `providers/` fetch-url/web-search, policies, background, cron, display), plan (`src/agent/plan/`), permission (`src/agent/permission/` — `PermissionManager` with manual/auto/yolo modes and rule matchers), background tasks, wire-record persistence (`src/agent/records/`), MCP client (`src/mcp/`), plugins (`src/plugin/`), session store (`src/session/store/`).
- A service layer (`src/services/`) covering approval, auth, config, fs, logger, message, oauth, prompt, question, session, skill, task, terminal, tool, workspace, and more.
- LLM calls go through `@moonshot-ai/kosong` (`generate()` / `ChatProvider`).

### 5.2 v2 — `packages/agent-core-v2`

A DI × Scope architecture that replaces the flat DI graph with scoped lifetimes:

- **LifecycleScope** (`src/app/scopes.ts`): four tiers — `App → Workspace → Session → Agent` — with `setScopeTopology`.
- **Service/Fiber units** (`src/_base/di/service.ts`, `fiber.ts`): a `Service` exposes five fiber capabilities — `provide` / `effect` / `on` / `get` / `ref` — and units are assembled per scope (buffered construction, ledger, cascade engine, dependency graph).
- **Features seam** (`src/features/feature.ts`): a `Feature` can `contributeConfig` / `contributeService` / `contributeTool` / `contributeProfiles`; the reference implementation is the Plan mode feature.
- **Agent loop** (`src/agent/loop/loopService.ts`): `executeLoopStep` drives two paths — LLM requests via `IAgentLLMRequesterService.start(...)` (`src/agent/llmRequester/`), which calls the kosong provider stack (`src/kosong/provider/bases/{anthropic,google-genai,openai}/*` plus the `kimi` and `standard.contrib` providers), and tool steps via `IAgentToolExecutorService.execute(...)` (`src/agent/toolExecutor/`), which resolves tools through `IAgentToolRegistryService` and applies tool policies.
- **Tools** (`src/agent/tools/`): filesystem tools under `os/` (`bash`, `glob`, `grep`, `read`, `write`), plus `edit`, `fetch-url`, `web-search`, `skill`, `task`, `cron`, `goal`, `agent` (subagents/swarm), `ask-user-question`, `todo-list`, `select-tools`, `read-media-file`, `plan`.
- **File access**: the `IHostFileSystem` contract (`src/os/interface/hostFileSystem.ts`) with the `node-local` backend (`src/os/backends/node-local/hostFsService.ts`); workspace-level operations with path confinement and symlink re-verification in `src/workspace/workspaceFs/fsService.ts`, which shells out to the `rg` (ripgrep) binary located via `internal/rgLocator.ts` (system PATH or cached `<home>/bin/rg`). A durable app-file layer (`src/persistence/backends/node-fs/fileStorageService.ts`) does atomic write/fsync/rename.
- **Bootstrap**: `src/app/bootstrap/bootstrap.ts` is the composition root. `resolveKimiHome()` = `KIMI_CODE_HOME` env → `~/.kimi-code`. Config lives at `<home>/config.toml`.
- **Config**: `src/app/config/configService.ts` — a layered registry (defaults → user TOML → memory overrides), env bindings, deprecations/migrations, TOML parsed with `smol-toml`.
- **Permissions**: split across `src/agent/permissionMode/`, `permissionPolicy/` (policies such as auto/yolo mode approval, user-configured allow/ask/deny rules, sensitive-file ask, git-control ask, fallback ask), `permissionGate/`, `permissionRules/`.
- **Events/hooks**: `src/hooks.ts` (`OrderedHookSlot` chain), `src/app/event/` (event bus + event service).
- **Sessions**: metadata/activity/state services (`src/session/sessionMetadata/`, `sessionActivity/`, `state/`), wire-record store (`src/wire/`), session index + a MiniDb read model (`src/app/sessionIndex/`).

### 5.3 Session lifecycle and persistence

Sessions are the unit of conversation and state. v2 persists through `IFileSystemStorageService` rooted at `KIMI_CODE_HOME` (directories created 0700/0600): session metadata as atomic docs, wire records as append-logs, blobs, plus the session index. Session export produces a zip. The global search index lives in a MiniDb at `<home>/search-index`, run inline or in a worker thread.

## 6. LLM providers, OAuth, telemetry

- **Providers/models**: resolved from config (`config.toml` sections) through the model catalog; the browser and CLI both read `GET /api/v1/models` / `/api/v1/providers`. v2 ships providers for Anthropic, Google GenAI, OpenAI, and Kimi (`packages/agent-core-v2/src/kosong/`).
- **OAuth**: `packages/oauth` implements the Kimi platform OAuth device flow, token storage, and userinfo/usage endpoints; managed credentials drive `kimi login` and the platform usage display.
- **Telemetry**: `packages/telemetry` sends event batches with crash handling; the CLI initializes it at boot (`apps/kimi-code/src/cli/telemetry.ts`).

## 7. Skills, plugins, MCP

- **Skills** are the Agent Skills format. Discovery (v2) lives in `src/app/skillCatalog/`: a set of code-defined built-ins (`BUILTIN_SKILLS`, e.g. `check-kimi-code-docs`, `update-config`, `write-goal`), plus filesystem sources. Roots (`skillRoots.ts`): user roots `<KIMI_CODE_HOME>/skills` (brand, merged) then `~/.agents/skills` (generic); project roots `<project>/.kimi-code/skills` (brand) then `<project>/.agents/skills` (generic), where the project root is found by walking up to `.git`. Per-scope catalogs exist for sessions and workspaces; `--skills-dir` adds configured roots. v1 has an equivalent scanner/registry (`packages/agent-core/src/skill/`).
- **Plugins**: `plugins/marketplace.json` lists the marketplace (the official `kimi-datasource`, `kimi-webbridge` local plugin dirs, and curated remote plugins). The engine is `src/app/plugin/` (manifest, service, manager, GitHub resolver, archive, store, commands); the built-in catalog is generated into `dist/built-in-catalog.json` by `catalog:update`.
- **MCP**: full client support in v2 under `src/mcpCore/` (stdio/HTTP/SSE/remote clients, OAuth, connection manager), with config sections, per-workspace/per-session MCP, and the REST surface `/api/v1/mcp/servers*`. MCP tools flow through the same tool registry/executor as built-in tools.

## 8. Web component

### 8.1 What it is

The browser web UI is a peer of the TUI. Its source lives in the **`kimi-code-web`** repo (`@mbuckaway/kimi-web`) — Vue 3.5 + Vite 6 + TypeScript (strict) + vue-i18n v11, with no client router and no state library (state lives in composables/refs and provide/inject). The UI speaks only the stable `/api/v1` REST + WebSocket surface; it is deliberately decoupled from the agent engine — wire types are re-implemented locally in `src/api/daemon/wire.ts`, and the app must not depend on `agent-core`.

### 8.2 How the browser talks to the server

- **Same-origin by default; CORS is an explicit allowlist**: the browser talks only to its own origin; `src/api/config.ts` sets `serverHttpUrl = VITE_KIMI_SERVER_HTTP_URL ?? window.location.origin`. In development, the Vite dev server proxies `/api/v1` (HTTP + WS) to the CLI server (`KIMI_SERVER_URL`, default `http://127.0.0.1:58627`). kap-server does implement CORS, but only against an explicit origin allowlist (`KIMI_CODE_CORS_ORIGINS`, no `*` wildcard — `packages/kap-server/src/middleware/origin.ts`): same-origin or Origin-less requests pass, and a cross-origin request is answered (with `Access-Control-Allow-*` echoed) only when its full origin is allowlisted. The same `isOriginAllowed` rule gates the WebSocket upgrade.
- **HTTP**: an envelope `{ code, msg, data, request_id }` with HTTP status always 200; success is `code === 0`. The client adds `X-Request-Id`, client-identity headers, and `Authorization: Bearer <token>` when a credential exists.
- **WebSocket**: `/api/v1/ws?client_id=…`; the bearer token rides the `Sec-WebSocket-Protocol: kimi-code.bearer.<token>` subprotocol (browsers cannot set WS headers). Handshake: server `server_hello` → client `client_hello`. Frames carry `event.*` protocol events, raw agent-core frames, `transcript.ops` batches, and terminal I/O. The client reconnects with exponential backoff and resubscribes on every `server_hello`.
- **Auth to the browser**: `kimi web` appends the server's bearer token to the opened URL as a `#token=` fragment (then it is scrubbed). The web app also accepts a typed token (`ServerAuthDialog`) and caches it in `localStorage` with a 7-day TTL. Any `401/40101` clears the credential and raises the auth modal. `--dangerous-bypass-auth` mode is advertised via `/api/v1/meta` and skips the token prompt.
- **Event pipeline** (the core of the client): `ws.ts` classifies each frame (`agentEventProjector.ts`) → maps raw/protocol frames into an `AppEvent` union (`mappers.ts` + `eventReducer.ts`) → `useKimiWebClient.ts` applies events through a bounded, ordered queue and re-renders (render events coalesced to one per animation frame) → Vue components consume computed view props and emit intents (no direct API access).
- **Two protocol generations**: the legacy raw agent-core + `event.*` frames (works against both v1 and v2 backends) and the newer transcript channel (`subscribe_v2` → idempotent ops, v2 backends only). When the transcript channel is armed, subsumed raw frames are suppressed to avoid double rendering; on a sequence gap the client falls back to REST catch-up and snapshot resync (`GET /sessions/{id}/snapshot` seeds state at a `{seq, epoch}` watermark).

### 8.3 Build and heavy dependencies

`pnpm build` (Vite) produces a static SPA in `dist/` (≈22 MB, ~155 files). Heavy vendor chunks: `shiki` (~9.9 MB, syntax highlighting), `mermaid` (~2.1 MB, diagrams), `markstream-vue` (the streaming markdown engine; peers `katex`, `stream-markdown`, `stream-diffs`, `stream-monaco`), and `monaco-editor` (code-block editing, loaded lazily via `stream-monaco`). KaTeX and mermaid render off the main thread in module workers.

### 8.4 Shipping the bundle

- The CLI package ships the web UI as the **prebuilt, committed bundle** at `apps/kimi-code/dist-web` (in `.gitignore` but force-added to git).
- kap-server serves it at `/` and `/*` with SPA fallback (`packages/kap-server/src/routes/webAssets.ts`); reserved `/api` and `/documentation` paths fall through to the API. The bundle is auth-exempt by construction — the auth hook only gates `/api/*` and the meta documents (`packages/kap-server/src/middleware/auth.ts` `defaultIsBypassed`).
- Upstream produces the bundle in the private code-app repo and syncs it with `KIMI_CODE_REPO=<this checkout> pnpm run sync:web`. The fork uses `apps/kimi-code/scripts/stage-web-assets.mjs`: with `KIMI_WEB_BUNDLE=<path>` (or `--web-bundle`) it replaces `dist-web` with a build from the `kimi-code-web` repo and verifies it; without a selector it just verifies the committed bundle (same behavior as upstream's `check-web-assets.mjs`).
- In dev (`KIMI_CODE_DEV_SERVER=1`), a missing bundle is tolerated and the web UI runs from the web repo's own Vite dev server against this repo's `kimi web` server.
- The build pipeline guards packaging: `scripts/check-web-assets.mjs` fails the build if `dist-web/index.html` is missing.

## 9. Data flow end to end

A user request travels like this:

1. **Input**: typed in the pi-tui composer, or posted by the browser to `POST /api/v1/sessions/{id}/prompts` (or steered mid-turn via `prompts:steer`).
2. **Engine**: the session's agent loop (`agent-core` v1 or `agent-core-v2` depending on the gate) starts a turn: LLM request → tool steps → LLM request, until the turn ends. The LLM provider layer (`kosong`) talks to the configured provider; tool calls run through the tool registry/executor with permission policy applied.
3. **Events**: the engine emits structured events (turn/thinking/delta/tool/approval/question/task/terminal/transcript ops). v2 publishes through the session event broadcaster/journal; both REST endpoints and the WS feed from the same in-process engine.
4. **Rendering**: the TUI renders events directly; the browser receives them over `/api/v1/ws`, projects them into `AppEvent`s, and updates the reactive store.
5. **State**: sessions, wire records, and the search index persist under `KIMI_CODE_HOME`; the GUI store (web-persisted key/value) is MiniDb-backed.

## 10. Configuration and state locations

Everything lives under `KIMI_CODE_HOME` (default `~/.kimi-code`):

| Path | Purpose |
| --- | --- |
| `config.toml` | Agent/runtime configuration (providers, models, permissions, experimental flags). |
| `tui.toml` | Terminal UI client preferences (theme, status line, notifications). |
| `server.token` | Persistent bearer token (0600) protecting `/api/v1`. |
| `server/instances/*.json` | Multi-instance registry (heartbeats). |
| `server/events/` | WS session event journal. |
| `search-index` | MiniDb global search index. |
| `bin/rg` | Cached ripgrep binary used by search/grep tools. |

## 11. Distribution

- **npm**: `@mbuckaway/kimi-code` publishes `dist`, `dist-web`, `native`, and the postinstall scripts. `postinstall.mjs` evicts a legacy Python `kimi` shim on global installs. Node `>=24.15` (root `engines`, enforced with `engine-strict`), pnpm 10.33.
- **Native binary**: a Node **SEA** (single executable application) built by `apps/kimi-code/scripts/native/*` (`build:native:sea`), with the `dist-web` bundle and the MiniDb/search workers embedded in the blob; macOS binaries are re-signed. The Nix flake (`flake.nix`) builds and installs that binary, wrapping PATH with `ripgrep` and `fd`, and provides a devShell (nodejs 24, pnpm, rg, fd).
- **Installers**: `fork/install.sh` (and the upstream install scripts) fetch the native binary; the CLI also self-updates (`upgrade` subcommand, `gh-pages` update channel on the fork).

## 12. Native dependencies (what a port must contend with)

Most of the codebase is pure TypeScript. The native/foreign pieces are concentrated:

- `node-pty` (native PTY) — terminals, used by both engines and kap-server's `/api/v1/terminals`.
- `fsevents` (macOS filesystem events), `@mariozechner/clipboard` (native clipboard) — optional deps.
- `@jsquash/webp` (WASM) — WebP decode for image compression.
- `rg` (ripgrep binary) — invoked as a subprocess for search/grep.
- SEA packaging itself (postject, code signing) is Node-specific.

See [`rust-port-review.md`](./rust-port-review.md) for the implications of these for a Rust port.
