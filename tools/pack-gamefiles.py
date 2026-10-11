#!/usr/bin/env python3
"""Packs the game's files for the private file host (tools/upload-gamefiles.sh, docs/MOBILE.md).

Reads gamefiles/manifest.json (tools/stage-gamefiles.sh) and writes, into OUT_DIR:
  pack-<sha256 prefix>.bin  the files the page imports (TowerFall.exe, Content/, DarkWorldContent/),
                            all but the music bank, one after another in path order
  manifest.json             the manifest with "pack" and "offset" added to each packed file
The page then reads the pack with a few range requests instead of one request per file (~1,600).
The pack is named by its content, so it can be cached for good and a new upload never changes one
a page is still reading. Files left out (or a page without pack support) load one by one as before.
Usage: tools/pack-gamefiles.py OUT_DIR
"""
import hashlib
import json
import os
import sys

MUSIC = "Content/Music/Win/MusicWaveBank.xwb"  # web/wwwroot/gamefiles.js: imported separately


def main():
    out = sys.argv[1]
    manifest = json.load(open("gamefiles/manifest.json"))
    paths = {f["path"].lower(): f["path"] for f in manifest["files"]}
    # The game's folder: TowerFall.exe with Content/ beside it, as the page's locateGame finds it.
    exes = sorted((p for p in paths.values() if p.lower().endswith("/towerfall.exe") and (os.path.dirname(p) + "/content/atlas/atlas.xml").lower() in paths), key=len)
    if not exes:
        sys.exit("No TowerFall.exe with Content/ next to it in gamefiles/manifest.json")
    base = os.path.dirname(exes[0]) + "/"
    dw = sorted((p[: -len("Atlas/atlas.xml")] for p in paths.values() if p.lower().endswith("darkworldcontent/atlas/atlas.xml")), key=lambda r: abs(len(r) - len(base)))
    wanted = lambda p: p == exes[0] or (p.startswith(base + "Content/") and p != base + MUSIC) or (dw and p.startswith(dw[0]))

    files = sorted((f for f in manifest["files"] if wanted(f["path"])), key=lambda f: f["path"])
    tmp = os.path.join(out, "pack.tmp")
    digest = hashlib.sha256()
    offset = 0
    with open(tmp, "wb") as pack:
        for f in files:
            data = open(os.path.join("gamefiles", f["path"]), "rb").read()
            if len(data) != f["size"]:
                sys.exit(f"{f['path']} changed since the manifest was written; run tools/stage-gamefiles.sh again")
            pack.write(data)
            digest.update(data)
            f["offset"] = offset
            offset += len(data)
    name = f"pack-{digest.hexdigest()[:16]}.bin"
    os.replace(tmp, os.path.join(out, name))
    for f in files:
        f["pack"] = "packs/" + name
    json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"))
    print(f"Packed {len(files)} files ({offset / 1048576:.0f} MB) into {name}")
    print(name)


if __name__ == "__main__":
    main()
