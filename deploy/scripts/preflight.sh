#!/usr/bin/env bash
# Read-only inspection of the target server before (and between) Desyn deploys. Changes nothing.
#
# Reports: OS/CPU/memory/disk, Docker (version, compose, buildx, networks + subnets, containers, volumes),
# listening ports and whether the reserved range 127.0.0.1:47100-47199 is free, nginx (version, http2/IPv6
# listen style, brotli, enabled sites, server_names already claiming desyn hostnames), certbot and existing
# certificates, DNS of every desyn hostname vs this host's addresses, outbound HTTPS to Convex Cloud, S3 and the
# image/package registries the builds need, firewall, existing desyn resources.
#
# Usage:
#   deploy/scripts/preflight.sh --host hetzner      from your workstation (runs remotely via ssh)
#   sudo deploy/scripts/preflight.sh                on the server
# Exit status: 0 = no blocking issue, 1 = blocking issue found (listed at the end).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/nginx.sh
source "${SCRIPT_DIR}/lib/nginx.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

ORIG_ARGS=("$@")
while (($#)); do
  common_arg "$@" || usage_error "$1"
  shift "${COMMON_SHIFT}"
done
maybe_remote "${ORIG_ARGS[@]}"

BLOCKERS=()
WARNINGS=()
blocker() {
  BLOCKERS+=("$*")
  error "$*"
}
warning() {
  WARNINGS+=("$*")
  warn "$*"
}
section() { printf '\n== %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [[ "$(id -u)" -ne 0 ]]; then
  warning "not running as root: nginx -T, certbot and some docker details will be missing"
fi

section "Host"
printf 'hostname   %s\n' "$(hostname -f 2>/dev/null || hostname)"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  printf 'os         %s\n' "$(. /etc/os-release && echo "${PRETTY_NAME}")"
fi
printf 'kernel     %s\n' "$(uname -r)"
printf 'cpus       %s\n' "$(nproc)"
printf 'load       %s\n' "$(cut -d' ' -f1-3 /proc/loadavg)"
if have free; then free -h | sed 's/^/           /'; fi

section "Disk"
df -h / /opt /var/lib/docker 2>/dev/null | awk 'NR == 1 || !seen[$0]++' | sed 's/^/  /'
root_free_pct="$(df --output=pcent / | tail -n 1 | tr -dc '0-9')"
if [[ -n "${root_free_pct}" && "${root_free_pct}" -ge 90 ]]; then
  blocker "root filesystem is ${root_free_pct}% full"
fi
avail_gb="$(df -BG --output=avail / | tail -n 1 | tr -dc '0-9')"
if [[ -n "${avail_gb}" && "${avail_gb}" -lt 40 ]]; then
  warning "only ${avail_gb} GB free on / (images, build cache and backups need ~40 GB)"
fi

section "Docker"
if have docker && docker info >/dev/null 2>&1; then
  printf 'engine     %s\n' "$(docker version --format '{{.Server.Version}}')"
  printf 'compose    %s\n' "$(docker compose version --short 2>/dev/null || echo missing)"
  printf 'buildx     %s\n' "$(docker buildx version 2>/dev/null | awk '{print $2}' || echo missing)"
  printf 'root dir   %s\n' "$(docker info --format '{{.DockerRootDir}}')"
  docker compose version >/dev/null 2>&1 || blocker "docker compose plugin missing"
  echo "networks:"
  docker network ls --format '{{.Name}}' | while read -r net; do
    subnet="$(docker network inspect "${net}" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null)"
    printf '  %-32s %s\n' "${net}" "${subnet}"
  done
  echo "containers ($(docker ps -q | wc -l) running, $(docker ps -aq | wc -l) total):"
  docker ps -a --format '  {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' | column -t -s $'\t' 2>/dev/null || true
  echo "compose projects:"
  docker ps -a --format '{{.Label "com.docker.compose.project"}}' | sort -u | sed '/^$/d; s/^/  /'
  desyn_containers="$(docker ps -a --filter "label=com.docker.compose.project=${DESYN_PROJECT}" -q | wc -l)"
  printf 'desyn      %s containers, network %s: %s\n' "${desyn_containers}" "${DESYN_NETWORK}" \
    "$(docker network inspect "${DESYN_NETWORK}" >/dev/null 2>&1 && echo present || echo absent)"
  echo "volumes named desyn*:"
  docker volume ls --format '{{.Name}}' | grep -E '^desyn' | sed 's/^/  /' || echo "  (none)"
  if docker network inspect "${DESYN_NETWORK}" >/dev/null 2>&1; then
    owner="$(docker network inspect "${DESYN_NETWORK}" --format '{{index .Labels "com.desyn.owner"}}')"
    [[ "${owner}" == "desyn" ]] || blocker "network ${DESYN_NETWORK} exists but was not created by bootstrap.sh (label com.desyn.owner missing)"
  fi
else
  blocker "docker engine not reachable"
fi

section "Ports (listening TCP)"
if have ss; then
  ss -H -ltn | awk '{print $4}' | sort -u | sed 's/^/  /' | head -n 60
  in_range="$(ss -H -ltn | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/' |
    awk -v lo="${DESYN_PORT_MIN}" -v hi="${DESYN_PORT_MAX}" '$1 >= lo && $1 <= hi' | sort -un | tr '\n' ' ')"
  if [[ -n "${in_range// /}" ]]; then
    ours="$(docker ps --filter "label=com.docker.compose.project=${DESYN_PROJECT}" --format '{{.Ports}}' 2>/dev/null | tr ',' '\n' | sed -nE 's/.*:([0-9]+)->.*/\1/p' | sort -un | tr '\n' ' ')"
    for p in ${in_range}; do
      if [[ " ${ours} " == *" ${p} "* ]]; then
        printf '  port %s used by desyn (expected)\n' "${p}"
      else
        blocker "port ${p} in the reserved desyn range ${DESYN_PORT_MIN}-${DESYN_PORT_MAX} is used by something else"
      fi
    done
  else
    ok "reserved range ${DESYN_PORT_MIN}-${DESYN_PORT_MAX} is free"
  fi
  for p in 80 443; do
    ss -H -ltn "sport = :${p}" | grep -q . || warning "nothing listens on :${p} (host nginx expected)"
  done
else
  warning "ss not available"
fi

section "nginx"
if have nginx; then
  version="$(nginx_version)"
  printf 'version    %s\n' "${version}"
  printf 'active     %s\n' "$(systemctl is-active nginx 2>/dev/null || echo unknown)"
  printf 'http2      %s\n' "$(detect_http2_mode "${version}")"
  printf 'ipv6       %s\n' "$(host_has_ipv6 && echo yes || echo no)"
  printf 'brotli     %s\n' "$(nginx_has_brotli && echo yes || echo no)"
  printf 'user       %s\n' "$(nginx_user)"
  if [[ "$(id -u)" -eq 0 ]]; then
    nginx_sites_dir_layout_ok || blocker "nginx does not include /etc/nginx/sites-enabled/* (Debian layout expected)"
    echo "enabled sites:"
    find /etc/nginx/sites-enabled -maxdepth 1 \( -type l -o -type f \) -printf '  %f\n' 2>/dev/null | sort
    echo "server_name claims for desyn hostnames outside desyn-* files:"
    conflicts=0
    for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
      [[ -e "${f}" ]] || continue
      case "$(basename "${f}")" in desyn-*) continue ;; esac
      for d in "${DESYN_DOMAINS[@]}"; do
        if grep -Eq "server_name[^;]*[[:space:]]${d//./\\.}([[:space:];]|$)" "${f}"; then
          blocker "$(basename "${f}") already claims ${d}"
          conflicts=1
        fi
      done
    done
    ((conflicts)) || echo "  (none)"
    # desyn listens on the wildcard address (listen 80 / 443). nginx hands a connection to an explicitly bound
    # address (listen 203.0.113.10:443) only to the servers bound to that address, so desyn would never see
    # requests arriving there and other sites' default servers would answer for the desyn hostnames.
    explicit="$(nginx -T 2>/dev/null | grep -oE '^\s*listen\s+(\[[0-9A-Fa-f:.]+\]|[0-9]{1,3}(\.[0-9]{1,3}){3}):(80|443)\b' |
      awk '{print $2}' | grep -vE '^(127\.|\[::1\])' | sort -u | tr '\n' ' ' || true)"
    if [[ -n "${explicit// /}" ]]; then
      warning "other sites listen on explicit addresses (${explicit% }); add matching lines (e.g. 'listen <ip>:443 ssl;') to /etc/nginx/desyn/local/listen-80.conf and listen-443.conf after bootstrap, or desyn hostnames will reach those sites instead"
    fi
    if nginx -T >/dev/null 2>&1; then ok "nginx -T: configuration valid"; else blocker "current nginx configuration does not validate (nginx -T)"; fi
    echo "existing desyn nginx files:"
    find /etc/nginx/sites-available /etc/nginx/desyn -maxdepth 2 -name 'desyn*' -printf '  %p\n' 2>/dev/null | sort || true
    if [[ -f "${DESYN_HTPASSWD}" ]]; then echo "  ${DESYN_HTPASSWD}"; fi
  fi
else
  blocker "nginx is not installed on the host"
fi

section "TLS"
if have certbot; then
  printf 'certbot    %s\n' "$(certbot --version 2>&1 | awk '{print $2}')"
  if [[ "$(id -u)" -eq 0 ]]; then
    if [[ -f "/etc/letsencrypt/live/${DESYN_CERT_NAME}/fullchain.pem" ]]; then
      printf 'desyn cert %s\n' "$(openssl x509 -noout -enddate -in "/etc/letsencrypt/live/${DESYN_CERT_NAME}/fullchain.pem" | cut -d= -f2)"
      openssl x509 -noout -ext subjectAltName -in "/etc/letsencrypt/live/${DESYN_CERT_NAME}/fullchain.pem" 2>/dev/null | tail -n +2 | sed 's/^ */  /'
    else
      echo "desyn cert  not issued yet (deploy/scripts/certs.sh)"
    fi
  fi
  if systemctl list-timers --all 2>/dev/null | grep -q certbot; then
    echo "renewal    certbot timer present"
  else
    warning "no certbot timer found: confirm automatic renewal (snap.certbot.renew.timer or cron)"
  fi
else
  warning "certbot not installed (needed by certs.sh: apt-get install certbot)"
fi

section "DNS"
mapfile -t host_ips < <(ip -o addr show scope global 2>/dev/null | awk '{split($4, a, "/"); print a[1]}')
printf 'host addresses: %s\n' "${host_ips[*]:-unknown}"
for d in "${DESYN_DOMAINS[@]}"; do
  mapfile -t resolved < <(getent ahosts "${d}" 2>/dev/null | awk '{print $1}' | sort -u)
  if ((${#resolved[@]} == 0)); then
    printf '  %-24s unresolved\n' "${d}"
    warning "${d} does not resolve yet"
    continue
  fi
  match=no
  for r in "${resolved[@]}"; do
    for h in "${host_ips[@]}"; do [[ "${r}" == "${h}" ]] && match=yes; done
  done
  printf '  %-24s %-40s %s\n' "${d}" "${resolved[*]}" "$([[ "${match}" == yes ]] && echo "-> this host" || echo "-> elsewhere")"
  [[ "${match}" == yes ]] || warning "${d} does not point to this host"
done

section "Outbound HTTPS"
# The worker fetches design assets from S3, the builds pull from these registries, and backups talk to Convex
# Cloud and S3. A HEAD/GET of public endpoints only; any HTTP status proves the route works.
convex_site="$(env_value "${DESYN_DEPLOY_DIR}/env/public.env" NEXT_PUBLIC_CONVEX_SITE_URL 2>/dev/null || true)"
for url in "${convex_site:+${convex_site}/healthz}" https://s3.eu-central-1.amazonaws.com https://registry-1.docker.io/v2/ \
  https://ghcr.io/v2/ https://registry.npmjs.org/ https://static.crates.io/ https://github.com/; do
  [[ -n "${url}" ]] || continue
  code="$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "${url}" 2>/dev/null || echo 000)"
  printf '  %-56s %s\n' "${url}" "${code}"
  [[ "${code}" != "000" ]] || warning "no HTTPS route to ${url}"
done

# nginx itself proxies app.desyn.app/api/v1 and /mcp to the Convex site URL: it needs a nameserver it can use
# (bootstrap writes desyn/local/resolver.conf from resolv.conf) and the system CA bundle to verify Convex's TLS.
mapfile -t nameservers < <(host_nameservers)
usable_ns=()
for ns in "${nameservers[@]}"; do [[ "${ns}" == *%* ]] || usable_ns+=("${ns}"); done
printf '  %-56s %s\n' "nameservers (${DESYN_RESOLV_CONF})" "${usable_ns[*]:-none}"
((${#usable_ns[@]})) || blocker "no usable nameserver in ${DESYN_RESOLV_CONF} (nginx resolver for the Convex site proxy)"
if [[ -s /etc/ssl/certs/ca-certificates.crt ]]; then
  printf '  %-56s %s\n' "CA bundle /etc/ssl/certs/ca-certificates.crt" "present"
else
  blocker "/etc/ssl/certs/ca-certificates.crt missing (package ca-certificates; nginx verifies Convex's certificate with it)"
fi

section "Firewall"
if have ufw && [[ "$(id -u)" -eq 0 ]]; then
  ufw status 2>/dev/null | sed 's/^/  /'
else
  echo "  ufw not available or not root"
fi

section "Existing desyn resources"
if [[ -d "${DESYN_ROOT}" ]]; then
  find "${DESYN_ROOT}" -maxdepth 1 -mindepth 1 -printf '  %p\n' | sort
else
  echo "  ${DESYN_ROOT} absent"
fi
if id "${DESYN_SYSTEM_USER}" >/dev/null 2>&1; then
  echo "  system user ${DESYN_SYSTEM_USER} present"
else
  echo "  system user ${DESYN_SYSTEM_USER} absent"
fi
systemctl list-unit-files 'desyn-*' --no-legend 2>/dev/null | sed 's/^/  /' || true
if [[ -f "${DESYN_ROOT}/state/current-release" ]]; then
  echo "  current release: $(cat "${DESYN_ROOT}/state/current-release")"
fi

section "Summary"
printf '%s warning(s), %s blocker(s)\n' "${#WARNINGS[@]}" "${#BLOCKERS[@]}"
for b in "${BLOCKERS[@]}"; do printf '  BLOCKER %s\n' "${b}"; done
for w in "${WARNINGS[@]}"; do printf '  warning %s\n' "${w}"; done
((${#BLOCKERS[@]} == 0))
