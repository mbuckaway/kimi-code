---
"@moonshot-ai/kimi-code": minor
---

- web: port upstream 0.35/0.36 web UI improvements — composer work-mode pills (plan/goal) with a Swarm and Supermoon toolbar chip and an Add menu for arming modes, plus plan-armed intent; slash and @-mention menu restyle with pinyin fuzzy search and close-on-blur; assistant reply timestamps now show the message time; fullscreen image/video preview with image zoom; dock task status filter with a task detail pane and a subagent card grid; dock goal/plan tabs with a goal panel and plan viewer; session-title generation and workspace recency sorting; and baseline fixes (failure-card resume, flat sidebar view, failed-only badges, IME-safe renaming, skill-activation attachments, retry wording, approval-dock layout).
- web: add a plugin marketplace and capability management panel to Settings (installed plugins with enable/remove and content counts, marketplace browse and install, custom plugin install, capability install progress).
- web: cache content-hashed web assets as immutable (1 year) while revalidating the entry point, and remove the 64 MiB session-export limit.
