#!/usr/bin/env bash
# Turn a screen recording into something Claude can read, then narrate.
#
# Claude cannot watch video — there is no video input. It can read still images,
# so the recording is broken into frames it can look at one at a time, with the
# timestamp of each in the filename so narration can be written against the
# clock rather than guessed at.
#
#   bash scripts/narrate.sh recording.mov [seconds-between-frames]
#
# Then, in a FRESH conversation (the image budget is per-conversation), ask
# Claude to read docs/media/frames/ and write narration. Generate the voiceover
# with `glance say-file`, or read it yourself.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VIDEO="${1:?usage: narrate.sh <recording.mov> [interval-seconds]}"
EVERY="${2:-3}"
OUT="$ROOT/docs/media/frames"

[ -f "$VIDEO" ] || { echo "no such file: $VIDEO"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO")
echo "==> ${DUR%.*}s of video, a frame every ${EVERY}s"

# Scaled down hard: Claude rejects large images, and a 3360px retina frame is
# both over the limit and far more detail than narration needs.
ffmpeg -nostdin -loglevel error -i "$VIDEO" \
  -vf "fps=1/${EVERY},scale=1200:-2" \
  -frame_pts 1 "$OUT/t%04d.jpg" 2>/dev/null || true

# Rename each frame to the second it came from, so narration lines up.
i=0
for f in "$OUT"/t*.jpg; do
  [ -e "$f" ] || break
  printf -v name "%s/frame-%03ds.jpg" "$OUT" "$((i * EVERY))"
  mv "$f" "$name"
  i=$((i + 1))
done

echo "==> $i frames in docs/media/frames/"
echo
echo "If the recording has your voice on it, transcribe it too:"
echo "  ffmpeg -i '$VIDEO' -ar 16000 -ac 1 /tmp/narration.wav"
echo "  ./vendor/whisper.cpp/build/bin/whisper-cli -m models/ggml-base.en.bin -f /tmp/narration.wav -nt"
echo
echo "Then in a NEW conversation: \"read docs/media/frames/ and write narration\""
