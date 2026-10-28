#!/usr/bin/env bash
# Build and roll out a Desyn release: Convex Cloud functions plus the Hetzner services, with automatic rollback.
#
# Workstation mode (default):
#   deploy/scripts/deploy.sh --host hetzner [--ref HEAD | --worktree] [--build server|local|registry]
#                            [--registry ghcr.io/<owner> --tag v1.2.3] [--only convex,worker,landing,web,docs]
#                            [--skip-backup] [--skip-env] [--skip-convex] [--convex-flag FLAG]... [--force-switch]
#                            [--keep 5] [--dry-run]
#     --ref REF       ship `git archive REF` (default HEAD; committed files only). The Convex functions are pushed
#                     from this checkout, so convex/, packages/, config/ and the manifests must match REF.
#     --worktree      ship the working tree (tracked + untracked, minus .gitignore'd files and any .env*)
#     --build server  build the images on the server from the shipped source (default; CPU/memory capped buildx
#                     builder "desyn-builder")
#     --build local   build here with docker, then `docker save | ssh docker load`
#     --build registry  pull <registry>/desyn-<service>:<tag> (pushed by .github/workflows/release.yml)
#     --skip-env      do not push the Convex function env (convex-cloud-env.py) or the server env files
#                     (server-env.py); both read .env.keys on this machine and never print values
#     --skip-convex   do not run `convex deploy` (e.g. CI already deployed the functions of this tag)
#     --convex-flag   extra flag for `convex deploy`, e.g. --convex-flag --skip-large-indexes-check
#     --force-switch  start a fresh colour even when a service already runs this release (applies new env files)
#
# Steps (workstation mode):
#   1. package the source and upload it to /opt/desyn/releases/<id>/src            (only when a server service is selected)
#   2. server: build or pull the images; pre-deploy backup (Convex Cloud export -> s3://desyn-prod-backups)
#   3. here:   python3 deploy/scripts/convex-cloud-env.py prod      (Convex function env; generates missing secrets)
#              python3 deploy/scripts/server-env.py prod --host H     (root-only /opt/desyn/secrets/*.env)
#   4. here:   convex deploy to Convex Cloud prod (opulent-alpaca-530) with the owner's CLI login
#              (CONVEX_DEPLOYMENT=prod:opulent-alpaca-530), or with CONVEX_DEPLOY_KEY when it is set (CI)
#   5. server: worker, landing, web, docs blue/green with health checks, then healthcheck.sh; any failure rolls the
#              services back to the previous release. Convex functions are not rolled back (they must stay
#              compatible with the previous release; see RUNBOOK "Convex functions").
#
# Server mode (what workstation mode runs; also usable directly on the server):
#   deploy.sh --on-server --release <id> [--phase build|rollout|all] [--no-build] [--only ...] [--skip-backup]
#             [--rollback] [--force-switch]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

ON_SERVER=0
PHASE="all"
RELEASE=""
SRC_DIR=""
REF="HEAD"
SOURCE_MODE="git"
BUILD_MODE="server"
REGISTRY=""
REGISTRY_TAG=""
ONLY=""
SKIP_BACKUP=0
SKIP_ENV=0
SKIP_CONVEX=0
CONVEX_FLAGS=()
FORCE_SWITCH=0
NO_BUILD=0
ROLLBACK_MODE=0
PKG=""
while (($#)); do
  case "$1" in
    --on-server) ON_SERVER=1 && shift ;;
    --phase)
      PHASE="$2"
      shift 2
      ;;
    --release)
      RELEASE="$2"
      shift 2
      ;;
    --src-dir)
      SRC_DIR="$2"
      shift 2
      ;;
    --ref)
      REF="$2"
      shift 2
      ;;
    --worktree) SOURCE_MODE="worktree" && shift ;;
    --build)
      BUILD_MODE="$2"
      shift 2
      ;;
    --registry)
      REGISTRY="${2%/}"
      shift 2
      ;;
    --tag)
      REGISTRY_TAG="$2"
      shift 2
      ;;
    --only)
      ONLY="$2"
      shift 2
      ;;
    --skip-backup) SKIP_BACKUP=1 && shift ;;
    --skip-env) SKIP_ENV=1 && shift ;;
    --skip-convex) SKIP_CONVEX=1 && shift ;;
    --convex-flag)
      [[ "$2" == --* ]] || die "--convex-flag takes a flag such as --skip-large-indexes-check"
      CONVEX_FLAGS+=("$2")
      shift 2
      ;;
    --force-switch) FORCE_SWITCH=1 && shift ;;
    --no-build) NO_BUILD=1 && shift ;;
    --rollback) ROLLBACK_MODE=1 && shift ;;
    --keep)
      DESYN_KEEP_RELEASES="$2"
      shift 2
      ;;
    *)
      common_arg "$@" || usage_error "$1"
      shift "${COMMON_SHIFT}"
      ;;
  esac
done

# Images built per release (desyn/<service>:<release>), in rollout order.
SERVICES=(worker landing web docs)
selected() { [[ -z "${ONLY}" || ",${ONLY}," == *",$1,"* ]]; }
server_selected() {
  local s
  for s in "${SERVICES[@]}"; do selected "${s}" && return 0; done
  return 1
}
for item in ${ONLY//,/ }; do
  case "${item}" in convex | worker | landing | web | docs) ;; *) die "--only: unknown service ${item} (convex, worker, landing, web, docs)" ;; esac
done
case "${BUILD_MODE}" in server | local | registry) ;; *) die "--build must be server, local or registry" ;; esac
case "${PHASE}" in build | rollout | all) ;; *) die "--phase must be build, rollout or all" ;; esac
if [[ "${BUILD_MODE}" == "registry" ]]; then
  [[ -n "${REGISTRY}" && -n "${REGISTRY_TAG}" ]] || die "--build registry needs --registry and --tag"
fi
if [[ -n "${RELEASE}" && ! "${RELEASE}" =~ ^[a-z0-9][a-z0-9._-]{1,100}$ ]]; then
  die "invalid release id: ${RELEASE}"
fi
[[ "${DESYN_KEEP_RELEASES}" =~ ^[1-9][0-9]*$ ]] || die "--keep must be a positive number"

# service_source_present SRC SERVICE: the release contains the code for SERVICE.
service_source_present() {
  local src=$1 svc=$2
  case "${svc}" in
    worker) [[ -f "${src}/crates/desyn-worker/Cargo.toml" ]] ;;
    landing | web | docs) [[ -f "${src}/apps/${svc}/package.json" ]] ;;
    *) return 1 ;;
  esac
}

image_ref() { printf '%s/%s:%s' "desyn" "$1" "$2"; }

# image_ready SERVICE RELEASE: the image exists (or, in --dry-run, would have been built).
image_ready() {
  image_exists "$(image_ref "$1" "$2")" && return 0
  [[ "${DRY_RUN}" == "1" && -n "${SRC:-}" ]] && service_source_present "${SRC}" "$1"
}

# convex_cli_version DIR: the exact `convex` dependency of DIR/package.json (the version convex/ is built with).
convex_cli_version() {
  local v
  v="$(grep -oE '"convex"[[:space:]]*:[[:space:]]*"[^"]+"' "$1/package.json" 2>/dev/null | head -n 1 | sed -E 's/.*"([^"]+)"$/\1/')"
  v="${v#[\^~=]}"
  [[ "${v}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s' "${v}"
}

# build_args SRC: --build-arg flags from deploy/env/public.env, overridden by non-empty values in the optional
# /opt/desyn/secrets/build.env (both hold public build-time configuration only).
build_args() {
  local src=$1 file line key value
  declare -A vals=()
  for file in "${src}/deploy/env/public.env" "${DESYN_ROOT}/secrets/build.env"; do
    [[ -r "${file}" ]] || continue
    while IFS= read -r line || [[ -n "${line}" ]]; do
      [[ "${line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      if [[ -n "${value}" || -z "${vals[${key}]+x}" ]]; then vals[${key}]="${value}"; fi
    done <"${file}"
  done
  for key in "${!vals[@]}"; do
    printf -- '--build-arg\0%s=%s\0' "${key}" "${vals[${key}]}"
  done
}

# build_images SRC RELEASE [BUILDER]: build every selected service present in SRC as desyn/<service>:<release>.
build_images() {
  local src=$1 release=$2 builder=${3:-} svc dockerfile
  local common=(--load --build-arg "DESYN_RELEASE=${release}")
  if [[ -n "${builder}" ]]; then common+=(--builder "${builder}"); fi
  local next_args=()
  while IFS= read -r -d '' a; do next_args+=("${a}"); done < <(build_args "${src}")
  for svc in "${SERVICES[@]}"; do
    selected "${svc}" || continue
    if ! service_source_present "${src}" "${svc}"; then
      warn "skipping ${svc}: not present in this release"
      continue
    fi
    local extra=()
    case "${svc}" in
      worker) dockerfile="${src}/deploy/docker/worker.Dockerfile" ;;
      *)
        dockerfile="${src}/deploy/docker/next.Dockerfile"
        extra=(--build-arg "APP=${svc}" "${next_args[@]}")
        ;;
    esac
    info "building $(image_ref "${svc}" "${release}")"
    run docker buildx build "${common[@]}" "${extra[@]}" -f "${dockerfile}" \
      -t "$(image_ref "${svc}" "${release}")" "${src}" ||
      die "build of ${svc} failed; nothing was deployed"
  done
}

# ensure_convex_cli SRC [BUILDER]: desyn/convex-cli:<version> for backup/restore (built once per CLI version).
ensure_convex_cli() {
  local src=$1 builder=${2:-} version image args=()
  if ! version="$(convex_cli_version "${src}")"; then
    warn "no exact convex version in ${src}/package.json: keeping the existing Convex CLI image for backups"
    return 0
  fi
  image="$(image_ref convex-cli "${version}")"
  if ! image_exists "${image}"; then
    info "building ${image} (Convex CLI for export/import)"
    if [[ -n "${builder}" ]]; then args=(--builder "${builder}"); fi
    run docker buildx build --load "${args[@]}" --build-arg "CONVEX_VERSION=${version}" \
      -f "${src}/deploy/docker/convex-cli.Dockerfile" -t "${image}" "${src}/deploy/docker" ||
      die "build of ${image} failed; nothing was deployed"
  fi
  set_image_var "${DESYN_ROOT}/state/images.env" DESYN_TAG_CONVEX_CLI "${version}"
}

# pull_images RELEASE: fetch <registry>/desyn-<service>:<tag> and tag it desyn/<service>:<release>.
pull_images() {
  local release=$1 svc remote
  for svc in "${SERVICES[@]}"; do
    selected "${svc}" || continue
    remote="${REGISTRY}/desyn-${svc}:${REGISTRY_TAG}"
    if run docker pull "${remote}"; then
      run docker tag "${remote}" "$(image_ref "${svc}" "${release}")"
    else
      warn "could not pull ${remote}; ${svc} is skipped"
    fi
  done
}

# =========================================================================================== workstation
REPO_DIR="$(cd "${DESYN_DEPLOY_DIR}/.." && pwd)"
# Everything `convex deploy` bundles: the functions, the workspace packages they import, config/plans.json and
# the manifests that pin their dependencies.
CONVEX_INPUTS=(convex packages config package.json pnpm-lock.yaml pnpm-workspace.yaml)

package_source() {
  local repo=$1 out=$2
  if [[ "${SOURCE_MODE}" == "git" ]]; then
    git -C "${repo}" rev-parse --verify "${REF}^{commit}" >/dev/null 2>&1 ||
      die "${REF} is not a commit in ${repo} (use --worktree to ship uncommitted files)"
    git -C "${repo}" archive --format=tar "${REF}" | gzip -6 >"${out}"
  else
    local list
    list="$(mktemp)"
    if git -C "${repo}" rev-parse --git-dir >/dev/null 2>&1; then
      git -C "${repo}" ls-files -z --cached --others --exclude-standard >"${list}"
    else
      (cd "${repo}" && find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -not -path './target/*' \
        -not -path '*/.next/*' -not -path '*/.turbo/*' -not -path '*/dist/*' -printf '%P\0') >"${list}"
    fi
    local filtered
    filtered="$(mktemp)"
    while IFS= read -r -d '' f; do
      [[ -f "${repo}/${f}" ]] || continue
      case "$(basename "${f}")" in
        .env.example) ;;
        .env | .env.* | convex.env | *.pem | *.key | *.p12 | *.p8 | *.mobileprovision | *.htpasswd) continue ;;
      esac
      printf '%s\0' "${f}"
    done <"${list}" >"${filtered}"
    tar -C "${repo}" --null -T "${filtered}" -czf "${out}"
    rm -f "${list}" "${filtered}"
  fi
  # Defense in depth: no env file other than .env.example may ever leave the workstation.
  if tar -tzf "${out}" | grep -E '(^|/)\.env(\.[^/]+)?$' | grep -vqE '\.env\.example$'; then
    rm -f "${out}"
    die "the source package contains an .env file; aborting"
  fi
}

# convex_auth_mode: "key" when CONVEX_DEPLOY_KEY is set (CI), otherwise "login" (the owner's `npx convex login`).
convex_auth_mode() {
  if [[ -n "${CONVEX_DEPLOY_KEY:-}" ]]; then echo key; else echo login; fi
}

# check_convex_ready: fail before anything is built when the Convex deploy could not run.
check_convex_ready() {
  require_cmd node
  [[ -x "${REPO_DIR}/node_modules/.bin/convex" ]] ||
    die "node_modules/.bin/convex is missing: run pnpm install --frozen-lockfile in ${REPO_DIR}"
  if [[ "$(convex_auth_mode)" == "key" ]]; then
    [[ "${CONVEX_DEPLOY_KEY}" == "${DESYN_CONVEX_PROD_DEPLOYMENT}|"* ]] ||
      die "CONVEX_DEPLOY_KEY is not a deploy key for ${DESYN_CONVEX_PROD_DEPLOYMENT}"
  else
    [[ -s "${HOME}/.convex/config.json" ]] ||
      die "not logged in to Convex: run 'npx convex login' (or export CONVEX_DEPLOY_KEY for ${DESYN_CONVEX_PROD_DEPLOYMENT})"
  fi
  if [[ "${SOURCE_MODE}" == "git" ]]; then
    # The functions are bundled from this checkout: refuse when they differ from what REF ships to the server.
    if ! git -C "${REPO_DIR}" diff --quiet "${REF}" -- "${CONVEX_INPUTS[@]}" ||
      [[ -n "$(git -C "${REPO_DIR}" ls-files --others --exclude-standard -- "${CONVEX_INPUTS[@]}")" ]]; then
      die "convex/ or its inputs (${CONVEX_INPUTS[*]}) differ from ${REF} in this checkout; commit them, or deploy with --worktree"
    fi
  fi
}

# convex_deploy RELEASE: push the functions to Convex Cloud prod. The target comes from a private env file so
# neither .env nor .env.local (an agent's anonymous local deployment) can redirect it.
convex_deploy() {
  local release=$1 tmpd rc=0
  tmpd="$(mktemp -d)"
  chmod 0700 "${tmpd}"
  if [[ "$(convex_auth_mode)" == "key" ]]; then
    (
      umask 077
      printf 'CONVEX_DEPLOY_KEY=%s\n' "${CONVEX_DEPLOY_KEY}" >"${tmpd}/target.env"
    )
  else
    printf 'CONVEX_DEPLOYMENT=%s\n' "${DESYN_CONVEX_PROD_DEPLOYMENT}" >"${tmpd}/target.env"
  fi
  info "convex deploy -> ${DESYN_CONVEX_PROD_DEPLOYMENT} ($(convex_auth_mode) auth, release ${release})"
  (
    cd "${REPO_DIR}"
    run env -u CONVEX_DEPLOY_KEY -u CONVEX_DEPLOYMENT -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY \
      node_modules/.bin/convex deploy --yes --typecheck enable --env-file "${tmpd}/target.env" \
      --message "desyn release ${release}" "${CONVEX_FLAGS[@]}"
  ) || rc=$?
  rm -rf "${tmpd}"
  return "${rc}"
}

# push_env: Convex function env (when the functions are deployed) and the server env files.
push_env() {
  require_cmd python3
  local dry=()
  [[ "${DRY_RUN}" == "1" ]] && dry=(--dry-run)
  if selected convex; then
    info "Convex Cloud function env (convex-cloud-env.py prod; values are never printed)"
    python3 -I "${SCRIPT_DIR}/convex-cloud-env.py" prod "${dry[@]}" || die "pushing the Convex env failed"
  fi
  info "server env files (server-env.py prod; values are never printed)"
  if [[ "${DRY_RUN}" == "1" ]]; then
    python3 -I "${SCRIPT_DIR}/server-env.py" prod --dry-run || die "server env files cannot be generated"
  else
    python3 -I "${SCRIPT_DIR}/server-env.py" prod --host "${REMOTE_HOST}" || die "syncing the server env files failed"
  fi
}

workstation_main() {
  [[ -n "${REMOTE_HOST}" ]] || die "workstation mode needs --host <ssh-host> (or use --on-server on the server)"
  require_cmd ssh tar gzip
  [[ "${SOURCE_MODE}" == "git" ]] && require_cmd git
  local sha release sudo dest do_convex=0 do_server=0
  if selected convex && [[ "${SKIP_CONVEX}" != "1" ]]; then do_convex=1; fi
  if server_selected; then do_server=1; fi
  ((do_convex || do_server)) || die "nothing to deploy (--only convex together with --skip-convex)"

  if [[ "${SOURCE_MODE}" == "git" ]]; then
    sha="$(git -C "${REPO_DIR}" rev-parse --short=7 "${REF}^{commit}" 2>/dev/null || true)"
    [[ -n "${sha}" ]] || die "cannot resolve ${REF}; commit first or pass --worktree"
  else
    sha="wt$(date -u +%H%M%S)"
  fi
  release="${RELEASE:-r$(date -u +%Y%m%d%H%M%S)-${sha}}"
  if ((do_convex)); then check_convex_ready; fi
  if [[ "${SKIP_ENV}" != "1" ]]; then
    [[ -f "${REPO_DIR}/.env.keys" ]] || die "${REPO_DIR}/.env.keys is missing (needed for the env push; or pass --skip-env)"
  fi

  sudo="$(ssh "${DESYN_SSH_OPTS[@]}" "${REMOTE_HOST}" 'if [ "$(id -u)" -eq 0 ]; then echo; else echo "sudo -n"; fi')" ||
    die "cannot reach ${REMOTE_HOST}"
  local flags=(--on-server --release "${release}")
  [[ -n "${ONLY}" ]] && flags+=(--only "${ONLY}")
  [[ "${SKIP_BACKUP}" == "1" ]] && flags+=(--skip-backup)
  [[ "${DRY_RUN}" == "1" ]] && flags+=(--dry-run)
  [[ "${FORCE_SWITCH}" == "1" ]] && flags+=(--force-switch)
  flags+=(--keep "${DESYN_KEEP_RELEASES}")

  if ((do_server)); then
    PKG="$(mktemp --suffix=.tar.gz)"
    trap 'rm -f "${PKG}"' EXIT
    info "packaging ${SOURCE_MODE} source (${REF}) as release ${release}"
    package_source "${REPO_DIR}" "${PKG}"
    info "package size $(du -h "${PKG}" | cut -f1)"
    if [[ "${DRY_RUN}" == "1" ]]; then
      dest="$(ssh "${DESYN_SSH_OPTS[@]}" "${REMOTE_HOST}" 'mktemp -d /tmp/desyn-dryrun.XXXXXX')"
      flags+=(--src-dir "${dest}")
    else
      dest="${DESYN_ROOT}/releases/${release}/src"
    fi
    info "uploading to ${REMOTE_HOST}:${dest}"
    # shellcheck disable=SC2029 # expanded locally on purpose
    ssh "${DESYN_SSH_OPTS[@]}" "${REMOTE_HOST}" "${sudo} mkdir -p '${dest}' && ${sudo} tar --no-same-owner -xzf - -C '${dest}'" <"${PKG}"

    local build_flags=()
    case "${BUILD_MODE}" in
      local)
        require_cmd docker
        local images=() svc
        build_images "${REPO_DIR}" "${release}"
        for svc in "${SERVICES[@]}"; do
          if image_exists "$(image_ref "${svc}" "${release}")"; then images+=("$(image_ref "${svc}" "${release}")"); fi
        done
        ((${#images[@]})) || die "no images were built"
        info "transferring ${#images[@]} images (docker save | ssh docker load)"
        if [[ "${DRY_RUN}" == "1" ]]; then
          info "[dry-run] would transfer: ${images[*]}"
        else
          # shellcheck disable=SC2029
          docker save "${images[@]}" | gzip -1 | ssh "${DESYN_SSH_OPTS[@]}" "${REMOTE_HOST}" "gunzip -c | ${sudo} docker load"
        fi
        build_flags=(--no-build)
        ;;
      registry) build_flags=(--build registry --registry "${REGISTRY}" --tag "${REGISTRY_TAG}") ;;
      server) ;;
    esac
    remote_deploy "${sudo}" "${dest}" "${flags[@]}" --phase build "${build_flags[@]}" ||
      die "build phase failed on ${REMOTE_HOST}; nothing was changed"
  elif selected convex && [[ "${SKIP_BACKUP}" != "1" ]]; then
    info "pre-deploy backup of the Convex data (functions-only deploy)"
    local bflags=(--host "${REMOTE_HOST}" --label "pre-${release}")
    [[ "${DRY_RUN}" == "1" ]] && bflags+=(--dry-run)
    bash "${SCRIPT_DIR}/backup.sh" "${bflags[@]}" || die "pre-deploy backup failed; nothing was deployed (use --skip-backup to override)"
  fi

  [[ "${SKIP_ENV}" == "1" ]] || push_env
  if ((do_convex)); then
    convex_deploy "${release}" || die "convex deploy failed; the Hetzner services were not changed"
    ok "Convex functions of ${release} are live on ${DESYN_CONVEX_PROD_DEPLOYMENT}"
  fi

  local rc=0
  if ((do_server)); then
    remote_deploy "${sudo}" "${dest}" "${flags[@]}" --phase rollout || rc=$?
    if [[ "${DRY_RUN}" == "1" ]]; then
      # shellcheck disable=SC2029
      ssh "${DESYN_SSH_OPTS[@]}" "${REMOTE_HOST}" "${sudo} rm -rf '${dest}'" || true
    fi
    if ((rc != 0 && do_convex)); then
      warn "the services were rolled back, but the Convex functions of ${release} stay deployed (they must be"
      warn "compatible with the previous release). To revert them: deploy.sh --host ${REMOTE_HOST} --ref <previous sha> --only convex"
    fi
  fi
  return "${rc}"
}

# remote_deploy SUDO SRC FLAGS...: run the server mode of the uploaded release.
remote_deploy() {
  local sudo=$1 dest=$2 quoted
  shift 2
  quoted="$(printf '%q ' "$@")"
  # shellcheck disable=SC2029
  ssh "${DESYN_SSH_OPTS[@]}" "${REMOTE_HOST}" "${sudo} bash '${dest}/deploy/scripts/deploy.sh' ${quoted}"
}

# ================================================================================================ server
refresh_tooling() {
  local from=$1
  [[ "$(cd "${from}" && pwd -P)" == "$(cd "${DESYN_ROOT}/tooling" 2>/dev/null && pwd -P)" ]] && return 0
  run rm -rf "${DESYN_ROOT}/tooling.new"
  run cp -a "${from}" "${DESYN_ROOT}/tooling.new"
  run rm -rf "${DESYN_ROOT}/tooling.prev"
  if [[ -d "${DESYN_ROOT}/tooling" ]]; then run mv "${DESYN_ROOT}/tooling" "${DESYN_ROOT}/tooling.prev"; fi
  run mv "${DESYN_ROOT}/tooling.new" "${DESYN_ROOT}/tooling"
  info "tooling refreshed from ${from}"
}

switch_color() {
  local app=$1 release=$2 cur new svc port tries path max=500
  cur="$(active_color "${app}")"
  if [[ "${cur}" != "none" && "${FORCE_SWITCH}" != "1" ]]; then
    local cur_tag
    cur_tag="$(env_value "${DESYN_ROOT}/state/images.env" "DESYN_TAG_$(upper "${app}")_$(upper "${cur}")" 2>/dev/null || true)"
    if [[ "${cur_tag}" == "${release}" && -n "$(dc ps -q "${app}-${cur}" 2>/dev/null)" ]]; then
      ok "${app} already served by ${cur} (${release})"
      return 0
    fi
  fi
  if [[ "${cur}" == "none" ]]; then new=blue; else new="$(other_color "${cur}")"; fi
  svc="${app}-${new}"
  port="${DESYN_APP_PORT[${app}:${new}]}"
  path="${DESYN_HEALTH_PATH[${app}]}"
  # The worker's /healthz must answer 2xx; the Next apps only must not fail (redirects to /login are fine).
  [[ "${app}" == "worker" ]] && max=300
  [[ -f "${DESYN_ROOT}/secrets/${app}.env" ]] ||
    warn "${DESYN_ROOT}/secrets/${app}.env is missing (run server-env.py prod --host <ssh-host>)"
  info "${app}: ${cur} -> ${new} (port ${port})"
  set_image_var "${DESYN_ROOT}/state/images.env" "DESYN_TAG_$(upper "${app}")_$(upper "${new}")" "${release}"
  if ! run dc up -d --no-deps --force-recreate --wait --wait-timeout 180 "${svc}"; then
    error "${svc} did not become healthy"
    run dc logs --tail 80 "${svc}" || true
    run dc rm -sf "${svc}" || true
    return 1
  fi
  if [[ "${DRY_RUN}" != "1" ]]; then
    tries=0
    until http_probe "http://127.0.0.1:${port}${path}" "${max}"; do
      tries=$((tries + 1))
      if ((tries >= 10)); then
        error "${svc} does not answer ${path} below HTTP ${max} on 127.0.0.1:${port}"
        dc rm -sf "${svc}" || true
        return 1
      fi
      sleep 3
    done
    mkdir -p "${DESYN_ROOT}/state/active"
    printf '%s\n' "${new}" >"$(state_file "active/${app}")"
  fi
  if [[ "${cur}" != "none" ]]; then
    run dc stop -t 30 "${app}-${cur}" || true
    run dc rm -f "${app}-${cur}" || true
  fi
  ok "${app} now served by ${new} (${release})"
}

# apply_release RELEASE: converge every selected service to RELEASE. Returns non-zero on failure.
apply_release() {
  local release=$1 app
  info "applying release ${release}$([[ "${ROLLBACK_MODE}" == "1" ]] && echo " (rollback)")"
  for app in "${DESYN_APPS[@]}"; do
    if selected "${app}" && image_ready "${app}" "${release}"; then
      switch_color "${app}" "${release}" || return 1
    fi
  done
  run bash "${DESYN_ROOT}/tooling/scripts/healthcheck.sh" --quiet || {
    error "post-deploy health check failed"
    return 1
  }
}

# prune_releases KEEP CURRENT PREVIOUS: delete the oldest release directories and their images beyond KEEP.
# Never touches the current or previous release, nor any release whose image is still referenced in
# images.env (running services or the idle colour a switch can fall back to): after deploys with --only, the
# worker image may come from a much older release. Convex CLI images other than the referenced version go too.
prune_releases() {
  local keep=$1 current=$2 previous=$3 dirs=() d svc
  local referenced
  referenced=" $(grep -E '^DESYN_TAG_[A-Z_]+=' "${DESYN_ROOT}/state/images.env" 2>/dev/null | cut -d= -f2- | tr '\n' ' ')"
  mapfile -t dirs < <(find "${DESYN_ROOT}/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
  local excess=$((${#dirs[@]} - keep))
  if ((excess > 0)); then
    for d in "${dirs[@]:0:excess}"; do
      [[ "${d}" == "${current}" || "${d}" == "${previous}" ]] && continue
      if [[ "${referenced}" == *" ${d} "* ]]; then
        info "keeping release ${d}: still referenced in images.env"
        continue
      fi
      info "pruning release ${d}"
      run rm -rf "${DESYN_ROOT:?}/releases/${d}"
      for svc in "${SERVICES[@]}" convex-tools; do
        if image_exists "$(image_ref "${svc}" "${d}")"; then run docker image rm "$(image_ref "${svc}" "${d}")" >/dev/null || true; fi
      done
    done
  fi
  local cli tag
  cli="$(env_value "${DESYN_ROOT}/state/images.env" DESYN_TAG_CONVEX_CLI 2>/dev/null || true)"
  if [[ -n "${cli}" ]]; then
    while IFS= read -r tag; do
      [[ -n "${tag}" && "${tag}" != "${cli}" ]] || continue
      info "removing unused desyn/convex-cli:${tag}"
      run docker image rm "desyn/convex-cli:${tag}" >/dev/null || true
    done < <(docker images --format '{{.Tag}}' desyn/convex-cli 2>/dev/null || true)
  fi
}

# prune_build_cache: trims the desyn-builder cache to DESYN_BUILD_CACHE_KEEP (only Desyn's own builder; the
# host's default builder belongs to other workloads). Best effort: a failed prune never fails a deploy.
prune_build_cache() {
  docker buildx inspect "${DESYN_BUILDER}" >/dev/null 2>&1 || return 0
  info "trimming the ${DESYN_BUILDER} build cache to ${DESYN_BUILD_CACHE_KEEP}"
  run docker buildx prune --builder "${DESYN_BUILDER}" --keep-storage "${DESYN_BUILD_CACHE_KEEP}" --force >/dev/null ||
    warn "build cache prune failed (continuing)"
}

record() {
  [[ "${DRY_RUN}" == "1" ]] && return 0
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >>"${DESYN_ROOT}/state/releases.log"
}

rollback_to() {
  local prev=$1
  warn "rolling back to ${prev}"
  if [[ -d "${DESYN_ROOT}/releases/${prev}/src/deploy" ]]; then
    refresh_tooling "${DESYN_ROOT}/releases/${prev}/src/deploy"
  fi
  local saved_only="${ONLY}" saved_force="${FORCE_SWITCH}"
  ONLY=""
  FORCE_SWITCH=0
  ROLLBACK_MODE=1
  if apply_release "${prev}"; then
    [[ "${DRY_RUN}" == "1" ]] || printf '%s\n' "${prev}" >"${DESYN_ROOT}/state/current-release"
    record "${prev}" "rollback-ok"
    ok "rolled back to ${prev}"
  else
    record "${prev}" "rollback-failed"
    error "ROLLBACK FAILED: follow deploy/RUNBOOK.md 'Incident playbook'"
  fi
  ONLY="${saved_only}"
  FORCE_SWITCH="${saved_force}"
}

# enable_logship: start Vector -> Axiom once server-env.py has written axiom.env (bootstrap installs the unit).
enable_logship() {
  [[ -f "${DESYN_ROOT}/secrets/axiom.env" && -f "${DESYN_SYSTEMD_DIR}/desyn-logship.service" ]] || return 0
  systemctl is-enabled --quiet desyn-logship.service 2>/dev/null && return 0
  run systemctl enable --now desyn-logship.service || warn "could not enable desyn-logship.service"
}

backup_configured() {
  env_has_value "${DESYN_ROOT}/secrets/convex-backup.env" CONVEX_DEPLOY_KEY &&
    env_has_value "${DESYN_ROOT}/secrets/backup.env" BACKUP_S3_BUCKET
}

phase_build() {
  local prev=$1 builder=""
  if docker buildx inspect "${DESYN_BUILDER}" >/dev/null 2>&1; then
    builder="${DESYN_BUILDER}"
  else
    warn "buildx builder ${DESYN_BUILDER} missing (bootstrap.sh creates it); using the default builder"
  fi
  if [[ "${NO_BUILD}" != "1" ]]; then
    if [[ "${BUILD_MODE}" == "registry" ]]; then
      pull_images "${RELEASE}"
    else
      build_images "${SRC}" "${RELEASE}" "${builder}"
    fi
  fi
  ensure_convex_cli "${SRC}" "${builder}"

  # The backup protects the data before the functions (and with them the schema) change; deploys of only the
  # stateless services skip it.
  if [[ "${SKIP_BACKUP}" != "1" && "${ROLLBACK_MODE}" != "1" ]] && selected convex; then
    if [[ -z "${prev}" ]]; then
      info "first deploy: nothing to back up yet"
    elif backup_configured; then
      run bash "${SRC}/deploy/scripts/backup.sh" --label "pre-${RELEASE}" ||
        die "pre-deploy backup failed; nothing was deployed (use --skip-backup to override)"
    else
      warn "backups are not configured (${DESYN_ROOT}/secrets/{backup,convex-backup}.env); deploying without a pre-deploy backup"
    fi
  fi
  ok "release ${RELEASE} built"
}

phase_rollout() {
  local prev=$1 rc=0
  if [[ "${DRY_RUN}" != "1" ]]; then
    refresh_tooling "${SRC}/deploy"
    cp "${DESYN_ROOT}/state/images.env" "${DESYN_ROOT}/state/history/${RELEASE}.images.before"
  fi
  apply_release "${RELEASE}" || rc=$?
  if ((rc == 0)); then
    if [[ "${DRY_RUN}" != "1" ]]; then
      printf '%s\n' "${RELEASE}" >"${DESYN_ROOT}/state/current-release"
      cp "${DESYN_ROOT}/state/images.env" "${DESYN_ROOT}/state/history/${RELEASE}.images.after"
      [[ "${SRC}" == "${DESYN_ROOT}/releases/${RELEASE}/src" ]] && ln -sfn "releases/${RELEASE}" "${DESYN_ROOT}/current"
    fi
    record "${RELEASE}" "$([[ "${ROLLBACK_MODE}" == "1" ]] && echo rollback-ok || echo ok)"
    prune_releases "${DESYN_KEEP_RELEASES}" "${RELEASE}" "${prev}"
    prune_build_cache
    enable_logship
    ok "release ${RELEASE} is live"
    return 0
  fi

  record "${RELEASE}" "failed"
  if [[ "${ROLLBACK_MODE}" == "1" ]]; then
    die "rollback to ${RELEASE} failed"
  fi
  if [[ -n "${prev}" && "${prev}" != "${RELEASE}" ]]; then
    rollback_to "${prev}"
    die "release ${RELEASE} failed and was rolled back to ${prev}"
  fi
  die "release ${RELEASE} failed and there is no previous release to roll back to"
}

server_main() {
  require_root
  require_bootstrapped
  require_cmd docker curl flock
  [[ -n "${RELEASE}" ]] || die "--release is required in server mode"
  SRC="${SRC_DIR:-${DESYN_ROOT}/releases/${RELEASE}/src}"
  [[ -d "${SRC}/deploy" ]] || die "release source not found: ${SRC}"

  exec 9>"${DESYN_ROOT}/state/deploy.lock"
  flock -n 9 || die "another deploy or rollback is running"
  if [[ "${DRY_RUN}" != "1" ]]; then
    exec > >(tee -a "${DESYN_ROOT}/state/history/${RELEASE}.log") 2>&1
  fi
  info "release ${RELEASE} phase ${PHASE} (source ${SRC}, rollback=${ROLLBACK_MODE}, only=${ONLY:-all})"

  local prev=""
  [[ -f "${DESYN_ROOT}/state/current-release" ]] && prev="$(cat "${DESYN_ROOT}/state/current-release")"
  case "${PHASE}" in
    build) phase_build "${prev}" ;;
    rollout) phase_rollout "${prev}" ;;
    all)
      # A rollback reuses images that are already on the host: nothing to build or back up.
      [[ "${ROLLBACK_MODE}" == "1" ]] || phase_build "${prev}"
      phase_rollout "${prev}"
      ;;
  esac
}

if [[ "${ON_SERVER}" == "1" ]]; then
  server_main
else
  workstation_main
fi
