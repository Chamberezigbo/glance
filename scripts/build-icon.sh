#!/usr/bin/env bash
# Render the app icon and package it as an .icns.
#
# Each size is drawn at its own scale rather than scaled from one large
# artwork: below ~48px the outlined eye and its iris merge into a blob, so
# small sizes use a solid eye with the screen knocked out instead.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
SET="$TMP/glance.iconset"; mkdir -p "$SET"

swiftc -O "$ROOT/native/icon/make-icon.swift" -o "$TMP/make-icon"
"$TMP/make-icon" "$TMP"

cp "$TMP/icon_16.png"   "$SET/icon_16x16.png"
cp "$TMP/icon_32.png"   "$SET/icon_16x16@2x.png"
cp "$TMP/icon_32.png"   "$SET/icon_32x32.png"
cp "$TMP/icon_64.png"   "$SET/icon_32x32@2x.png"
cp "$TMP/icon_128.png"  "$SET/icon_128x128.png"
cp "$TMP/icon_256.png"  "$SET/icon_128x128@2x.png"
cp "$TMP/icon_256.png"  "$SET/icon_256x256.png"
cp "$TMP/icon_512.png"  "$SET/icon_256x256@2x.png"
cp "$TMP/icon_512.png"  "$SET/icon_512x512.png"
cp "$TMP/icon_1024.png" "$SET/icon_512x512@2x.png"

mkdir -p "$ROOT/native/icon"
iconutil -c icns "$SET" -o "$ROOT/native/icon/glance.icns"
echo "built: native/icon/glance.icns"
