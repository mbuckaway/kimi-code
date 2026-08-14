---
"@moonshot-ai/kimi-code": patch
---

Fix `kimi -p` refusing to start when the provider key comes only from the environment: the auth readiness gate now falls back to `process.env` through the provider's declared `apiKeyEnv`, with explicit `config.toml` credentials (inline `apiKey`, `[providers.<id>.env]`, oauth) still taking precedence.
