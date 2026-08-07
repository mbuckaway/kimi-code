---
"@moonshot-ai/kimi-code": patch
---

Harden the ACP socket transport and the macOS FSEvents workspace watcher. The socket server now keeps a permanent error handler after startup (a post-listen server error is logged instead of crashing every connected client), caps concurrent connections at 64, and warns on Windows that a named pipe carries no filesystem access boundary. The FSEvents watcher bounds its known-path set instead of growing it for the lifetime of the watch, and validates the loaded native module before use. Provider quota errors now report the real HTTP status rather than a hardcoded 429, and the native module hook normalizes redirect paths before joining them onto the asset cache root.
