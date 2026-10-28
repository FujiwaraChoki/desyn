#!/usr/bin/env bash
# Issue (or expand) the Let's Encrypt certificate for the desyn hostnames only (desyn.app, www.desyn.app,
# app.desyn.app, docs.desyn.app, render.desyn.app), then install the TLS server blocks (desyn-landing, -app,
# -docs, -render). Uses certbot --webroot against /var/www/desyn-acme (served by desyn-acme.conf), so certbot
# never edits nginx files. The renewal config of this one certificate gets a deploy hook that reloads nginx.
# Server blocks of the former self-hosted Convex hosts (desyn-convex, desyn-dash) are removed if present.
#
# Run after bootstrap.sh and once DNS for every hostname points at the server.
#
# Usage:
#   deploy/scripts/certs.sh --host hetzner --email ops@desyn.app [--acme-test]
#                           [--skip-dns-check] [--install-certbot] [--dry-run]
#     --acme-test   full ACME http-01 round trip against Let's Encrypt staging (certbot --dry-run): nothing is
#                   saved and no server block is installed. Run it first to catch DNS/firewall problems
#                   without touching the production rate limits.
#   deploy/scripts/certs.sh --host hetzner --renew-test        certbot renew --dry-run for this certificate
#   deploy/scripts/certs.sh --host hetzner --sites-only        (re)install TLS server blocks without certbot
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/nginx.sh
source "${SCRIPT_DIR}/lib/nginx.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

EMAIL="${DESYN_ACME_EMAIL:-}"
ACME_TEST=0
SKIP_DNS=0
INSTALL_CERTBOT=0
RENEW_TEST=0
SITES_ONLY=0
ORIG_ARGS=("$@")
while (($#)); do
  case "$1" in
    --email)
      EMAIL="$2"
      shift 2
      ;;
    --acme-test) ACME_TEST=1 && shift ;;
    --skip-dns-check) SKIP_DNS=1 && shift ;;
    --install-certbot) INSTALL_CERTBOT=1 && shift ;;
    --renew-test) RENEW_TEST=1 && shift ;;
    --sites-only) SITES_ONLY=1 && shift ;;
    *)
      common_arg "$@" || usage_error "$1"
      shift "${COMMON_SHIFT}"
      ;;
  esac
done
maybe_remote "${ORIG_ARGS[@]}"

require_root
require_cmd nginx openssl getent

DOMAINS=("${DESYN_DOMAINS[@]}")
SITES=("${DESYN_NGINX_TLS_SITES[@]}")

if [[ "${INSTALL_CERTBOT}" == "1" ]] && ! command -v certbot >/dev/null 2>&1; then
  run apt-get install -y --no-install-recommends certbot
fi

if [[ "${RENEW_TEST}" == "1" ]]; then
  require_cmd certbot
  run certbot renew --cert-name "${DESYN_CERT_NAME}" --dry-run
  exit 0
fi

cert_dir="${DESYN_LETSENCRYPT_LIVE}/${DESYN_CERT_NAME}"

# The HTTP/ACME server block must list every hostname before Let's Encrypt asks for it, and older installs still
# have the self-hosted Convex server blocks, which reference definitions the current desyn-00-common no longer has.
for f in "${DESYN_NGINX_LOCAL_FILES[@]}"; do
  # Hosts bootstrapped by an older version lack newer files (resolver.conf); bootstrap adds them, keeping the rest.
  [[ -f "${DESYN_NGINX_ETC}/desyn/local/${f}" ]] ||
    die "${DESYN_NGINX_ETC}/desyn/local/${f} is missing; run bootstrap.sh (again) first"
done
remove_retired_nginx_files
install_nginx_snippets "${DESYN_DEPLOY_DIR}"
install_nginx_sites "${DESYN_DEPLOY_DIR}" "${DESYN_NGINX_BASE_SITES[@]}"
nginx_test_and_reload || die "nginx rejected the updated HTTP/ACME configuration; nothing else was changed"

if [[ "${SITES_ONLY}" != "1" ]]; then
  require_cmd certbot
  [[ -n "${EMAIL}" ]] || die "--email is required (Let's Encrypt expiry notices)"

  if [[ "${SKIP_DNS}" != "1" ]]; then
    mapfile -t host_ips < <(ip -o addr show scope global | awk '{split($4, a, "/"); print a[1]}')
    bad=0
    for d in "${DOMAINS[@]}"; do
      mapfile -t resolved < <(getent ahosts "${d}" | awk '{print $1}' | sort -u)
      if ((${#resolved[@]} == 0)); then
        error "${d} does not resolve"
        bad=1
        continue
      fi
      for r in "${resolved[@]}"; do
        match=0
        for h in "${host_ips[@]}"; do [[ "${r}" == "${h}" ]] && match=1; done
        if ((match == 0)); then
          error "${d} resolves to ${r}, which is not an address of this host"
          bad=1
        fi
      done
    done
    ((bad == 0)) || die "fix DNS first (or pass --skip-dns-check if a proxy in front terminates elsewhere)"
    ok "DNS for ${#DOMAINS[@]} hostnames points at this host"
  fi

  # Prove the webroot is reachable through nginx for every hostname before asking Let's Encrypt.
  probe="desyn-probe-$(random_hex 8)"
  if [[ "${DRY_RUN}" != "1" ]]; then
    printf 'ok\n' >"${DESYN_ACME_ROOT}/.well-known/acme-challenge/${probe}"
    for d in "${DOMAINS[@]}"; do
      code="$(curl -sS -o /dev/null -w '%{http_code}' --resolve "${d}:80:127.0.0.1" "http://${d}/.well-known/acme-challenge/${probe}" || echo 000)"
      if [[ "${code}" != "200" ]]; then
        rm -f "${DESYN_ACME_ROOT}/.well-known/acme-challenge/${probe}"
        die "http://${d}/.well-known/acme-challenge/ answered ${code} locally; check desyn-acme.conf"
      fi
    done
    rm -f "${DESYN_ACME_ROOT}/.well-known/acme-challenge/${probe}"
    ok "ACME webroot reachable for every hostname"
  fi

  args=(certonly --webroot -w "${DESYN_ACME_ROOT}" --cert-name "${DESYN_CERT_NAME}"
    --email "${EMAIL}" --agree-tos --no-eff-email --non-interactive --keep-until-expiring --expand
    --key-type ecdsa --deploy-hook "systemctl reload nginx")
  [[ "${ACME_TEST}" == "1" ]] && args+=(--dry-run)
  for d in "${DOMAINS[@]}"; do args+=(-d "${d}"); done
  run certbot "${args[@]}"
  if [[ "${ACME_TEST}" == "1" ]]; then
    ok "ACME test passed for ${DOMAINS[*]}; run again without --acme-test to issue the certificate"
    exit 0
  fi
fi

if [[ "${DRY_RUN}" != "1" ]]; then
  [[ -f "${cert_dir}/fullchain.pem" && -f "${cert_dir}/privkey.pem" ]] || die "certificate files missing in ${cert_dir}"
  info "certificate valid until $(openssl x509 -noout -enddate -in "${cert_dir}/fullchain.pem" | cut -d= -f2)"
fi

install_nginx_sites "${DESYN_DEPLOY_DIR}" "${SITES[@]}"
if ! nginx_test_and_reload; then
  error "nginx rejected the TLS server blocks; disabling them so the host keeps serving"
  disable_nginx_sites "${SITES[@]}"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  die "TLS sites not enabled"
fi
ok "TLS server blocks enabled for: ${DOMAINS[*]}"
