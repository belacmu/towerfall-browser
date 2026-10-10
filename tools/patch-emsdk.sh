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
want="$(cat patches/emsdk/*.patch | shasum -a 256 | cut -c1-16) $(cat "$EMSDK_TOOLS/emscripten/emscripten-version.txt")"
# One copy per patch set and Emscripten version, so worktrees on different branches (and builds
# running at the same time) never rebuild a copy another build is using. Each is made in a
# temporary folder and renamed into place when complete.
DIR=${PATCHED_EMSDK:-$HOME/.towerfall-browser/tools/emsdk-patched-$(echo "$want" | shasum -a 256 | cut -c1-12)}
if [ "$(cat "$DIR/.stamp" 2>/dev/null)" != "$want" ]; then
	tmp=$(mktemp -d "$DIR.tmp.XXXXXX")
	trap 'rm -rf "$tmp"' EXIT
	cp -R "$EMSDK_TOOLS/emscripten" "$tmp/emscripten"
	cp -R "$EM_CACHE" "$tmp/cache"
	for p in patches/emsdk/*.patch; do
		patch -d "$tmp/emscripten" -p1 --forward -s < "$p"
	done
	# Rebuild the system libraries the patches touch, into the copy's cache.
	(
		export EM_CACHE="$tmp/cache" EM_FROZEN_CACHE=0
		"$tmp/emscripten/embuilder" build libhtml5 libwasmfs-mt --force >/dev/null
	)
	echo "$want" > "$tmp/.stamp"
	# Another build may have finished the same copy meanwhile; then keep that one.
	if [ "$(cat "$DIR/.stamp" 2>/dev/null)" != "$want" ]; then
		rm -rf "$DIR"
		mv "$tmp" "$DIR"
	fi
fi
echo "$DIR"
