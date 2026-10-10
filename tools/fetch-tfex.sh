#!/usr/bin/env bash
# Fetches the pinned TF.EX release (online play, by DShad/Fcornaire, GPL-2.0:
# https://github.com/Fcornaire/TF.EX) into vendor/tfex/, for the site to host. This is the one
# mod the site hosts (see docs/MODS.md): GitHub release downloads can't be fetched cross-origin, and
# the GPL allows it. The zips are repacked without Unmanaged/ (Windows/Linux builds of ggrs_ffi,
# which the browser replaces with its own build, see netplay/README.md). Also writes
# vendor/tfex/hosted.json, which the page lists alongside the GameBanana catalog.
set -euo pipefail
cd "$(dirname "$0")/.."
TFEX_VERSION=v0.19.1
# The TF.EX zip bundles all four of its mods (TF.EX, TF.State, TF.Replay, TF.InputDisplayer).
ZIPS="
DShad.TF.EX:156de4ddc032474ad972688f3a254c6afe161648737bfff89cf30ae48e90833d
"
OUT=vendor/tfex
want="$TFEX_VERSION $(shasum -a 256 tools/fetch-tfex.sh | cut -c1-16)"
[ "$(cat $OUT/.stamp 2>/dev/null)" = "$want" ] && exit 0

rm -rf $OUT && mkdir -p $OUT
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for pair in $ZIPS; do
	name=${pair%%:*}
	sha=${pair#*:}
	zip="$tmp/$name.zip"
	curl -sSLf -o "$zip" "https://github.com/Fcornaire/TF.EX/releases/download/$TFEX_VERSION/$name-$TFEX_VERSION.zip"
	echo "$sha  $zip" | shasum -a 256 -c - >/dev/null
	mkdir "$tmp/$name" && unzip -q "$zip" -d "$tmp/$name"
	find "$tmp/$name" -type d -name Unmanaged -prune -exec rm -rf {} +
	(cd "$tmp/$name" && zip -q -r -X "$OLDPWD/$OUT/$name-$TFEX_VERSION.zip" .)
done

python3 - "$OUT" "$TFEX_VERSION" <<'PY'
import hashlib, json, os, sys, zipfile
out, version = sys.argv[1], sys.argv[2]
entries = []
for f in sorted(os.listdir(out)):
    if not f.endswith(".zip"):
        continue
    path = os.path.join(out, f)
    data = open(path, "rb").read()
    z = zipfile.ZipFile(path)
    mods = []
    for meta_name in sorted(n for n in z.namelist() if n.endswith("meta.json")):
        meta = {k.lower(): v for k, v in json.loads(z.read(meta_name).decode("utf-8-sig")).items()}
        main = meta["name"] == "TF.EX"
        mods.append({
            "name": meta["name"], "version": meta.get("version"),
            "displayName": "Online play (TF.EX)" if main else (meta.get("displayname") or meta["name"]),
            "dll": meta.get("dll"),
            "dependencies": [{"name": d["name"], "version": d.get("version")} for d in meta.get("dependencies", [])],
            "optionalDependencies": [],
            # Only TF.EX itself is listed; the rest come with it.
            "status": "experimental" if main else "dependency",
            "note": "Rollback netplay by DShad. Experimental in the browser." if main else "Part of TF.EX.",
        })
    entries.append({
        "hosted": True, "title": "TF.EX", "author": "DShad", "category": "Online",
        "page": f"https://github.com/Fcornaire/TF.EX/releases/tag/{version}",
        "file": {"name": f, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "mirror": f"hosted-mods/{f}"},
        "mods": mods,
    })
json.dump({"source": "hosted", "mods": entries}, open(os.path.join(out, "hosted.json"), "w"), indent=1)
print(f"TF.EX {version}: " + ", ".join(f"{e['file']['name']} ({e['file']['size'] // 1024} KB: {', '.join(m['name'] for m in e['mods'])})" for e in entries))
PY
echo "$want" > $OUT/.stamp
