# claude-ui

Claude-style terminal UI for Pi: editor, footer, tool rendering, and themes.

| File | Purpose |
|------|---------|
| `claude-editor.ts` | Custom editor with the bordered input and working indicator |
| `claude-footer.ts` | Footer with cwd, git branch, model, usage, and extension statuses |
| `claude-tools.ts` | Claude-style rendering for the built-in tools (read, edit, bash, …) |
| `claude-uniform.ts` | Uniform tool-call rows and streamed output rendering |
| `claude-shared/` | Shared state and styling helpers (not loaded as extensions) |
| `themes/` | `claude-light` and `claude-dark` |

Enable the theme pair in `~/.pi/agent/settings.json`:

```json
{ "theme": "claude-light/claude-dark" }
```
