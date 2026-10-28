#!/usr/bin/env bash
# Validate everything under deploy/ and .github/workflows/ without touching any server:
#   shell    shellcheck on every script (local shellcheck, else koalaman/shellcheck in docker)
#   python   parse every deploy/scripts/*.py (server-env.py, convex-cloud-env.py)
#   compose  `docker compose config` for every compose file with dummy, secret-free values
#   nginx    `nginx -t` on the full desyn nginx tree inside an Ubuntu-like nginx.conf that also contains a
#            pre-existing "other site", with self-signed certificates (local nginx via NGINX_BIN, else the
#            nginx:stable image)
#   actions  actionlint on .github/workflows (local, else rhysd/actionlint in docker)
#   vector   `vector validate` + `vector test` (transform unit tests) on the log-shipping config
#            (local VECTOR_BIN, else timberio/vector in docker)
#
# Usage: deploy/scripts/lint.sh [--only shell,python,compose,nginx,actions,vector]
# Environment (optional local binaries): NGINX_BIN, VECTOR_BIN, SHELLCHECK_BIN, ACTIONLINT_BIN
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/nginx.sh
source "${SCRIPT_DIR}/lib/nginx.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

ONLY="shell,python,compose,nginx,actions,vector"
REPO_DIR="$(cd "${DESYN_DEPLOY_DIR}/.." && pwd)"
SHELLCHECK_IMAGE="koalaman/shellcheck:v0.11.0"
ACTIONLINT_IMAGE="rhysd/actionlint:1.7.12"
NGINX_IMAGE="nginx:stable"

while (($#)); do
  case "$1" in
    --only)
      ONLY="$2"
      shift 2
      ;;
    *)
      common_arg "$@" || usage_error "$1"
      shift "${COMMON_SHIFT}"
      ;;
  esac
done

want() { [[ ",${ONLY}," == *",$1,"* ]]; }
docker_ok() { docker info >/dev/null 2>&1; }

FAILURES=()
step() {
  local name=$1
  shift
  info "== ${name}"
  if "$@"; then
    ok "${name}"
  else
    error "${name} failed"
    FAILURES+=("${name}")
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# ------------------------------------------------------------------------------------------------ shell

lint_shell() {
  local files=()
  mapfile -t files < <(cd "${DESYN_DEPLOY_DIR}" && find scripts tests aws -type f -name '*.sh' | sort)
  local sc="${SHELLCHECK_BIN:-shellcheck}"
  if command -v "${sc}" >/dev/null 2>&1 && "${sc}" --version >/dev/null 2>&1; then
    (cd "${DESYN_DEPLOY_DIR}" && "${sc}" --external-sources --source-path=SCRIPTDIR --severity=style "${files[@]}")
  elif docker_ok; then
    docker run --rm -v "${DESYN_DEPLOY_DIR}:/mnt:ro" -w /mnt "${SHELLCHECK_IMAGE}" \
      --external-sources --source-path=SCRIPTDIR --severity=style "${files[@]}"
  else
    error "neither shellcheck nor docker is available"
    return 1
  fi
}

# ----------------------------------------------------------------------------------------------- python

lint_python() {
  require_cmd python3
  local f rc=0
  for f in "${DESYN_DEPLOY_DIR}"/scripts/*.py; do
    python3 -I -c 'import ast, sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' "${f}" || rc=1
  done
  return "${rc}"
}

# ---------------------------------------------------------------------------------------------- compose

lint_compose() {
  local root="${WORK}/compose-root" f rc=0
  mkdir -p "${root}/secrets"
  for f in worker web landing docs; do : >"${root}/secrets/${f}.env"; done
  require_cmd docker
  info "desyn.prod.yml"
  DESYN_ROOT="${root}" docker compose -f "${DESYN_DEPLOY_DIR}/compose/desyn.prod.yml" \
    --env-file "${DESYN_DEPLOY_DIR}/compose/ci.env" --profile bluegreen config --quiet || rc=1
  info "desyn.selfhost.yml (all profiles, .env.example with throwaway values for the empty secrets)"
  sed -E 's/^([A-Z0-9_]+)=$/\1=lint-placeholder/' "${DESYN_DEPLOY_DIR}/compose/.env.example" >"${WORK}/selfhost.env"
  docker compose -f "${DESYN_DEPLOY_DIR}/compose/desyn.selfhost.yml" \
    --env-file "${WORK}/selfhost.env" --profile '*' config --quiet || rc=1
  return "${rc}"
}

# ------------------------------------------------------------------------------------------------ nginx

# build_nginx_tree DIR MODE(local|docker) VERSION: an /etc/nginx-like tree with the desyn files installed.
build_nginx_tree() {
  local dir=$1 mode=$2 version=$3 http2_mode prefix_le prefix_cache prefix_logs prefix_acme
  mkdir -p "${dir}/sites-available" "${dir}/sites-enabled" "${dir}/conf.d" "${dir}/desyn/snippets" \
    "${dir}/desyn/local" "${dir}/le/desyn" "${dir}/le/other" "${dir}/logs" "${dir}/cache"
  if [[ "${mode}" == "local" ]]; then
    prefix_le="${dir}/le"
    prefix_cache="${dir}/cache/desyn"
    prefix_logs="${dir}/logs"
    prefix_acme="${dir}/acme"
  else
    prefix_le="/etc/letsencrypt/live"
    prefix_cache="/var/cache/nginx/desyn"
    prefix_logs="/var/log/nginx"
    prefix_acme="/var/www/desyn-acme"
  fi
  local f
  # The CA bundle for the TLS proxy to the Convex Cloud site URL is loaded by nginx -t: point it at the test
  # certificate generated below, so the check does not depend on the distribution's bundle path.
  for f in "${DESYN_DEPLOY_DIR}"/nginx/sites-available/*.conf "${DESYN_DEPLOY_DIR}"/nginx/desyn/snippets/*.conf; do
    local subdir="sites-available"
    [[ "${f}" == */desyn/snippets/* ]] && subdir="desyn/snippets"
    sed -e "s#/etc/ssl/certs/ca-certificates.crt#${prefix_le}/desyn/fullchain.pem#g" \
      -e "s#/etc/letsencrypt/live#${prefix_le}#g" \
      -e "s#/var/cache/nginx/desyn#${prefix_cache}#g" \
      -e "s#/var/log/nginx#${prefix_logs}#g" \
      -e "s#/var/www/desyn-acme#${prefix_acme}#g" \
      "${f}" >"${dir}/${subdir}/$(basename "${f}")"
  done
  for f in "${dir}"/sites-available/*.conf; do
    ln -s "../sites-available/$(basename "${f}")" "${dir}/sites-enabled/$(basename "${f}")"
  done
  if version_ge "${version}" "1.25.1"; then http2_mode=directive; else http2_mode=listen; fi
  render_listen_snippets "${dir}/desyn/local" "${version}" 1 "${http2_mode}"
  render_auth_switch "${dir}/desyn/local" 1
  render_gate "${dir}/desyn/local" "$(random_hex 32)"
  render_trusted "${dir}/desyn/local" 127.0.0.1 ::1 172.30.0.0/16 203.0.113.10
  render_brotli "${dir}/desyn/local" 0
  render_resolver "${dir}/desyn/local" 1 127.0.0.53 ::1
  printf 'ci:%s\n' "$(openssl passwd -6 "$(random_hex 12)")" >"${dir}/desyn.htpasswd"
  local name
  for name in desyn other; do
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=${name}.test" \
      -keyout "${dir}/le/${name}/privkey.pem" -out "${dir}/le/${name}/fullchain.pem" >/dev/null 2>&1
  done
  local pid_line="" log_line="error_log ${prefix_logs}/error.log;"
  if [[ "${mode}" == "local" ]]; then pid_line="pid ${dir}/nginx.pid;"; fi
  # Ubuntu-like main config plus a pre-existing site that owns the default servers and defines the common
  # $connection_upgrade map, to prove the desyn files coexist with what is already on the shared host.
  cat >"${dir}/nginx.conf" <<EOF
worker_processes 1;
${pid_line}
${log_line}
events { worker_connections 64; }
http {
    include mime.types;
    default_type application/octet-stream;
    sendfile on;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    access_log ${prefix_logs}/access.log;
    gzip on;
    map \$http_upgrade \$connection_upgrade { default upgrade; "" close; }
    include conf.d/*.conf;
    include sites-enabled/*;
}
EOF
  # On nginx < 1.25.1 bootstrap only uses "listen ... http2" when another site already does (the flag is
  # per socket there), so the emulated other site does too.
  local other_h2=""
  if [[ "${http2_mode}" == "listen" ]]; then other_h2=" http2"; fi
  cat >"${dir}/conf.d/other-site.conf" <<EOF
server { listen 80 default_server; listen [::]:80 default_server; server_name _; return 444; }
server {
    listen 443 ssl${other_h2} default_server;
    listen [::]:443 ssl${other_h2} default_server;
    server_name other.example;
    ssl_certificate ${prefix_le}/other/fullchain.pem;
    ssl_certificate_key ${prefix_le}/other/privkey.pem;
    location / { return 200 "other"; }
}
EOF
  if [[ "${mode}" == "local" ]]; then
    # nginx -t binds its listen sockets; unprivileged local runs use high ports instead of 80/443.
    sed -i -e 's/listen 80\b/listen 18080/; s/listen \[::\]:80\b/listen [::]:18080/' \
      -e 's/listen 443\b/listen 18443/; s/listen \[::\]:443\b/listen [::]:18443/' \
      "${dir}/desyn/local/listen-80.conf" "${dir}/desyn/local/listen-443.conf"
    sed -i -e 's/listen 80 /listen 18080 /; s/listen \[::\]:80 /listen [::]:18080 /' \
      -e 's/listen 443 /listen 18443 /; s/listen \[::\]:443 /listen [::]:18443 /' "${dir}/conf.d/other-site.conf"
  fi
}

# nginx_mime_types NGINX_BIN: the mime.types shipped with that nginx (source build or distro package).
nginx_mime_types() {
  local candidate
  for candidate in "$(dirname "$(dirname "$1")")/conf/mime.types" /etc/nginx/mime.types; do
    if [[ -f "${candidate}" ]]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}

lint_nginx() {
  if [[ -n "${NGINX_BIN:-}" ]]; then
    local version dir
    version="$("${NGINX_BIN}" -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"
    dir="${WORK}/nginx-${version}"
    build_nginx_tree "${dir}" local "${version}"
    cp "$(nginx_mime_types "${NGINX_BIN}")" "${dir}/mime.types"
    info "nginx ${version} (local binary)"
    "${NGINX_BIN}" -t -q -p "${dir}" -c "${dir}/nginx.conf"
    "${NGINX_BIN}" -t -p "${dir}" -c "${dir}/nginx.conf" 2>&1 | sed 's/^/  /' >&2
  elif docker_ok; then
    local version dir
    version="$(docker run --rm "${NGINX_IMAGE}" nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"
    dir="${WORK}/nginx-docker"
    build_nginx_tree "${dir}" docker "${version}"
    docker run --rm "${NGINX_IMAGE}" cat /etc/nginx/mime.types >"${dir}/mime.types"
    info "nginx ${version} (${NGINX_IMAGE})"
    docker run --rm \
      -v "${dir}:/etc/nginx:ro" \
      -v "${dir}/le:/etc/letsencrypt/live:ro" \
      "${NGINX_IMAGE}" nginx -t
  else
    error "set NGINX_BIN or make docker available"
    return 1
  fi
}

# ---------------------------------------------------------------------------------------------- actions

lint_actions() {
  local al="${ACTIONLINT_BIN:-actionlint}" sc_args=()
  if [[ -n "${SHELLCHECK_BIN:-}" ]]; then sc_args=(-shellcheck "${SHELLCHECK_BIN}"); fi
  if command -v "${al}" >/dev/null 2>&1 && "${al}" -version >/dev/null 2>&1; then
    (cd "${REPO_DIR}" && "${al}" -color "${sc_args[@]}")
  elif docker_ok; then
    docker run --rm -v "${REPO_DIR}:/repo:ro" -w /repo "${ACTIONLINT_IMAGE}" -color
  else
    error "neither actionlint nor docker is available"
    return 1
  fi
}

# ----------------------------------------------------------------------------------------------- vector

lint_vector() {
  local dir="${DESYN_DEPLOY_DIR}/systemd"
  if [[ -n "${VECTOR_BIN:-}" ]]; then
    AXIOM_TOKEN=lint-placeholder AXIOM_DATASET=desyn "${VECTOR_BIN}" validate --no-environment "${dir}/vector.yaml" &&
      AXIOM_TOKEN=lint-placeholder AXIOM_DATASET=desyn "${VECTOR_BIN}" test "${dir}/vector.yaml" "${dir}/vector.tests.yaml"
  elif docker_ok; then
    local run=(docker run --rm -e AXIOM_TOKEN=lint-placeholder -e AXIOM_DATASET=desyn -v "${dir}:/cfg:ro" "${DESYN_VECTOR_IMAGE}")
    "${run[@]}" validate --no-environment /cfg/vector.yaml && "${run[@]}" test /cfg/vector.yaml /cfg/vector.tests.yaml
  else
    error "set VECTOR_BIN or make docker available"
    return 1
  fi
}

# Sourcing this file (tests) only defines the functions.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

want shell && step "shellcheck" lint_shell
want python && step "python syntax" lint_python
want compose && step "compose config" lint_compose
want nginx && step "nginx -t" lint_nginx
want actions && step "actionlint" lint_actions
want vector && step "vector validate" lint_vector

if ((${#FAILURES[@]})); then
  die "failed: ${FAILURES[*]}"
fi
ok "all checks passed"
