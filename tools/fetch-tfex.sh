#!/usr/bin/env bash
# Fetches the pinned TF.EX release (online play, by DShad/Fcornaire, GPL-2.0:
# https://github.com/Fcornaire/TF.EX) into vendor/tfex/, for the site to host. This is the one
# mod the site hosts (see docs/MODS.md): GitHub release downloads can't be fetched cross-origin, and
# the GPL allows it. The zips are repacked without Unmanaged/ (Windows/Linux builds of ggrs_ffi,
# which the browser replaces with its own build, see netplay/README.md). Also writes
# vendor/tfex/hosted.json, which the page lists alongside the GameBanana catalog.
# Or, with TFEX_SOURCE=<owner/repo>@<commit> (below, or from the environment), TF.EX built from source at that commit
# (tools/build-tfex.sh): a fork or branch with a change of ours. The commit pins it (a build isn't byte-for-byte
# reproducible, so there's no zip checksum); TFEX_VERSION then only names the zip. tools/update-tfex.py leaves a source
# pin alone. See docs/TFEX-UPDATE.md.
set -euo pipefail
cd "$(dirname "$0")/.."
# v0.22.2 (2026-10-24, with the Switch's switch-online): its release bundles ggrs-ffi v2.2.0, which tools/build-netplay.sh builds (the
# Switch's ggrs-ffi-switch has the same change).
TFEX_VERSION=v0.22.2
# Our fork (docs/TFEX-UPDATE.md "TF.EX from a fork"): v0.22.2 + Fcornaire/TF.EX#283 (several local players on one device online),
# branch belacmu/TF.EX lmp-v0.22.2. Identical to v0.22.2 until a second local player joins; back to a release when #283 is in one.
TFEX_SOURCE=${TFEX_SOURCE-belacmu/TF.EX@38c7b1e73038f7a33bf9fdac9809c42ced1fa60e}
# The TF.EX zip bundles all four of its mods (TF.EX, TF.State, TF.Replay, TF.InputDisplayer).
ZIPS="
DShad.TF.EX:bedfa8496a1cf19093793f02ec27cdd92f83c260feeb991f43bc823d249c4280
"
OUT=vendor/tfex
want="$TFEX_VERSION $TFEX_SOURCE $(shasum -a 256 tools/fetch-tfex.sh | cut -c1-16)"
[ "$(cat $OUT/.stamp 2>/dev/null)" = "$want" ] && exit 0

rm -rf $OUT && mkdir -p $OUT
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ -n "$TFEX_SOURCE" ]; then
	[[ "$TFEX_SOURCE" =~ ^[^@]+@[0-9a-f]{40}$ ]] || { echo "TFEX_SOURCE must be <owner/repo>@<full commit sha>: $TFEX_SOURCE" >&2; exit 1; }
	label="$TFEX_VERSION-${TFEX_SOURCE%%/*}-$(echo "${TFEX_SOURCE#*@}" | cut -c1-7)"
	tools/build-tfex.sh "${TFEX_SOURCE%@*}" "${TFEX_SOURCE#*@}" "$OUT/DShad.TF.EX-$label.zip"
	PAGE="https://github.com/${TFEX_SOURCE%@*}/tree/${TFEX_SOURCE#*@}"
	TFEX_VERSION=$label ZIPS=
fi
PAGE=${PAGE:-https://github.com/Fcornaire/TF.EX/releases/tag/$TFEX_VERSION}
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

python3 - "$OUT" "$TFEX_VERSION" "$PAGE" <<'PY'
import hashlib, json, os, sys, zipfile
out, version, page = sys.argv[1], sys.argv[2], sys.argv[3]
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
        "page": page,
        "file": {"name": f, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "mirror": f"hosted-mods/{f}"},
        "mods": mods,
    })
json.dump({"source": "hosted", "mods": entries}, open(os.path.join(out, "hosted.json"), "w"), indent=1)
print(f"TF.EX {version}: " + ", ".join(f"{e['file']['name']} ({e['file']['size'] // 1024} KB: {', '.join(m['name'] for m in e['mods'])})" for e in entries))
PY
echo "$want" > $OUT/.stamp
