---
"@moonshot-ai/kimi-code": minor
---

`kimi web` reads its host, port, log level, and every other server option from a new `[server]` section in config.toml, with command-line flags still overriding the file; set them once instead of retyping them on every start.
