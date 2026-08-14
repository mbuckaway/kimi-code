---
'@moonshot-ai/agent-core-v2': patch
---

Flush the replayable wire before disposing an agent scope on session close so the tail assistant records are never dropped.
