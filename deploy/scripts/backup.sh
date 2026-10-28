#!/usr/bin/env bash
# Back up the Desyn data (Convex Cloud prod) and ship it to S3. Runs on the server.
#
# Each backup is a directory /opt/desyn/backups/<UTC timestamp>-<label> containing:
#   convex-export.zip   `convex export` of the prod deployment (every table, component tables, and with
#                       BACKUP_INCLUDE_FILE_STORAGE=1 the Convex file storage); restorable with `convex import`
#   manifest.json       deployment, release, Convex CLI version, sizes, sha256 of every file
# The export runs in the pinned desyn/convex-cli:<version> image with the prod deploy key from
# /opt/desyn/secrets/convex-backup.env (handed only to that container). The upload uses the pinned aws-cli image
# with the desyn-backup IAM user from /opt/desyn/secrets/backup.env:
#   s3://$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-backups/}<id>/   (SSE-S3)
#   s3://$BACKUP_S3_BUCKET/assets-mirror/                        server-side copy of BACKUP_ASSETS_BUCKET (user uploads)
# Remote retention is the bucket's lifecycle rule (deploy/aws/backup-lifecycle.json): the backup credentials
# cannot delete anything. For S3-compatible stores without lifecycle rules set BACKUP_REMOTE_PRUNE=1 and
# BACKUP_RETENTION_DAYS (needs delete permission). Local copies are kept BACKUP_LOCAL_RETENTION_DAYS (3) days.
#
# Usage: deploy/scripts/backup.sh [--host hetzner] [--label nightly] [--no-upload] [--dry-run]
# Runs nightly from desyn-backup.timer and before every deploy (label pre-<release>).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

LABEL="manual"
UPLOAD=1
ORIG_ARGS=("$@")
while (($#)); do
  case "$1" in
    --label)
      LABEL="$2"
      shift 2
      ;;
    --no-upload) UPLOAD=0 && shift ;;
    *)
      common_arg "$@" || usage_error "$1"
      shift "${COMMON_SHIFT}"
      ;;
  esac
done
maybe_remote "${ORIG_ARGS[@]}"

require_root
require_bootstrapped
require_cmd docker sha256sum
[[ "${LABEL}" =~ ^[a-z0-9][a-z0-9._-]{0,80}$ ]] || die "invalid --label"

CFG="${DESYN_ROOT}/secrets/backup.env"
CONVEX_CFG="${DESYN_ROOT}/secrets/convex-backup.env"
cfg() { env_value "${CFG}" "$1" 2>/dev/null || true; }
BUCKET="$(cfg BACKUP_S3_BUCKET)"
PREFIX="$(cfg BACKUP_S3_PREFIX)"
PREFIX="${PREFIX:-backups/}"
[[ "${PREFIX}" == */ ]] || PREFIX="${PREFIX}/"
REGION="$(cfg BACKUP_S3_REGION)"
ENDPOINT="$(cfg BACKUP_S3_ENDPOINT)"
LOCAL_RETENTION="$(cfg BACKUP_LOCAL_RETENTION_DAYS)"
LOCAL_RETENTION="${LOCAL_RETENTION:-3}"
INCLUDE_FILES="$(cfg BACKUP_INCLUDE_FILE_STORAGE)"
ASSETS_BUCKET="$(cfg BACKUP_ASSETS_BUCKET)"
REMOTE_PRUNE="$(cfg BACKUP_REMOTE_PRUNE)"
RETENTION="$(cfg BACKUP_RETENTION_DAYS)"
RETENTION="${RETENTION:-30}"
[[ "${LOCAL_RETENTION}" =~ ^[0-9]+$ && "${RETENTION}" =~ ^[0-9]+$ ]] || die "retention days must be numbers in ${CFG}"
if [[ "${UPLOAD}" == "1" && -z "${BUCKET}" ]]; then
  die "BACKUP_S3_BUCKET is empty in ${CFG} (run server-env.py prod --host <ssh-host>, or use --no-upload)"
fi
env_has_value "${CONVEX_CFG}" CONVEX_DEPLOY_KEY ||
  die "no Convex deploy key in ${CONVEX_CFG} (run deploy/scripts/server-env.py prod --host <ssh-host> from your workstation)"

CLI_TAG="$(env_value "${DESYN_ROOT}/state/images.env" DESYN_TAG_CONVEX_CLI 2>/dev/null || true)"
[[ -n "${CLI_TAG}" ]] || die "no Convex CLI image recorded yet (DESYN_TAG_CONVEX_CLI); deploy once first"
TOOL="desyn/convex-cli:${CLI_TAG}"
image_exists "${TOOL}" || [[ "${DRY_RUN}" == "1" ]] || die "Convex CLI image ${TOOL} is missing; deploy again to rebuild it"
RELEASE="$(cat "${DESYN_ROOT}/state/current-release" 2>/dev/null || echo none)"
DEPLOYMENT="$(env_value "${DESYN_DEPLOY_DIR}/env/public.env" CONVEX_DEPLOYMENT 2>/dev/null || echo "${DESYN_CONVEX_PROD_DEPLOYMENT}")"

ID="$(date -u +%Y%m%dT%H%M%SZ)-${LABEL}"
DIR="${DESYN_ROOT}/backups/${ID}"
info "backup ${ID} of ${DEPLOYMENT} (release ${RELEASE})"

# aws CMD...: the pinned aws-cli image with the backup credentials; /backups = the local backup root (read-only).
aws() {
  local extra=()
  [[ -n "${ENDPOINT}" ]] && extra+=(--endpoint-url "${ENDPOINT}")
  run docker run --rm --read-only --tmpfs /tmp --env-file "${CFG}" -e "AWS_DEFAULT_REGION=${REGION:-eu-central-1}" \
    -v "${DESYN_ROOT}/backups:/backups:ro" "${DESYN_AWSCLI_IMAGE}" "$@" "${extra[@]}"
}

run install -d -m 0700 "${DIR}"
# The CLI runs as uid 1000 (node) inside its container; it writes into its own subdirectory of the root-only
# backup directory, which is moved up and removed afterwards.
run install -d -m 0700 -o 1000 -g 1000 "${DIR}/export"

info "convex export (${TOOL})"
export_args=(export --path /out/convex-export.zip)
[[ "${INCLUDE_FILES}" == "1" ]] && export_args+=(--include-file-storage)
run docker run --rm --read-only --tmpfs /tmp --security-opt no-new-privileges:true --cap-drop ALL \
  --env-file "${CONVEX_CFG}" -v "${DIR}/export:/out" "${TOOL}" "${export_args[@]}" ||
  die "convex export failed (backup ${ID} is incomplete)"
run mv "${DIR}/export/convex-export.zip" "${DIR}/convex-export.zip"
run rmdir "${DIR}/export"

if [[ "${DRY_RUN}" != "1" ]]; then
  [[ -s "${DIR}/convex-export.zip" && "$(head -c 2 "${DIR}/convex-export.zip")" == "PK" ]] ||
    die "the export is empty or not a ZIP file"
  {
    printf '{\n  "id": "%s",\n  "deployment": "%s",\n  "release": "%s",\n' "${ID}" "${DEPLOYMENT}" "${RELEASE}"
    printf '  "createdAt": "%s",\n  "convexCli": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${CLI_TAG}"
    printf '  "includeFileStorage": %s,\n  "files": [\n' "$([[ "${INCLUDE_FILES}" == "1" ]] && echo true || echo false)"
    printf '    {"name": "%s", "bytes": %s, "sha256": "%s"}\n' "convex-export.zip" \
      "$(stat -c %s "${DIR}/convex-export.zip")" "$(sha256sum "${DIR}/convex-export.zip" | cut -d' ' -f1)"
    printf '  ]\n}\n'
  } >"${DIR}/manifest.json"
  chmod 0600 "${DIR}"/*
  info "local backup complete: $(du -sh "${DIR}" | cut -f1) in ${DIR}"
fi

if [[ "${UPLOAD}" == "1" ]]; then
  sse=()
  [[ -z "${ENDPOINT}" ]] && sse=(--sse AES256)
  info "uploading to s3://${BUCKET}/${PREFIX}${ID}/"
  aws s3 cp "/backups/${ID}" "s3://${BUCKET}/${PREFIX}${ID}/" --recursive --only-show-errors "${sse[@]}" ||
    die "upload of ${ID} failed (the local copy is kept in ${DIR})"

  if [[ -n "${ASSETS_BUCKET}" ]]; then
    info "mirroring s3://${ASSETS_BUCKET} to s3://${BUCKET}/assets-mirror/ (server-side copy, nothing is deleted)"
    aws s3 sync "s3://${ASSETS_BUCKET}" "s3://${BUCKET}/assets-mirror/" --only-show-errors "${sse[@]}" ||
      die "assets mirror failed (the database backup ${ID} was uploaded)"
  fi

  if [[ "${REMOTE_PRUNE}" == "1" ]]; then
    info "remote retention: ${RETENTION} days (BACKUP_REMOTE_PRUNE=1)"
    cutoff="$(date -u -d "${RETENTION} days ago" +%Y%m%dT%H%M%SZ)"
    if [[ "${DRY_RUN}" != "1" ]]; then
      listing="$(DRY_RUN=0 aws s3 ls "s3://${BUCKET}/${PREFIX}" | awk '$1 == "PRE" { print $2 }')"
      while IFS= read -r p; do
        p="${p%/}"
        # Only prefixes this script created (timestamp-label); never anything else in the bucket.
        [[ "${p}" =~ ^[0-9]{8}T[0-9]{6}Z-[a-z0-9._-]+$ ]] || continue
        if [[ "${p%%-*}" < "${cutoff}" ]]; then
          info "deleting expired s3://${BUCKET}/${PREFIX}${p}/"
          aws s3 rm "s3://${BUCKET}/${PREFIX}${p}/" --recursive --only-show-errors
        fi
      done <<<"${listing}"
    fi
  fi
fi

info "local retention: ${LOCAL_RETENTION} days"
find "${DESYN_ROOT}/backups" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
  -regex '.*/[0-9]{8}T[0-9]{6}Z-[a-z0-9._-]+' -mtime "+${LOCAL_RETENTION}" -print0 |
  while IFS= read -r -d '' old; do
    [[ "${old}" == "${DIR}" ]] && continue
    run rm -rf "${old}"
    info "removed local ${old}"
  done

if [[ "${DRY_RUN}" != "1" ]]; then
  printf '%s %s\n' "${ID}" "$([[ "${UPLOAD}" == "1" ]] && echo uploaded || echo local-only)" >"$(state_file last-backup)"
fi
ok "backup ${ID} done"
