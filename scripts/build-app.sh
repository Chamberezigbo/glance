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
# Prefer a stable identity. Ad-hoc signatures are a hash of the binary, so they
# change on every build and macOS silently drops the Screen Recording and
# Microphone grants each time. See scripts/make-signing-cert.sh.
IDENTITY="Glance Local Signing"
# Note: `find-identity -v` lists only identities chaining to a trusted anchor,
# so a self-signed root never appears there even when codesign accepts it
# happily. Ask without -v, which lists what codesign can actually use.
if security find-identity -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  codesign --force --sign "$IDENTITY" --identifier com.glance.app "$APP"
  echo "signed with stable identity: $IDENTITY (permissions survive rebuilds)"
else
  codesign --force --sign - --identifier com.glance.app "$APP"
  echo "signed ad-hoc — permissions will reset on every rebuild."
  echo "   Run: bash scripts/make-signing-cert.sh   to fix this permanently."
fi
echo "built: $APP"
