#!/usr/bin/env bash
# Health of the Desyn services on this server. Read-only.
#
# Checks: container state/health of the active colour of worker, landing, web and docs; HTTP probes on their
# 127.0.0.1 ports (worker /healthz must answer 2xx); the worker rejects a request with a wrong secret; Convex
# Cloud reachability from this host (warning only: an outage there is not fixed by rolling back this host);
# nginx config + service; certificate expiry; disk space; age of the last successful backup.
# With --public it also requests every hostname through nginx (using the basic-auth credentials file), checks
# that app.desyn.app/api/v1 reaches Convex Cloud without basic auth, and that render.desyn.app answers /healthz
# without basic auth and turns away requests without the secret header.
#
# Usage: deploy/scripts/healthcheck.sh [--host hetzner] [--quiet] [--public]
# Exit status: 0 healthy (warnings allowed), 1 at least one failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

QUIET=0
PUBLIC=0
ORIG_ARGS=("$@")
while (($#)); do
  case "$1" in
    --quiet) QUIET=1 && shift ;;
    --public) PUBLIC=1 && shift ;;
    *)
      common_arg "$@" || usage_error "$1"
      shift "${COMMON_SHIFT}"
      ;;
  esac
done
maybe_remote "${ORIG_ARGS[@]}"

require_root
require_bootstrapped
require_cmd docker curl

FAILS=0
WARNS=0
pass() { [[ "${QUIET}" == "1" ]] || printf '  %-38s ok   %s\n' "$1" "${2:-}"; }
fail() {
  printf '  %-38s FAIL %s\n' "$1" "${2:-}"
  FAILS=$((FAILS + 1))
}
soft() {
  printf '  %-38s warn %s\n' "$1" "${2:-}"
  WARNS=$((WARNS + 1))
}
section() { [[ "${QUIET}" == "1" ]] || echo "$1"; }

check_container() {
  local svc=$1 id status
  id="$(dc ps -q "${svc}" 2>/dev/null | head -n 1)"
  if [[ -z "${id}" ]]; then
    fail "container ${svc}" "not running"
    return 1
  fi
  status="$(container_health "${id}")"
  case "${status}" in
    healthy | running) pass "container ${svc}" "${status}" ;;
    *)
      fail "container ${svc}" "${status}"
      return 1
      ;;
  esac
}

# http_code URL [CURL ARGS...]: the status code, 000 when nothing answered.
http_code() {
  local url=$1
  shift
  curl -sS -o /dev/null -m 10 -w '%{http_code}' "$@" "${url}" 2>/dev/null || echo 000
}

# check_status NAME URL MIN MAX [CURL ARGS...]: pass when MIN <= status < MAX.
check_status() {
  local name=$1 url=$2 min=$3 max=$4 code
  shift 4
  code="$(http_code "${url}" "$@")"
  if [[ "${code}" != "000" && "${code}" -ge "${min}" && "${code}" -lt "${max}" ]]; then
    pass "${name}" "${code}"
  else
    fail "${name}" "HTTP ${code} from ${url}"
  fi
}

section "containers + http (127.0.0.1)"
running=0
for app in "${DESYN_APPS[@]}"; do
  color="$(active_color "${app}")"
  [[ "${color}" == "none" ]] && continue
  running=$((running + 1))
  check_container "${app}-${color}" || true
  port="${DESYN_APP_PORT[${app}:${color}]}"
  if [[ "${app}" == "worker" ]]; then
    check_status "worker (${color}) /healthz" "http://127.0.0.1:${port}/healthz" 200 300
    # A wrong secret must be refused by the worker itself (nginx only checks that the header is present).
    code="$(http_code "http://127.0.0.1:${port}/v1/render" -X POST -H "x-desyn-secret: $(random_hex 32)" \
      -H 'content-type: application/json' --data '{}')"
    case "${code}" in
      401 | 403) pass "worker (${color}) rejects a wrong secret" "${code}" ;;
      2??) fail "worker (${color}) rejects a wrong secret" "HTTP ${code}: the worker accepted a wrong x-desyn-secret" ;;
      *) soft "worker (${color}) rejects a wrong secret" "HTTP ${code} (expected 401/403)" ;;
    esac
  else
    check_status "${app} (${color})" "http://127.0.0.1:${port}/" 100 500
  fi
done
((running > 0)) || soft "services" "nothing deployed yet"

section "convex cloud"
site="$(env_value "${DESYN_DEPLOY_DIR}/env/public.env" NEXT_PUBLIC_CONVEX_SITE_URL 2>/dev/null || true)"
if [[ -n "${site}" ]]; then
  code="$(http_code "${site}/healthz")"
  if [[ "${code}" == "200" ]]; then pass "${site#https://}/healthz" "${code}"; else soft "${site#https://}/healthz" "HTTP ${code} (Convex Cloud or the deployed functions)"; fi
fi

section "host"
if command -v nginx >/dev/null 2>&1; then
  if nginx -t >/dev/null 2>&1; then pass "nginx -t"; else fail "nginx -t"; fi
  if systemctl is-active --quiet nginx; then pass "nginx service" "active"; else fail "nginx service" "inactive"; fi
fi
cert="${DESYN_LETSENCRYPT_LIVE}/${DESYN_CERT_NAME}/fullchain.pem"
if [[ -f "${cert}" ]]; then
  end="$(openssl x509 -noout -enddate -in "${cert}" | cut -d= -f2)"
  days=$((($(date -d "${end}" +%s) - $(date +%s)) / 86400))
  if ((days < 7)); then
    fail "certificate" "expires in ${days} days"
  elif ((days < 21)); then
    soft "certificate" "expires in ${days} days (renewal should have happened)"
  else
    pass "certificate" "${days} days left"
  fi
fi
for mount in / "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)"; do
  used="$(df --output=pcent "${mount}" | tail -n 1 | tr -dc '0-9')"
  if ((used >= 95)); then
    fail "disk ${mount}" "${used}% used"
  elif ((used >= 85)); then
    soft "disk ${mount}" "${used}% used"
  else
    pass "disk ${mount}" "${used}% used"
  fi
done
last_backup="$(state_file last-backup)"
if [[ -f "${last_backup}" ]]; then
  age_h=$((($(date +%s) - $(stat -c %Y "${last_backup}")) / 3600))
  if ((age_h > 36)); then soft "last backup" "${age_h}h ago ($(cat "${last_backup}"))"; else pass "last backup" "${age_h}h ago"; fi
elif [[ -f "$(state_file current-release)" ]]; then
  soft "last backup" "none recorded yet"
fi

if [[ "${PUBLIC}" == "1" ]]; then
  section "public (through nginx, resolved to 127.0.0.1)"
  # Credentials go to curl through stdin (-K -), never on the command line where ps could show them.
  curl_cfg=""
  if [[ -r "${DESYN_BASIC_AUTH_FILE}" ]]; then
    curl_cfg="$(printf 'user = "%s:%s"\n' "$(sed -n 's/^user: //p' "${DESYN_BASIC_AUTH_FILE}")" \
      "$(sed -n 's/^password: //p' "${DESYN_BASIC_AUTH_FILE}")")"
  fi
  for d in desyn.app app.desyn.app docs.desyn.app; do
    code="$(printf '%s\n' "${curl_cfg}" | curl -K - -sS -o /dev/null -m 10 -w '%{http_code}' \
      --resolve "${d}:443:127.0.0.1" "https://${d}/" 2>/dev/null || echo 000)"
    if [[ "${code}" != "000" && "${code}" -lt 500 && "${code}" != "401" ]]; then pass "https://${d}/" "${code}"; else fail "https://${d}/" "HTTP ${code}"; fi
  done
  unset curl_cfg
  # Agent API pass-through to the Convex Cloud site URL: answered by Convex (any status below 500, never
  # nginx's basic-auth challenge), so DNS (desyn/local/resolver.conf), TLS verification and routing work.
  api_headers="$(curl -sS -o /dev/null -D - -m 15 --resolve "app.desyn.app:443:127.0.0.1" \
    "https://app.desyn.app/api/v1/me" 2>/dev/null || true)"
  api_code="$(awk 'toupper($1) ~ /^HTTP\// { code = $2 } END { print code + 0 }' <<<"${api_headers}")"
  if grep -qi '^www-authenticate: basic' <<<"${api_headers}"; then
    fail "app.desyn.app/api/v1 -> Convex" "basic auth challenge (the pass-through location is missing)"
  elif ((api_code >= 100 && api_code < 500)); then
    pass "app.desyn.app/api/v1 -> Convex" "${api_code}"
  else
    fail "app.desyn.app/api/v1 -> Convex" "HTTP ${api_code} (see logs.sh --nginx app: resolver, TLS to *.convex.site)"
  fi
  r=(--resolve "render.desyn.app:443:127.0.0.1")
  check_status "https://render.desyn.app/healthz" "https://render.desyn.app/healthz" 200 300 "${r[@]}"
  check_status "render: no secret header -> 401" "https://render.desyn.app/v1/render" 401 402 "${r[@]}" -X POST --data '{}'
  check_status "render: other paths -> 404" "https://render.desyn.app/" 404 405 "${r[@]}"
fi

if ((FAILS)); then
  error "${FAILS} check(s) failed, ${WARNS} warning(s)"
  exit 1
fi
[[ "${QUIET}" == "1" ]] || ok "healthy (${WARNS} warning(s))"
