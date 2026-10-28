# syntax=docker/dockerfile:1.19
#
# Render worker (crates/desyn-worker, Axum). Build from the repository root:
#
#   docker buildx build -f deploy/docker/worker.Dockerfile -t desyn/worker:dev .
#
# cargo-chef splits dependency compilation (cached while Cargo.lock and manifests are unchanged) from the
# workspace build. The runtime image is Debian slim with a static ffmpeg (MP4/GIF export), the bundled OFL
# font set from assets/fonts (FONTS_DIR) and Noto system fonts as glyph fallback, running as a non-root user.

ARG CHEF_IMAGE=lukemathwalker/cargo-chef:0.1.78-rust-1.98.1-trixie
ARG RUNTIME_IMAGE=debian:trixie-20261005-slim
ARG FFMPEG_IMAGE=mwader/static-ffmpeg:9.0.2-1

FROM ${CHEF_IMAGE} AS chef
WORKDIR /src
ENV CARGO_TERM_COLOR=never \
    CARGO_INCREMENTAL=0

# ---------------------------------------------------------------------------------------------------
FROM chef AS planner
COPY . .
RUN test -f crates/desyn-worker/Cargo.toml || { echo "crates/desyn-worker is missing" >&2; exit 1; } \
 && test -f Cargo.lock || { echo "Cargo.lock is missing; run cargo generate-lockfile and commit it" >&2; exit 1; }
RUN cargo chef prepare --recipe-path recipe.json

# ---------------------------------------------------------------------------------------------------
FROM chef AS cook
ARG CARGO_BUILD_JOBS=6
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
COPY --from=planner /src/recipe.json recipe.json
RUN --mount=type=cache,id=desyn-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=desyn-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    cargo chef cook --release --locked --recipe-path recipe.json --package desyn-worker

# ---------------------------------------------------------------------------------------------------
FROM cook AS build
ARG WORKER_BIN=desyn-worker
COPY . .
RUN --mount=type=cache,id=desyn-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=desyn-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    cargo build --release --locked --package desyn-worker --bin "${WORKER_BIN}" \
 && install -m 0755 "target/release/${WORKER_BIN}" /desyn-worker

# ---------------------------------------------------------------------------------------------------
FROM ${FFMPEG_IMAGE} AS ffmpeg

# ---------------------------------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime
ARG DESYN_RELEASE=dev
ARG SOURCE_URL=""
# fonts-noto-cjk adds ~90 MB but keeps CJK text rendering correct for localized designs.
ARG EXTRA_FONT_PACKAGES="fonts-noto-cjk"
LABEL org.opencontainers.image.title="desyn-worker" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${DESYN_RELEASE}" \
      org.opencontainers.image.licenses="LicenseRef-Desyn-NonCommercial"
RUN <<EOF
set -eu
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl tini fontconfig \
  fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji ${EXTRA_FONT_PACKAGES}
rm -rf /var/lib/apt/lists/*
groupadd --system --gid 10001 desyn
useradd --system --uid 10001 --gid desyn --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin desyn
EOF
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY assets/fonts/ /usr/share/desyn/fonts/
COPY --from=build /desyn-worker /usr/local/bin/desyn-worker
RUN fc-cache -f >/dev/null && ffmpeg -hide_banner -version | head -n 1
ENV PORT=8080 \
    FONTS_DIR=/usr/share/desyn/fonts \
    SYSTEM_FONTS_DIR=/usr/share/fonts \
    FFMPEG_PATH=/usr/local/bin/ffmpeg \
    FFPROBE_PATH=/usr/local/bin/ffprobe \
    TMPDIR=/tmp \
    RUST_LOG=info \
    DESYN_RELEASE=${DESYN_RELEASE}
USER desyn
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["sh", "-c", "curl -fsS -o /dev/null \"http://127.0.0.1:${PORT}/healthz\""]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/desyn-worker"]
