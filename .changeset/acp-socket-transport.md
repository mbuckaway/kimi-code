---
"@moonshot-ai/kimi-code": minor
---

Add a socket transport to `kimi acp` so the agent can run as one long-lived local server that multiple clients connect to, instead of each client spawning its own stdio subprocess. Pass `--socket <path>` (or set `[acp].socket` in config.toml) to listen on a Unix domain socket (macOS/Linux) or Windows named pipe.
