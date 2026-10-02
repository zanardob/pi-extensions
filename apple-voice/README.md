# Apple Voice — dictation for Pi

Live push-to-talk dictation with two interchangeable engines:
Deepgram Nova-3 (cloud, Claude Code's engine) or Apple on-device.

## Layout

| Path | Purpose |
|------|---------|
| `index.ts`, `config.ts`, `deepgram.ts` | Pi extension (this directory) |
| `native/apple-voice.swift` | Live helper: mic → Apple `DictationTranscriber`, streams NDJSON (`volatile`/`final`) |
| `native/apple-stt.swift` | One-shot file transcription CLI (`DictationTranscriber`, SpeechTranscriber fallback) |
| `~/.pi/agent/apple-stt/` | Built helper binaries (runtime; produced by `scripts/build-native.sh`) |
| `~/.pi/agent/apple-voice.json` | Configuration (below) |
| [claude-ui](../claude-ui/) | Renders extension statuses (voice hint) in the footer |

## Setup

```bash
scripts/setup.sh
```

Builds both helpers into `~/.pi/agent/apple-stt/` and writes a default
`~/.pi/agent/apple-voice.json` if one does not exist.

Requirements: macOS 26+ and a Swift toolchain (Xcode Command Line Tools) to
build the helpers; `ffmpeg` in `PATH` for Deepgram microphone capture. Deepgram
also needs an API key (env `DEEPGRAM_API_KEY`, config `deepgram.apiKey`, or
Keychain); without one, the Apple on-device engine is used.

Rebuild after editing a helper:

```bash
scripts/build-native.sh
```

## Behavior

- **Hold Space** to talk (release to stop) or **Ctrl+R** to toggle.
- Transcript streams into the editor while speaking; Enter sends.
- Engine: `provider: auto` uses Deepgram when a key resolves, else Apple.
- **Keyterms**: global coding terms + project folder + git branch, sent as
  `AnalysisContext.contextualStrings` (Apple) or `keyterm` params (Deepgram) —
  ported from Claude Code's `voiceKeyterms`.
- **Indicator**: footer status only — `voice: hold space · ctrl+r`, then
  `● recording 0:07`, `● finalizing…`.
- **Tool**: `transcribe_audio` for local files (Deepgram pre-recorded when a
  key is configured, otherwise the `apple-stt` CLI).

## Config (`~/.pi/agent/apple-voice.json`)

- `keybind` — toggle shortcut (env `APPLE_VOICE_KEYBIND` wins).
- `provider` / `fileProvider` — `auto` | `deepgram` | `apple`.
- `locale` — BCP-47 id (`"en-GB"`); empty = system.
- `context` / `extraTerms` — keyterm boosting on/off and custom terms.
- `capture` — `{ ffmpegPath, input }` for Deepgram mic capture (`":0"` = default device).
- `deepgram` — key resolution order: `apiKeyEnv` env var → `apiKey` → Keychain
  (`keychainService`), plus `model`, `language`, `endpointingMs`.

Push-to-talk tuning lives in `index.ts`: `HOLD_EVENTS`, `HOLD_FIRST_GAP_MS`,
`HOLD_GAP_MS`, `HOLD_RELEASE_MS`, `HOLD_PRESS_MS`.

## Environment overrides

- `APPLE_VOICE_CONFIG` — alternate config file path.
- `APPLE_VOICE_BIN` / `APPLE_STT_BIN` — alternate helper binaries.
- `APPLE_VOICE_FILE` — feed a file instead of the mic (testing).
