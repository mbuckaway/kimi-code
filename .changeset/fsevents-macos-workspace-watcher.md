---
"@moonshot-ai/kimi-code": patch
---

Fix tools like Bash becoming unavailable in kimi web on macOS in large workspaces: the workspace file watcher now uses the native FSEvents API instead of one fs.watch handle per file, avoiding file-descriptor exhaustion.
