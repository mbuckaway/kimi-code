---
"@moonshot-ai/kimi-code": patch
---

Keep large cross-session registries responsive under load by coalescing heartbeat writes and bounding registry file I/O, and make server shutdown finish within a fixed budget on a busy machine.
