#!/usr/bin/env bash
# Publishes the browser build to web/bin/Release/net10.0/publish/wwwroot.
# Pass AOT=1 for an ahead-of-time compiled build (much slower to build, faster to run).
set -euo pipefail
cd "$(dirname "$0")/.."
source ./env.sh

[ -f vendor/statics/SDL3.a ] || tools/fetch-deps.sh

rm -rf web/bin/Release/net10.0/publish
dotnet publish web/TowerFallBrowser.csproj -c Release -p:RunAOTCompilation="${AOT:-false}" -nologo -v q

FW=web/bin/Release/net10.0/publish/wwwroot/_framework
# Fix Mono's init when -sWASMFS is enabled (from r58Playz/fna-wasm-threads).
perl -pi -e 's/FS_createPath\("\/","usr\/share",!0,!0\)/FS_createPath("\/usr","share",!0,!0)/' $FW/dotnet.runtime.*.js
# Transfer the `.canvas` element to the deputy thread (the C# main thread) so FNA can render there.
perl -pi -e 's/var offscreenCanvases=\{\};/var offscreenCanvases={};if(globalThis.window&&!window.TRANSFERRED_CANVAS){transferredCanvasNames=[".canvas"];window.TRANSFERRED_CANVAS=true;}/' $FW/dotnet.native.*.js
# Emscripten bug: findCanvasEventTarget("canvas") returns the first offscreen canvas's *key*
# (a string) instead of the canvas, so resizing from the game thread throws.
perl -pi -e 's/target=="canvas"&&Object\.keys\(GL\.offscreenCanvases\)\[0\]/target=="canvas"&&Object.values(GL.offscreenCanvases)[0]/' $FW/dotnet.native.*.js
grep -q 'Object.values(GL.offscreenCanvases)\[0\]' $FW/dotnet.native.*.js || { echo "canvas lookup patch did not apply" >&2; exit 1; }
grep -q TRANSFERRED_CANVAS $FW/dotnet.native.*.js || { echo "canvas transfer patch did not apply" >&2; exit 1; }
echo "Built: web/bin/Release/net10.0/publish/wwwroot"
