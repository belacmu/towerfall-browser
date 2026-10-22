#!/usr/bin/env bash
# After a TF.EX update: boots the page with TF.EX once (headless, tools/probe-page.mjs) and checks that every
# browser patch of TF.EX (web/Netplay/*.cs) still found what it patches. The patches look TF.EX's members up by name
# at run time and turn themselves off with a log line when one is missing or changed, so a TF.EX release that renames
# or rewrites something shows here, not in the build. See docs/TFEX-UPDATE.md.
#   tools/check-tfex-patches.sh [page URL, default http://localhost:8080/]   (the page: tools/serve.py on a fresh build)
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=${1:-http://localhost:8080/}
# ?tfexplatform=Switch also checks SwitchLobby's platform claim.
URL="${BASE%/}/?mute&nointro&autoplay&mods=TF.EX&tfexplatform=Switch"
log=$(mktemp)
trap 'rm -rf "$log" "$HOME/.towerfall-browser/tfexcheck-profile"' EXIT
node tools/probe-page.mjs --url "$URL" --seconds "${SECONDS_TO_RUN:-150}" --profile tfexcheck --port 9341 > "$log" 2>&1 || true

# Lines a patch logs when it works.
expect=(
	"TF.EX [0-9.]+ has been loaded"
	"Dark World: True"                                  # TF.EX 0.21+ refuses online play without it
	"Direct field access at [0-9]+ places"              # DirectFields (TF.State)
	"Optimized TF.State's entity lookups"               # StateSpeedups
	"TF.EX session rate patches: 3 of 3"                # TfexFps
	"TF.EX patched for the browser"                     # TfexPatches
	"rollbacks drop recorded ticks from the end"        # ReplayRecordFix
	"slowing down from [0-9]+ ticks ahead"              # AheadThreshold
	"Online catch-up capped"                            # TickCatchUp
	"this page says it plays on \"Switch\""             # SwitchLobby.ClaimPlatform
)
# Lines a patch logs when TF.EX isn't as it expects.
refuse="MISSING|isn't as expected|members missing|changed \(|not found|couldn't|stays as it is|Unhandled|Exception"

fail=0
for e in "${expect[@]}"; do
	grep -Eq "$e" "$log" || { echo "missing: $e"; fail=1; }
done
if grep -E "$refuse" "$log" | grep -v "\[perf\]"; then fail=1; fi
grep -Eo "TF\.EX [0-9.]+ has been loaded" "$log" | head -1
[ $fail = 0 ] && echo "TF.EX patches: all found" || { echo "TF.EX patches: see above (full log: rerun with SECONDS_TO_RUN)"; exit 1; }
