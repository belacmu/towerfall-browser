#!/usr/bin/env bash
# Fetches the patched .NET WebAssembly runtime pack (Mono with an interpreter change that MonoMod's
# WebAssembly detours need, plus Mono-vs-CoreCLR compatibility fixes) and the two small native glue
# objects, from r58Playz/FNA-WASM-Build (built from github.com/r58playz/dotnet-runtime, MIT).
# Used for Harmony-based FortRise mods; see docs/FORTRISE.md.
set -euo pipefail
cd "$(dirname "$0")/.."
RELEASE=${RUNTIME_RELEASE:-5ecb4294-8cbb-42f1-a73b-476bb46ddbb6}
# RUNTIME_ZIP picks a variant of a release (dotnet.zip, or e.g. dotnet-jspi-jit.zip); OUT where to.
ZIP=${RUNTIME_ZIP:-dotnet.zip}
OUT=${OUT:-vendor/runtime}
# Release files can be replaced, so the ones the site builds with are checked against what was
# built and tested with (release/file:sha256). Other releases and variants (for experiments) aren't.
PINNED="
5ecb4294-8cbb-42f1-a73b-476bb46ddbb6/dotnet.zip:774137f11758167d7ea7068fc6b6b2413859cc48d8129f2f864027aaa0be03ec
5ecb4294-8cbb-42f1-a73b-476bb46ddbb6/liba.o:deb4e692cdba72c48e8d4a017a94dc455b740d02e7695ff6d395119cd279cf43
5ecb4294-8cbb-42f1-a73b-476bb46ddbb6/hot_reload_detour.o:aced73eef591ed06dc554a2162d86a263f61ea5c0c8d2e19b1189fe347ed6d92
"
check() { # local file, its name in the release
	local sum
	sum=$(echo "$PINNED" | sed -n "s|^$RELEASE/$2:||p")
	if [ -z "$sum" ]; then
		echo "warning: $RELEASE/$2 has no pinned checksum" >&2
		return
	fi
	echo "$sum  $1" | shasum -a 256 -c - >/dev/null || { echo "$RELEASE/$2 doesn't match its pinned checksum" >&2; exit 1; }
}
want="$RELEASE $ZIP $(shasum -a 256 tools/fetch-runtime.sh | cut -c1-16)"
[ "$(cat $OUT/.stamp 2>/dev/null)" = "$want" ] && exit 0
rm -rf "$OUT" && mkdir -p "$OUT"
base=https://github.com/r58Playz/FNA-WASM-Build/releases/download/$RELEASE
curl -sSLf -o "$OUT/dotnet.zip" "$base/$ZIP" && check "$OUT/dotnet.zip" "$ZIP"
curl -sSLf -o "$OUT/liba.o" "$base/liba.o" && check "$OUT/liba.o" liba.o
curl -sSLf -o "$OUT/hot_reload_detour.o" "$base/hot_reload_detour.o" && check "$OUT/hot_reload_detour.o" hot_reload_detour.o
unzip -q "$OUT/dotnet.zip" -d "$OUT/dotnet" && rm "$OUT/dotnet.zip"
echo "$want" > "$OUT/.stamp"
echo "Runtime pack: $(grep -o 'Version="[^"]*"' $OUT/dotnet/data/RuntimeList.xml | head -1)"
