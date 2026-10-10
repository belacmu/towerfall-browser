#!/usr/bin/env bash
# Makes a patched copy of the workload's Emscripten 3.1.56 (its emscripten/ scripts and system
# library cache; the LLVM binaries stay shared) with the fixes r58playz's newer runtime packs are
# built with (patches/emsdk/, from r58Playz/FNA-WASM-Build):
#   1. html5 callbacks proxied asynchronously (upstream; the page froze when the game thread
#      blocked; web/Native/Emscripten.c carries the same fix for the stock toolchain);
#   2. a WASMFS proxy-worker start-up race that can deadlock (upstream);
#   3. faster OPFS file access (non-exclusive sync access handles where the browser has them).
# The copy is used only by builds that ask for it (see docs/COMPILATION.md):
#   MSBUILD_ARGS="-p:EmscriptenUpstreamEmscriptenPath=$DIR/emscripten/ -p:WasmCachePath=$DIR/cache/"
# Prints DIR. Usage: tools/patch-emsdk.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source tools/emenv.sh
DIR=${PATCHED_EMSDK:-$HOME/.towerfall-browser/tools/emsdk-patched}
want="$(cat patches/emsdk/*.patch | shasum -a 256 | cut -c1-16) $(cat "$EMSDK_TOOLS/emscripten/emscripten-version.txt")"
if [ "$(cat "$DIR/.stamp" 2>/dev/null)" != "$want" ]; then
	rm -rf "$DIR" && mkdir -p "$DIR"
	cp -R "$EMSDK_TOOLS/emscripten" "$DIR/emscripten"
	cp -R "$EM_CACHE" "$DIR/cache"
	for p in patches/emsdk/*.patch; do
		patch -d "$DIR/emscripten" -p1 --forward -s < "$p"
	done
	# Rebuild the system libraries the patches touch, into the copy's cache.
	(
		export EM_CACHE="$DIR/cache" EM_FROZEN_CACHE=0
		"$DIR/emscripten/embuilder" build libhtml5 libwasmfs-mt --force >/dev/null
	)
	echo "$want" > "$DIR/.stamp"
fi
echo "$DIR"
