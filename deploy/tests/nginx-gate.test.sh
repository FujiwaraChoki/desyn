#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted bash -c snippets and stub bodies expand at their own runtime
# Functional test of the desyn nginx configuration with a real nginx binary on high ports: the pre-launch gate on
# the human-facing hosts (basic auth, gate cookie, trusted sources), security headers, blue/green failover,
# static caching, docs fallback, ACME, the launch switch, the Agent API / MCP pass-through to the Convex site URL
# (no basic auth, no gate cookie, bearer key kept, rate limited), and render.desyn.app (never basic auth, x-desyn-secret
# pre-filter, POST-only API paths, /healthz, 404 elsewhere, body size limit, rate limit, the secret never logged,
# no gate cookie).
#
# Usage: NGINX_BIN=/usr/sbin/nginx deploy/tests/nginx-gate.test.sh
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=../scripts/lint.sh
source "${DEPLOY_DIR}/scripts/lint.sh" --only none

NGINX_BIN="${NGINX_BIN:-$(command -v nginx || true)}"
[[ -x "${NGINX_BIN}" ]] || {
  echo "SKIP nginx-gate: set NGINX_BIN"
  exit 0
}
require_cmd python3 curl openssl

D="$(mktemp -d)"
version="$("${NGINX_BIN}" -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"
build_nginx_tree "${D}" local "${version}"
cp "$(nginx_mime_types "${NGINX_BIN}")" "${D}/mime.types"
# Only a documentation address is trusted, so requests from 127.0.0.1 have to authenticate.
render_trusted "${D}/desyn/local" 203.0.113.10
TOKEN="$(random_hex 32)"
render_gate "${D}/desyn/local" "${TOKEN}"
PASSWORD="$(random_hex 12)"
printf 'tester:%s\n' "$(openssl passwd -6 "${PASSWORD}")" >"${D}/desyn.htpasswd"
sed -i -e 's/listen 80\b/listen 18080/; s/listen \[::\]:80\b/listen [::]:18080/' \
  -e 's/listen 443\b/listen 18443/; s/listen \[::\]:443\b/listen [::]:18443/' \
  "${D}/desyn/local/listen-80.conf" "${D}/desyn/local/listen-443.conf"
# The Convex Cloud site URL (TLS, resolved through desyn/local/resolver.conf) is replaced by a local stub; the
# real directives are covered by nginx -t in lint.sh.
sed -i 's#^proxy_pass https://\$desyn_convex_site_host;#proxy_pass http://127.0.0.1:47198;#' \
  "${D}/desyn/snippets/convex-site.conf"
grep -q '^proxy_pass http://127.0.0.1:47198;' "${D}/desyn/snippets/convex-site.conf" || {
  echo "convex-site.conf: proxy_pass line not found" >&2
  exit 1
}

# Upstream stubs: web green, landing blue, worker green (blue is down: failover). docs is down on purpose.
# Port 47198 stands in for the Convex Cloud site URL.
PIDS=()
python3 - <<'PY' &
import http.server
class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        auth = self.headers.get("Authorization", "")
        xff = self.headers.get("X-Forwarded-For", "")
        host = self.headers.get("Host", "")
        self.wfile.write(f"convex-site {self.command} {self.path} host={host} auth={auth} xff={xff}".encode())
    do_GET = do_POST = do_OPTIONS = do_DELETE = do_PATCH = reply
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", 47198), Handler).serve_forever()
PY
PIDS+=($!)
for port in 47121 47100 47123; do
  python3 - "${port}" <<'EOF' &
import http.server, sys
port = int(sys.argv[1])
class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        xff = self.headers.get("X-Forwarded-For", "")
        secret = "yes" if self.headers.get("x-desyn-secret") else "no"
        self.wfile.write(f"stub-{port} {self.command} {self.path} xff={xff} secret={secret}".encode())
    do_GET = do_POST = do_HEAD = do_PUT = reply
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
EOF
  PIDS+=($!)
done
cleanup() {
  "${NGINX_BIN}" -p "${D}" -c "${D}/nginx.conf" -s stop 2>/dev/null || true
  kill "${PIDS[@]}" 2>/dev/null || true
  rm -rf "${D}" "${WORK}"
}
trap cleanup EXIT
"${NGINX_BIN}" -p "${D}" -c "${D}/nginx.conf"
sleep 1

# code HOST PATH [CURL ARGS...]: HTTP status through nginx's TLS port.
code() {
  local host=$1 path=$2
  shift 2
  curl -sk -o /dev/null -w '%{http_code}' --resolve "${host}:18443:127.0.0.1" "$@" "https://${host}:18443${path}"
}
body() {
  local host=$1 path=$2
  shift 2
  curl -sk --resolve "${host}:18443:127.0.0.1" "$@" "https://${host}:18443${path}"
}
headers() {
  local host=$1 path=$2
  shift 2
  curl -sk -D - -o /dev/null --resolve "${host}:18443:127.0.0.1" "$@" "https://${host}:18443${path}"
}
expect() {
  local name=$1 want=$2 got
  shift 2
  got="$(code "$@")"
  if [[ "${got}" == "${want}" ]]; then pass "${name} (${got})"; else fail "${name} (got ${got}, want ${want})"; fi
}
AUTH=(-u "tester:${PASSWORD}")
SECRET="$(random_hex 32)"
WS=(-H "x-desyn-secret: ${SECRET}" -H "content-type: application/json")

# --- human-facing hosts --------------------------------------------------------------------------------
expect "app without auth -> 401" 401 app.desyn.app /
expect "app with basic auth -> 200 (only green up)" 200 app.desyn.app / "${AUTH[@]}"
h="$(headers app.desyn.app / "${AUTH[@]}")"
check "gate cookie set after auth" grep -qi "^set-cookie: desyn_gate=${TOKEN}; Domain=.desyn.app; Path=/;.*HttpOnly" <<<"${h}"
for name in content-security-policy strict-transport-security x-content-type-options x-frame-options referrer-policy permissions-policy; do
  check "header ${name}" grep -qi "^${name}:" <<<"${h}"
done
check "app CSP allows the Convex Cloud websocket" grep -qi "^content-security-policy:.*wss://opulent-alpaca-530.eu-west-1.convex.cloud" <<<"${h}"
check "no gate cookie on 401" bash -c '! grep -qi "^set-cookie: desyn_gate" <<<"$1"' _ "$(headers app.desyn.app /)"
expect "app with gate cookie -> 200" 200 app.desyn.app / -b "desyn_gate=${TOKEN}"
expect "app with wrong cookie -> 401" 401 app.desyn.app / -b "desyn_gate=nope"
expect "docs with the gate cookie from app -> no second prompt" 302 docs.desyn.app /x -b "desyn_gate=${TOKEN}"
check "client X-Forwarded-For is replaced, not appended" \
  grep -q 'xff=127.0.0.1 ' <<<"$(body app.desyn.app /xff "${AUTH[@]}" -H 'X-Forwarded-For: 6.6.6.6')"
expect "auth endpoint passes to the web app" 200 app.desyn.app /api/auth/sign-in/email "${AUTH[@]}" -X POST
# Agent API + MCP: straight to the Convex Cloud site URL, without basic auth and without the gate cookie.
expect "Agent API without basic auth (pre-launch) -> Convex site" 200 app.desyn.app /api/v1/designs
api="$(body app.desyn.app '/api/v1/designs?limit=5' -H 'Authorization: Bearer dk_test_123' -H 'X-Forwarded-For: 6.6.6.6')"
check "Agent API reaches the Convex site stub" grep -q '^convex-site GET /api/v1/designs?limit=5 ' <<<"${api}"
check "Agent API keeps the bearer key" grep -q 'auth=Bearer dk_test_123 ' <<<"${api}"
check "Agent API Host header is the Convex site host" grep -q 'host=opulent-alpaca-530.eu-west-1.convex.site ' <<<"${api}"
check "Agent API X-Forwarded-For is replaced" grep -q 'xff=127.0.0.1$' <<<"${api}"
ha="$(headers app.desyn.app /api/v1/designs -X POST --data '{}')"
check "Agent API never hands out the gate cookie" bash -c '! grep -qi "^set-cookie" <<<"$1"' _ "${ha}"
check "Agent API asks for no basic auth" bash -c '! grep -qi "^www-authenticate" <<<"$1"' _ "${ha}"
expect "Agent API CORS preflight -> Convex site" 200 app.desyn.app /api/v1/designs -X OPTIONS
expect "MCP endpoint -> Convex site" 200 app.desyn.app /mcp -X POST --data '{}'
check "MCP request reaches the Convex site stub" grep -q '^convex-site POST /mcp ' <<<"$(body app.desyn.app /mcp -X POST --data '{}')"
expect "other /api paths stay behind basic auth" 401 app.desyn.app /api/v2/designs
expect "/mcpx is not the MCP endpoint (basic auth)" 401 app.desyn.app /mcpx
limited=0
for _ in $(seq 1 120); do
  [[ "$(code app.desyn.app /api/v1/me)" == 429 ]] && limited=$((limited + 1))
done
check "Agent API is rate limited (${limited} of 120 got 429)" test "${limited}" -gt 0
expect "docs down -> 302 fallback" 302 docs.desyn.app /getting-started "${AUTH[@]}"
check "docs fallback target" grep -qi '^location: https://desyn.app/docs/getting-started' \
  <<<"$(headers docs.desyn.app /getting-started "${AUTH[@]}")"
expect "www -> 301" 301 www.desyn.app /x
expect "landing with auth -> 200" 200 desyn.app / "${AUTH[@]}"
check "landing CSP allows Convex Cloud" grep -qi "^content-security-policy:.*https://opulent-alpaca-530.eu-west-1.convex.site" \
  <<<"$(headers desyn.app / "${AUTH[@]}")"
expect "landing static asset -> 200" 200 desyn.app /_next/static/chunks/a.js "${AUTH[@]}"
check "static asset served from cache on the second request" grep -qi '^x-cache-status: HIT' \
  <<<"$(headers desyn.app /_next/static/chunks/a.js "${AUTH[@]}")"
check "convex.desyn.app is no desyn host any more (the default server answers)" \
  test "$(body convex.desyn.app /version)" = "other"
mkdir -p "${D}/acme/.well-known/acme-challenge"
echo token >"${D}/acme/.well-known/acme-challenge/t1"
for host in app.desyn.app render.desyn.app; do
  check "ACME challenge over HTTP without auth (${host})" \
    test "$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${host}" http://127.0.0.1:18080/.well-known/acme-challenge/t1)" = 200
done
check "HTTP -> HTTPS redirect" test "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: app.desyn.app' http://127.0.0.1:18080/x)" = 301

# --- render.desyn.app ----------------------------------------------------------------------------------
expect "render /healthz without basic auth -> 200 (pre-launch)" 200 render.desyn.app /healthz
check "render /healthz fails over to the green worker" grep -q '^stub-47123 GET /healthz' <<<"$(body render.desyn.app /healthz)"
expect "render POST /healthz -> 403" 403 render.desyn.app /healthz -X POST
expect "render without the secret header -> 401" 401 render.desyn.app /v1/render -X POST --data '{}'
expect "render with a too short secret -> 401" 401 render.desyn.app /v1/render -X POST -H "x-desyn-secret: short" --data '{}'
expect "render with basic auth but no secret -> 401" 401 render.desyn.app /v1/render -X POST "${AUTH[@]}" --data '{}'
for path in render thumbnail describe layout measure apply; do
  expect "render POST /v1/${path} with the secret -> worker" 200 render.desyn.app "/v1/${path}" -X POST "${WS[@]}" --data '{}'
done
check "the secret header reaches the worker" grep -q 'secret=yes' <<<"$(body render.desyn.app /v1/render -X POST "${WS[@]}" --data '{}')"
expect "render GET /v1/render -> 405" 405 render.desyn.app /v1/render "${WS[@]}"
check "405 names the allowed method" grep -qi '^allow: POST' <<<"$(headers render.desyn.app /v1/render "${WS[@]}")"
expect "render unknown API path -> 404" 404 render.desyn.app /v1/imageops/upscale -X POST "${WS[@]}" --data '{}'
expect "render root -> 404" 404 render.desyn.app /
hr="$(headers render.desyn.app /v1/render -X POST "${WS[@]}" --data '{}')"
check "render never sets the gate cookie" bash -c '! grep -qi "^set-cookie" <<<"$1"' _ "${hr}"
check "render CSP is default-src none" grep -qi "^content-security-policy: default-src 'none'" <<<"${hr}"
check "render 401 is JSON" grep -q '"unauthorized"' <<<"$(body render.desyn.app /v1/render -X POST --data '{}')"
truncate -s 65m "${D}/big.json"
expect "render body above 64 MB -> 413" 413 render.desyn.app /v1/render -X POST "${WS[@]}" --data-binary "@${D}/big.json"
truncate -s 20m "${D}/design.json"
expect "render 20 MB design -> worker" 200 render.desyn.app /v1/render -X POST "${WS[@]}" --data-binary "@${D}/design.json"
limited=0
for _ in $(seq 1 30); do
  [[ "$(code render.desyn.app /healthz)" == 429 ]] && limited=$((limited + 1))
done
check "render /healthz is rate limited (${limited} of 30 got 429)" test "${limited}" -gt 0
check "the secret never appears in the access log" bash -c '! grep -qF "$1" "$2"/logs/desyn-render.access.log' _ "${SECRET}" "${D}"
check "render requests are logged" grep -q '"POST /v1/render HTTP' "${D}/logs/desyn-render.access.log"

# --- launch switch ---------------------------------------------------------------------------------------
render_auth_switch "${D}/desyn/local" 0
"${NGINX_BIN}" -p "${D}" -c "${D}/nginx.conf" -s reload
sleep 1
expect "launched: app without auth -> 200" 200 app.desyn.app /
check "launched: no gate cookie" bash -c '! grep -qi "^set-cookie: desyn_gate" <<<"$1"' _ "$(headers app.desyn.app /)"
expect "launched: render still needs the secret" 401 render.desyn.app /v1/render -X POST --data '{}'
expect "launched: MCP still proxied to the Convex site" 200 app.desyn.app /mcp -X POST --data '{}'

finish
