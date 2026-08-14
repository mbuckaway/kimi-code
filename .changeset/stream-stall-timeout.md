---
'@moonshot-ai/agent-core-v2': patch
---

Add a streaming idle/stall timeout (KIMI_CODE_STREAM_STALL_TIMEOUT_MS, default 300s) to the model-request path so a stalled provider stream aborts like a cancel and persists the partial content.
