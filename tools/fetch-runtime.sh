#!/usr/bin/env bash
# Fetches the patched .NET WebAssembly runtime pack (Mono with an interpreter change that MonoMod's
# WebAssembly detours need, plus Mono-vs-CoreCLR compatibility fixes) and the two small native glue
# objects, from r58Playz/FNA-WASM-Build (built from github.com/r58playz/dotnet-runtime, MIT).
# Used for Harmony-based FortRise mods; see docs/FORTRISE.md.
set -euo pipefail
cd "$(dirname "$0")/.."
RELEASE=eb111fb8-7474-4f75-a1b7-848fc6293aa5
OUT=vendor/runtime
[ "$(cat $OUT/.stamp 2>/dev/null)" = "$RELEASE" ] && exit 0
rm -rf "$OUT" && mkdir -p "$OUT"
base=https://github.com/r58Playz/FNA-WASM-Build/releases/download/$RELEASE
curl -sSLf -o "$OUT/dotnet.zip" "$base/dotnet.zip"
curl -sSLf -o "$OUT/liba.o" "$base/liba.o"
curl -sSLf -o "$OUT/hot_reload_detour.o" "$base/hot_reload_detour.o"
unzip -q "$OUT/dotnet.zip" -d "$OUT/dotnet" && rm "$OUT/dotnet.zip"
echo "$RELEASE" > "$OUT/.stamp"
echo "Runtime pack: $(grep -o 'Version="[^"]*"' $OUT/dotnet/data/RuntimeList.xml | head -1)"
