#!/usr/bin/env bash
# Fetches FNA (pinned, patched for wasm) and the prebuilt FNA native libs for Emscripten.
# FAudio is built from source instead (tools/build-faudio.sh) to carry a decoder fix.
set -euo pipefail
cd "$(dirname "$0")/.."
STATICS_RELEASE=eb111fb8-7474-4f75-a1b7-848fc6293aa5
mkdir -p vendor/statics
for f in FNA3D.a libmojoshader.a SDL3.a; do
	[ -f vendor/statics/$f ] || curl -sSLf -o vendor/statics/$f \
		https://github.com/r58Playz/FNA-WASM-Build/releases/download/$STATICS_RELEASE/$f
done
if [ ! -d vendor/FNA ]; then
	git clone --recursive -b 26.04 https://github.com/FNA-XNA/FNA vendor/FNA
	patch -d vendor/FNA -p1 --forward < patches/FNA.patch
fi
[ -f vendor/statics/FAudio.a ] || tools/build-faudio.sh
