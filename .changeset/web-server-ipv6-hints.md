---
"@moonshot-ai/kimi-code": patch
---

`kimi web` no longer prints IPv6 addresses it is not listening on in the startup banner; pass `--ipv6` to include them. An IPv6 bind such as `--host ::1` now prints a usable bracketed URL instead of failing to start.
