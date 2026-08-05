# `kimi acp` Subcommand

`kimi acp` switches Kimi Code CLI to **ACP (Agent Client Protocol)** mode: it communicates with an ACP client (such as Zed, JetBrains AI Chat, etc.) via JSON-RPC over stdin/stdout, letting the IDE directly drive kimi's sessions, prompts, and tool calls.

```sh
kimi acp
```

Once started, the command prints no banner and immediately waits for the ACP client to send an `initialize` request on stdin. Logs are written to stderr (as well as the diagnostic log under `~/.kimi-code/logs/`), so the ACP channel itself stays clean.

::: tip Who calls this?
You typically do not need to run `kimi acp` manually — this command is the subprocess entry point for IDEs. For IDE-side configuration, see [Using in IDEs](../guides/ides.md).
:::

## Socket transport

By default `kimi acp` talks to a single client over stdin/stdout, so every client spawns its own CLI child process. The `--socket` flag pivots the command into a long-lived local server: it listens on a Unix domain socket (a special file used for communication between local processes) on macOS/Linux, or a named pipe (`\\.\pipe\...`) on Windows, and several clients can stay connected to the same process at once. The ACP protocol itself is unchanged — only the byte channel it travels over.

```sh
kimi acp --socket ~/.kimi-code/acp.sock
```

To make socket mode the default, set `[acp].socket` in `config.toml`. An explicit `--socket` flag always overrides the config value; with neither, the command falls back to stdio.

```toml
[acp]
socket = "/Users/you/.kimi-code/acp.sock"
```

Once bound, the server prints `acp server listening on <path>` to stderr and stays in the foreground. `Ctrl-C` (SIGINT) or SIGTERM drains in-flight sessions, removes the socket file, and exits cleanly — run the command under launchd, systemd, or `nohup` if you want it permanently in the background.

::: warning Note
There is no authentication on the socket: any local process that can open it gets full agent access. On macOS/Linux the CLI tightens the socket to owner-only (`0600`, inside a `0700` directory), so keep the socket under your home directory — filesystem permissions are the entire access boundary.
:::

Clients connect with `net.createConnection` and speak the same newline-delimited JSON-RPC (ndjson — one JSON message per line) as stdio mode:

```ts
import { createConnection } from 'node:net';
import { Duplex } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const socket = createConnection('/Users/you/.kimi-code/acp.sock');
const { readable, writable } = Duplex.toWeb(socket);
// `client` implements the ACP Client interface (sessionUpdate, requestPermission, ...).
const conn = new ClientSideConnection(() => client, ndJsonStream(writable, readable));
await conn.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
const { sessionId } = await conn.newSession({ cwd: process.cwd(), mcpServers: [] });
```

Each connection gets its own independent set of sessions. Two clients cannot attach to the same live session — a second client calling `session/load` or `session/resume` on a session another client is actively driving starts a second engine-side copy. Use `session/list` to discover sessions left behind by earlier connections.

Socket mode targets the default engine (`agent-core-v2`), the same one `kimi acp` uses for stdio. Each accepted connection boots its own engine instance. Every instance reads and writes the same on-disk session store, so keep a given session live in only one client at a time. The legacy engine (`KIMI_CODE_LEGACY_FLAG=1`) works the same way.

The stock editor integrations (Zed, JetBrains, Paseo) only know how to spawn `kimi acp` as a stdio subprocess; socket mode is for custom clients — your own editor glue, a Python library, or other local tooling.

## Capability Matrix

The table below lists the capabilities declared by the current ACP adapter layer. The `agentCapabilities` field is returned in full in the `initialize` response, so the IDE can adjust its UI accordingly.

| Capability | Value | Description |
| --- | --- | --- |
| `promptCapabilities.image` | `true` | Supports ACP `image` content blocks (base64 + mimeType) |
| `promptCapabilities.audio` | `false` | Audio prompts not yet supported |
| `promptCapabilities.embeddedContext` | `true` | Client may send `resource`/`resource_link` embedded resource blocks; text content is injected into the prompt as `<resource uri="...">...</resource>`; blob resources are dropped with a warn |
| `mcpCapabilities.http` | `true` | Forwards HTTP MCP services configured by the IDE |
| `mcpCapabilities.sse` | `true` | Forwards legacy SSE MCP services configured by the IDE |
| `loadSession` | `true` | Supports `session/load` to resume an existing session, replaying history on load |
| `sessionCapabilities.list` | `{}` | Supports `session/list` to enumerate the current user's sessions |

## ACP Method Coverage

The spec divides methods into a **stable** surface and an evolving **unstable** surface (handlers mounted with the `unstable_*` prefix in `@agentclientprotocol/sdk@0.23.0`). The two have entirely different stability guarantees — the stable surface covers methods every production ACP client uses, while the unstable surface covers experimental extensions (inline-edit prediction, document buffer sync, provider management, elicitation, etc.) — so they are tracked separately.

**Summary: stable agent-side 10/12 (83%) + client reverse-RPC 4/9 (44%); unstable surface has only `session/set_model` (1/19).** All methods needed for a normal agent flow (initialize → auth → new/load/resume → prompt → cancel + file I/O + tool approval) are implemented.

### Stable agent-side — IDE → agent (10 / 12)

| Method | Implemented | Description |
| --- | --- | --- |
| `initialize` | Yes | Version negotiation; returns `agentInfo: { name: 'Kimi Code CLI', version }`, capability matrix, and `authMethods` |
| `authenticate` | Yes | Validates `method_id='login'`; returns `authRequired (-32000)` if token is missing, `invalidParams (-32602)` for unknown ID |
| `session/new` | Yes | Accepts `cwd` / `mcpServers`; returns `configOptions[]` |
| `session/load` | Yes | Restores a session from disk and replays history via `session/update` |
| `session/resume` | Yes | Lightweight sibling of `session/load`; skips history replay |
| `session/prompt` | Yes | Accepts `text` / `image` / `resource` / `resource_link` content blocks; streams `agent_message_chunk` |
| `session/cancel` | Yes | Interrupts the current turn |
| `session/list` | Yes | Enumerates sessions on disk (advertised via `sessionCapabilities.list = {}`) |
| `session/set_mode` | Yes | Compatibility path; dispatches to the same handler as `set_config_option({configId:'mode'})` |
| `session/set_config_option` | Yes | Unified model / thinking / mode picker dispatcher |
| `session/close` | No | |
| `logout` | No | |

### Stable client-side reverse-RPC — agent → IDE (4 / 9)

| Method | Implemented | Description |
| --- | --- | --- |
| `session/update` | Yes | Streams `agent_message_chunk` / `tool_call*` / `plan` / `config_option_update` / `available_commands_update` |
| `session/request_permission` | Yes | Shared channel for tool approval and question elicitation |
| `fs/read_text_file` | Yes | File reads at the kaos layer are routed to the client (advertised via `fsCapabilities`) |
| `fs/write_text_file` | Yes | File writes at the kaos layer are routed to the client |
| `terminal/create` · `output` · `release` · `kill` · `wait_for_exit` | No | Terminal reverse-RPC not connected; shell commands use local execution |

### Unstable surface (1 / 19)

| Method | Implemented | Description |
| --- | --- | --- |
| `session/set_model` | Yes | Compatibility path; equivalent to `set_config_option({configId:'model'})` |
| Remaining 18 methods | No | Includes session lifecycle extensions, buffer sync, inline-edit prediction, provider management, etc. |

All methods not listed above return `methodNotFound`.

## MCP Forwarding

When an ACP client provides `mcpServers` in `session/new` or `session/load`, the adapter layer performs the following conversions:

- `http` → kimi's `transport: 'http'` configuration
- `stdio` → kimi's `transport: 'stdio'` configuration
- `sse` → kimi's `transport: 'sse'` configuration
- `acp` → discarded with a warn log entry

## Next steps

- [Using in IDEs](../guides/ides.md) — Zed / JetBrains configuration steps and troubleshooting
- [`kimi` Command Reference](./kimi-command.md) — Complete subcommand list
