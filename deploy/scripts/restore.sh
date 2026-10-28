#!/usr/bin/env bash
# Restore Desyn data from a backup made by backup.sh, or rehearse a restore without touching production.
#
# Usage:
#   deploy/scripts/restore.sh --host hetzner --list
#   deploy/scripts/restore.sh --host hetzner --backup <id> --drill [--no-functions]
#       Download + verify checksums, start a throwaway self-hosted Convex backend (pinned image, SQLite, isolated
#       internal network), deploy the current release's functions to it (Convex tool image built from the release
#       source; --no-functions skips this), `convex import --replace-all` the export, list the tables with their
#       document counts, remove everything. Production is not touched. Run it monthly (RUNBOOK "Restore drill").
#   deploy/scripts/restore.sh --host hetzner --backup <id> --mode import [--yes]
#       `convex import --replace-all` of the export into the PRODUCTION Convex Cloud deployment (prod deploy key).
#       A fresh export of the current data is taken first (label pre-restore, kept locally and uploaded) unless
#       --no-safety-backup.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

BACKUP_ID=""
MODE=""
DRILL=0
LIST=0
SAFETY=1
FUNCTIONS=1
ORIG_ARGS=("$@")
while (($#)); do
  case "$1" in
    --backup)
      BACKUP_ID="$2"
      shift 2
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    --drill) DRILL=1 && shift ;;
    --no-functions) FUNCTIONS=0 && shift ;;
    --list) LIST=1 && shift ;;
    --no-safety-backup) SAFETY=0 && shift ;;
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

CFG="${DESYN_ROOT}/secrets/backup.env"
CONVEX_CFG="${DESYN_ROOT}/secrets/convex-backup.env"
cfg() { env_value "${CFG}" "$1" 2>/dev/null || true; }
BUCKET="$(cfg BACKUP_S3_BUCKET)"
PREFIX="$(cfg BACKUP_S3_PREFIX)"
PREFIX="${PREFIX:-backups/}"
[[ "${PREFIX}" == */ ]] || PREFIX="${PREFIX}/"
REGION="$(cfg BACKUP_S3_REGION)"
ENDPOINT="$(cfg BACKUP_S3_ENDPOINT)"

aws() {
  local extra=()
  [[ -n "${ENDPOINT}" ]] && extra+=(--endpoint-url "${ENDPOINT}")
  docker run --rm --read-only --tmpfs /tmp --env-file "${CFG}" -e "AWS_DEFAULT_REGION=${REGION:-eu-central-1}" \
    -v "${DESYN_ROOT}/backups:/backups" "${DESYN_AWSCLI_IMAGE}" "$@" "${extra[@]}"
}

if [[ "${LIST}" == "1" ]]; then
  echo "local (${DESYN_ROOT}/backups):"
  find "${DESYN_ROOT}/backups" -mindepth 1 -maxdepth 1 -type d -printf '  %f\n' | sort
  if [[ -n "${BUCKET}" ]]; then
    echo "remote (s3://${BUCKET}/${PREFIX}):"
    aws s3 ls "s3://${BUCKET}/${PREFIX}" | awk '$1 == "PRE" { print "  " $2 }' || true
  fi
  exit 0
fi

[[ "${BACKUP_ID}" =~ ^[0-9]{8}T[0-9]{6}Z-[a-z0-9._-]+$ ]] || die "--backup <id> is required (see --list)"
if [[ "${DRILL}" != "1" ]]; then
  [[ "${MODE}" == "import" ]] || die "--mode import (or --drill) is required"
fi
DIR="${DESYN_ROOT}/backups/${BACKUP_ID}"
CLI_TAG="$(env_value "${DESYN_ROOT}/state/images.env" DESYN_TAG_CONVEX_CLI 2>/dev/null || true)"
CLI="desyn/convex-cli:${CLI_TAG:-missing}"
[[ -n "${CLI_TAG}" ]] && image_exists "${CLI}" || [[ "${DRY_RUN}" == "1" ]] ||
  die "Convex CLI image ${CLI} is missing (deploy first)"

# ------------------------------------------------------------------------------------- fetch + verify
if [[ ! -f "${DIR}/manifest.json" ]]; then
  [[ -n "${BUCKET}" ]] || die "${DIR} not present locally and no bucket configured"
  info "downloading s3://${BUCKET}/${PREFIX}${BACKUP_ID}/"
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] would download and verify ${BACKUP_ID}"
  else
    install -d -m 0700 "${DIR}"
    aws s3 cp "s3://${BUCKET}/${PREFIX}${BACKUP_ID}/" "/backups/${BACKUP_ID}/" --recursive --only-show-errors
  fi
fi
if [[ -f "${DIR}/manifest.json" ]]; then
  info "verifying checksums"
  checked=0
  while read -r name sum; do
    [[ -f "${DIR}/${name}" ]] || die "missing ${name}"
    [[ "$(sha256sum "${DIR}/${name}" | cut -d' ' -f1)" == "${sum}" ]] || die "checksum mismatch: ${name}"
    ok "${name}"
    checked=$((checked + 1))
  done < <(sed -n 's/.*"name": "\([^"]*\)".*"sha256": "\([0-9a-f]*\)".*/\1 \2/p' "${DIR}/manifest.json")
  ((checked > 0)) || die "the manifest lists no files"
  [[ -f "${DIR}/convex-export.zip" ]] || die "${DIR} has no convex-export.zip"
fi

# ------------------------------------------------------------------------------------------------ drill
if [[ "${DRILL}" == "1" ]]; then
  suffix="$(random_hex 4)"
  net="desyn_drill_${suffix}"
  cb="desyn-drill-convex-${suffix}"
  release="$(cat "${DESYN_ROOT}/state/current-release" 2>/dev/null || true)"
  src="${DESYN_ROOT}/releases/${release}/src"
  tools="desyn/convex-tools:${release:-none}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] would import ${BACKUP_ID} into the throwaway backend ${cb} (${DESYN_CONVEX_BACKEND_IMAGE}) on ${net}"
    [[ "${FUNCTIONS}" == "1" ]] && info "[dry-run] after deploying the functions of ${release:-<no release>} with ${tools}"
    exit 0
  fi
  if [[ "${FUNCTIONS}" == "1" ]]; then
    [[ -n "${release}" && -d "${src}/convex" ]] || die "no release source with convex/ on this host (or use --no-functions)"
    if ! image_exists "${tools}"; then
      info "building ${tools} (Convex functions + CLI from the release source; cached by BuildKit)"
      builder=()
      docker buildx inspect "${DESYN_BUILDER}" >/dev/null 2>&1 && builder=(--builder "${DESYN_BUILDER}")
      docker buildx build --load "${builder[@]}" --build-arg "DESYN_RELEASE=${release}" \
        -f "${src}/deploy/docker/convex.Dockerfile" -t "${tools}" "${src}" || die "building ${tools} failed"
    fi
  fi
  drill_env=""
  # shellcheck disable=SC2329 # invoked by the EXIT trap
  cleanup() {
    docker rm -f "${cb}" >/dev/null 2>&1 || true
    docker network rm "${net}" >/dev/null 2>&1 || true
    [[ -n "${drill_env}" ]] && rm -rf "${drill_env}"
  }
  trap cleanup EXIT
  docker network create --internal --label com.desyn.owner=desyn "${net}" >/dev/null
  info "drill: throwaway Convex backend ${DESYN_CONVEX_BACKEND_IMAGE}"
  docker run -d --name "${cb}" --network "${net}" --network-alias convex-drill --label com.desyn.owner=desyn \
    -e INSTANCE_NAME=drill -e "INSTANCE_SECRET=$(random_hex 32)" -e DISABLE_BEACON=true \
    --memory 4g --cpus 2 "${DESYN_CONVEX_BACKEND_IMAGE}" >/dev/null
  up=0
  for _ in $(seq 1 60); do
    if docker exec "${cb}" curl -fsS -o /dev/null http://localhost:3210/version; then
      up=1
      break
    fi
    sleep 2
  done
  ((up)) || die "drill: the throwaway backend did not start"
  drill_env="$(mktemp -d "${DESYN_ROOT}/secrets/.drill.XXXXXX")"
  key="$(docker exec "${cb}" ./generate_admin_key.sh | tr -d '\r' | sed '/^$/d' | tail -n 1)"
  printf 'CONVEX_SELF_HOSTED_URL=http://convex-drill:3210\nCONVEX_SELF_HOSTED_ADMIN_KEY=%s\n' "${key}" >"${drill_env}/admin.env"
  unset key
  chown 1000:1000 "${drill_env}/admin.env"
  chmod 0400 "${drill_env}/admin.env"
  install -m 0444 "${DIR}/convex-export.zip" "${drill_env}/export.zip"
  if [[ "${FUNCTIONS}" == "1" ]]; then
    info "drill: deploying the functions of ${release}"
    docker run --rm --network "${net}" --env-file "${drill_env}/admin.env" "${tools}" deploy --yes --typecheck disable ||
      die "drill: convex deploy into the throwaway backend failed"
  fi
  info "drill: convex import --replace-all"
  docker run --rm --network "${net}" --read-only --tmpfs /tmp --env-file "${drill_env}/admin.env" \
    -v "${drill_env}/export.zip:/in/export.zip:ro" "${CLI}" import --replace-all --yes /in/export.zip ||
    die "drill: convex import failed"
  info "drill: tables in the restored deployment"
  docker run --rm --network "${net}" --read-only --tmpfs /tmp --env-file "${drill_env}/admin.env" "${CLI}" data |
    sed 's/^/  /'
  ok "restore drill of ${BACKUP_ID} passed; throwaway backend and network removed"
  exit 0
fi

# ------------------------------------------------------------------------------------------- live
env_has_value "${CONVEX_CFG}" CONVEX_DEPLOY_KEY || die "no Convex deploy key in ${CONVEX_CFG}"
deployment="$(env_value "${DESYN_DEPLOY_DIR}/env/public.env" CONVEX_DEPLOYMENT 2>/dev/null || echo "${DESYN_CONVEX_PROD_DEPLOYMENT}")"
confirm "Import ${BACKUP_ID} into PRODUCTION ${deployment}? Every table is replaced by the backup." "restore ${BACKUP_ID}"
if [[ "${SAFETY}" == "1" ]]; then
  run bash "${SCRIPT_DIR}/backup.sh" --label pre-restore || die "safety backup failed; aborting"
fi
stage="$(mktemp -d "${DESYN_ROOT}/secrets/.restore.XXXXXX")"
trap 'rm -rf "${stage}"' EXIT
install -m 0444 "${DIR}/convex-export.zip" "${stage}/export.zip"
run docker run --rm --read-only --tmpfs /tmp --env-file "${CONVEX_CFG}" \
  -v "${stage}/export.zip:/in/export.zip:ro" "${CLI}" import --replace-all --yes /in/export.zip ||
  die "convex import failed; production may be partially restored: retry, or restore the pre-restore backup"
ok "convex import of ${BACKUP_ID} into ${deployment} complete"
run bash "${SCRIPT_DIR}/healthcheck.sh" --quiet
