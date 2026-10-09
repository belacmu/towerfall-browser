#!/usr/bin/env bash
# Fetches FNA (pinned, patched for wasm) and the prebuilt FNA native libs for Emscripten.
# FAudio is built from source instead (tools/build-faudio.sh) to carry a decoder fix.
# Re-fetches a dependency when its pin or patch changes.
set -euo pipefail
cd "$(dirname "$0")/.."
FNA_VERSION=26.10
STATICS_RELEASE=eb111fb8-7474-4f75-a1b7-848fc6293aa5

stamp() { # identifies a pinned dependency: version plus the hash of its patch
	echo "$1 $(shasum -a 256 "$2" | cut -c1-16)"
}

mkdir -p vendor/statics
if [ "$(cat vendor/statics/.stamp 2>/dev/null)" != "$STATICS_RELEASE" ]; then
	rm -f vendor/statics/FNA3D.a vendor/statics/libmojoshader.a vendor/statics/SDL3.a
fi
for f in FNA3D.a libmojoshader.a SDL3.a; do
	[ -f vendor/statics/$f ] || curl -sSLf -o vendor/statics/$f \
		https://github.com/r58Playz/FNA-WASM-Build/releases/download/$STATICS_RELEASE/$f
done
echo "$STATICS_RELEASE" > vendor/statics/.stamp

want="$(stamp $FNA_VERSION patches/FNA.patch)"
if [ "$(cat vendor/FNA/.stamp 2>/dev/null)" != "$want" ]; then
	rm -rf vendor/FNA
	git clone --quiet --recursive -b $FNA_VERSION https://github.com/FNA-XNA/FNA vendor/FNA
	patch -d vendor/FNA -p1 --forward < patches/FNA.patch
	echo "$want" > vendor/FNA/.stamp
fi

tools/build-faudio.sh --if-needed
tools/fetch-fortrise.sh
tools/build-monomod.sh
tools/fetch-runtime.sh
tools/build-netplay.sh
