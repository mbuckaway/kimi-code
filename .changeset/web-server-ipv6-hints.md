---
"@moonshot-ai/kimi-code": patch
---

`kimi web` lists IPv6 interface hints only for an IPv6 wildcard bind with `--ipv6`, and a server bound to an IPv6 address now accepts requests instead of rejecting every `Host` header with 403. An IPv6 bind such as `--host ::1` now prints a usable bracketed URL instead of failing to start.
