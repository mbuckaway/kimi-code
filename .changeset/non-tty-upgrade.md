---
'@moonshot-ai/kimi-code': patch
---

`kimi upgrade` in a non-TTY environment now runs the automatic install and reports failure with a non-zero exit instead of silently exiting 0.
