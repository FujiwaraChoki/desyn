#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2016,SC2034 # stub bodies are literal; DEPLOY_DIR is used by the suites
#
# Helpers for the deploy/ test suites. The suites run the real scripts as fake root (user namespace via
# `unshare -r`) against throwaway directories, with docker/nginx/systemctl/ssh replaced by stubs on PATH.
# Nothing outside the temp directory is touched.

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${TESTS_DIR}/.." && pwd)"
PASSED=0
FAILED=0

pass() {
  PASSED=$((PASSED + 1))
  printf 'PASS %s\n' "$*"
}
fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL %s\n' "$*"
}
# check NAME COMMAND...: pass when COMMAND succeeds.
check() {
  local name=$1
  shift
  if "$@"; then pass "${name}"; else fail "${name}"; fi
}
finish() {
  printf '%s: passed=%s failed=%s\n' "$(basename "$0")" "${PASSED}" "${FAILED}"
  ((FAILED == 0))
}

require_userns() {
  if ! unshare -r true 2>/dev/null; then
    echo "SKIP $(basename "$0"): unprivileged user namespaces are disabled (unshare -r)"
    exit 0
  fi
}

# stub NAME <<'EOF' ... EOF: install an executable stub into $STUB_BIN.
stub() {
  cat >"${STUB_BIN}/$1"
  chmod +x "${STUB_BIN}/$1"
}

# logging_stub NAME...: stubs that only record their arguments.
logging_stub() {
  local name
  for name in "$@"; do
    printf '#!/usr/bin/env bash\necho "%s $*" >> "$STUB_LOG"\nexit 0\n' "${name}" | stub "${name}"
  done
}

# sandbox_env DIR: point every desyn host path at DIR and put the stubs first on PATH.
sandbox_env() {
  local dir=$1
  export STUB_BIN="${dir}/bin" STUB_LOG="${dir}/calls.log" STUB_STATE="${dir}/stub-state"
  mkdir -p "${STUB_BIN}" "${STUB_STATE}" "${dir}/etc/nginx/sites-available" "${dir}/etc/nginx/sites-enabled" \
    "${dir}/etc/systemd/system" "${dir}/root" "${dir}/etc/letsencrypt/live"
  : >"${STUB_LOG}"
  export PATH="${STUB_BIN}:${PATH}"
  export DESYN_ROOT="${dir}/opt/desyn" DESYN_NGINX_ETC="${dir}/etc/nginx" \
    DESYN_ACME_ROOT="${dir}/var/www/desyn-acme" DESYN_NGINX_CACHE="${dir}/var/cache/nginx/desyn" \
    DESYN_HTPASSWD="${dir}/etc/nginx/desyn.htpasswd" DESYN_BASIC_AUTH_FILE="${dir}/root/desyn-basic-auth.txt" \
    DESYN_SYSTEMD_DIR="${dir}/etc/systemd/system" DESYN_LETSENCRYPT_LIVE="${dir}/etc/letsencrypt/live" \
    DESYN_RESOLV_CONF="${dir}/etc/resolv.conf"
  # systemd-resolved style host: the stub resolver plus a link-local entry nginx cannot use.
  printf '# test\nnameserver 127.0.0.53\nnameserver fe80::1%%eth0\noptions edns0\n' >"${DESYN_RESOLV_CONF}"
  # install/chown: users and groups such as "desyn" or "www-data" do not exist inside the namespace.
  stub install <<'EOF'
#!/usr/bin/env bash
args=()
while (($#)); do case "$1" in -o | -g) shift 2 ;; *) args+=("$1"); shift ;; esac; done
exec /usr/bin/install "${args[@]}"
EOF
  logging_stub chown systemctl useradd userdel
}

# file_sum FILE...: one checksum over the given files (compared, never printed raw).
file_sum() {
  cat "$@" | sha256sum | cut -d' ' -f1
}
