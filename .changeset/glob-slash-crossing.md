---
'@moonshot-ai/agent-core-v2': patch
'@moonshot-ai/agent-core': patch
---

Match permission-rule glob subjects as opaque text (so `*` crosses `/` for commands, URLs, and search subjects) while path subjects keep path semantics.
