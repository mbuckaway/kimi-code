---
"@moonshot-ai/kimi-code": patch
---

`POST /api/v1/shutdown` now closes the Remote Control tunnel and flushes telemetry first, so a `kimi web --rc` server exits after an API shutdown instead of lingering.
