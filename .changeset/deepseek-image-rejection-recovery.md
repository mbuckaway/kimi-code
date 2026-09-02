---
"@moonshot-ai/kimi-code": patch
---

Fix image upload rejections freezing the session: when a provider rejects an image, the image is no longer re-sent, so the conversation continues without restarting.
