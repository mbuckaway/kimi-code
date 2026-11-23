---
"@moonshot-ai/kimi-code": patch
---

`kimi web` now stops on Ctrl+C or `kill` within seconds instead of hanging when a client stops responding, prints the shutdown it is doing, and exits with the signal's status code (130 for Ctrl+C, 143 for `kill`) rather than 0.
