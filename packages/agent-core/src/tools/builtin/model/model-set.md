Switches the active model for this session to the given alias. The switch is
guarded by the context window: a target model whose window is smaller than the
current model's window is rejected, because the existing conversation may not
fit. The change applies from the next turn.

The `role` argument selects what to change:
- `current` (default): switch the active model for this session.
- `default` / `planning`: persist the model as the default or planning model.
  Persisting is not supported by the legacy engine; use /model or the web
  settings instead.
