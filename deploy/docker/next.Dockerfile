# syntax=docker/dockerfile:1.19
#
# One Dockerfile for every Next.js app in the monorepo (apps/web, apps/landing, apps/docs).
# Build from the repository root:
#
#   docker buildx build -f deploy/docker/next.Dockerfile --build-arg APP=web -t desyn/web:dev .
#
# Stages:
#   prune      turbo prune of the selected app -> a minimal package.json/lockfile set (stable cache key)
#   deps       pnpm install of only that app's dependency graph
#   toolchain  Rust 1.98 + wasm32 target + the wasm-bindgen CLI pinned by Cargo.lock + wasm-opt, installed only when
#              the app depends on @desyn/engine (apps/web): the engine's own build compiles crates/desyn-wasm here,
#              so no prebuilt wasm has to be committed or copied in
#   build      full source + `turbo run build`, then the Next standalone output is collected into /out
#   runtime    node slim + standalone server, non-root, healthcheck
#
# Next standalone output: apps should set `output: "standalone"` in next.config. NEXT_PRIVATE_STANDALONE=1
# below makes standalone the default when the config does not set `output` itself.

ARG NODE_IMAGE=node:26.12.0-trixie-slim

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=12.11.2
ARG TURBO_VERSION=2.11.9
ENV NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    CI=1
RUN npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}" "turbo@${TURBO_VERSION}" \
 && pnpm --version && turbo --version

# ---------------------------------------------------------------------------------------------------
FROM base AS prune
ARG APP
WORKDIR /repo
COPY . .
RUN <<'EOF'
set -eu
if [ -z "${APP:-}" ] || [ ! -f "apps/${APP}/package.json" ]; then
  echo "APP build arg must name a directory under apps/ with a package.json (got '${APP:-}')" >&2
  exit 1
fi
pkg="$(node -p "require('./apps/${APP}/package.json').name")"
turbo prune "${pkg}" --docker --out-dir /pruned
printf '%s\n' "${pkg}" > /pruned/pkgname
if [ -f .npmrc ]; then cp .npmrc /pruned/json/.npmrc; fi
# @desyn/engine compiles crates/desyn-wasm (cargo + wasm-bindgen + wasm-opt) as part of its build. The Rust
# toolchain is installed only when this app's pruned dependency graph needs it: it contains packages/engine, or a
# package script calls cargo / wasm-bindgen / wasm-pack. landing and docs stay Rust-free. The exact wasm-bindgen
# version comes from Cargo.lock so the CLI matches the crate (the toolchain layer is cached while it is unchanged).
wb="none"
needs_rust=0
if [ -f /pruned/json/packages/engine/package.json ]; then needs_rust=1; fi
if find /pruned/json -name package.json -not -path '*/node_modules/*' -exec grep -lE '"[^"]+": *"[^"]*(cargo |wasm-bindgen|wasm-pack)' {} + 2>/dev/null | grep -q .; then
  needs_rust=1
fi
if [ "${needs_rust}" = 1 ]; then
  if [ ! -f crates/desyn-wasm/Cargo.toml ] || [ ! -f Cargo.lock ]; then
    echo "${pkg} needs the wasm engine, but crates/desyn-wasm/Cargo.toml or Cargo.lock is missing" >&2
    exit 1
  fi
  wb="$(awk '$0 == "name = \"wasm-bindgen\"" { getline; gsub(/version = |"/, ""); print; exit }' Cargo.lock)"
  if [ -z "${wb}" ]; then
    echo "Cargo.lock has no wasm-bindgen entry; cannot pick a matching wasm-bindgen CLI" >&2
    exit 1
  fi
fi
echo "rust toolchain for ${pkg}: wasm-bindgen ${wb}"
printf '%s\n' "${wb}" > /pruned/wasm-bindgen-version
EOF

# ---------------------------------------------------------------------------------------------------
FROM base AS deps
WORKDIR /repo
COPY --from=prune /pruned/json/ ./
RUN --mount=type=cache,id=desyn-pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --config.package-import-method=copy

# ---------------------------------------------------------------------------------------------------
FROM deps AS toolchain
ARG RUST_VERSION=1.98.1
ARG BINARYEN_VERSION=133
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
COPY --from=prune /pruned/wasm-bindgen-version /tmp/wasm-bindgen-version
RUN <<'EOF'
set -eu
wb="$(cat /tmp/wasm-bindgen-version)"
if [ "${wb}" = "none" ]; then
  echo "this app does not build the wasm engine: skipping the Rust toolchain"
  exit 0
fi
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gcc libc6-dev pkg-config xz-utils
rm -rf /var/lib/apt/lists/*
curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
  | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" --target wasm32-unknown-unknown
arch="$(uname -m)"
curl -fsSL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${wb}/wasm-bindgen-${wb}-${arch}-unknown-linux-musl.tar.gz" \
  | tar -xz -C /tmp
install -m 0755 "/tmp/wasm-bindgen-${wb}-${arch}-unknown-linux-musl/wasm-bindgen" /usr/local/bin/wasm-bindgen
curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-${arch}-linux.tar.gz" \
  | tar -xz -C /tmp
install -m 0755 "/tmp/binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt" /usr/local/bin/wasm-opt
rm -rf /tmp/wasm-bindgen-* /tmp/binaryen-*
rustc --version && wasm-bindgen --version && wasm-opt --version
EOF

# ---------------------------------------------------------------------------------------------------
FROM toolchain AS build
ARG APP
# Public, build-time configuration. These values end up in client bundles; never pass secrets here.
ARG NEXT_PUBLIC_CONVEX_URL
ARG NEXT_PUBLIC_CONVEX_SITE_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_DOCS_URL
ARG NEXT_PUBLIC_DESYN_EDITION
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
ARG NEXT_PUBLIC_POSTHOG_UI_HOST
ARG NEXT_PUBLIC_DATAFAST_WEBSITE_ID
ARG NEXT_PUBLIC_DATAFAST_DOMAIN
ARG SITE_URL
ARG APP_URL
ARG DESYN_EDITION=hosted
# docs only: build under a sub-path (e.g. /docs for desyn.app/docs); empty = served at the domain root.
ARG DOCS_BASE_PATH=""
ARG CARGO_BUILD_JOBS=6
ENV NEXT_PUBLIC_CONVEX_URL=${NEXT_PUBLIC_CONVEX_URL} \
    NEXT_PUBLIC_CONVEX_SITE_URL=${NEXT_PUBLIC_CONVEX_SITE_URL} \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_DOCS_URL=${NEXT_PUBLIC_DOCS_URL} \
    NEXT_PUBLIC_DESYN_EDITION=${NEXT_PUBLIC_DESYN_EDITION} \
    NEXT_PUBLIC_POSTHOG_KEY=${NEXT_PUBLIC_POSTHOG_KEY} \
    NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST} \
    NEXT_PUBLIC_POSTHOG_UI_HOST=${NEXT_PUBLIC_POSTHOG_UI_HOST} \
    NEXT_PUBLIC_DATAFAST_WEBSITE_ID=${NEXT_PUBLIC_DATAFAST_WEBSITE_ID} \
    NEXT_PUBLIC_DATAFAST_DOMAIN=${NEXT_PUBLIC_DATAFAST_DOMAIN} \
    SITE_URL=${SITE_URL} \
    APP_URL=${APP_URL} \
    DESYN_EDITION=${DESYN_EDITION} \
    DOCS_BASE_PATH=${DOCS_BASE_PATH} \
    CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} \
    NEXT_PRIVATE_STANDALONE=1 \
    NODE_ENV=production
COPY --from=prune /pruned/pkgname /tmp/pkgname
# Full source (filtered by next.Dockerfile.dockerignore). Installed node_modules from `deps` are kept
# because node_modules is excluded from the context. Apps read files outside their workspace while building
# (apps/docs prerenders docs/DOCUMENT_MODEL.md and config/plans.json), so turbo's pruned source is not enough.
COPY . .
# The full lockfile and workspace now describe every project while node_modules holds only this app's
# graph (installed --frozen-lockfile in `deps`). pnpm's verify-deps-before-run would see that difference
# and try to reinstall the whole monorepo, uncached, before `next build`; the frozen install above is the
# integrity check, so the second one is switched off for this step.
ENV pnpm_config_verify_deps_before_run=false
RUN --mount=type=cache,id=desyn-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=desyn-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=desyn-wasm-target,target=/repo/target,sharing=locked \
    turbo run build --filter="$(cat /tmp/pkgname)" --env-mode=loose
RUN <<'EOF'
set -eu
app_dir="apps/${APP}"
standalone="${app_dir}/.next/standalone"
mkdir -p /out
if [ -f "${standalone}/${app_dir}/server.js" ]; then
  # Tracing root = monorepo root (Next infers it from pnpm-lock.yaml): standalone mirrors the repo layout.
  cp -a "${standalone}/." /out/
elif [ -f "${standalone}/server.js" ]; then
  # Tracing root = the app directory: place it where the runtime stage expects it.
  mkdir -p "/out/${app_dir}"
  cp -a "${standalone}/." "/out/${app_dir}/"
else
  echo "No standalone server.js for ${app_dir}. Set output: \"standalone\" in ${app_dir}/next.config." >&2
  exit 1
fi
mkdir -p "/out/${app_dir}/.next"
cp -a "${app_dir}/.next/static" "/out/${app_dir}/.next/static"
if [ -d "${app_dir}/public" ]; then cp -a "${app_dir}/public" "/out/${app_dir}/public"; fi
EOF

# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG APP
ARG DESYN_RELEASE=dev
ARG SOURCE_URL=""
LABEL org.opencontainers.image.title="desyn-${APP}" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${DESYN_RELEASE}" \
      org.opencontainers.image.licenses="LicenseRef-Desyn-NonCommercial"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DESYN_HEALTH_PATH=/ \
    DESYN_RELEASE=${DESYN_RELEASE}
COPY <<'EOF' /usr/local/lib/desyn-healthcheck.mjs
// Container healthcheck: the server answers on its port without a 5xx (redirects to /login count as healthy).
const port = process.env.PORT ?? "3000";
const path = process.env.DESYN_HEALTH_PATH ?? "/";
try {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(4000),
  });
  process.exit(res.status < 500 ? 0 : 1);
} catch {
  process.exit(1);
}
EOF
# Application files are owned by root and read-only for the runtime user; only the Next cache is writable.
COPY --from=build /out/ /app/
RUN mkdir -p "/app/apps/${APP}/.next/cache" && chown node:node "/app/apps/${APP}/.next/cache"
WORKDIR /app/apps/${APP}
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=6s --start-period=40s --retries=3 \
  CMD ["node", "/usr/local/lib/desyn-healthcheck.mjs"]
CMD ["node", "server.js"]
