---
"@moonshot-ai/kimi-code": patch
---

TUI: stop serving a stale in-memory transcript after an external client (ACP attach, mobile) appends turns to the session's wire journal. The send guard now compares the journal's newest user turn against the last turn the TUI rendered and refuses input — with a reload hint — when an unseen external turn would fork the session into two divergent histories. Re-selecting the current session from `/sessions` and `/reload` now re-read the journal from disk and re-hydrate the transcript instead of short-circuiting on the stale view.
