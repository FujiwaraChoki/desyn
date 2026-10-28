#!/usr/bin/env bash
# The pre-launch HTTP basic auth switch for the human-facing hosts desyn.app, app.desyn.app and docs.desyn.app
# (one file: /etc/nginx/desyn/local/auth-switch.conf). render.desyn.app never asks for basic auth (Convex Cloud
# calls it with the shared secret header), whatever the switch says.
#
# Usage:
#   deploy/scripts/basic-auth.sh --host hetzner status
#   deploy/scripts/basic-auth.sh --host hetzner off              launch: public access (nginx -t, reload)
#   deploy/scripts/basic-auth.sh --host hetzner on               back to pre-launch
#   deploy/scripts/basic-auth.sh --host hetzner rotate-password  new random password for the existing user,
#                                                                plus a new gate token (logs every browser out)
#   deploy/scripts/basic-auth.sh --host hetzner rotate-gate      only a new gate token: invalidates every
#                                                                desyn_gate cookie (30-day pass) handed out so far
#   deploy/scripts/basic-auth.sh --host hetzner add-user NAME    extra user; password in /root/desyn-basic-auth-NAME.txt
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/nginx.sh
source "${SCRIPT_DIR}/lib/nginx.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

ACTION=""
NAME=""
ORIG_ARGS=("$@")
while (($#)); do
  case "$1" in
    status | on | off | rotate-password | rotate-gate)
      ACTION="$1"
      shift
      ;;
    add-user)
      ACTION="add-user"
      NAME="${2:-}"
      shift 2 || die "add-user needs a NAME"
      ;;
    *)
      common_arg "$@" || usage_error "$1"
      shift "${COMMON_SHIFT}"
      ;;
  esac
done
[[ -n "${ACTION}" ]] || {
  usage >&2
  exit 2
}
maybe_remote "${ORIG_ARGS[@]}"

require_root
require_cmd nginx openssl
switch="${DESYN_NGINX_ETC}/desyn/local/auth-switch.conf"
[[ -f "${switch}" ]] || die "${switch} missing; run bootstrap.sh first"

current_state() {
  if grep -qE '^\s*default 1;' "${switch}"; then echo on; else echo off; fi
}

set_switch() {
  local want=$1 value=1 tmp backup
  [[ "${want}" == "off" ]] && value=0
  if [[ "$(current_state)" == "${want}" ]]; then
    ok "basic auth already ${want}"
    return 0
  fi
  tmp="$(mktemp -d)"
  render_auth_switch "${tmp}" "${value}"
  backup="$(mktemp)"
  cp -a "${switch}" "${backup}"
  run install -m 0644 "${tmp}/auth-switch.conf" "${switch}"
  rm -rf "${tmp}"
  if nginx_test_and_reload; then
    rm -f "${backup}"
    ok "basic auth ${want} for desyn.app, app.desyn.app and docs.desyn.app"
  else
    cp -a "${backup}" "${switch}"
    rm -f "${backup}"
    die "nginx rejected the change; restored the previous switch"
  fi
}

write_user() {
  local user=$1 file=$2 mode=$3 password hash tmp
  password="$(random_hex 16)"
  hash="$(openssl passwd -6 -stdin <<<"${password}")"
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] would set a new password for ${user} in ${DESYN_HTPASSWD} and ${file}"
    return 0
  fi
  tmp="$(mktemp)"
  grep -v -E "^${user}:" "${DESYN_HTPASSWD}" >"${tmp}" 2>/dev/null || true
  printf '%s:%s\n' "${user}" "${hash}" >>"${tmp}"
  install -m 0640 -o root -g "$(nginx_user)" "${tmp}" "${DESYN_HTPASSWD}"
  rm -f "${tmp}"
  (
    umask 077
    printf 'Desyn pre-launch HTTP basic auth (all desyn.app hosts)\nuser: %s\npassword: %s\n' "${user}" "${password}" >"${file}.tmp"
  )
  chmod "${mode}" "${file}.tmp"
  mv -f "${file}.tmp" "${file}"
  ok "credentials for ${user} written to ${file} (root only); nginx reads the htpasswd on every request"
}

# rotate_gate: new random gate token. A password rotation alone would leave every 30-day desyn_gate cookie
# issued so far valid, so a leaked password would keep working through its cookie.
rotate_gate() {
  local gate="${DESYN_NGINX_ETC}/desyn/local/gate.conf" tmp backup
  [[ -f "${gate}" ]] || die "${gate} missing; run bootstrap.sh first"
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] would write a new gate token to ${gate} (0600), run nginx -t and reload"
    return 0
  fi
  tmp="$(mktemp -d)"
  render_gate "${tmp}" "$(random_hex 32)"
  backup="$(mktemp)"
  cp -a "${gate}" "${backup}"
  install -m 0600 -o root -g root "${tmp}/gate.conf" "${gate}"
  rm -rf "${tmp}"
  if nginx_test_and_reload; then
    rm -f "${backup}"
    ok "new gate token active: every browser has to pass basic auth again"
  else
    cp -a "${backup}" "${gate}"
    rm -f "${backup}"
    die "nginx rejected the new gate token; restored the previous one"
  fi
}

case "${ACTION}" in
  status)
    echo "basic auth: $(current_state)"
    echo "users: $(cut -d: -f1 "${DESYN_HTPASSWD}" 2>/dev/null | tr '\n' ' ')"
    ;;
  on | off) set_switch "${ACTION}" ;;
  rotate-password)
    user="$(sed -n 's/^user: //p' "${DESYN_BASIC_AUTH_FILE}" 2>/dev/null || true)"
    user="${user:-desyn}"
    confirm "Replace the basic-auth password of ${user}?" "rotate"
    write_user "${user}" "${DESYN_BASIC_AUTH_FILE}" 0600
    rotate_gate
    ;;
  rotate-gate) rotate_gate ;;
  add-user)
    [[ "${NAME}" =~ ^[a-z][a-z0-9_-]{1,31}$ ]] || die "invalid user name"
    file="/root/desyn-basic-auth-${NAME}.txt"
    [[ -e "${file}" ]] && die "${file} exists; refusing to overwrite (use rotate-password for the main user)"
    write_user "${NAME}" "${file}" 0600
    ;;
esac
