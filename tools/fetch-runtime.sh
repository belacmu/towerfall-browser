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
want="$RELEASE $ZIP $(shasum -a 256 tools/fetch-runtime.sh | cut -c1-16)"
[ "$(cat $OUT/.stamp 2>/dev/null)" = "$want" ] && exit 0
rm -rf "$OUT" && mkdir -p "$OUT"
base=https://github.com/r58Playz/FNA-WASM-Build/releases/download/$RELEASE
curl -sSLf -o "$OUT/dotnet.zip" "$base/$ZIP"
curl -sSLf -o "$OUT/liba.o" "$base/liba.o"
curl -sSLf -o "$OUT/hot_reload_detour.o" "$base/hot_reload_detour.o"
unzip -q "$OUT/dotnet.zip" -d "$OUT/dotnet" && rm "$OUT/dotnet.zip"
echo "$want" > "$OUT/.stamp"
echo "Runtime pack: $(grep -o 'Version="[^"]*"' $OUT/dotnet/data/RuntimeList.xml | head -1)"
