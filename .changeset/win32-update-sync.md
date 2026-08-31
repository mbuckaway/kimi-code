---
"@moonshot-ai/kimi-code": patch
---

Fix native updates on Windows: the staged updater now extracts the downloaded zip before installing (System32 tar with a PowerShell `Expand-Archive` fallback), so win32-x64/arm64 upgrades install reliably; the release manifest now fails loudly if any supported platform's artifacts are missing.
