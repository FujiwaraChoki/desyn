#!/usr/bin/env bash
# Remove Desyn from the server. Only desyn resources are touched: compose project "desyn" containers,
# networks desyn_net/desyn_drill_* (and desyn_db of older installs), images desyn/*, buildx builder
# desyn-builder, container desyn-vector, systemd units desyn-*, nginx desyn-* sites + /etc/nginx/desyn +
# /etc/nginx/desyn.htpasswd, /var/cache/nginx/desyn, /var/www/desyn-acme, /opt/desyn (partially, see below),
# system user desyn. The data itself lives in Convex Cloud and S3 and is never touched.
#
# Default: local state is kept (docker volumes, /opt/desyn/secrets, /opt/desyn/backups, the certificate).
#   --purge-data     also delete volumes (Vector state, volumes of older self-hosted installs), the env files
#                    in /opt/desyn/secrets, local backups, /root/desyn-basic-auth*.txt  (second typed confirmation)
#   --delete-certs   also `certbot delete --cert-name desyn`
#
# Usage: deploy/scripts/uninstall.sh --host hetzner [--purge-data] [--delete-certs] [--dry-run] [--yes]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/nginx.sh
source "${SCRIPT_DIR}/lib/nginx.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

PURGE=0
DELETE_CERTS=0
ORIG_ARGS=("$@")
while (($#)); do
  case "$1" in
    --purge-data) PURGE=1 && shift ;;
    --delete-certs) DELETE_CERTS=1 && shift ;;
    *)
      common_arg "$@" || usage_error "$1"
      shift "${COMMON_SHIFT}"
      ;;
  esac
done
maybe_remote "${ORIG_ARGS[@]}"

require_root
require_cmd docker

confirm "Uninstall Desyn from $(hostname)?" "uninstall desyn"
if [[ "${PURGE}" == "1" ]]; then
  confirm "Permanently delete the local Desyn state (volumes, env files, local backups)?" "delete all desyn data"
fi

info "systemd units"
for unit in desyn-backup.timer desyn-backup.service desyn-logship.service; do
  if systemctl list-unit-files "${unit}" --no-legend 2>/dev/null | grep -q .; then
    run systemctl disable --now "${unit}" || true
  fi
  [[ -f "${DESYN_SYSTEMD_DIR}/${unit}" ]] && run rm -f "${DESYN_SYSTEMD_DIR}/${unit}"
done
run systemctl daemon-reload

info "containers"
mapfile -t containers < <(docker ps -aq --filter "label=com.docker.compose.project=${DESYN_PROJECT}")
mapfile -t -O "${#containers[@]}" containers < <(docker ps -aq --filter "label=com.desyn.owner=desyn")
if ((${#containers[@]})); then
  run docker rm -f "${containers[@]}" >/dev/null
fi

info "networks"
for net in "${DESYN_NETWORK}" desyn_db $(docker network ls --format '{{.Name}}' | grep -E '^desyn_drill_' || true); do
  docker network inspect "${net}" >/dev/null 2>&1 || continue
  owner="$(docker network inspect "${net}" --format '{{index .Labels "com.desyn.owner"}}{{index .Labels "com.docker.compose.project"}}')"
  if [[ "${owner}" != *desyn* ]]; then
    warn "network ${net} is not labelled as desyn-owned; left in place"
    continue
  fi
  attached="$(docker network inspect "${net}" --format '{{len .Containers}}')"
  if [[ "${attached}" != "0" ]]; then
    warn "network ${net} still has ${attached} container(s) attached; left in place"
    continue
  fi
  run docker network rm "${net}" >/dev/null
done

info "images and builder"
mapfile -t images < <(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^desyn/' || true)
if ((${#images[@]})); then run docker image rm "${images[@]}" >/dev/null || true; fi
if docker buildx inspect "${DESYN_BUILDER}" >/dev/null 2>&1; then run docker buildx rm "${DESYN_BUILDER}"; fi

if [[ "${PURGE}" == "1" ]]; then
  info "volumes"
  mapfile -t volumes < <(
    docker volume ls -q --filter "label=com.docker.compose.project=${DESYN_PROJECT}"
    docker volume ls -q --filter "label=com.desyn.owner=desyn"
    docker volume ls -q --filter "name=^desyn_vector_data$"
  )
  mapfile -t volumes < <(printf '%s\n' "${volumes[@]}" | sed '/^$/d' | sort -u)
  if ((${#volumes[@]})); then run docker volume rm "${volumes[@]}" >/dev/null; fi
fi

info "nginx"
if command -v nginx >/dev/null 2>&1; then
  for f in "${DESYN_NGINX_ETC}"/sites-enabled/desyn-*; do
    [[ -L "${f}" || -f "${f}" ]] && run rm -f "${f}"
  done
  for f in "${DESYN_NGINX_ETC}"/sites-available/desyn-*; do
    [[ -f "${f}" ]] && run rm -f "${f}"
  done
  [[ -d "${DESYN_NGINX_ETC}/desyn" ]] && run rm -rf "${DESYN_NGINX_ETC}/desyn"
  [[ -f "${DESYN_HTPASSWD}" ]] && run rm -f "${DESYN_HTPASSWD}"
  nginx_test_and_reload || error "nginx -t failed after removing the desyn files; inspect with nginx -t"
fi
[[ -d "${DESYN_NGINX_CACHE}" ]] && run rm -rf "${DESYN_NGINX_CACHE}"
[[ -d "${DESYN_ACME_ROOT}" ]] && run rm -rf "${DESYN_ACME_ROOT}"

if [[ "${DELETE_CERTS}" == "1" ]] && command -v certbot >/dev/null 2>&1; then
  if [[ -d "/etc/letsencrypt/live/${DESYN_CERT_NAME}" ]]; then
    run certbot delete --cert-name "${DESYN_CERT_NAME}" --non-interactive
  fi
fi

info "${DESYN_ROOT}"
if [[ -d "${DESYN_ROOT}" ]]; then
  if [[ "${PURGE}" == "1" ]]; then
    run rm -rf "${DESYN_ROOT:?}"
    for f in /root/desyn-basic-auth*.txt; do [[ -f "${f}" ]] && run rm -f "${f}"; done
  else
    for d in tooling tooling.prev tooling.new releases state current; do
      [[ -e "${DESYN_ROOT}/${d}" || -L "${DESYN_ROOT}/${d}" ]] && run rm -rf "${DESYN_ROOT:?}/${d}"
    done
    info "kept ${DESYN_ROOT}/secrets and ${DESYN_ROOT}/backups (use --purge-data to delete them)"
  fi
fi

if id "${DESYN_SYSTEM_USER}" >/dev/null 2>&1; then run userdel "${DESYN_SYSTEM_USER}"; fi
ok "desyn removed$([[ "${PURGE}" == "1" ]] && echo " including its local state")"
