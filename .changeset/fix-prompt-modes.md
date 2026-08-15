---
"@moonshot-ai/kimi-code": patch
---

Fix the web modes menu losing swarm and supermoon toggles on a new session before the first turn: the prompt submit route now applies swarm_mode and supermoon_mode like plan_mode.
