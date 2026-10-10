#!/usr/bin/env bash
# Builds MonoMod with WebAssembly detour support (r58Playz's port, carried forward onto upstream in
# patches/MonoMod.patch) and puts it in place of FortRise's MonoMod libraries in vendor/fortrise/lib.
# Harmony patches then go through WasmDetourFactory, which swaps a method's IL for a trampoline
# (needs the patched runtime from tools/fetch-runtime.sh). Upstream commit 69fdc9de is the source of
# MonoMod.Core 1.3.4 / MonoMod.Utils 25.0.12, matching what FortRise and Harmony 2.4 reference.
set -euo pipefail
cd "$(dirname "$0")/.."
MONOMOD_COMMIT=69fdc9debfcdf99cf6481047801b03b4eba947fe
SRC=vendor/MonoMod
want="$MONOMOD_COMMIT $(cat patches/MonoMod.patch tools/build-monomod.sh | shasum -a 256 | cut -c1-16)"
if [ "$(cat $SRC/.stamp 2>/dev/null)" != "$want" ]; then
	rm -rf $SRC
	git init -q $SRC
	git -C $SRC remote add origin https://github.com/MonoMod/MonoMod
	git -C $SRC fetch -q --depth 1 origin $MONOMOD_COMMIT
	git -C $SRC checkout -q FETCH_HEAD
	git -C $SRC submodule update -q --init --depth 1 external/iced
	patch -d $SRC -p1 --forward < patches/MonoMod.patch
	source ./env.sh
	for p in Utils Core RuntimeDetour Patcher; do
		dotnet build $SRC/src/MonoMod.$p/MonoMod.$p.csproj -c Release -f net10.0 -nologo -v q -clp:ErrorsOnly
	done
	echo "$want" > $SRC/.stamp
fi
bin=$SRC/artifacts/bin
cp $bin/MonoMod.Core/release_net10.0/MonoMod.Core.dll \
	$bin/MonoMod.Utils/release_net10.0/MonoMod.Utils.dll \
	$bin/MonoMod.Patcher/release_net10.0/MonoMod.Patcher.dll \
	$bin/iced/release_net10.0/MonoMod.Iced.dll \
	vendor/fortrise/lib/
echo "MonoMod (wasm detours) in place of FortRise's MonoMod.Core/Utils/Patcher/Iced"
