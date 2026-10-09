#!/usr/bin/env bash
# Private mode: makes the dev server (tools/serve.py) host your TowerFall install, so the page
# imports it automatically instead of asking for a folder. Links the install into gamefiles/ and
# writes the manifest the page reads; the page finds TowerFall.exe and the content inside it the
# same way it does for a dropped folder. Without gamefiles/ the page runs in public mode.
#   tools/stage-gamefiles.sh [TowerFall install dir]   (default: the Steam install)
#   tools/stage-gamefiles.sh --clear                   (back to public mode)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--clear" ]; then
	rm -rf gamefiles
	echo "Removed gamefiles/; the page will ask for a TowerFall folder."
	exit 0
fi
TF="${1:-$HOME/Library/Application Support/Steam/steamapps/common/TowerFall}"
[ -d "$TF" ] || { echo "No such directory: $TF" >&2; exit 1; }
rm -rf gamefiles && mkdir -p gamefiles
ln -s "$TF" gamefiles/TowerFall
python3 - <<'PY'
import json, os
files = []
for dirpath, dirs, names in os.walk("gamefiles/TowerFall", followlinks=True):
    dirs[:] = [d for d in dirs if not d.startswith(".")]
    for n in names:
        if n.startswith("."):
            continue
        full = os.path.join(dirpath, n)
        files.append({"path": os.path.relpath(full, "gamefiles"), "size": os.path.getsize(full)})
files.sort(key=lambda f: f["path"])
json.dump({"files": files}, open("gamefiles/manifest.json", "w"))
print(f"Listed {len(files)} files ({sum(f['size'] for f in files) / 1048576:.0f} MB); the page copies only the game's.")
PY
