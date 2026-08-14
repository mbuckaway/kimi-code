---
'@moonshot-ai/agent-core-v2': patch
'@moonshot-ai/agent-core': patch
---

Classify context-limit 401 responses ("supports only N context") as context overflow rather than auth, so no pointless token refresh is forced and ACP clients see the provider message instead of "Authentication required".
