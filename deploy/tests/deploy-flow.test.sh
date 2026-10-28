#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted bash -c snippets and stub bodies expand at their own runtime
# deploy.sh (workstation + server mode), backup.sh and rollback.sh in a sandbox with stubbed docker, ssh, sudo,
# curl, npx and Convex CLI: source packaging without .env files, phase order (build -> Convex env -> server env
# -> convex deploy -> rollout), image builds per present service, blue/green colours including the worker,
# automatic rollback on a failing service, functions-only deploys, backups (Convex export + S3 upload commands),
# rollback.sh, --dry-run, release pruning, and that no secret value ever reaches the output.
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_userns

T="$(mktemp -d)"
trap 'rm -rf "${T}"' EXIT
sandbox_env "${T}"

# A minimal repository: the real deploy/ plus marker files for every service except docs.
REPO="${T}/repo"
mkdir -p "${REPO}/apps/web" "${REPO}/apps/landing" "${REPO}/crates/desyn-worker" "${REPO}/convex" "${REPO}/node_modules/.bin"
cp -a "${DEPLOY_DIR}" "${REPO}/deploy"
echo '{"name":"@desyn/web"}' >"${REPO}/apps/web/package.json"
echo '{"name":"@desyn/landing"}' >"${REPO}/apps/landing/package.json"
echo '[package]' >"${REPO}/crates/desyn-worker/Cargo.toml"
echo 'export default {}' >"${REPO}/convex/schema.ts"
echo '{"name":"desyn","dependencies":{"convex":"1.47.0"}}' >"${REPO}/package.json"
echo 'NOT_SHIPPED=1' >"${REPO}/.env"
echo 'NOT_SHIPPED=1' >"${REPO}/apps/web/.env.local"
echo 'X=' >"${REPO}/.env.example"
rand() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
WORKER_SECRET="worker$(rand)"
BACKUP_SECRET="backup$(rand)"
SERVER_KEY="prod:opulent-alpaca-530|server$(rand)"
CI_KEY="prod:opulent-alpaca-530|ci$(rand)"
cat >"${REPO}/.env.keys" <<EOF
RENDER_WORKER_SECRET_PROD=${WORKER_SECRET}
BACKUP_AWS_ACCESS_KEY_ID=AKIAFAKEFAKEFAKE0000
BACKUP_AWS_SECRET_ACCESS_KEY=${BACKUP_SECRET}
CONVEX_DEPLOY_KEY_PROD=${SERVER_KEY}
BETTER_AUTH_SECRET_PROD=$(rand)
AI_KEY_ENCRYPTION_SECRET_PROD=$(rand)
EOF
SECRETS=("${WORKER_SECRET}" "${BACKUP_SECRET}" "${SERVER_KEY#*|}" "${CI_KEY#*|}")
no_secret_in() {
  local f v
  for f in "$@"; do
    for v in "${SECRETS[@]}"; do grep -qF -- "${v}" "${f}" && return 1; done
  done
  return 0
}
# The Convex CLI of the repo (node_modules/.bin/convex) and npx (convex-cloud-env.py) only record their calls.
cat >"${REPO}/node_modules/.bin/convex" <<'EOF'
#!/usr/bin/env bash
envf=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do [[ "${args[$i]}" == --env-file ]] && envf="${args[$((i + 1))]}"; done
target="$(sed -n 's/^\(CONVEX_DEPLOY[A-Z_]*\)=\([a-z]*:[a-z0-9-]*\).*/\1=\2/p' "${envf}")"
echo "convex-cli $* target=${target} inherited=${CONVEX_DEPLOY_KEY:-none}" >> "$STUB_LOG"
[[ "${FAIL_CONVEX:-0}" == 1 ]] && { echo "simulated convex failure" >&2; exit 1; }
exit 0
EOF
chmod +x "${REPO}/node_modules/.bin/convex"
stub npx <<'EOF'
#!/usr/bin/env bash
names=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ "${args[$i]}" == --from-file ]] && names="$(cut -d= -f1 "${args[$((i + 1))]}" | tr '\n' ' ')"
done
echo "npx $* names=${names} deployment=${CONVEX_DEPLOYMENT:-}" >> "$STUB_LOG"
exit 0
EOF

stub docker <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
img() { echo "$STUB_STATE/image_$(echo "$1" | tr '/:' '__')"; }
if [[ "$1" == compose ]]; then
  envf="" sub="" svcs=()
  args=("$@")
  for ((i = 1; i < ${#args[@]}; i++)); do
    case "${args[$i]}" in
      --env-file) envf="${args[$((i + 1))]}"; i=$((i + 1)) ;;
      --project-name | --project-directory | -f | --profile | --wait-timeout | -t | --tail) i=$((i + 1)) ;;
      up | ps | stop | rm | exec | logs | version) [[ -z "$sub" ]] && sub="${args[$i]}" ;;
      -*) ;;
      *) [[ -n "$sub" ]] && svcs+=("${args[$i]}") ;;
    esac
  done
  case "$sub" in
    version) echo 2.40.0 ;;
    up)
      for s in "${svcs[@]}"; do
        var="DESYN_TAG_$(echo "$s" | tr 'a-z-' 'A-Z_')"
        tag="$(grep -E "^${var}=" "$envf" 2>/dev/null | cut -d= -f2)"
        if [[ "$s" == "${FAIL_SVC:-}" && "$tag" == "${FAIL_TAG:-}" ]]; then echo "simulated failure $s:$tag" >&2; exit 1; fi
        touch "$STUB_STATE/running_$s"
        echo "$tag" >"$STUB_STATE/tag_$s"
      done ;;
    ps) [[ -f "$STUB_STATE/running_${svcs[0]:-}" ]] && echo "cid_${svcs[0]}" ;;
    stop | rm) for s in "${svcs[@]}"; do rm -f "$STUB_STATE/running_$s"; done ;;
  esac
  exit 0
fi
case "$1 ${2:-}" in
  "network inspect") [[ "$*" == *Labels* ]] && echo desyn; [[ "$*" == *Subnet* ]] && echo "172.31.0.0/16 " ;;
  "buildx build") for ((i = 1; i <= $#; i++)); do [[ "${!i}" == -t ]] && { j=$((i + 1)); touch "$(img "${!j}")"; }; done ;;
  "image inspect") [[ -f "$(img "$3")" ]]; exit $? ;;
  "image rm") rm -f "$(img "$3")" ;;
  "inspect --format") echo healthy ;;
  "info --format") echo / ;;
  "images --format")
    for f in "$STUB_STATE"/image_*; do
      [[ -e "$f" ]] || continue
      ref="$(basename "$f" | sed 's/^image_desyn_/desyn\//; s/_/:/')"
      if [[ -n "${4:-}" ]]; then [[ "${ref%%:*}" == "$4" ]] && echo "${ref#*:}"; else echo "$ref"; fi
    done ;;
  "run --rm")
    # convex export: write a ZIP signature into the host directory mounted at /out.
    if [[ "$*" == *" export --path /out/convex-export.zip"* ]]; then
      for ((i = 1; i <= $#; i++)); do
        if [[ "${!i}" == -v ]]; then j=$((i + 1)); m="${!j}"; [[ "${m#*:}" == /out ]] && printf 'PK\003\004fake' >"${m%%:*}/convex-export.zip"; fi
      done
    fi ;;
esac
exit 0
EOF
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
# curl: 200, except that the worker refuses a request carrying a (wrong) secret header.
stub curl <<'EOF'
#!/usr/bin/env bash
[[ "$*" == *x-desyn-secret* ]] && { printf 401; exit 0; }
printf 200
EOF
stub nginx <<'EOF'
#!/usr/bin/env bash
case "$1" in -v) echo "nginx version: nginx/1.30.6" >&2 ;; -T) printf 'http {\n include /etc/nginx/sites-enabled/*;\n}\n' ;; esac
exit 0
EOF
printf '#!/usr/bin/env bash\n[[ "${1:-}" == desyn ]] && exit 0\nexec /usr/bin/id "$@"\n' | stub id

unshare -r bash "${REPO}/deploy/scripts/bootstrap.sh" >"${T}/bootstrap.out" 2>&1 || {
  tail -20 "${T}/bootstrap.out"
  exit 1
}

export CONVEX_DEPLOY_KEY="${CI_KEY}"
deploy() { bash "${REPO}/deploy/scripts/deploy.sh" --host sandbox --worktree --release "$1" "${@:2}" >"${T}/deploy-$1.out" 2>&1; }
active() { cat "${DESYN_ROOT}/state/active/$1" 2>/dev/null || echo none; }
tag() { cat "${STUB_STATE}/tag_$1" 2>/dev/null || echo none; }
current() { cat "${DESYN_ROOT}/state/current-release"; }
line_of() { grep -n -m1 -F -- "$1" "${STUB_LOG}" | cut -d: -f1; }

deploy r1 || {
  tail -40 "${T}/deploy-r1.out"
  exit 1
}
SRC="${DESYN_ROOT}/releases/r1/src"
check "source uploaded" test -d "${SRC}/deploy"
check "no .env file shipped" test -z "$(find "${SRC}" \( -name .env -o -name '.env.local' -o -name '.env.keys' \) -print)"
check ".env.example shipped" test -f "${SRC}/.env.example"
for s in worker web landing; do check "image ${s} built" test -f "${STUB_STATE}/image_desyn_${s}_r1"; done
check "no Convex tool image per release" test ! -f "${STUB_STATE}/image_desyn_convex_r1"
check "Convex CLI image built once for backups" test -f "${STUB_STATE}/image_desyn_convex-cli_1.47.0"
check "Convex CLI version recorded" grep -qx "DESYN_TAG_CONVEX_CLI=1.47.0" "${DESYN_ROOT}/state/images.env"
check "docs skipped (not in the release)" test ! -f "${STUB_STATE}/image_desyn_docs_r1"
check "first deploy runs blue everywhere" test "$(active worker)/$(active web)/$(active landing)" = blue/blue/blue
check "worker and web run r1" test "$(tag worker-blue)/$(tag web-blue)" = r1/r1
check "current release r1" test "$(current)" = r1
check "Convex env pushed to prod by convex-cloud-env.py" \
  grep -q "npx -y convex@1.47.0 env set --from-file .* --force names=.*RENDER_WORKER_SECRET.* deployment=prod:opulent-alpaca-530" "${STUB_LOG}"
check "Convex env includes the render worker URL" grep -q "names=.*RENDER_WORKER_URL" "${STUB_LOG}"
check "convex deploy uses the CI deploy key through a private env file" \
  grep -q "convex-cli deploy --yes --typecheck enable --env-file .* --message desyn release r1 target=CONVEX_DEPLOY_KEY=prod:opulent-alpaca-530 inherited=none" "${STUB_LOG}"
b="$(line_of "buildx build --load --build-arg DESYN_RELEASE=r1")"
e="$(line_of "env set --from-file")"
d="$(line_of "convex-cli deploy")"
u="$(line_of "worker-blue")"
check "order: build -> Convex env -> convex deploy -> rollout" test "${b}" -lt "${e}" -a "${e}" -lt "${d}" -a "${d}" -lt "${u}"
check "server env files written root-only" test -f "${DESYN_ROOT}/secrets/web.env" -a "$(stat -c %a "${DESYN_ROOT}/secrets/worker.env")" = 600
check "worker gets RENDER_WORKER_SECRET_PROD" grep -qxF "RENDER_WORKER_SECRET=${WORKER_SECRET}" "${DESYN_ROOT}/secrets/worker.env"
check "backup deploy key placed for the server" grep -qxF "CONVEX_DEPLOY_KEY=${SERVER_KEY}" "${DESYN_ROOT}/secrets/convex-backup.env"
check "no backup on the first deploy" grep -q "first deploy: nothing to back up" "${T}/deploy-r1.out"
check "release r1 is live" grep -q "release r1 is live" "${T}/deploy-r1.out"
check "no secret value in the deploy output" no_secret_in "${T}/deploy-r1.out" "${DESYN_ROOT}/state/history/r1.log"

deploy r2
check "second deploy switches to green" test "$(active web)/$(tag web-green)/$(active worker)" = green/r2/green
check "old colour stopped" test ! -f "${STUB_STATE}/running_web-blue" -a ! -f "${STUB_STATE}/running_worker-blue"
check "pre-deploy backup ran before the functions were deployed" \
  test "$(line_of "pre-r2")" -lt "$(grep -n "convex-cli deploy.*release r2" "${STUB_LOG}" | cut -d: -f1)"
bk="$(find "${DESYN_ROOT}/backups" -mindepth 1 -maxdepth 1 -name '*-pre-r2' | head -n 1)"
check "backup directory holds the export and a manifest" test -s "${bk}/convex-export.zip" -a -s "${bk}/manifest.json"
check "manifest records the deployment and the export checksum" \
  grep -q "\"deployment\": \"prod:opulent-alpaca-530\"" "${bk}/manifest.json"
check "manifest checksum matches" grep -q "$(sha256sum "${bk}/convex-export.zip" | cut -d' ' -f1)" "${bk}/manifest.json"
check "export used the deploy-key env file and the pinned CLI" \
  grep -q "run --rm --read-only --tmpfs /tmp .*--env-file ${DESYN_ROOT}/secrets/convex-backup.env .*desyn/convex-cli:1.47.0 export --path /out/convex-export.zip --include-file-storage" "${STUB_LOG}"
check "upload to s3://desyn-prod-backups/backups/<id>/ with SSE" \
  grep -q "amazon/aws-cli:.* s3 cp /backups/$(basename "${bk}") s3://desyn-prod-backups/backups/$(basename "${bk}")/ --recursive --only-show-errors --sse AES256" "${STUB_LOG}"
check "assets mirrored outside the expiring prefix" grep -q "s3 sync s3://desyn-prod-assets s3://desyn-prod-backups/assets-mirror/" "${STUB_LOG}"
check "no remote deletion by default (lifecycle rule)" bash -c '! grep -q "s3 rm" "$1"' _ "${STUB_LOG}"
check "backup files are 0600" test -z "$(find "${bk}" -type f ! -perm 600)"

if FAIL_SVC=web-blue FAIL_TAG=r3 deploy r3 --skip-backup; then fail "r3 should have failed"; else pass "r3 fails as simulated"; fi
check "automatic rollback reported" grep -q "rolled back to r2" "${T}/deploy-r3.out"
check "Convex functions are reported as not rolled back" grep -q "Convex functions of r3 stay deployed" "${T}/deploy-r3.out"
check "current release back to r2" test "$(current)" = r2
check "worker back on r2" test "$(tag "worker-$(active worker)")" = r2
check "web keeps serving r2 without an extra switch" grep -q "web already served by green (r2)" "${T}/deploy-r3.out"
check "releases.log records failure and rollback" bash -c 'grep -q "r3 failed" "$1" && grep -q "r2 rollback-ok" "$1"' _ "${DESYN_ROOT}/state/releases.log"

if FAIL_CONVEX=1 deploy r3b --skip-backup; then fail "a failing convex deploy should stop the deploy"; else pass "a failing convex deploy stops the deploy"; fi
check "services untouched after a failed convex deploy" test "$(current)/$(tag "web-$(active web)")" = r2/r2
check "failed convex deploy explains the state" grep -q "convex deploy failed; the Hetzner services were not changed" "${T}/deploy-r3b.out"

log_lines="$(wc -l <"${STUB_LOG}")"
unshare -r bash "${DESYN_ROOT}/tooling/scripts/rollback.sh" --to r1 --yes >"${T}/rollback.out" 2>&1 || {
  tail -20 "${T}/rollback.out"
  fail "rollback.sh exited non-zero"
}
check "rollback.sh --to r1" test "$(current)/$(tag "worker-$(active worker)")" = r1/r1
check "rollback does not touch Convex" bash -c '! tail -n "+$(($2 + 1))" "$1" | grep -q "convex-cli deploy\|^npx "' _ "${STUB_LOG}" "${log_lines}"

state_sum() { find "${DESYN_ROOT}/state" -type f -exec sha256sum {} + | sort | sha256sum; }
before="$(state_sum)"
calls_before="$(grep -c "convex-cli deploy" "${STUB_LOG}")"
bash "${REPO}/deploy/scripts/deploy.sh" --host sandbox --worktree --release r9 --dry-run >"${T}/dry.out" 2>&1 || fail "dry-run exited non-zero"
check "dry-run leaves state untouched" test "$(state_sum)" = "${before}" -a ! -d "${DESYN_ROOT}/releases/r9"
check "dry-run prints the rollout" grep -q '\[dry-run\] dc up -d --no-deps --force-recreate --wait' "${T}/dry.out"
check "dry-run prints the convex deploy instead of running it" \
  test "$(grep -c "convex-cli deploy" "${STUB_LOG}")" = "${calls_before}" -a -n "$(grep -F '[dry-run]' "${T}/dry.out" | grep 'convex deploy')"

# Functions-only deploy: backup through backup.sh --host, env push, convex deploy; no release upload.
deploy c1 --only convex || {
  tail -30 "${T}/deploy-c1.out"
  fail "deploy --only convex"
}
check "--only convex uploads no release" test ! -d "${DESYN_ROOT}/releases/c1"
check "--only convex takes a pre-deploy backup" test -n "$(find "${DESYN_ROOT}/backups" -maxdepth 1 -name '*-pre-c1')"
check "--only convex deploys the functions" grep -q "convex-cli deploy .*release c1" "${STUB_LOG}"
check "--only convex leaves the services alone" test "$(current)" = r1

# Owner login instead of a deploy key: the target is CONVEX_DEPLOYMENT=prod:opulent-alpaca-530.
mkdir -p "${T}/home/.convex"
echo '{"accessToken":"x"}' >"${T}/home/.convex/config.json"
HOME="${T}/home" CONVEX_DEPLOY_KEY="" deploy c2 --only convex --skip-backup --skip-env || fail "login-mode deploy"
check "login mode targets prod by deployment name" grep -q "convex-cli deploy .*release c2 target=CONVEX_DEPLOYMENT=prod:opulent-alpaca-530" "${STUB_LOG}"
if HOME="${T}/nologin" CONVEX_DEPLOY_KEY="" deploy c3 --only convex --skip-backup --skip-env; then
  fail "no login and no key must stop the deploy"
else
  pass "no login and no key stops the deploy"
fi
if CONVEX_DEPLOY_KEY="dev:unique-hedgehog-677|nope" deploy c4 --only convex --skip-backup --skip-env; then
  fail "a dev deploy key must be refused"
else
  pass "a dev deploy key is refused"
fi

for r in r4 r5 r6 r7 r8; do deploy "${r}" --skip-backup --skip-convex || fail "deploy ${r}"; done
kept="$(find "${DESYN_ROOT}/releases" -mindepth 1 -maxdepth 1 -type d | wc -l)"
check "old releases pruned (${kept} kept)" test "${kept}" -le 6
check "images of pruned releases removed" test ! -f "${STUB_STATE}/image_desyn_web_r2"

# Web-only releases: the worker keeps running r8 (both colours' images stay referenced) and must survive pruning.
for r in s1 s2 s3 s4 s5 s6; do deploy "${r}" --skip-backup --skip-convex --only web || fail "deploy ${r} --only web"; done
check "--only web builds no worker image" test ! -f "${STUB_STATE}/image_desyn_worker_s6"
check "worker still runs r8" test "$(tag "worker-$(active worker)")" = r8
check "referenced r8 worker image survives pruning" test -f "${STUB_STATE}/image_desyn_worker_r8"
check "referenced r8 release directory survives pruning" test -d "${DESYN_ROOT}/releases/r8"
check "unreferenced older releases are pruned" test ! -d "${DESYN_ROOT}/releases/r5" -a ! -f "${STUB_STATE}/image_desyn_web_r5"
check "the Convex CLI image survives pruning" test -f "${STUB_STATE}/image_desyn_convex-cli_1.47.0"
deploy w1 --skip-convex --only web || fail "deploy w1 --only web"
check "a services-only deploy takes no pre-deploy backup" test -z "$(find "${DESYN_ROOT}/backups" -maxdepth 1 -name '*-pre-w1')"
deploy s7 --skip-backup --skip-convex --only worker --force-switch || fail "deploy --force-switch"
check "--force-switch starts a fresh worker colour" test "$(tag "worker-$(active worker)")" = s7

check "no secret value in any output" no_secret_in "${T}"/deploy-*.out "${T}/rollback.out" "${T}/dry.out"

finish
