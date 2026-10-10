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
# FortRise's patch module and built-in modules, served under fortrise/ for the page to copy into
# the player's FortRise folder (see web/wwwroot/main.js).
WWW=web/bin/Release/net10.0/publish/wwwroot
mkdir -p $WWW/fortrise && cp -R vendor/fortrise/data/. $WWW/fortrise/
python3 - "$WWW/fortrise" "$(cat vendor/fortrise/version.txt)" <<'PY'
import json, os, sys
root, version = sys.argv[1], sys.argv[2]
files = []
for dirpath, _, names in os.walk(root):
    for n in names:
        full = os.path.join(dirpath, n)
        rel = os.path.relpath(full, root)
        if rel != "manifest.json":
            files.append({"path": rel, "size": os.path.getsize(full)})
files.sort(key=lambda f: f["path"])
json.dump({"version": version, "files": files}, open(os.path.join(root, "manifest.json"), "w"))
PY
# The mod catalog (metadata only; mod files always come from GameBanana).
mkdir -p $WWW/mods && cp mods/catalog.json $WWW/mods/catalog.json
# The one hosted mod: TF.EX, for online play (GPL; see tools/fetch-tfex.sh and docs/MODS.md).
mkdir -p $WWW/hosted-mods && cp vendor/tfex/*.zip vendor/tfex/hosted.json $WWW/hosted-mods/
grep -q TRANSFERRED_CANVAS $FW/dotnet.native.*.js || { echo "canvas transfer patch did not apply" >&2; exit 1; }
# Cache busting. GitHub Pages lets browsers keep every file for 10 minutes, and a reload fetches the
# page again but not the scripts it loads, so after a deploy a phone could run the new page with
# old scripts, or an old _framework/dotnet.js naming runtime files the deploy removed. The page's
# own modules and dotnet.js (the only unfingerprinted files in _framework) are loaded with
# ?v=<hash of them all>, so a deploy that changes any of them changes every URL.
python3 - "$WWW" <<'PY'
import hashlib, os, re, sys
root = sys.argv[1]
modules = sorted(n for n in os.listdir(root) if n.endswith(".js") and n != "coi-serviceworker.js")
h = hashlib.sha256()
for rel in modules + ["_framework/dotnet.js"]:
    h.update(open(os.path.join(root, rel), "rb").read())
v = h.hexdigest()[:12]
def stamp(rel, pattern, expect):
    path = os.path.join(root, rel)
    text, n = re.subn(pattern, lambda m: f"{m[1]}{m[2]}?v={v}{m[3]}", open(path).read())
    if n < expect:
        sys.exit(f"cache busting: expected {expect}+ script URLs in {rel}, found {n}")
    open(path, "w").write(text)
stamp("index.html", r'(<script type="module" src=")(\./main\.js)(")', 1)
for rel in modules:
    # import ... from "./x.js" and import("./x.js")
    stamp(rel, r'((?:\bfrom|\bimport\s*\()\s*")(\./[^"?]+\.js)(")', 2 if rel == "main.js" else 0)
if f'"./_framework/dotnet.js?v={v}"' not in open(os.path.join(root, "main.js")).read():
    sys.exit("cache busting: main.js's dotnet.js import wasn't stamped")
print(f"Script version: {v}")
PY
echo "Built: web/bin/Release/net10.0/publish/wwwroot"
