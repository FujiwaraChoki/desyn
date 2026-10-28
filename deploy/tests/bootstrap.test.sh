#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted bash -c snippets and stub bodies expand at their own runtime
# bootstrap.sh, certs.sh --sites-only, basic-auth.sh and uninstall.sh --dry-run in a sandbox: directory modes,
# htpasswd consistency, host-specific nginx files, idempotency, removal of the retired self-hosted Convex server
# blocks, the launch switch and gate-token rotation.
set -euo pipefail
shopt -s extglob

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_userns

T="$(mktemp -d)"
trap 'rm -rf "${T}"' EXIT
sandbox_env "${T}"
export DESYN_SSH_CLIENT_IP=198.51.100.23

stub docker <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
case "$1 ${2:-}" in
  "compose version") echo "2.40.0" ;;
  "network inspect")
    [[ -f "$STUB_STATE/net" ]] || exit 1
    if [[ "$*" == *Subnet* ]]; then echo "172.31.0.0/16 "; elif [[ "$*" == *Labels* ]]; then echo desyn; fi ;;
  "network create") touch "$STUB_STATE/net" ;;
  "buildx inspect") [[ -f "$STUB_STATE/builder" ]] || exit 1 ;;
  "buildx create") touch "$STUB_STATE/builder" ;;
esac
exit 0
EOF
stub nginx <<'EOF'
#!/usr/bin/env bash
echo "nginx $*" >> "$STUB_LOG"
case "$1" in
  -v | -V) echo "nginx version: nginx/1.24.0" >&2 ;;
  -T) printf 'user www-data;\nhttp {\n include /etc/nginx/sites-enabled/*;\n}\nserver { listen 443 ssl; }\n' ;;
esac
exit 0
EOF
stub id <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == desyn ]]; then grep -q '^useradd' "$STUB_LOG"; exit $?; fi
exec /usr/bin/id "$@"
EOF

S="${DEPLOY_DIR}/scripts"
SECRETS="${DESYN_ROOT}/secrets"
LOCAL="${DESYN_NGINX_ETC}/desyn/local"
ENABLED="${DESYN_NGINX_ETC}/sites-enabled"

unshare -r bash "${S}/bootstrap.sh" --dry-run >"${T}/dry.out" 2>&1
check "dry-run creates nothing" test ! -e "${DESYN_ROOT}" -a ! -e "${DESYN_HTPASSWD}"
check "dry-run prints its commands" grep -q '\[dry-run\]' "${T}/dry.out"

unshare -r bash "${S}/bootstrap.sh" >"${T}/run1.out" 2>&1 || {
  cat "${T}/run1.out"
  exit 1
}
check "secrets directory is 0700" test "$(stat -c %a "${SECRETS}")" = 700
check "backups directory is 0700" test "$(stat -c %a "${DESYN_ROOT}/backups")" = 700
check "bootstrap writes no service env files (server-env.py does)" test -z "$(ls -A "${SECRETS}")"
check "gate token file is 0600" test "$(stat -c %a "${LOCAL}/gate.conf")" = 600
check "basic-auth credentials file is 0600" test "$(stat -c %a "${DESYN_BASIC_AUTH_FILE}")" = 600
user="$(sed -n 's/^user: //p' "${DESYN_BASIC_AUTH_FILE}")"
password="$(sed -n 's/^password: //p' "${DESYN_BASIC_AUTH_FILE}")"
hash="$(grep "^${user}:" "${DESYN_HTPASSWD}" | cut -d: -f2-)"
check "htpasswd matches the credentials file" test "$(openssl passwd -6 -salt "$(cut -d'$' -f3 <<<"${hash}")" "${password}")" = "${hash}"
check "the password never reaches the output" bash -c '! grep -q "$1" "$2"' _ "${password}" "${T}/run1.out"
check "no dash allowlist any more" test ! -e "${LOCAL}/dash-allow.conf"
check "trusted sources include the desyn_net subnet" grep -q "172.31.0.0/16 1;" "${LOCAL}/trusted.geo"
check "nginx 1.24 without http2 elsewhere: no http2 flag on the shared socket" bash -c '! grep -qE "^(listen .*http2|http2 on)" "$1"' _ "${LOCAL}/listen-443.conf"
check "resolver.conf uses the host nameserver (link-local skipped)" grep -qxE 'resolver 127\.0\.0\.53 valid=60s( ipv6=off)?;' "${LOCAL}/resolver.conf"
check "only the HTTP/ACME sites are enabled before certificates" bash -c \
  '[[ -L "$1/desyn-00-common.conf" && -L "$1/desyn-acme.conf" && ! -e "$1/desyn-app.conf" && ! -e "$1/desyn-render.conf" ]]' _ "${ENABLED}"
check "ACME server lists render.desyn.app" grep -q "render.desyn.app" "${DESYN_NGINX_ETC}/sites-available/desyn-acme.conf"
check "tooling installed" test -f "${DESYN_ROOT}/tooling/scripts/deploy.sh" -a -f "${DESYN_ROOT}/tooling/scripts/server-env.py"
check "backup timer enabled" grep -q "systemctl enable --now desyn-backup.timer" "${STUB_LOG}"
check "log shipping waits for axiom.env" bash -c '! grep -q "enable --now desyn-logship" "$1"' _ "${STUB_LOG}"
check "builder capped at 6 CPUs / 16 GB" grep -q "driver-opt cpu-quota=600000,cpu-period=100000,memory=16g" "${STUB_LOG}"
check "next steps name the Convex Cloud flow" grep -q "server-env.py" "${T}/run1.out"

generated=("${DESYN_HTPASSWD}" "${DESYN_BASIC_AUTH_FILE}" "${LOCAL}"/*)
before="$(file_sum "${generated[@]}")"
unshare -r bash "${S}/bootstrap.sh" >"${T}/run2.out" 2>&1
check "second run changes no generated file" test "$(file_sum "${generated[@]}")" = "${before}"
check "network created once" test "$(grep -c 'network create' "${STUB_LOG}")" = 1

# A host bootstrapped by an older version has no resolver.conf: certs.sh refuses, a bootstrap re-run adds it and
# leaves every other generated file alone.
mkdir -p "${DESYN_LETSENCRYPT_LIVE}/desyn"
rm "${LOCAL}/resolver.conf"
others="$(file_sum "${DESYN_HTPASSWD}" "${LOCAL}"/*)"
if unshare -r bash "${S}/certs.sh" --sites-only >"${T}/certs-old.out" 2>&1; then
  fail "certs.sh should refuse a host without resolver.conf"
else
  pass "certs.sh refuses a host without resolver.conf"
fi
check "certs.sh names the missing file and the fix" grep -q "resolver.conf is missing; run bootstrap.sh" "${T}/certs-old.out"
unshare -r bash "${S}/bootstrap.sh" >"${T}/run3.out" 2>&1
check "bootstrap re-run adds resolver.conf" test -f "${LOCAL}/resolver.conf"
check "bootstrap re-run keeps the other generated files" test "$(file_sum "${DESYN_HTPASSWD}" "${LOCAL}"/!(resolver.conf))" = "${others}"
printf 'options edns0\n' >"${DESYN_RESOLV_CONF}"
rm "${LOCAL}/resolver.conf"
if unshare -r bash "${S}/bootstrap.sh" >"${T}/run4.out" 2>&1; then
  fail "bootstrap without any nameserver should fail"
else
  pass "bootstrap without any nameserver fails"
fi
check "bootstrap explains the missing nameserver" grep -q "no usable nameserver" "${T}/run4.out"
printf 'nameserver 127.0.0.53\n' >"${DESYN_RESOLV_CONF}"
unshare -r bash "${S}/bootstrap.sh" >"${T}/run5.out" 2>&1

# certs.sh --sites-only on a host that still has the former self-hosted Convex server blocks.
mkdir -p "${DESYN_LETSENCRYPT_LIVE}/desyn" "${DESYN_NGINX_ETC}/desyn/snippets"
: >"${DESYN_LETSENCRYPT_LIVE}/desyn/fullchain.pem"
: >"${DESYN_LETSENCRYPT_LIVE}/desyn/privkey.pem"
for old in desyn-convex.conf desyn-dash.conf; do
  echo "# old" >"${DESYN_NGINX_ETC}/sites-available/${old}"
  ln -s "${DESYN_NGINX_ETC}/sites-available/${old}" "${ENABLED}/${old}"
done
echo "# old" >"${DESYN_NGINX_ETC}/desyn/snippets/auth-api.conf"
stub openssl <<'EOF'
#!/usr/bin/env bash
[[ "$*" == *-enddate* ]] && { echo "notAfter=Jan  1 00:00:00 2099 GMT"; exit 0; }
exec /usr/bin/openssl "$@"
EOF
unshare -r bash "${S}/certs.sh" --sites-only >"${T}/certs.out" 2>&1 || {
  cat "${T}/certs.out"
  exit 1
}
for site in desyn-landing.conf desyn-app.conf desyn-docs.conf desyn-render.conf; do
  check "certs enables ${site}" test -L "${ENABLED}/${site}"
done
check "retired desyn-convex.conf removed" test ! -e "${ENABLED}/desyn-convex.conf" -a ! -e "${DESYN_NGINX_ETC}/sites-available/desyn-convex.conf"
check "retired desyn-dash.conf removed" test ! -e "${ENABLED}/desyn-dash.conf" -a ! -e "${DESYN_NGINX_ETC}/sites-available/desyn-dash.conf"
check "retired snippet removed" test ! -e "${DESYN_NGINX_ETC}/desyn/snippets/auth-api.conf"
check "render snippet installed" test -f "${DESYN_NGINX_ETC}/desyn/snippets/csp-render.conf"
check "nginx validated before reloading" grep -q "nginx -t" "${STUB_LOG}"

unshare -r bash "${S}/basic-auth.sh" off >"${T}/ba.out" 2>&1
check "basic-auth off flips the switch" grep -q "default 0;" "${LOCAL}/auth-switch.conf"
status="$(unshare -r bash "${S}/basic-auth.sh" status 2>&1)"
check "basic-auth status reports off" grep -q "basic auth: off" <<<"${status}"
unshare -r bash "${S}/basic-auth.sh" on >"${T}/ba.out" 2>&1
check "basic-auth on flips it back" grep -q "default 1;" "${LOCAL}/auth-switch.conf"
# A reload failure (nginx -t passed) must fail the switch and restore the previous file, not report success.
printf '#!/usr/bin/env bash\necho "systemctl $*" >> "$STUB_LOG"\n[[ "$1" == reload ]] && exit 1\nexit 0\n' | stub systemctl
if unshare -r bash "${S}/basic-auth.sh" off >"${T}/ba-fail.out" 2>&1; then
  fail "basic-auth off with a failing reload should exit non-zero"
else
  pass "basic-auth off with a failing reload exits non-zero"
fi
check "failed reload restores the pre-launch switch" grep -q "default 1;" "${LOCAL}/auth-switch.conf"
check "failed reload is reported" grep -q "systemctl reload nginx failed" "${T}/ba-fail.out"
logging_stub systemctl
gate_before="$(file_sum "${LOCAL}/gate.conf")"
unshare -r bash "${S}/basic-auth.sh" rotate-password --yes >"${T}/ba.out" 2>&1
check "rotate-password also replaces the gate token" test "$(file_sum "${LOCAL}/gate.conf")" != "${gate_before}"
check "rotated gate token file stays 0600" test "$(stat -c %a "${LOCAL}/gate.conf")" = 600
check "rotated gate token is a 64-hex token used in both maps" \
  test "$(grep -oE '[0-9a-f]{64}' "${LOCAL}/gate.conf" | sort -u | wc -l)" = 1
gate_before="$(file_sum "${LOCAL}/gate.conf")"
unshare -r bash "${S}/basic-auth.sh" rotate-gate --dry-run >"${T}/ba-dry.out" 2>&1
check "rotate-gate --dry-run changes nothing" test "$(file_sum "${LOCAL}/gate.conf")" = "${gate_before}"
new_hash="$(grep "^desyn:" "${DESYN_HTPASSWD}" | cut -d: -f2-)"
new_password="$(sed -n 's/^password: //p' "${DESYN_BASIC_AUTH_FILE}")"
check "rotate-password updates both files consistently" test "${new_hash}" != "${hash}" -a \
  "$(openssl passwd -6 -salt "$(cut -d'$' -f3 <<<"${new_hash}")" "${new_password}")" = "${new_hash}"

unshare -r bash "${S}/uninstall.sh" --dry-run --yes >"${T}/uninstall.out" 2>&1
check "uninstall --dry-run removes nothing" test -d "${SECRETS}" -a -f "${DESYN_HTPASSWD}"
check "uninstall --dry-run lists desyn nginx files" grep -q "\[dry-run\] rm -f ${DESYN_NGINX_ETC}/sites-available/desyn-render.conf" "${T}/uninstall.out"

finish
