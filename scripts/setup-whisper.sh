#!/usr/bin/env bash
# Build whisper.cpp for voice input (Phase 2b).
#
# Homebrew is deliberately not used: `whisper.cpp` has no bottle on Intel
# Ventura and pulls ggml, llama.cpp and sdl2-compat in from source. A direct
# cmake build is self-contained and much lighter.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/vendor/whisper.cpp"

command -v cmake >/dev/null || { echo "cmake is required: brew install cmake"; exit 1; }

if [ ! -d "$SRC" ]; then
  echo "==> cloning whisper.cpp"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$SRC"
fi

# Metal on Apple Silicon, Accelerate BLAS on Intel. cmake picks the right one
# when we simply don't force it off.
EXTRA=()
if [ "$(uname -m)" = "x86_64" ]; then
  EXTRA+=(-DGGML_METAL=OFF)
fi

echo "==> configuring ($(uname -m))"
cmake -S "$SRC" -B "$SRC/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_SDL2=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  "${EXTRA[@]}"

echo "==> building"
cmake --build "$SRC/build" --config Release -j "$(sysctl -n hw.logicalcpu)"

echo "==> done: $SRC/build/bin/whisper-cli"
