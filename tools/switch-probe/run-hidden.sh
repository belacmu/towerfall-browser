#!/bin/bash
# run-hidden.sh <nsp> <seconds>: runs a game in Ryujinx with its window hidden the whole time, then
# stops it and prints the newest Ryujinx log's path. Ryujinx 1.2 has no headless mode, so it starts
# hidden in the background (open -g -j), and keephidden re-hides it within ~20 ms whenever it
# un-hides itself (about twice a second; it never takes focus). Hidden, the game runs slower.
set -u
here=$(cd "$(dirname "$0")" && pwd)
nsp=$1; total=$2
bin=${TMPDIR:-/tmp}/xplay-keephidden
[ "$bin" -nt "$here/keephidden.swift" ] || swiftc -O -o "$bin" "$here/keephidden.swift"
pgrep -f "Ryujinx.app/Contents/MacOS/Ryujinx" >/dev/null && { echo "Ryujinx is already running" >&2; exit 1; }
open -g -j -n -a /Applications/Ryujinx.app --args "$nsp"
for _ in $(seq 1 200); do pid=$(pgrep -n -f "Ryujinx.app/Contents/MacOS/Ryujinx") && break; sleep 0.02; done
"$bin" "$pid" "$total" >&2
kill "$pid" 2>/dev/null; sleep 3; kill -9 "$pid" 2>/dev/null
ls -t ~/Library/Logs/Ryujinx/*.log | head -1
