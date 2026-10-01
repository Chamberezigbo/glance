#!/usr/bin/env bash
# Record a short demo of glance answering a question, and turn it into a GIF.
#
# A README for a tool that looks at your screen and talks back needs to show
# that happening. No amount of prose substitutes for twenty seconds of footage.
#
#   bash scripts/record-demo.sh "what is this error telling me?" [seconds]
#
# Records the display your mouse is on, runs the question through glance so the
# answer panel appears on camera, then encodes a GIF sized for a README.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUESTION="${1:-what is on my screen right now?}"
SECONDS_TO_RECORD="${2:-22}"
OUT="$ROOT/docs/media"
mkdir -p "$OUT"

DISPLAY_INDEX="$("$ROOT/bin/cursor-display" 2>/dev/null || echo 1)"
RAW="$OUT/demo-raw.mov"

echo "==> recording display $DISPLAY_INDEX for ${SECONDS_TO_RECORD}s"
echo "    the question runs automatically; just do not move windows around"
echo
echo "    Before this starts, make sure the screen shows what you want a"
echo "    stranger to see: one real problem, no private windows, and nothing"
echo "    you would not publish. This frame is the most-viewed part of the repo."
echo
for i in 5 4 3 2 1; do printf "\r    starting in %ds... " "$i"; sleep 1; done
echo; echo
rm -f "$RAW"
# -v records video, -V caps the duration, -x stays silent, -D picks the display.
screencapture -v -V "$SECONDS_TO_RECORD" -x -D "$DISPLAY_INDEX" "$RAW" &
REC=$!

sleep 2
echo "==> asking: $QUESTION"
( cd "$ROOT" && node dist/cli.js --popup --max-words 30 "$QUESTION" ) || true

wait $REC 2>/dev/null || true
[ -f "$RAW" ] || { echo "recording failed — is Screen Recording granted to your terminal?"; exit 1; }

echo "==> encoding GIF"
# Two passes: build a palette from the whole clip, then apply it. A GIF encoded
# without this looks like a fax of a screenshot.
PALETTE="$(mktemp -d)/palette.png"
ffmpeg -nostdin -loglevel error -i "$RAW" \
  -vf "fps=10,scale=1200:-1:flags=lanczos,palettegen=stats_mode=diff" -y "$PALETTE"
ffmpeg -nostdin -loglevel error -i "$RAW" -i "$PALETTE" \
  -lavfi "fps=10,scale=1200:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=3" \
  -y "$OUT/demo.gif"

echo "==> also encoding mp4 (smaller, and GitHub plays it inline)"
ffmpeg -nostdin -loglevel error -i "$RAW" \
  -vf "scale=1280:-2" -c:v libx264 -pix_fmt yuv420p -crf 26 -movflags +faststart \
  -an -y "$OUT/demo.mp4"

# Keep the raw recording if either encode failed — re-shooting is expensive.
if [ -s "$OUT/demo.gif" ] && [ "$(stat -f%z "$OUT/demo.mp4" 2>/dev/null || echo 0)" -gt 100000 ]; then
  rm -f "$RAW"
else
  echo "!! an encode looked wrong — keeping $RAW so it can be redone"
fi
echo
echo "done:"
ls -lh "$OUT"/demo.* | awk '{print "  " $9 "  " $5}'
