# syntax=docker/dockerfile:1.19
#
# The plain Convex CLI at one exact version, for the server's Convex Cloud data jobs: `convex export` (backup.sh)
# and `convex import` (restore.sh), authenticated by the prod deploy key in /opt/desyn/secrets/convex-backup.env.
# It contains no Desyn code. deploy.sh builds it once per CLI version (the `convex` dependency of the root
# package.json) as desyn/convex-cli:<version>; the build context can be any directory (nothing is copied in).
#
#   docker buildx build -f deploy/docker/convex-cli.Dockerfile --build-arg CONVEX_VERSION=1.47.0 \
#     -t desyn/convex-cli:1.47.0 deploy/docker
#   docker run --rm --read-only --tmpfs /tmp --env-file /opt/desyn/secrets/convex-backup.env \
#     -v /opt/desyn/backups/<id>/export:/out desyn/convex-cli:1.47.0 export --path /out/convex-export.zip

ARG NODE_IMAGE=node:26.12.0-trixie-slim

FROM ${NODE_IMAGE}
ARG CONVEX_VERSION
LABEL org.opencontainers.image.title="desyn-convex-cli" \
      org.opencontainers.image.version="${CONVEX_VERSION}" \
      org.opencontainers.image.description="Convex CLI for export/import against Convex Cloud"
ENV DO_NOT_TRACK=1 \
    NODE_ENV=production \
    HOME=/tmp \
    npm_config_update_notifier=false
WORKDIR /opt/convex
RUN <<'EOF'
set -eu
case "${CONVEX_VERSION:-}" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "CONVEX_VERSION must be an exact version such as 1.47.0 (got '${CONVEX_VERSION:-}')" >&2; exit 1 ;;
esac
printf '{"name":"desyn-convex-cli","private":true}\n' > package.json
npm install --no-fund --no-audit --omit=dev --save-exact "convex@${CONVEX_VERSION}"
node node_modules/convex/bin/main.js --version
EOF
# Runs as the unprivileged node user with a read-only root filesystem (HOME=/tmp is a tmpfs at run time).
USER node
ENTRYPOINT ["node", "/opt/convex/node_modules/convex/bin/main.js"]
CMD ["--help"]
