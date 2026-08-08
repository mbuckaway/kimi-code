---
"@moonshot-ai/kimi-code": patch
---

Fix models replying in the wrong language. Replies now default to English and follow the `[language]` section in `config.toml` (or the `KIMI_CODE_REPLY_LANGUAGE` env var).
