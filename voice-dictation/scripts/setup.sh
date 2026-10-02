#!/bin/bash
# One-time setup for the Voice Dictation extension: build the native helpers and
# write a default config file if none exists.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/build-native.sh"

CONFIG="$HOME/.pi/agent/voice-dictation.json"
if [ ! -f "$CONFIG" ]; then
  mkdir -p "$(dirname "$CONFIG")"
  cat > "$CONFIG" <<'JSON'
{
  "keybind": "ctrl+r",
  "provider": "auto",
  "fileProvider": "auto",
  "locale": "",
  "context": true,
  "extraTerms": [],
  "capture": {
    "ffmpegPath": "ffmpeg",
    "input": ":0"
  },
  "deepgram": {
    "apiKeyEnv": "DEEPGRAM_API_KEY",
    "apiKey": "",
    "keychainService": "apple-voice-deepgram",
    "model": "nova-3",
    "language": "",
    "endpointingMs": 300
  }
}
JSON
  echo "Wrote $CONFIG"
else
  echo "Keeping existing $CONFIG"
fi

echo
echo "Next: reload Pi (/reload), then hold Space or press Ctrl+R to dictate."
