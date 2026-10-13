#!/usr/bin/env bash
# Prints the performance reports pages sent to our TF.EX server (cloudflare/tfex-server/reports.js),
# newest last, as JSON lines. Needs STATUS_KEY in ~/.config/towerfall-tfex.env (as for deploys).
#   tools/reports.sh [since-id]
set -euo pipefail
URL="${TFEX_SERVER_URL:-https://tfex-server.tf-bd1030ec.workers.dev}"
KEY=$(sed -n 's/^STATUS_KEY=//p' "${TFEX_SECRETS:-$HOME/.config/towerfall-tfex.env}")
since=${1:-0}
while :; do
	page=$(curl -sSf -H "Authorization: Bearer $KEY" "$URL/reports?since=$since")
	n=$(jq '.reports | length' <<<"$page")
	[ "$n" = 0 ] && break
	jq -c '.reports[] | {id, at: (.at / 1000 | todate)} + .report' <<<"$page"
	since=$(jq '.reports[-1].id' <<<"$page")
done
