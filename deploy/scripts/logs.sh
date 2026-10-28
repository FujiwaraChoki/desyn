#!/usr/bin/env bash
# Show logs of Desyn containers (compose project "desyn" only) or of the desyn nginx sites.
#
# Usage:
#   deploy/scripts/logs.sh --host hetzner [SERVICE...] [-f|--follow] [--since 1h] [--tail 200]
#   deploy/scripts/logs.sh --host hetzner --nginx [app|landing|docs|render|http] [-f]
# SERVICE: worker, landing, web, docs (the active colour is resolved automatically; web-blue etc. also work).
# No SERVICE = every desyn container. Convex function logs: `npx convex logs --prod` or the Convex dashboard.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

FOLLOW=0
SINCE=""
TAIL=200
NGINX=0
TARGETS=()
ORIG_ARGS=("$@")
while (($#)); do
  case "$1" in
    -f | --follow) FOLLOW=1 && shift ;;
    --since)
      SINCE="$2"
      shift 2
      ;;
    --tail)
      TAIL="$2"
      shift 2
      ;;
    --nginx) NGINX=1 && shift ;;
    -*)
      common_arg "$@" || usage_error "$1"
      shift "${COMMON_SHIFT}"
      ;;
    *)
      TARGETS+=("$1")
      shift
      ;;
  esac
done
maybe_remote "${ORIG_ARGS[@]}"

require_root
[[ "${TAIL}" =~ ^[0-9]+$ ]] || die "--tail must be a number"

if [[ "${NGINX}" == "1" ]]; then
  files=()
  if ((${#TARGETS[@]} == 0)); then
    mapfile -t files < <(find /var/log/nginx -maxdepth 1 -name 'desyn-*.log' | sort)
  else
    for t in "${TARGETS[@]}"; do
      [[ "${t}" =~ ^[a-z-]+$ ]] || die "invalid nginx log name: ${t}"
      files+=(/var/log/nginx/desyn-"${t}".access.log /var/log/nginx/desyn-"${t}".error.log)
    done
  fi
  existing=()
  for f in "${files[@]}"; do [[ -f "${f}" ]] && existing+=("${f}"); done
  ((${#existing[@]})) || die "no desyn nginx log files found"
  if [[ "${FOLLOW}" == "1" ]]; then exec tail -n "${TAIL}" -F "${existing[@]}"; fi
  exec tail -n "${TAIL}" "${existing[@]}"
fi

require_bootstrapped
services=()
for t in "${TARGETS[@]}"; do
  case "${t}" in
    worker | landing | web | docs)
      color="$(active_color "${t}")"
      [[ "${color}" != "none" ]] || die "${t} has no active colour yet"
      services+=("${t}-${color}")
      ;;
    *) services+=("${t}") ;;
  esac
done
args=(logs --timestamps --tail "${TAIL}")
[[ -n "${SINCE}" ]] && args+=(--since "${SINCE}")
[[ "${FOLLOW}" == "1" ]] && args+=(--follow)
dc "${args[@]}" "${services[@]}"
