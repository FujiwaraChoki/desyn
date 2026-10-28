# syntax=docker/dockerfile:1.19
#
# Convex CLI tool image: the repository's convex/ functions plus the dependencies they import, so
# `convex deploy | env set | export | import` run on the server against the self-hosted backend without
# Node on the host. It is a one-shot tool (docker run --rm), never a long-running service.
#
#   docker buildx build -f deploy/docker/convex.Dockerfile -t desyn/convex:dev .
#   docker run --rm --network desyn_net \
#     -e CONVEX_SELF_HOSTED_URL=http://convex-backend:3210 --env-file /opt/desyn/secrets/convex-admin.env \
#     desyn/convex:dev deploy --yes
#
# convex/ resolves packages from the repository root, so the install is the root project ("desyn") and its
# workspace dependencies only (pnpm --filter "desyn..."), not every app of the monorepo. Dependencies are
# installed from the manifests alone, so that layer stays cached until a package.json or the lockfile changes.

ARG NODE_IMAGE=node:26.12.0-trixie-slim

# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN <<'EOF'
set -eu
test -d convex || { echo "convex/ directory is missing" >&2; exit 1; }
mkdir -p /out
cp package.json pnpm-lock.yaml pnpm-workspace.yaml /out/
if [ -f .npmrc ]; then cp .npmrc /out/; fi
find . -name package.json -not -path './package.json' -not -path '*/node_modules/*' -exec cp --parents {} /out/ \;
EOF

# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS tool
ARG PNPM_VERSION=12.11.2
ARG DESYN_RELEASE=dev
ARG SOURCE_URL=""
LABEL org.opencontainers.image.title="desyn-convex" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${DESYN_RELEASE}" \
      org.opencontainers.image.licenses="LicenseRef-Desyn-NonCommercial"
# verify-deps-before-run off: node_modules holds the filtered graph on purpose, the full lockfile describes
# every project, and the runtime user cannot (and must not) reinstall anything.
ENV CI=1 \
    DO_NOT_TRACK=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    pnpm_config_verify_deps_before_run=false \
    DESYN_RELEASE=${DESYN_RELEASE}
RUN npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}" && pnpm --version
WORKDIR /repo
COPY --from=manifests /out/ ./
RUN --mount=type=cache,id=desyn-pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --frozen-lockfile --filter "desyn..." --store-dir /pnpm-store --config.package-import-method=copy
COPY . .
RUN node_modules/.bin/convex --version
# `convex deploy` regenerates convex/_generated and the CLI keeps state under $HOME; both must be writable.
RUN chown node:node /repo && chown -R node:node /repo/convex && mkdir -p /home/node/.cache && chown -R node:node /home/node
USER node
ENTRYPOINT ["/repo/node_modules/.bin/convex"]
CMD ["--help"]
