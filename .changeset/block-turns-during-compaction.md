---
'@moonshot-ai/agent-core-v2': patch
---

Block turns while auto compaction is in flight so a commit-time history-safety race can no longer cancel the compaction and kill the user's turn.
