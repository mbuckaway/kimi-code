---
"@moonshot-ai/kimi-code": patch
---

Prevent `kimi acp` from hanging indefinitely when a session turn or a question never resolves: the turn now ends as cancelled and the question falls back to its default option.
