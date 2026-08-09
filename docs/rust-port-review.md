# Porting kimi-code to Rust, and moving the web UI out of the distribution

> This is a **secondary, exploratory** review. The primary document is [`architecture.md`](./architecture.md), which describes how Kimi Code works today; this one asks "what if we rewrote the CLI in Rust, and what if the web UI stopped shipping inside the CLI package and ran on a web host such as AWS Amplify?". The Rust port is a speculative exercise that may never happen. Everything factual here is grounded in the current `fork/main` source (paths cited) or the linked sources; difficulty ratings and person-month figures are **estimates**, clearly labeled as such.

## 1. What a Rust port would touch

The CLI is a TypeScript monorepo (see [`architecture.md`](./architecture.md#2-monorepo-layout)). The pieces a port must contend with, in rough order of size:

| Piece | TS implementation | What it is |
| --- | --- | --- |
| Agent engine | `packages/agent-core-v2` (+ legacy `packages/agent-core`) | The core: DI × Scope, agent loop, LLM requester, tool executor, permissions, sessions |
| TUI | `packages/pi-tui` + `apps/kimi-code/src/tui/` | Terminal UI (self-authored, differential rendering) |
| LLM abstraction | `packages/kosong` (v1) and `agent-core-v2/src/kosong/` (v2) | Provider layer: Kimi, Anthropic, OpenAI, Google GenAI |
| Local server | `packages/kap-server` | Fastify 5, REST `/api/v1` + WS `/api/v1/ws`, auth, debug RPC |
| Tools & FS | `agent-core-v2/src/agent/tools/os/` + `src/os/` + `src/workspace/` | bash/glob/grep/read/write, `IHostFileSystem`, path confinement, `rg` subprocess |
| Storage | `packages/minidb` | Embedded KV with WAL/snapshot + full-text search index |
| Skills/plugins/MCP | `agent-core-v2/src/app/skillCatalog/`, `src/app/plugin/`, `src/mcpCore/` | Skill discovery, marketplace plugins, MCP clients |
| Transcript layer | `packages/transcript` | Idempotent event store + view registry (used by server + web) |
| OAuth/telemetry | `packages/oauth`, `packages/telemetry` | Kimi platform OAuth, event telemetry |
| Packaging | SEA + `postject` + Nix flake | Single-executable Node binary, code signing |

Native/foreign dependencies that constrain a port (verified in `apps/kimi-code/package.json` and source): `node-pty` (PTY terminals), `fsevents` (macOS FS watch), `@mariozechner/clipboard`, `@jsquash/webp` (WASM image decode), and the `rg` binary invoked as a subprocess (`agent-core-v2/src/workspace/workspaceFs/internal/runRg.ts`).

## 2. Subsystem-by-subsystem assessment

Difficulty is relative to a team that already knows both codebases: **Low** = weeks, **Medium** = 1–3 months, **High** = multiple months to a year+. These are order-of-magnitude engineering estimates, not commitments.

| Subsystem | Rust approach | Difficulty | Notes |
| --- | --- | --- | --- |
| Agent engine (v2) | Port `agent-core-v2` semantics: async `tokio`, scopes via typed structs/RAII, features via traits | **High** | The biggest single surface. The DI × Scope model (LifecycleScope `App → Workspace → Session → Agent`, Service/Fiber units) maps to Rust lifetimes/ownership awkwardly; the agent loop, permission policies, and session persistence are all logic-heavy. The legacy **v1 engine doubles this** — port v2 only (see §3). |
| TUI | `ratatui` (immediate-mode, v0.31.x, ~21k stars, used by atuin/gitui/yazi/bottom) | **Medium–High** | `pi-tui` is self-authored so there is no license concern, but `KimiTUI` is a large surface: markdown rendering (would use `pulldown-cmark` + a syntax highlighter), editor, select lists, kitty-graphics images, slash commands. UI parity is fiddly. |
| LLM layer | `reqwest`/`hyper` + streaming SSE/JSON per provider | **Medium** | Straightforward HTTP work; provider APIs are documented REST. Effort is in streaming semantics, tool-call loops, and capability catalog parity. |
| Local server | `axum` + `tokio-tungstenite` | **Medium** | The `/api/v1` contract (envelope, routes, WS frames, seq/epoch cursors) is well-specified and mostly transport-agnostic; a Rust server could reimplement it. Auth (bearer token, bcrypt password) maps cleanly. |
| Tools & FS | `tokio::fs`, `grep`/`ignore` crates (ripgrep is Rust — embed instead of subprocess), `run_script`/`portable-pty` | **Medium** | Path-confinement + symlink-verification logic must be ported faithfully — security-sensitive. |
| Storage | `redb` / `rusqlite` / `sled` | **Medium** | `minidb` (WAL + snapshot, full-text/trigram index) has no direct Rust equivalent; reimplement on SQLite or a KV crate. The search index semantics (compound/dt/text indexes) are the subtle part. |
| Skills/plugins | Markdown-skill parsing (frontmatter) + plugin store | **Low–Medium** | The skill format is files on disk — portable. Plugin marketplace engine is smaller. |
| MCP client | `rmcp` — the official Rust SDK for MCP (modelcontextprotocol/rust-sdk) | **Low–Medium** | Mature crate; stdio/HTTP/SSE transports, OAuth. |
| PTY | `portable-pty` (cross-platform PTY crate) | **Low** | Direct `node-pty` analog. |
| Transcript layer | Reimplement idempotent op store | **Medium** | Pure logic, but the op-batch contract is subtle and is the contract the web UI depends on. |
| OAuth/telemetry | `oauth2` crate + custom event client | **Low** | Well-trodden. |
| Packaging | `cargo` + platform installers (e.g. `cargo-dist`) | **Medium** | SEA/`postject` is Node-specific; a Rust port replaces it entirely (one static binary per platform, smaller, no Node runtime). Gains: startup time, memory, single-binary distribution. |
| Web bundle | **unchanged** (Vue SPA) | n/a | The `dist-web` bundle is static assets; the Rust server serves it the same way kap-server does (`/` + SPA fallback). |

## 3. Cross-cutting considerations

- **Port v2 only.** The CLI ships two engines mid-migration (`KIMI_CODE_LEGACY_FLAG=1` selects v1). A Rust port should target the v2 engine semantics and drop v1; keeping both would roughly double the work.
- **The cleanest port boundary is the API, not the process.** kap-server's `/api/v1` + `/api/v1/ws` contract is language-neutral (envelope, JSON, WS frames; see `packages/protocol` and `packages/kap-server/src/protocol/`). That means two very different port strategies:
  1. **Faithful in-process port** — reimplement the engine + TUI + server in Rust, keep the web bundle. This is the full effort.
  2. **Rust as a client** — if the engine is hosted remotely (the web-extraction scenario in §4), a Rust `kimi` could be a thin TUI client over the same `/api/v1` API. This is dramatically cheaper and is the strategic intersection of the two questions.
- **Test surface**: the repo enforces TDD and 90%+ coverage (root `AGENTS.md`); a port inherits that bar, which dominates the schedule.
- **The SDK/klient/ACP/vis surfaces** (`node-sdk`, `klient`, `acp-server`, `apps/vis`, `apps/kimi-inspect`) would all need decisions: port, drop, or keep as Node sidecars. `apps/vis` and `kimi-inspect` are debug tooling that could stay on Node and talk to the Rust server over `/api/v1/debug/*`.
- **Ecosystem gaps are smaller than they look**: the heaviest native pieces (PTY, ripgrep, MCP) already have Rust analogs; the genuinely hard parts are the agent-engine semantics and the transcript/search index subtleties.

### Net estimate

A **faithful v2-only port** of the CLI (engine + TUI + server + storage + tests, web bundle unchanged) is roughly a **2–4 person-year** engineering effort for a team familiar with both codebases — call it a senior-team year-plus to first parity. A **Rust client-only** approach against a hosted engine is weeks-to-months. The numbers are estimates; the ordering (engine ≫ TUI ≈ storage > server > tools) is the reliable part.

**What a port buys**: a single static binary per platform with no Node runtime, faster startup and lower memory, embeddable ripgrep, and (arguably) stronger safety for the file/process-facing surfaces. **What it costs**: TypeScript's rapid iteration, the existing 90%-coverage test suite, and the entire package ecosystem (`smol-toml`, `marked`, SDKs) — plus the risk of behavioral drift in subtle agent-loop semantics. For a product moving as fast as this, the honest recommendation is: do not port unless there's a concrete distribution/performance driver.

## 4. Moving the web UI out of the distribution

Today the web UI ships **inside** the CLI package as the prebuilt `apps/kimi-code/dist-web` bundle and is served by the CLI's own server (`kimi web`). "Moving it out" has two separable halves:

### 4.1 Hosting the SPA (the easy half)

The bundle is a static SPA (`pnpm build` in `kimi-code-web` → `dist/`, ≈22 MB of static files). Any static host works. On **AWS Amplify**:

- Amplify Hosting serves static apps directly, and its **200 rewrites** can map any path to `index.html` for SPA fallback ([AWS docs — redirects and rewrites](https://docs.aws.amazon.com/amplify/latest/userguide/redirects.html)) — exactly the `/*` → `index.html` fallback kap-server implements in `packages/kap-server/src/routes/webAssets.ts`.
- Cost: nothing exotic; a branch-based deploy pipeline. This half is **Low** effort — essentially a CI job that builds `kimi-code-web` and deploys to Amplify.

### 4.2 The API/backend (the real work)

The SPA is useless without a reachable `/api/v1` server, and today that server only exists locally. The web app is deeply coupled to that local model (all verified in `kimi-code-web` source):

1. **Same-origin by default; CORS is an explicit allowlist.** The app defaults to `window.location.origin` (`src/api/config.ts`). kap-server does implement CORS, but only against an explicit origin allowlist (`KIMI_CODE_CORS_ORIGINS`, no `*` wildcard — `packages/kap-server/src/middleware/origin.ts`): same-origin or Origin-less requests pass, and a cross-origin request is answered (with `Access-Control-Allow-*` echoed) only when its full origin is allowlisted. A hosted deployment must put the app's origin on that allowlist.
2. **WS origin handling.** The same `isOriginAllowed` rule gates the `/api/v1/ws` upgrade — a present-but-disallowed browser `Origin` is rejected. In development the Vite proxy strips the browser `Origin` header so the server sees an Origin-less (non-browser) request; a hosted deployment must configure the allowlist (or strip/relay the header via a proxy) rather than relying on the dev proxy.
3. **Auth is a local bearer token.** The token is minted by the local server (`<home>/server.token`) and delivered to the browser via a `#token=` URL fragment; the app caches it in `localStorage` (7-day TTL). A hosted deployment needs a real login flow (or an authenticated token relay) instead of a locally-minted token.
4. **WebSockets are load-bearing.** Streaming, approvals, questions, tasks, terminals, and transcript deltas all flow over one long-lived `/api/v1/ws` connection with reconnect + cursor resync. The hosting story must provide a persistent WS endpoint.
5. **The server is a filesystem + process controller, not a stateless API.** The UI drives `fs:read/list/grep/diff/open`, `git_status`, PTY terminals, skills, and workspace folders on the machine the engine runs on. "Remote hosting" therefore means hosting an agent/workspace server, not just the SPA.

On **AWS Amplify** specifically: Amplify Hosting's redirect/rewrite feature is an **HTTP-level** mechanism ([AWS docs](https://docs.aws.amazon.com/amplify/latest/userguide/redirects.html); reverse-proxy usage documented in community reports such as [amplify-hosting#2839](https://github.com/aws-amplify/amplify-hosting/issues/2839)). It can serve the SPA and forward HTTP `/api/v1` to a backend, but there is no documented WebSocket proxying through Amplify rewrites — the WS endpoint would need its own route (e.g. a managed WS service, an AppSync WebSocket API, or a plain server/container), and the app would connect to a separate `wss://` endpoint. TLS, Origin handling, and the auth story are all on the deployment, not the web app.

### Net assessment

- **Move the SPA to Amplify (or any static host): Low effort.** Pure CI/build work.
- **Make the app work against a remote server: Medium-to-High.** The work is (a) server-side: CORS/Origin policy, TLS, WS endpoint, remote-safe auth; (b) app-side: remote URL configuration (exists via `VITE_KIMI_SERVER_HTTP_URL`), login instead of `#token=`, and re-examining the localStorage bearer-token risk that was accepted "only for a local loopback-only server" (noted in the web repo's own review docs).
- The strategic caveat: hosting the engine remotely **is** the "Rust client" port path from §3 — a thin client is enough once the engine is a hosted service. The two ideas compound.

## 5. Verdict

1. **Architecture today is sound for its purpose**: one local process, a language-neutral `/api/v1` + WS contract, and a fully decoupled web SPA shipped as a prebuilt bundle. That contract is what makes both the port and the extraction questions tractable.
2. **Rust port**: feasible, but a faithful v2-only port is a multi-person-year project with real behavioral-drift risk; a client-only Rust rewrite against a hosted engine is cheap. Don't port without a concrete driver.
3. **Web extraction**: hosting the SPA is trivial (Amplify works for that); making the app work against a remote server is the actual project, and it's primarily a server/auth/WS problem, not a frontend problem.
