#!/usr/bin/env bash
# Create a Convex deploy key for the prod deployment (deploy/env/public.env) and store it as the GitHub Actions
# secret CONVEX_DEPLOY_KEY of the "production" environment, without printing it. The key is saved by the Convex
# CLI into a 0600 file in a private temp dir, piped into `gh secret set`, and the temp dir is removed.
# Needs the owner's `npx convex login` and `gh auth login` (scope repo). Re-run to rotate; delete old keys in the
# Convex dashboard (Production -> Settings -> Deploy keys).
#
# Usage: deploy/scripts/github-deploy-key.sh [--repo owner/name] [--env production] [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  script_usage "${BASH_SOURCE[0]}"
}

REPO=""
GH_ENV="production"
while (($#)); do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --env)
      GH_ENV="$2"
      shift 2
      ;;
    *)
      common_arg "$@" || usage_error "$1"
      shift "${COMMON_SHIFT}"
      ;;
  esac
done
[[ -z "${REPO}" || "${REPO}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo must look like owner/name"
[[ "${GH_ENV}" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid --env"
require_cmd gh npx
version="$(grep -oE '"convex"[[:space:]]*:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' "${DESYN_DEPLOY_DIR}/../package.json" | head -n 1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')" ||
  die "cannot read the exact convex version from package.json"
name="github-actions-$(date -u +%Y%m%d%H%M)"
repo_args=()
[[ -n "${REPO}" ]] && repo_args=(--repo "${REPO}")

if [[ "${DRY_RUN}" == "1" ]]; then
  info "[dry-run] would create Convex deploy key '${name}' for ${DESYN_CONVEX_PROD_DEPLOYMENT} (convex@${version})"
  info "[dry-run] and store it with: gh secret set CONVEX_DEPLOY_KEY --env ${GH_ENV} ${repo_args[*]}"
  exit 0
fi

tmpd="$(mktemp -d)"
chmod 0700 "${tmpd}"
trap 'rm -rf "${tmpd}"' EXIT
printf '{"name":"desyn-key","private":true,"dependencies":{"convex":"%s"}}\n' "${version}" >"${tmpd}/package.json"
info "creating Convex deploy key '${name}' for ${DESYN_CONVEX_PROD_DEPLOYMENT}"
(
  cd "${tmpd}"
  env -u CONVEX_DEPLOY_KEY -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY \
    CONVEX_DEPLOYMENT="${DESYN_CONVEX_PROD_DEPLOYMENT}" \
    npx -y "convex@${version}" deployment token create "${name}" --save-env "${tmpd}/key.env" </dev/null >/dev/null
) || die "convex deployment token create failed (logged in with npx convex login?)"
key="$(env_value "${tmpd}/key.env" CONVEX_DEPLOY_KEY || true)"
[[ "${key}" == "${DESYN_CONVEX_PROD_DEPLOYMENT}|"* ]] || die "the created key is not a deploy key for ${DESYN_CONVEX_PROD_DEPLOYMENT}"
printf '%s' "${key}" | gh secret set CONVEX_DEPLOY_KEY --env "${GH_ENV}" "${repo_args[@]}" >/dev/null ||
  die "gh secret set failed (does the GitHub environment '${GH_ENV}' exist?)"
unset key
ok "GitHub secret CONVEX_DEPLOY_KEY (environment ${GH_ENV}) holds the new deploy key '${name}'"
