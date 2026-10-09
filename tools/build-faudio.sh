#!/usr/bin/env bash
# Builds vendor/statics/FAudio.a from FAudio 26.10 + patches/FAudio.patch, matching the
# prebuilt lib (SDL3 platform, Emscripten 3.1.56) but compiled with -pthread.
set -euo pipefail
cd "$(dirname "$0")/.."
source tools/emenv.sh

if [ ! -d vendor/FAudio ]; then
	git clone --depth 1 -b 26.10 https://github.com/FNA-XNA/FAudio vendor/FAudio
	git -C vendor/FAudio apply ../../patches/FAudio.patch
fi
if [ ! -d vendor/SDL3/include ]; then
	git clone --depth 1 --filter=blob:none --sparse -b release-3.4.4 https://github.com/libsdl-org/SDL vendor/SDL3
	git -C vendor/SDL3 sparse-checkout set include
fi

OUT=vendor/faudio-build
rm -rf "$OUT" && mkdir -p "$OUT"
for src in vendor/FAudio/src/*.c; do
	case "$(basename "$src")" in
		FAudio_platform_sdl2.c|FAudio_platform_win32.c|FAudio_platform_win32_wmadec.c) continue ;;
	esac
	emcc -O3 -pthread -DNDEBUG -DFAUDIO_SDL3_PLATFORM -DFAUDIO_DISABLE_DEBUGCONFIGURATION \
		-Ivendor/FAudio/include -Ivendor/SDL3/include \
		-c "$src" -o "$OUT/$(basename "${src%.c}").o" &
done
wait
rm -f vendor/statics/FAudio.a
emar rcs vendor/statics/FAudio.a "$OUT"/*.o
echo "Built vendor/statics/FAudio.a ($(ls "$OUT"/*.o | wc -l | tr -d ' ') objects)"
