#!/usr/bin/env bash
# Roll the Hetzner services (worker, landing, web, docs) back to an earlier release whose images are still on
# the server (the last DESYN_KEEP_RELEASES releases are kept), blue/green like a deploy.
# Convex Cloud functions are not touched: to revert them, deploy that release's commit from your workstation with
# `deploy.sh --host hetzner --ref <sha> --only convex` (only when its schema still matches the data).
#
# Usage:
#   deploy/scripts/rollback.sh --host hetzner [--to <release-id>] [--list] [--dry-run] [--yes]
#   (default target: the newest successful release before the current one)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

TARGET=""
LIST=0
ORIG_ARGS=("$@")
while (($#)); do
  case "$1" in
    --to)
      TARGET="$2"
      shift 2
      ;;
    --list) LIST=1 && shift ;;
    *)
      common_arg "$@" || usage_error "$1"
      shift "${COMMON_SHIFT}"
      ;;
  esac
done
maybe_remote "${ORIG_ARGS[@]}"

require_root
require_bootstrapped
log_file="${DESYN_ROOT}/state/releases.log"
current="$(cat "${DESYN_ROOT}/state/current-release" 2>/dev/null || true)"

if [[ "${LIST}" == "1" ]]; then
  echo "current: ${current:-none}"
  echo "history (newest last):"
  tail -n 30 "${log_file}" 2>/dev/null | sed 's/^/  /' || echo "  (empty)"
  echo "releases with images on this host:"
  for d in "${DESYN_ROOT}"/releases/*/; do
    [[ -d "${d}" ]] || continue
    r="$(basename "${d}")"
    imgs="$(docker images --format '{{.Repository}}' --filter "reference=desyn/*:${r}" | sed 's#desyn/##' | sort | tr '\n' ' ')"
    printf '  %-36s %s\n' "${r}" "${imgs:-<no images>}"
  done
  exit 0
fi

if [[ -z "${TARGET}" ]]; then
  # Newest release recorded as ok (or rollback-ok) that is not the current one.
  TARGET="$(awk -v cur="${current}" '($3 == "ok" || $3 == "rollback-ok") && $2 != cur { r = $2 } END { print r }' "${log_file}" 2>/dev/null || true)"
  [[ -n "${TARGET}" ]] || die "no earlier successful release recorded in ${log_file}"
fi
[[ "${TARGET}" != "${current}" ]] || die "${TARGET} is already the current release"
# Captured first: with pipefail, `grep -q` closing the pipe early would fail the whole pipeline.
images="$(docker images --format '{{.Repository}}:{{.Tag}}')"
if ! grep -q ":${TARGET}\$" <<<"${images}"; then
  die "no images tagged ${TARGET} on this host (pruned?); deploy that commit again instead"
fi

confirm "Roll back from ${current:-none} to ${TARGET}?" "rollback"

script="${DESYN_ROOT}/releases/${TARGET}/src/deploy/scripts/deploy.sh"
[[ -f "${script}" ]] || script="${DESYN_ROOT}/tooling/scripts/deploy.sh"
src_args=()
if [[ ! -d "${DESYN_ROOT}/releases/${TARGET}/src/deploy" ]]; then
  # The release source was pruned but its images remain: run with the current tooling.
  shim="$(mktemp -d)"
  ln -s "${DESYN_ROOT}/tooling" "${shim}/deploy"
  src_args=(--src-dir "${shim}")
fi
flags=(--on-server --release "${TARGET}" --no-build --skip-backup --rollback "${src_args[@]}")
[[ "${DRY_RUN}" == "1" ]] && flags+=(--dry-run)
exec bash "${script}" "${flags[@]}"
