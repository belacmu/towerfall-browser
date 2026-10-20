#!/usr/bin/env bash
# TF.EX's match reports on our TF.EX server (cloudflare/tfex-server/match-reports.js): zips with a
# player's replay, log and exception, sent when a match ends in a desync, a disconnect or a crash.
#   tools/match-reports.sh                 lists them, oldest first (key, kind, group, name, size, time)
#   tools/match-reports.sh get <key> [dir] downloads one zip (into dir, default .)
# Needs STATUS_KEY in ~/.config/towerfall-tfex.env (as for deploys and tools/reports.sh).
set -euo pipefail
URL="${TFEX_SERVER_URL:-https://tfex-server.tf-bd1030ec.workers.dev}"
KEY=$(sed -n 's/^STATUS_KEY=//p' "${TFEX_SECRETS:-$HOME/.config/towerfall-tfex.env}")
auth=(-H "Authorization: Bearer $KEY")
if [ "${1:-}" = get ]; then
	key=${2:?usage: $0 get <key> [dir]}
	out="${3:-.}/$(basename "$key")"
	curl -sSf "${auth[@]}" "$URL/reports/match/$(jq -rn --arg k "$key" '$k|@uri')" -o "$out"
	echo "$out"
	exit
fi
cursor=
while :; do
	page=$(curl -sSf "${auth[@]}" "$URL/reports/match${cursor:+?cursor=$cursor}")
	jq -r '.reports[] | [.key, .kind, .group, .name, .size, .uploaded] | @tsv' <<<"$page"
	cursor=$(jq -r '.cursor // empty' <<<"$page")
	[ -n "$cursor" ] || break
done
