# Language Bug — Model replies in wrong language

## Observed behavior

When using the DeepSeek model (and occasionally other models) with plan mode enabled
on the mobile web UI, the model replies in Chinese or French instead of English,
even when the user writes in English. The model switches language mid-turn or
starts the turn in a non-English language without the user requesting it.

## Root cause

Two factors combined:

1. **Misleading system prompt phrasing** — Both `agent-core` and `agent-core-v2`
   `system.md` templates contained the phrase "even after long stretches of
   English tool output" in the Language section and Ultimate Reminders. This
   implies English output is foreign to the user, leading DeepSeek to infer
   Chinese from the Kimi product context.

2. **No explicit language directive** — The system prompt relied entirely on
   "Reply in the user's language" with no configurable fallback. Models that
   struggle with implicit language detection (notably DeepSeek) default to
   their training distribution.

Upstream issue: [MoonshotAI/kimi-code#1998](https://github.com/MoonshotAI/kimi-code/issues/1998)

## Fix applied

### 1. system.md text cleanup

Removed the misleading "even after long stretches of English tool output" clauses
from all four occurrences (Language section and Ultimate Reminders in both
`agent-core` and `agent-core-v2` `system.md` files).

### 2. Config-driven language directive

Added a `[language]` section to `config.toml`:

```toml
[language]
# Language the model should reply in. Default: "en".
# Set to "auto" (or leave empty) to use the model's built-in detection.
# Supported values: any ISO 639-1 code (en, zh, fr, ja, etc.)
reply_language = "en"
```

When set to a language code (e.g. `"en"`), the system prompt includes:

> Reply in English. Only switch languages if the user explicitly writes to you
> in another language. Never infer the user's language from project context,
> file contents, or tool output.

Env override: `KIMI_CODE_REPLY_LANGUAGE=fr`

This directive is rendered on every prompt (not just at session creation), so
language consistency is enforced throughout the conversation.

## How to configure

1. Edit `~/.kimi-code/config.toml` and add/edit the `[language]` section
2. Or set `KIMI_CODE_REPLY_LANGUAGE` environment variable
3. Restart kimi-code or the kap-server

## Future work

- Wire the web UI's `i18n.locale` to this config field so the UI language
  automatically determines the model's reply language
- Add a `[language]` section to the TUI settings dialog
