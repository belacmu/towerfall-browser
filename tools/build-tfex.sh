#!/usr/bin/env bash
# Builds TF.EX from source at a commit of any GitHub repository (Fcornaire/TF.EX, or a fork with our own change) into
# the same zip its releases ship: DShad.TF.EX/, DShad.TF.Replay/, DShad.TF.State/, DShad.TF.InputDisplayer/. These are
# the steps of TF.EX's .github/workflows/release.yml, without the Windows/Linux ggrs_ffi (the browser links its own,
# netplay/). Used by tools/fetch-tfex.sh when TFEX_SOURCE is set; see docs/TFEX-UPDATE.md.
#   tools/build-tfex.sh <owner/repo> <commit> <out.zip>
# Needs: git, zip, and the .NET 10 SDK (env.sh's, from tools/install-sdk.sh). NuGet packages come from nuget.org
# (FortRise.Configuration, MessagePack, ...). The FortRise compile references (stripped TowerFall.Patch.dll, FNA,
# Harmony, MonoMod.Utils) are in TF.EX's own libs/, so no FortRise or game files are needed.
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# = 3 ] || { echo "usage: $0 <owner/repo> <commit> <out.zip>" >&2; exit 2; }
REPO=$1 REF=$2 OUTZIP=$(cd "$(dirname "$3")" && pwd)/$(basename "$3")
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "not owner/repo: $REPO" >&2; exit 2; }
source ./env.sh

# The real path: on macOS the temp folder is under /var, a symlink to /private/var, and a build seeing both spellings
# loses the projects' transitive packages (CS0246 for MessagePack in TF.State.Core).
tmp=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$tmp"' EXIT
git init -q "$tmp/src"
git -C "$tmp/src" remote add origin "https://github.com/$REPO"
git -C "$tmp/src" fetch -q --depth 1 origin "$REF"
git -C "$tmp/src" checkout -q FETCH_HEAD
echo "TF.EX from $REPO at $(git -C "$tmp/src" rev-parse HEAD), meta.json version $(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$tmp/src/src/network/TF.EX.Core/meta.json" | head -1)"

projects=(
	"src/state/TF.State.Core/TF.State.Core.csproj:DShad.TF.State"
	"src/replay/TF.Replay.Core/TF.Replay.Core.csproj:DShad.TF.Replay"
	"src/utilities/TF.InputDisplayer/TF.InputDisplayer.Core/TF.InputDisplayer.Core.csproj:DShad.TF.InputDisplayer"
	"src/network/TF.EX.Core/TF.EX.Core.csproj:DShad.TF.EX"
)
for p in "${projects[@]}"; do
	proj=${p%%:*} name=${p#*:}
	dotnet build "$tmp/src/$proj" --configuration Release -nologo -v q -clp:ErrorsOnly \
		-p:ModLoaderPath="$tmp/src/libs" -p:ModEnablePublish=false -p:ModEnableZip=false
	mkdir -p "$tmp/stage/$name"
	cp -r "$tmp/src/$(dirname "$proj")/bin/Release/net10.0/." "$tmp/stage/$name/"
	rm -f "$tmp/stage/$name"/*.deps.json
	rm -rf "$tmp/stage/$name/Unmanaged"
	[ -f "$tmp/stage/$name/meta.json" ] || { echo "$name has no meta.json" >&2; exit 1; }
done
rm -f "$OUTZIP"
(cd "$tmp/stage" && zip -q -r -X "$OUTZIP" DShad.TF.EX DShad.TF.Replay DShad.TF.State DShad.TF.InputDisplayer)
echo "Built $OUTZIP"
