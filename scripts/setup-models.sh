#!/usr/bin/env bash
# Download whisper models from Hugging Face.
#
# Hugging Face rather than GitHub Releases: Releases downloads at ~16 KB/s on
# some networks, which turns a 2-minute job into an hour.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/models"
BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

mkdir -p "$DEST"
for M in ggml-base.en.bin ggml-tiny.en.bin; do
  if [ -s "$DEST/$M" ]; then
    echo "==> $M already present, skipping"
    continue
  fi
  echo "==> downloading $M"
  curl -fL --retry 3 --retry-delay 2 --progress-bar -o "$DEST/$M" "$BASE_URL/$M"
done
echo "==> done: $DEST"
