#!/usr/bin/env bash
# Build the menu-bar app bundle.
#
# It must be a real .app, not a bare executable: macOS grants Microphone access
# per application and will silently deny a loose Unix binary — no prompt, no
# error, just empty recordings. The Info.plist usage strings are what make the
# prompt appear at all, and ad-hoc signing stops the grant resetting every time
# the binary is rebuilt.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/bin/glance.app"

swiftc -O "$ROOT/native/cursor-display.swift" -o "$ROOT/bin/cursor-display"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O "$ROOT/native/glance-hotkey.swift" -o "$APP/Contents/MacOS/glance"
cp "$ROOT/native/Info.plist" "$APP/Contents/Info.plist"
codesign --force --sign - --identifier com.glance.app "$APP"
echo "built: $APP"
