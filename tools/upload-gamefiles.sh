#!/usr/bin/env bash
# Uploads your TowerFall install to the private deployment's R2 bucket (cloudflare/, docs/MOBILE.md),
# laid out like private mode's gamefiles/: the install plus a manifest.json the page reads.
# Needs rclone and an R2 API token (Object Read & Write on the bucket):
#   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... tools/upload-gamefiles.sh [install dir]
# R2_BUCKET defaults to towerfall-gamefiles. Re-running only uploads what changed.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}" "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}" "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}"
BUCKET="${R2_BUCKET:-towerfall-gamefiles}"
command -v rclone >/dev/null || { echo "Needs rclone (https://rclone.org/install/)" >&2; exit 1; }

# Same layout and manifest as the local dev server's private mode.
tools/stage-gamefiles.sh "$@"

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
# Files first, manifest last: the page only sees a complete upload.
rclone sync --copy-links --s3-no-check-bucket --exclude manifest.json --progress gamefiles/TowerFall "r2:$BUCKET/gamefiles/TowerFall"
rclone copyto --s3-no-check-bucket gamefiles/manifest.json "r2:$BUCKET/gamefiles/manifest.json"
echo "Uploaded to $BUCKET. tools/stage-gamefiles.sh --clear puts the local dev server back in public mode."
