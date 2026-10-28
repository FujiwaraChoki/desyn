#!/usr/bin/env bash
# Prepare the shared server for Desyn. Idempotent: safe to re-run; never overwrites an existing file it
# generated before (htpasswd, host-specific nginx files) and never touches non-desyn resources.
#
# Creates:
#   system user "desyn" (no login), /opt/desyn/{tooling,releases,state,secrets(0700),backups(0700)}
#   /etc/nginx/desyn.htpasswd + /root/desyn-basic-auth.txt (0600) with a random password (user "desyn")
#   /etc/nginx/desyn/{snippets,local}, sites desyn-00-common + desyn-acme (HTTP + ACME only), nginx reload
#   (local/ holds the host-specific files; a file missing from an older install, such as resolver.conf, is added)
#   docker network desyn_net (label com.desyn.owner=desyn), buildx builder desyn-builder (CPU/memory capped)
#   systemd units desyn-backup.{service,timer} (timer enabled) and desyn-logship.service (enabled once
#   /opt/desyn/secrets/axiom.env exists)
# The service env files in /opt/desyn/secrets are not created here: deploy/scripts/server-env.py writes them
# from .env.keys on your workstation (deploy.sh runs it on every deploy).
#
# Usage:
#   deploy/scripts/bootstrap.sh --host hetzner [--dry-run] [--basic-auth-user NAME] [--builder-cpus N]
#                               [--builder-memory 16g]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/nginx.sh
source "${SCRIPT_DIR}/lib/nginx.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

BASIC_AUTH_USER="desyn"
BUILDER_CPUS=6
BUILDER_MEMORY="16g"
ORIG_ARGS=("$@")
while (($#)); do
  case "$1" in
    --basic-auth-user)
      BASIC_AUTH_USER="$2"
      shift 2
      ;;
    --builder-cpus)
      BUILDER_CPUS="$2"
      shift 2
      ;;
    --builder-memory)
      BUILDER_MEMORY="$2"
      shift 2
      ;;
    *)
      common_arg "$@" || usage_error "$1"
      shift "${COMMON_SHIFT}"
      ;;
  esac
done
maybe_remote "${ORIG_ARGS[@]}"

require_root
require_cmd docker nginx openssl systemctl install od
docker compose version >/dev/null 2>&1 || die "docker compose plugin is required"
nginx_sites_dir_layout_ok || die "nginx must include /etc/nginx/sites-enabled/* (Debian/Ubuntu layout)"
[[ "${BASIC_AUTH_USER}" =~ ^[a-z][a-z0-9_-]{1,31}$ ]] || die "invalid --basic-auth-user"

info "bootstrapping ${DESYN_ROOT} (dry-run=${DRY_RUN})"

# ------------------------------------------------------------------------------------------- user/dirs
if id "${DESYN_SYSTEM_USER}" >/dev/null 2>&1; then
  info "system user ${DESYN_SYSTEM_USER} exists"
else
  run useradd --system --home-dir "${DESYN_ROOT}" --no-create-home --shell /usr/sbin/nologin \
    --comment "Desyn deploy" "${DESYN_SYSTEM_USER}"
fi

run install -d -m 0755 -o root -g root "${DESYN_ROOT}" "${DESYN_ROOT}/tooling" "${DESYN_ROOT}/state" \
  "${DESYN_ROOT}/state/active" "${DESYN_ROOT}/state/history"
run install -d -m 0750 -o root -g "${DESYN_SYSTEM_USER}" "${DESYN_ROOT}/releases"
run install -d -m 0700 -o root -g root "${DESYN_ROOT}/secrets" "${DESYN_ROOT}/backups"
run install -d -m 0755 -o root -g root "${DESYN_ACME_ROOT}" "${DESYN_ACME_ROOT}/.well-known" \
  "${DESYN_ACME_ROOT}/.well-known/acme-challenge"
NGINX_USER="$(nginx_user)"
run install -d -m 0700 -o "${NGINX_USER}" -g root "${DESYN_NGINX_CACHE}"

# Tooling: this deploy/ directory, so systemd units and manual runs have a stable path before the first
# release (deploy.sh refreshes it from every release).
if [[ "${DESYN_DEPLOY_DIR}" != "${DESYN_ROOT}/tooling" ]]; then
  run rm -rf "${DESYN_ROOT}/tooling.new"
  run cp -a "${DESYN_DEPLOY_DIR}" "${DESYN_ROOT}/tooling.new"
  run rm -rf "${DESYN_ROOT}/tooling"
  run mv "${DESYN_ROOT}/tooling.new" "${DESYN_ROOT}/tooling"
fi

if [[ ! -f "${DESYN_ROOT}/state/images.env" ]]; then
  printf '# Image tags per service/colour, written by deploy.sh (non-secret).\nDESYN_IMAGE_PREFIX=desyn\n' |
    write_new_file "${DESYN_ROOT}/state/images.env" 0644 root:root || true
fi

# ------------------------------------------------------------------------------------- basic auth
if [[ -e "${DESYN_HTPASSWD}" ]]; then
  info "exists, left untouched: ${DESYN_HTPASSWD}"
  [[ -e "${DESYN_BASIC_AUTH_FILE}" ]] || warn "${DESYN_BASIC_AUTH_FILE} is missing; rotate with basic-auth.sh rotate-password"
elif [[ -e "${DESYN_BASIC_AUTH_FILE}" ]]; then
  die "${DESYN_BASIC_AUTH_FILE} exists without ${DESYN_HTPASSWD}; refusing to overwrite it (move it away first)"
else
  password="$(random_hex 16)"
  printf 'Desyn pre-launch HTTP basic auth (all desyn.app hosts)\nuser: %s\npassword: %s\n' \
    "${BASIC_AUTH_USER}" "${password}" | write_new_file "${DESYN_BASIC_AUTH_FILE}" 0600 root:root || true
  printf '%s:%s\n' "${BASIC_AUTH_USER}" "$(openssl passwd -6 -stdin <<<"${password}")" |
    write_new_file "${DESYN_HTPASSWD}" 0640 "root:${NGINX_USER}" || true
  unset password
  info "basic-auth credentials stored in ${DESYN_BASIC_AUTH_FILE} (root only)"
fi

# --------------------------------------------------------------------------------------- network
if docker network inspect "${DESYN_NETWORK}" >/dev/null 2>&1; then
  owner="$(docker network inspect "${DESYN_NETWORK}" --format '{{index .Labels "com.desyn.owner"}}')"
  [[ "${owner}" == "desyn" ]] || die "network ${DESYN_NETWORK} exists but is not labelled com.desyn.owner=desyn"
  info "docker network ${DESYN_NETWORK} exists"
else
  run docker network create --driver bridge --label com.desyn.owner=desyn "${DESYN_NETWORK}"
fi

# ---------------------------------------------------------------------------------- nginx (local)
LOCAL_DIR="${DESYN_NGINX_ETC}/desyn/local"
run install -d -m 0755 "${DESYN_NGINX_ETC}/desyn" "${DESYN_NGINX_ETC}/desyn/snippets"
run install -d -m 0750 "${LOCAL_DIR}"
GEN="$(mktemp -d)"
trap 'rm -rf "${GEN}"' EXIT
NGINX_VERSION="$(nginx_version)"
IPV6=0
host_has_ipv6 && IPV6=1
render_listen_snippets "${GEN}" "${NGINX_VERSION}" "${IPV6}" "$(detect_http2_mode "${NGINX_VERSION}")"
render_auth_switch "${GEN}" 1
render_gate "${GEN}" "$(random_hex 32)"
mapfile -t host_ips < <(ip -o addr show scope global 2>/dev/null | awk '{split($4, a, "/"); print a[1]}')
net_subnets=()
if [[ "${DRY_RUN}" != "1" ]] || docker network inspect "${DESYN_NETWORK}" >/dev/null 2>&1; then
  read -r -a net_subnets <<<"$(docker network inspect "${DESYN_NETWORK}" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null || true)"
fi
render_trusted "${GEN}" 127.0.0.1 ::1 "${net_subnets[@]}" "${host_ips[@]}"
BROTLI=0
nginx_has_brotli && BROTLI=1
render_brotli "${GEN}" "${BROTLI}"
mapfile -t nameservers < <(host_nameservers)
if [[ ! -e "${LOCAL_DIR}/resolver.conf" ]]; then
  render_resolver "${GEN}" "${IPV6}" "${nameservers[@]}" ||
    die "no usable nameserver in ${DESYN_RESOLV_CONF}; nginx needs one to reach the Convex Cloud site URL"
fi
for f in "${DESYN_NGINX_LOCAL_FILES[@]}"; do
  [[ -f "${GEN}/${f}" ]] || continue
  mode=0644
  [[ "${f}" == "gate.conf" ]] && mode=0600
  write_new_file "${LOCAL_DIR}/${f}" "${mode}" root:root <"${GEN}/${f}" || true
done

install_nginx_snippets "${DESYN_DEPLOY_DIR}"
install_nginx_sites "${DESYN_DEPLOY_DIR}" "${DESYN_NGINX_BASE_SITES[@]}"
if ! nginx_test_and_reload; then
  error "nginx -t failed; disabling the desyn sites again"
  disable_nginx_sites "${DESYN_NGINX_BASE_SITES[@]}"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  die "nginx configuration rejected; nothing else was changed in nginx"
fi

# ---------------------------------------------------------------------------------- buildx builder
if docker buildx inspect "${DESYN_BUILDER}" >/dev/null 2>&1; then
  info "buildx builder ${DESYN_BUILDER} exists"
else
  quota=$((BUILDER_CPUS * 100000))
  run docker buildx create --name "${DESYN_BUILDER}" --driver docker-container \
    --driver-opt "cpu-quota=${quota},cpu-period=100000,memory=${BUILDER_MEMORY}" \
    --buildkitd-config "${DESYN_ROOT}/tooling/docker/buildkitd.toml" \
    --bootstrap
fi

# --------------------------------------------------------------------------------------- systemd
for unit in desyn-backup.service desyn-backup.timer desyn-logship.service; do
  install_managed_file "${DESYN_DEPLOY_DIR}/systemd/${unit}" "${DESYN_SYSTEMD_DIR}/${unit}" 0644
done
run systemctl daemon-reload
run systemctl enable --now desyn-backup.timer
if env_has_value "${DESYN_ROOT}/secrets/axiom.env" AXIOM_TOKEN; then
  run systemctl enable --now desyn-logship.service
else
  info "log shipping starts once ${DESYN_ROOT}/secrets/axiom.env exists (server-env.py writes it when AXIOM_TOKEN is in .env.keys; deploy.sh then enables desyn-logship.service)"
fi

ok "bootstrap complete"
cat >&2 <<EOF

Next steps (deploy/RUNBOOK.md):
  1. DNS for ${DESYN_DOMAINS[*]} must point at this host.
  2. deploy/scripts/certs.sh --host <ssh-host> --email <you@domain>
  3. deploy/scripts/deploy.sh --host <ssh-host>   (writes ${DESYN_ROOT}/secrets/*.env from .env.keys via
     server-env.py, deploys the Convex functions to Convex Cloud and rolls out worker, landing, web, docs)
Basic-auth credentials: sudo cat ${DESYN_BASIC_AUTH_FILE}
EOF
