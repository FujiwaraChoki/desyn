#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted bash -c snippets and stub bodies expand at their own runtime
# server-env.py against a throwaway repository root with fake keys: rendering (references, alternatives,
# defaults, optional lines and files), file modes, refusal of unsafe values and missing names (names reported,
# values never printed), deploy-key creation through a stubbed Convex CLI, and the ssh sync into a sandboxed
# /opt/desyn/secrets (created / updated / unchanged, retired files, root-only modes).
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd() { command -v "$1" >/dev/null 2>&1 || {
  echo "SKIP $(basename "$0"): $1 missing"
  exit 0
}; }
require_cmd python3

T="$(mktemp -d)"
trap 'rm -rf "${T}"' EXIT
sandbox_env "${T}"
R="${T}/repo"
mkdir -p "${R}/deploy/env"
cp -a "${DEPLOY_DIR}/env/server" "${R}/deploy/env/server"
cp "${DEPLOY_DIR}/env/public.env" "${R}/deploy/env/public.env"
printf '{"dependencies":{"convex":"1.47.0"}}\n' >"${R}/package.json"
WORKER_SECRET="$(printf 'w%.0s' {1..8})$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
AWS_SECRET="fakeAwsSecret/With+Plus$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
DEPLOY_KEY="prod:opulent-alpaca-530|fakedeploykey$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
cat >"${R}/.env.keys" <<EOF
RENDER_WORKER_SECRET_PROD=${WORKER_SECRET}
BACKUP_AWS_ACCESS_KEY_ID=AKIAFAKEFAKEFAKE0000
BACKUP_AWS_SECRET_ACCESS_KEY="${AWS_SECRET}"
EOF
PY=(python3 -I "${DEPLOY_DIR}/scripts/server-env.py" prod --root "${R}")
secret_values=("${WORKER_SECRET}" "${AWS_SECRET}" "${DEPLOY_KEY}" "fakedeploykey")
no_values() {
  local v
  for v in "${secret_values[@]}"; do grep -qF -- "${v}" "$1" && return 1; done
  return 0
}

# --check / --dry-run report names only.
if "${PY[@]}" --check >"${T}/check.out" 2>&1; then fail "--check with a missing deploy key exits 1"; else pass "--check with a missing deploy key exits 1"; fi
check "--check names the missing deploy key" grep -q "convex-backup.env.*missing CONVEX_DEPLOY_KEY_PROD" "${T}/check.out"
check "optional axiom.env is skipped without AXIOM_TOKEN" grep -q "skipped axiom.env (missing AXIOM_TOKEN)" "${T}/check.out"
check "--check prints no values" no_values "${T}/check.out"
"${PY[@]}" --dry-run >"${T}/dry.out" 2>&1 || true
check "--dry-run lists variable names" grep -q "worker.env.*RENDER_WORKER_SECRET, RUST_LOG" "${T}/dry.out"
check "--dry-run prints no values" no_values "${T}/dry.out"

# Missing names stop --out before anything is written (deploy-key creation disabled).
if "${PY[@]}" --out "${T}/out0" --no-create-deploy-key >"${T}/out0.log" 2>&1; then
  fail "--out with missing names exits non-zero"
else
  pass "--out with missing names exits non-zero"
fi
check "nothing written when names are missing" test ! -e "${T}/out0"

# Deploy key creation through a stubbed Convex CLI (npx convex@<v> deployment token create <name> --save-env F).
stub npx <<EOF
#!/usr/bin/env bash
echo "npx \$* (CONVEX_DEPLOYMENT=\${CONVEX_DEPLOYMENT:-})" >> "\$STUB_LOG"
args=("\$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  if [[ "\${args[\$i]}" == --save-env ]]; then printf 'CONVEX_DEPLOY_KEY=%s\n' '${DEPLOY_KEY}' >"\${args[\$((i + 1))]}"; fi
done
exit 0
EOF
"${PY[@]}" --out "${T}/out1" >"${T}/out1.log" 2>&1 || {
  cat "${T}/out1.log"
  exit 1
}
check "deploy key created with the pinned CLI against prod" \
  grep -q "npx -y convex@1.47.0 deployment token create desyn-hetzner-[0-9]* --save-env .* (CONVEX_DEPLOYMENT=prod:opulent-alpaca-530)" "${STUB_LOG}"
check "deploy key appended to .env.keys" grep -qxF "CONVEX_DEPLOY_KEY_PROD=${DEPLOY_KEY}" "${R}/.env.keys"
check "deploy key creation prints no value" no_values "${T}/out1.log"
check "output directory is 0700" test "$(stat -c %a "${T}/out1")" = 700
check "every file is 0600" test -z "$(find "${T}/out1" -type f ! -perm 600)"
check "worker secret = RENDER_WORKER_SECRET_PROD" grep -qxF "RENDER_WORKER_SECRET=${WORKER_SECRET}" "${T}/out1/worker.env"
check "quoted source values are unquoted" grep -qxF "AWS_SECRET_ACCESS_KEY=${AWS_SECRET}" "${T}/out1/backup.env"
check "backup bucket from public.env" grep -qx "BACKUP_S3_BUCKET=desyn-prod-backups" "${T}/out1/backup.env"
check "assets bucket from public.env" grep -qx "BACKUP_ASSETS_BUCKET=desyn-prod-assets" "${T}/out1/backup.env"
check "convex-backup.env holds only the deploy key" test "$(grep -vc '^#' "${T}/out1/convex-backup.env")" = 1
check "web.env points at Convex Cloud" grep -qx "CONVEX_SITE_URL=https://opulent-alpaca-530.eu-west-1.convex.site" "${T}/out1/web.env"
check "no self-hosted Convex hosts in generated files" bash -c '! grep -rq "convex\.desyn\.app\|convex-site\.desyn\.app" "$1"' _ "${T}/out1"
check "the backup key never reaches the web app" bash -c '! grep -q "AWS_\|CONVEX_DEPLOY_KEY" "$1/web.env" "$1/landing.env" "$1/docs.env" "$1/worker.env"' _ "${T}/out1"
check "a second run does not create another key" test "$("${PY[@]}" --out "${T}/out2" 2>&1 >/dev/null | wc -l)" = 0 -a \
  "$(grep -c "deployment token create" "${STUB_LOG}")" = 1

# Template features: alternatives, defaults, optional lines, optional files.
F="${T}/feat"
mkdir -p "${F}/deploy/env/server"
cp "${R}/deploy/env/public.env" "${F}/deploy/env/public.env"
printf 'B_VALUE=from-b\nPLAIN=plain\n' >"${F}/.env.keys"
printf 'IGNORED=never\n' >"${F}/.env"
cat >"${F}/deploy/env/server/feat.env" <<'EOF'
# feature template
ALT=${A_VALUE|B_VALUE}
DEF=${MISSING:-fallback}
OPT=${MISSING:-}
MIX=prefix-${PLAIN}-suffix
LIT=literal
EOF
printf '# @optional-file: needs NOPE\nX=${NOPE}\n' >"${F}/deploy/env/server/opt.env"
python3 -I "${DEPLOY_DIR}/scripts/server-env.py" prod --root "${F}" --out "${F}/out" --no-create-deploy-key >"${F}/log" 2>&1 || {
  cat "${F}/log"
  fail "feature template renders"
}
check "\${A|B} takes the first present name" grep -qx "ALT=from-b" "${F}/out/feat.env"
check "\${X:-text} default" grep -qx "DEF=fallback" "${F}/out/feat.env"
check "\${X:-} drops an empty line" bash -c '! grep -q "^OPT=" "$1"' _ "${F}/out/feat.env"
check "references inside literal text" grep -qx "MIX=prefix-plain-suffix" "${F}/out/feat.env"
check "@optional-file skipped" test ! -e "${F}/out/opt.env"
printf 'BAD=${UNSAFE}\n' >"${F}/deploy/env/server/opt.env"
printf 'UNSAFE="has space $and quote"\n' >>"${F}/.env.keys"
if python3 -I "${DEPLOY_DIR}/scripts/server-env.py" prod --root "${F}" --out "${F}/out3" --no-create-deploy-key >"${F}/log3" 2>&1; then
  fail "unsafe value is refused"
else
  pass "unsafe value is refused"
fi
check "the refusal names the variable" grep -q "value for BAD contains" "${F}/log3"
check "the refusal does not print the value" bash -c '! grep -q "has space" "$1"' _ "${F}/log3"

# Sync to the sandboxed server over (stubbed) ssh as fake root.
stub ssh <<'EOF'
#!/usr/bin/env bash
while [[ "$1" == -* ]]; do case "$1" in -o) shift 2 ;; *) shift ;; esac; done
shift
exec bash -c "$*"
EOF
stub sudo <<'EOF'
#!/usr/bin/env bash
[[ "$1" == -n ]] && shift
exec unshare -r "$@"
EOF
mkdir -p "${DESYN_ROOT}/secrets"
echo "OLD=1" >"${DESYN_ROOT}/secrets/convex-functions.env"
echo "STALE=1" >"${DESYN_ROOT}/secrets/web.env"
"${PY[@]}" --host sandbox >"${T}/push1.out" 2>&1 || {
  cat "${T}/push1.out"
  exit 1
}
check "sync reports created files" grep -q "worker.env  *created" "${T}/push1.out"
check "sync reports updated files" grep -q "web.env  *updated" "${T}/push1.out"
check "sync reports retired files" grep -q "convex-functions.env  *retired file still present" "${T}/push1.out"
check "sync prints no values" no_values "${T}/push1.out"
check "remote secrets directory is 0700" test "$(stat -c %a "${DESYN_ROOT}/secrets")" = 700
check "remote files are 0600" test -z "$(find "${DESYN_ROOT}/secrets" -type f -name '*.env' ! -perm 600 ! -name convex-functions.env)"
check "remote files match the local render" cmp -s "${DESYN_ROOT}/secrets/worker.env" "${T}/out1/worker.env"
check "no temp directories left behind" test -z "$(find "${DESYN_ROOT}/secrets" -name '.sync.*')"
"${PY[@]}" --host sandbox --prune-retired >"${T}/push2.out" 2>&1
check "second sync: unchanged" grep -q "worker.env  *unchanged" "${T}/push2.out"
check "--prune-retired removes retired files" test ! -e "${DESYN_ROOT}/secrets/convex-functions.env"

finish
