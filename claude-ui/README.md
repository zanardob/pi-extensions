# claude-ui

Claude-style terminal UI for Pi: editor, footer, tool rendering, and themes.
Loaded as a single extension (`index.ts`) that composes five feature modules.

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point — registers all modules below |
| `claude-editor.ts` | Custom editor with the bordered input and the ❯ gutter inside it |
| `claude-footer.ts` | Footer with session name and age, model, thinking level, context, cost, cwd, git branch and stats, extension statuses |
| `claude-tools.ts` | Claude-style rendering for the built-in tools (read, edit, bash, …), plus file-tool guidelines |
| `claude-uniform.ts` | Uniform tool-call rows for every other tool |
| `claude-markers.ts` | ● on assistant text and ❯ on the prompt, drawn over pi's own message components |
| `claude-shared/` | Shared state and styling helpers |
| `themes/` | `claude-light` and `claude-dark` |

Enable the theme pair in `~/.pi/agent/settings.json`:

```json
{ "theme": "claude-light/claude-dark" }
```
