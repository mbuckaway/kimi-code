---
"@moonshot-ai/kimi-code": patch
---

Fix `kimi web --allowed-host` (and `KIMI_CODE_ALLOWED_HOSTS`) matching host headers case-insensitively, so an uppercase allowlist entry no longer silently fails to match.
