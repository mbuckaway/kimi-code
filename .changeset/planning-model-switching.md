---
"@moonshot-ai/kimi-code": minor
---

Add a configurable planning model (`planning_model` in `config.toml`) that the agent switches to when plan mode is entered and reverts to the default model on exit, plus `modelquery`, `modellist`, and `modelset` tools with a context-window switch guard (only switches to a model whose context window is at least as large as the current model's).
