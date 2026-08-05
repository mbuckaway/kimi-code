---
"@moonshot-ai/kimi-code": patch
---

Keep the `kimi acp` socket transport working now that the command defaults to the new engine: `--socket <path>` and `[acp].socket` serve each connection from its own engine instance sharing the on-disk session store.
