# session-name

Kebab-case session names for Pi, modeled on Claude Code:

- `/rename` — generate a short kebab-case name from the conversation.
- `/rename fix-login-bug` — set one manually (always wins over AI names).
- **Automatic** — after the first exchange a name is generated, and it is
  regenerated at the configured user-turn count while the name is still
  AI-generated.

The name is what Pi shows in the `/resume` session list, and
[claude-ui](../claude-ui/) renders it on the first footer line.

## Config (`~/.pi/agent/session-name.json`, optional)

```json
{
  "autoGenerate": true,
  "regenerateAfterTurns": 3,
  "model": ""
}
```

- `autoGenerate` — turn automatic naming off entirely.
- `regenerateAfterTurns` — user-turn count for the one-time regeneration
  (0 disables it).
- `model` — `"provider/id"` used for name generation; empty uses the current
  model.

## Environment

- `SESSION_NAME_CONFIG` — alternate config file path.
- `SESSION_NAME_TEST=1` — allow automatic naming without a UI (headless
  testing) and log generated names to stderr.
