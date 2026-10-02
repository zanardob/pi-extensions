# pi-extensions

Personal extensions for the [Pi coding agent](https://pi.dev).

## Extensions

| Extension | Description |
|-----------|-------------|
| [claude-ui](claude-ui/) | Claude-style editor, footer, tool rendering, and the `claude-light`/`claude-dark` themes |
| [voice-dictation](voice-dictation/) | Push-to-talk dictation with Apple on-device or Deepgram Nova-3 engines (macOS 26+) |
| [usage](usage/) | `/usage` dashboard: cost, tokens, and messages by provider/model |
| [aliases](aliases/) | Command aliases: `/exit` for `/quit`, `/rename` for `/name` |

## Install

```bash
pi install git:github.com/zanardob/pi-extensions
```

Then reload Pi with `/reload`.

To enable only a subset, replace the package entry in `~/.pi/agent/settings.json` with a filtered one:

```json
{
  "packages": [
    {
      "source": "git:github.com/zanardob/pi-extensions",
      "extensions": ["claude-ui/claude-editor.ts", "claude-ui/claude-footer.ts"]
    }
  ]
}
```

## Setup

Most extensions work as soon as the package loads. `voice-dictation` needs its
native helpers built once:

```bash
voice-dictation/scripts/setup.sh
```

See each extension's README for details.
