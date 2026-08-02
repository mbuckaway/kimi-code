---
"@moonshot-ai/kimi-code": patch
---

Show a clear usage-limit notice when the account's plan quota is exhausted, instead of a raw provider error or a silent spinner, and stop requeueing background agent work that cannot proceed until the quota window resets.
