#!/usr/bin/env bash
# Retention for s3://desyn-prod-backups. The desyn-backup IAM user can write but not delete (a stolen server key
# cannot wipe the backups), so expiry is a bucket lifecycle rule instead of a script:
#   backups/<id>/      expire after 30 days (deploy/scripts/backup.sh writes one prefix per backup)
#   assets-mirror/     current objects are kept; overwritten versions expire after 30 days when versioning is on
# Run once as the AWS account owner (idempotent; it replaces the bucket's lifecycle configuration):
#   bash deploy/aws/backup-lifecycle.sh [--bucket desyn-prod-backups] [--dry-run]
set -euo pipefail
cd "$(dirname "$0")"
BUCKET="desyn-prod-backups"
DRY=0
while (($#)); do
  case "$1" in
    --bucket) BUCKET="$2" && shift 2 ;;
    --dry-run) DRY=1 && shift ;;
    *) echo "usage: $0 [--bucket NAME] [--dry-run]" >&2 && exit 2 ;;
  esac
done
cmd=(aws s3api put-bucket-lifecycle-configuration --bucket "${BUCKET}" --lifecycle-configuration file://backup-lifecycle.json)
if ((DRY)); then
  printf '[dry-run]'
  printf ' %q' "${cmd[@]}"
  printf '\n'
  exit 0
fi
"${cmd[@]}"
aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET}" --query 'Rules[].ID' --output text
echo "ok: lifecycle rules applied to ${BUCKET}"
