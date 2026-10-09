#!/usr/bin/env bash
# Fetches the pinned FortRise release (MIT, github.com/FortRise/FortRise) and keeps the managed
# parts the browser uses, in vendor/fortrise/:
#   lib/        the launcher (FortRise.dll) and its managed dependencies; the host references these
#   data/       TowerFall.FortRise.mm.dll (the MonoMod patch for TowerFall.exe) and Internals/, which
#               the page copies into the player's FortRise folder in OPFS
# Left out: the .NET runtime and native libs, FortRise's FNA (we use our patched FNA 26.10),
# its Steamworks.NET (we use our stub) and FortRise.ImGui (needs native cimgui).
# tools/build-monomod.sh then replaces its MonoMod with our WebAssembly-capable build.
set -euo pipefail
cd "$(dirname "$0")/.."
FORTRISE_VERSION=5.4.1
FORTRISE_SHA256=dbb22763f5c129b8a9b0dc2390c01d3800d642cf0a20afa6391ed41d97a599bb

OUT=vendor/fortrise
[ "$(cat $OUT/.stamp 2>/dev/null)" = "$FORTRISE_VERSION" ] && exit 0

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
zip="$tmp/fortrise.zip"
curl -sSLf -o "$zip" "https://github.com/FortRise/FortRise/releases/download/$FORTRISE_VERSION/FortRise.v$FORTRISE_VERSION-linux-x64.zip"
echo "$FORTRISE_SHA256  $zip" | shasum -a 256 -c - >/dev/null
unzip -q "$zip" -d "$tmp"
src="$tmp/FortRise"

rm -rf "$OUT" && mkdir -p "$OUT/lib" "$OUT/data/Internals"
for f in FortRise.dll 0Harmony.dll Pintail.dll Mono.Cecil*.dll MonoMod.*.dll Microsoft.Extensions.*.dll; do
	cp "$src"/$f "$OUT/lib/"
done
cp "$src/TowerFall.FortRise.mm.dll" "$OUT/data/"
# The launcher is built x86-64-only (it's the one RID-specific managed assembly in the release).
source ./env.sh
dotnet run --project tools/AnyCpu -c Release -- "$OUT/lib/FortRise.dll" "$src"
for m in "$src"/Internals/*/; do
	name=$(basename "$m")
	case "$name" in
		# Needs native cimgui.
		FortRise.ImGui) continue ;;
	esac
	cp -R "$m" "$OUT/data/Internals/$name"
done
find "$OUT/data" -name '*.pdb' -delete
echo "$FORTRISE_VERSION" > "$OUT/version.txt"
echo "$FORTRISE_VERSION" > "$OUT/.stamp"
echo "FortRise $FORTRISE_VERSION: $(ls "$OUT/lib" | wc -l | tr -d ' ') libs, $(find "$OUT/data" -type f | wc -l | tr -d ' ') data files"
