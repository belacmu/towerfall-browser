#!/usr/bin/env bash
# Fetches FNA (pinned, patched for wasm) and the prebuilt FNA native libs for Emscripten.
# FAudio is built from source instead (tools/build-faudio.sh) to carry a decoder fix.
# Re-fetches a dependency when its pin or patch changes.
set -euo pipefail
cd "$(dirname "$0")/.."
FNA_VERSION=26.10
FNA_COMMIT=651c0ffdf4db43cd112865ad368c5d6cc3dc7558 # what the tag pointed at (a tag can move)
STATICS_RELEASE=eb111fb8-7474-4f75-a1b7-848fc6293aa5
# The release's files can be replaced, so each is checked against what was built and tested with.
STATICS_SHA256="
FNA3D.a:4619e3aeef4d492a6780feb70e0f315f0ea515fb302b7a98996b6bdfece66e7a
libmojoshader.a:ec482b00526301fdf17dfa3ad701b9de6f6f3d1d1d412531f2cdd00754afd355
SDL3.a:a208ba8c6df2449dd8487679b0041335ba96cf972c697cb380aa6e1a69717b79
"

stamp() { # identifies a pinned dependency: version (and commit) plus the hash of its patch
	echo "$1 $(shasum -a 256 "$2" | cut -c1-16)"
}

mkdir -p vendor/statics
statics_want="$STATICS_RELEASE $(echo "$STATICS_SHA256" | shasum -a 256 | cut -c1-16)"
if [ "$(cat vendor/statics/.stamp 2>/dev/null)" != "$statics_want" ]; then
	rm -f vendor/statics/FNA3D.a vendor/statics/libmojoshader.a vendor/statics/SDL3.a
fi
for f in FNA3D.a libmojoshader.a SDL3.a; do
	[ -f vendor/statics/$f ] && continue
	curl -sSLf -o vendor/statics/$f.part https://github.com/r58Playz/FNA-WASM-Build/releases/download/$STATICS_RELEASE/$f
	sum=$(echo "$STATICS_SHA256" | sed -n "s/^$f://p")
	echo "$sum  vendor/statics/$f.part" | shasum -a 256 -c - >/dev/null || { echo "$f from $STATICS_RELEASE doesn't match its pinned checksum" >&2; exit 1; }
	mv vendor/statics/$f.part vendor/statics/$f
done
echo "$statics_want" > vendor/statics/.stamp

want="$(stamp "$FNA_VERSION $FNA_COMMIT" patches/FNA.patch)"
if [ "$(cat vendor/FNA/.stamp 2>/dev/null)" != "$want" ]; then
	rm -rf vendor/FNA
	git clone --quiet --recursive -b $FNA_VERSION https://github.com/FNA-XNA/FNA vendor/FNA
	[ "$(git -C vendor/FNA rev-parse HEAD)" = "$FNA_COMMIT" ] || { echo "FNA $FNA_VERSION is no longer $FNA_COMMIT" >&2; exit 1; }
	patch -d vendor/FNA -p1 --forward < patches/FNA.patch
	echo "$want" > vendor/FNA/.stamp
fi

tools/build-faudio.sh --if-needed
tools/fetch-fortrise.sh
tools/build-monomod.sh
tools/fetch-runtime.sh
tools/build-netplay.sh
tools/fetch-tfex.sh
