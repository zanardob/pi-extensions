#!/bin/bash
# Builds the native Voice Dictation helpers into the runtime directory that the
# extension expects (~/.pi/agent/voice-dictation by default).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
RUNTIME_DIR="${VOICE_DICTATION_DIR:-$HOME/.pi/agent/voice-dictation}"

mkdir -p "$RUNTIME_DIR"
swiftc -O -parse-as-library "$PACKAGE_DIR/native/apple-voice.swift" -o "$RUNTIME_DIR/apple-voice"
swiftc -O -parse-as-library "$PACKAGE_DIR/native/apple-stt.swift" -o "$RUNTIME_DIR/apple-stt"

echo "Built:"
echo "  $RUNTIME_DIR/apple-voice"
echo "  $RUNTIME_DIR/apple-stt"
