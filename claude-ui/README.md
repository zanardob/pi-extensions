# claude-ui

Claude-style terminal UI for Pi: editor, footer, tool rendering, and themes.
Loaded as a single extension (`index.ts`) that composes four feature modules.

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point — registers all modules below |
| `claude-editor.ts` | Custom editor with the bordered input and working indicator |
| `claude-footer.ts` | Footer with cwd, git branch, model, usage, and extension statuses |
| `claude-tools.ts` | Claude-style rendering for the built-in tools (read, edit, bash, …), plus file-tool guidelines |
| `claude-uniform.ts` | Uniform tool-call rows for every other tool |
| `claude-shared/` | Shared state and styling helpers |
| `themes/` | `claude-light` and `claude-dark` |

Enable the theme pair in `~/.pi/agent/settings.json`:

```json
{ "theme": "claude-light/claude-dark" }
```
