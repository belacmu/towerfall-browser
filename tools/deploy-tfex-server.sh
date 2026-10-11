#!/usr/bin/env bash
# Redeploys our TF.EX server (cloudflare/tfex-server) when nobody is in a match. A redeploy restarts
# its Durable Objects, which disconnects every lobby and match (TF.EX then ends the match), so this
# asks the server's /status first (counts only) and
#   - deploys if no match is running;
#   - otherwise says how many are and stops, or with --wait checks every 30 s until none are;
#   - --force deploys anyway (also the way to deploy a server that has no /status yet).
# STATUS_KEY (a long random string) lives in ~/.config/towerfall-tfex.env as STATUS_KEY=...; that
# file holds nothing else, since it's also uploaded as the Worker's secrets with each deploy.
# Set CLOUDFLARE_ACCOUNT_ID if wrangler can see more than one account.
#   tools/deploy-tfex-server.sh [--wait] [--force]
set -euo pipefail
cd "$(dirname "$0")/../cloudflare/tfex-server"
URL="${TFEX_SERVER_URL:-https://tfex-server.tf-bd1030ec.workers.dev}"
SECRETS="${TFEX_SECRETS:-$HOME/.config/towerfall-tfex.env}"
wait=false force=false
for a in "$@"; do
	case "$a" in
		--wait) wait=true ;;
		--force) force=true ;;
		*) echo "usage: $0 [--wait] [--force]" >&2; exit 2 ;;
	esac
done
[ -f "$SECRETS" ] || { echo "No $SECRETS: create it with STATUS_KEY=\$(openssl rand -hex 24) (chmod 600)" >&2; exit 1; }
STATUS_KEY=$(sed -n 's/^STATUS_KEY=//p' "$SECRETS")
[ ${#STATUS_KEY} -ge 16 ] || { echo "STATUS_KEY in $SECRETS is missing or too short" >&2; exit 1; }

while ! $force; do
	if ! s=$(curl -sSf --max-time 10 -H "Authorization: Bearer $STATUS_KEY" "$URL/status"); then
		echo "Couldn't read $URL/status (a server deployed before /status, or another STATUS_KEY): check it's quiet, then --force." >&2
		exit 1
	fi
	echo "Server: $(jq -r '"\(.connections) connected, \(.lobbies) lobbies, \(.matches) matches (\(.playersInMatches) players), \(.searching) searching"' <<<"$s")"
	[ "$(jq -r .matches <<<"$s")" = 0 ] && break
	$wait || { echo "Not deploying: it would end those matches. --wait deploys once they're over, --force now." >&2; exit 1; }
	sleep 30
done
npx -y wrangler@4 deploy --secrets-file "$SECRETS"
