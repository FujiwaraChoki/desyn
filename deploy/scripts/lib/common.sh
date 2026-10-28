#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034 # constants and COMMON_SHIFT are consumed by the sourcing scripts
#
# Shared helpers for deploy/scripts/*.sh. Source it, never execute it.
#
# Conventions every script follows:
#   * set -euo pipefail, explicit argument parsing, --help
#   * --dry-run prints every mutating command instead of running it (read-only probes still run)
#   * --host <ssh-host> runs the same script on the server: the deploy/ directory is copied to a temp dir there
#     and executed as root (directly, or through `sudo -n` when the SSH user is not root)
#   * only resources named desyn* (compose project "desyn", network desyn_net, nginx desyn-* files,
#     /opt/desyn, systemd desyn-* units) are ever created, changed or removed
#   * secret values are never printed; scripts reference env var names and root-only file paths

if [[ -n "${DESYN_COMMON_SH:-}" ]]; then
  return 0
fi
DESYN_COMMON_SH=1

DESYN_ROOT="${DESYN_ROOT:-/opt/desyn}"
# Exported: compose files interpolate ${DESYN_ROOT} for the env_file paths.
export DESYN_ROOT
DESYN_PROJECT="desyn"
DESYN_NETWORK="desyn_net"
DESYN_SYSTEM_USER="desyn"
DESYN_PORT_MIN=47100
DESYN_PORT_MAX=47199
# Hostnames served by the host nginx (one certificate). The database/backend is Convex Cloud, not this host.
DESYN_DOMAINS=(desyn.app www.desyn.app app.desyn.app docs.desyn.app render.desyn.app)
# Blue/green services in rollout order: the render worker first (Convex Cloud calls it), then the Next apps.
DESYN_APPS=(worker landing web docs)
DESYN_CERT_NAME="desyn"
# Host paths (overridable only so the scripts can be exercised in a sandbox; never change them in production).
DESYN_ACME_ROOT="${DESYN_ACME_ROOT:-/var/www/desyn-acme}"
DESYN_NGINX_CACHE="${DESYN_NGINX_CACHE:-/var/cache/nginx/desyn}"
DESYN_HTPASSWD="${DESYN_HTPASSWD:-/etc/nginx/desyn.htpasswd}"
DESYN_BASIC_AUTH_FILE="${DESYN_BASIC_AUTH_FILE:-/root/desyn-basic-auth.txt}"
DESYN_SYSTEMD_DIR="${DESYN_SYSTEMD_DIR:-/etc/systemd/system}"
DESYN_LETSENCRYPT_LIVE="${DESYN_LETSENCRYPT_LIVE:-/etc/letsencrypt/live}"
DESYN_BUILDER="desyn-builder"
DESYN_KEEP_RELEASES="${DESYN_KEEP_RELEASES:-5}"
# Build cache the desyn-builder keeps after a deploy (warm enough for fast rebuilds; it grew to ~40 GB unpruned).
DESYN_BUILD_CACHE_KEEP="${DESYN_BUILD_CACHE_KEEP:-8gb}"
# Pinned helper images used by the scripts (never "latest").
DESYN_AWSCLI_IMAGE="amazon/aws-cli:2.38.2"
DESYN_VECTOR_IMAGE="timberio/vector:0.60.0-debian"
# Self-hosted Convex backend used only for restore drills (throwaway, SQLite); same pin as desyn.selfhost.yml.
DESYN_CONVEX_BACKEND_IMAGE="ghcr.io/convex/convex-backend:72ce13c379fe6dbdfc305bc8ad699c5663c68c2a"
# Production Convex Cloud deployment (deploy/env/public.env CONVEX_DEPLOYMENT).
DESYN_CONVEX_PROD_DEPLOYMENT="prod:opulent-alpaca-530"

DRY_RUN="${DRY_RUN:-0}"
ASSUME_YES="${ASSUME_YES:-0}"
REMOTE_HOST="${REMOTE_HOST:-}"
SCRIPT_NAME="$(basename "${BASH_SOURCE[-1]:-$0}")"
DESYN_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESYN_DEPLOY_DIR="$(cd "${DESYN_SCRIPTS_DIR}/.." && pwd)"

# Host ports per service and colour (127.0.0.1 only). Keep in sync with compose/desyn.prod.yml and
# nginx/sites-available/desyn-00-common.conf.
declare -A DESYN_APP_PORT=(
  [landing:blue]=47100 [landing:green]=47120
  [web:blue]=47101 [web:green]=47121
  [docs:blue]=47102 [docs:green]=47122
  [worker:blue]=47103 [worker:green]=47123
)
# Health path probed on each service's host port after a colour switch.
declare -A DESYN_HEALTH_PATH=([landing]=/ [web]=/ [docs]=/ [worker]=/healthz)

# ---------------------------------------------------------------------------------------------- logging

if [[ -t 2 ]]; then
  _c_dim=$'\033[2m' _c_red=$'\033[31m' _c_yel=$'\033[33m' _c_grn=$'\033[32m' _c_rst=$'\033[0m'
else
  _c_dim="" _c_red="" _c_yel="" _c_grn="" _c_rst=""
fi

_log() {
  local level=$1 color=$2
  shift 2
  printf '%s%s%s %s[%s]%s %s%s%s %s\n' "${_c_dim}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${_c_rst}" \
    "${_c_dim}" "${SCRIPT_NAME%.sh}" "${_c_rst}" "${color}" "${level}" "${_c_rst}" "$*" >&2
}
info() { _log "info " "" "$@"; }
ok() { _log "ok   " "${_c_grn}" "$@"; }
warn() { _log "warn " "${_c_yel}" "$@"; }
error() { _log "error" "${_c_red}" "$@"; }
die() {
  error "$@"
  exit 1
}

# ------------------------------------------------------------------------------------- command running

# run CMD...: execute, or print in --dry-run mode.
run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '%s[dry-run]%s' "${_c_yel}" "${_c_rst}" >&2
    printf ' %q' "$@" >&2
    printf '\n' >&2
    return 0
  fi
  "$@"
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "${cmd}" >/dev/null 2>&1 || die "required command not found: ${cmd}"
  done
}

require_root() {
  [[ "$(id -u)" -eq 0 ]] || die "run as root (sudo), or from your workstation with --host <ssh-host>"
}

# confirm "question" "expected answer": typed confirmation, skipped by --yes.
confirm() {
  local question=$1 expected=${2:-yes} answer
  if [[ "${ASSUME_YES}" == "1" ]]; then
    info "${question} -> confirmed by --yes"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    die "${question}: needs an interactive terminal or --yes"
  fi
  printf '%s Type "%s" to continue: ' "${question}" "${expected}" >&2
  read -r answer
  [[ "${answer}" == "${expected}" ]] || die "aborted"
}

# ------------------------------------------------------------------------------------------ arguments

# script_usage FILE: print the comment block at the top of FILE (after the shebang) as help text.
script_usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$1"
}

# common_arg "$@": handles one shared flag in the calling shell. Returns 1 when $1 is not a shared flag;
# otherwise sets COMMON_SHIFT to the number of words consumed. Usage in scripts:
#   while (($#)); do
#     case "$1" in
#       --label) LABEL=$2; shift 2 ;;
#       *) common_arg "$@" || usage_error "$1"; shift "${COMMON_SHIFT}" ;;
#     esac
#   done
COMMON_SHIFT=1
common_arg() {
  COMMON_SHIFT=1
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --verbose) set -x ;;
    --host)
      [[ $# -ge 2 && -n "$2" ]] || die "--host needs a value"
      REMOTE_HOST="$2"
      COMMON_SHIFT=2
      ;;
    --host=*) REMOTE_HOST="${1#--host=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) return 1 ;;
  esac
  export DRY_RUN ASSUME_YES
  return 0
}

usage_error() {
  error "unknown argument: $1"
  usage >&2
  exit 2
}

# strip_host_args "$@": prints the arguments without --host/--host=, NUL-separated.
strip_host_args() {
  while (($#)); do
    case "$1" in
      --host) shift ;;
      --host=*) ;;
      *) printf '%s\0' "$1" ;;
    esac
    shift
  done
}

# ----------------------------------------------------------------------------------------- remote mode

DESYN_SSH_OPTS=(-o BatchMode=yes -o ServerAliveInterval=30 -o ConnectTimeout=15)

# remote_dispatch HOST SCRIPT ARGS...: copy deploy/ to a temp dir on HOST and run SCRIPT there as root.
remote_dispatch() {
  local host=$1 script=$2
  shift 2
  require_cmd ssh tar
  info "running ${script} on ${host}"
  local rdir quoted tty_flag=()
  rdir="$(ssh "${DESYN_SSH_OPTS[@]}" "${host}" 'mktemp -d /tmp/desyn-tooling.XXXXXX')" ||
    die "cannot reach ${host} over ssh"
  # shellcheck disable=SC2029 # $rdir is expanded locally on purpose.
  tar -C "${DESYN_DEPLOY_DIR}" --exclude='./compose/.env' --exclude='./compose/convex.env' -czf - . |
    ssh "${DESYN_SSH_OPTS[@]}" "${host}" "tar --no-same-owner -xzf - -C '${rdir}'"
  # printf with no arguments would still print '' once, i.e. pass one empty argument to the script.
  quoted=""
  if (($#)); then quoted="$(printf '%q ' "$@")"; fi
  if [[ -t 0 && -t 1 ]]; then
    tty_flag=(-t)
  fi
  local rc=0
  # shellcheck disable=SC2029 # $rdir and $quoted are expanded locally on purpose.
  ssh "${DESYN_SSH_OPTS[@]}" "${tty_flag[@]}" "${host}" \
    "if [ \"\$(id -u)\" -eq 0 ]; then SUDO=''; else SUDO='sudo -n'; fi; \
     \$SUDO env DESYN_REMOTE_INVOCATION=1 DESYN_SSH_CLIENT_IP=\"\${SSH_CLIENT%% *}\" \
       bash '${rdir}/scripts/${script}' ${quoted}; rc=\$?; \
     rm -rf '${rdir}'; exit \$rc" || rc=$?
  return "${rc}"
}

# maybe_remote "$@" (original args): when --host was given, re-run this script remotely and exit.
maybe_remote() {
  if [[ -n "${REMOTE_HOST}" ]]; then
    local args=()
    while IFS= read -r -d '' a; do args+=("${a}"); done < <(strip_host_args "$@")
    remote_dispatch "${REMOTE_HOST}" "${SCRIPT_NAME}" "${args[@]}"
    exit $?
  fi
}

# ---------------------------------------------------------------------------------------------- files

# write_new_file PATH MODE OWNER: write stdin to PATH only when PATH does not exist yet.
# Returns 0 when written (or would be in dry-run), 1 when it already existed (left untouched).
write_new_file() {
  local path=$1 mode=$2 owner=$3 tmp
  if [[ -e "${path}" ]]; then
    info "exists, left untouched: ${path}"
    cat >/dev/null
    return 1
  fi
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] would create ${path} (mode ${mode}, owner ${owner})"
    cat >/dev/null
    return 0
  fi
  tmp="$(mktemp "${path}.tmp.XXXXXX")"
  chmod "${mode}" "${tmp}"
  chown "${owner}" "${tmp}"
  cat >"${tmp}"
  mv -n "${tmp}" "${path}"
  [[ -e "${tmp}" ]] && rm -f "${tmp}"
  ok "created ${path}"
}

# install_managed_file SRC DST MODE: install a desyn-managed file, keeping a timestamped backup when the
# content changes. Only ever called for paths named desyn*.
install_managed_file() {
  local src=$1 dst=$2 mode=$3
  # Only desyn-owned paths: a desyn* file name (sites, systemd units) or any file below a desyn/ directory
  # (/etc/nginx/desyn/snippets). Never e.g. /etc/nginx/nginx.conf.
  case "${dst}" in
    */desyn/* | */desyn[-.]*) ;;
    *) die "refusing to manage non-desyn file ${dst}" ;;
  esac
  if [[ -f "${dst}" ]] && cmp -s "${src}" "${dst}"; then
    return 0
  fi
  if [[ -f "${dst}" ]]; then
    local backup_dir
    backup_dir="${DESYN_ROOT}/state/backups/$(date -u +%Y%m%dT%H%M%SZ)"
    run mkdir -p "${backup_dir}"
    run cp -a "${dst}" "${backup_dir}/$(echo "${dst}" | tr '/' '_')"
  fi
  run install -D -m "${mode}" "${src}" "${dst}"
  info "installed ${dst}"
}

# env_value FILE KEY: print the value of KEY from a KEY=VALUE env file without sourcing it.
# Used to pass settings to commands; callers never log the result.
env_value() {
  local file=$1 key=$2 line
  [[ -r "${file}" ]] || return 1
  line="$(grep -E "^${key}=" "${file}" | tail -n 1 || true)"
  [[ -n "${line}" ]] || return 1
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  printf '%s' "${line}"
}

# env_has_value FILE KEY: true when KEY is present with a non-empty value.
env_has_value() {
  local v
  v="$(env_value "$1" "$2" 2>/dev/null || true)"
  [[ -n "${v}" ]]
}

random_hex() {
  od -An -N "${1:-32}" -tx1 /dev/urandom | tr -d ' \n'
}

# ---------------------------------------------------------------------------------------------- docker

compose_file() { printf '%s' "${DESYN_ROOT}/tooling/compose/desyn.prod.yml"; }

# dc ARGS...: docker compose for the desyn project with the current image tags.
dc() {
  docker compose \
    --project-name "${DESYN_PROJECT}" \
    --project-directory "${DESYN_ROOT}/tooling/compose" \
    -f "$(compose_file)" \
    --env-file "${DESYN_ROOT}/state/images.env" \
    --profile bluegreen \
    "$@"
}

image_exists() { docker image inspect "$1" >/dev/null 2>&1; }

container_health() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null ||
    echo "missing"
}

# wait_healthy CONTAINER TIMEOUT_SECONDS
wait_healthy() {
  local name=$1 timeout=${2:-120} waited=0 status
  while ((waited < timeout)); do
    status="$(container_health "${name}")"
    case "${status}" in
      healthy | running) return 0 ;;
      unhealthy | exited | dead | missing) ;;
    esac
    sleep 3
    waited=$((waited + 3))
  done
  error "${name} not healthy after ${timeout}s (status: $(container_health "${name}"))"
  return 1
}

# http_probe URL [MAX_STATUS]: true when URL answers with a status below MAX_STATUS (default 500).
http_probe() {
  local url=$1 max=${2:-500} code
  code="$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "${url}" 2>/dev/null || echo 000)"
  [[ "${code}" != "000" && "${code}" -lt "${max}" ]]
}

# ----------------------------------------------------------------------------------------------- state

state_file() { printf '%s/state/%s' "${DESYN_ROOT}" "$1"; }

active_color() {
  local f
  f="$(state_file "active/$1")"
  if [[ -f "${f}" ]]; then cat "${f}"; else echo "none"; fi
}

other_color() {
  if [[ "$1" == "blue" ]]; then echo green; else echo blue; fi
}

# set_image_var FILE KEY VALUE: set KEY=VALUE in an images.env-style file (non-secret).
set_image_var() {
  local file=$1 key=$2 value=$3 tmp
  tmp="$(mktemp)"
  if [[ -f "${file}" ]]; then grep -v -E "^${key}=" "${file}" >"${tmp}" || true; fi
  printf '%s=%s\n' "${key}" "${value}" >>"${tmp}"
  sort -o "${tmp}" "${tmp}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] would set ${key}=${value} in ${file}"
    rm -f "${tmp}"
    return 0
  fi
  install -m 0644 "${tmp}" "${file}"
  rm -f "${tmp}"
}

upper() { printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_'; }

require_bootstrapped() {
  [[ -d "${DESYN_ROOT}/secrets" && -f "${DESYN_ROOT}/state/images.env" ]] ||
    die "${DESYN_ROOT} is not bootstrapped; run deploy/scripts/bootstrap.sh first"
  docker network inspect "${DESYN_NETWORK}" >/dev/null 2>&1 ||
    die "docker network ${DESYN_NETWORK} is missing; run deploy/scripts/bootstrap.sh"
}
