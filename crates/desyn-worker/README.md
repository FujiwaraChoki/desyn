# desyn-worker

The Desyn render worker: an Axum + tokio HTTP service implementing the worker API of
`docs/DOCUMENT_MODEL.md` section 8 on top of the shared Rust engine (`desyn-core`, `desyn-text`, `desyn-raster`,
`desyn-describe`). Convex Cloud calls it at `https://render.desyn.app` (nginx vhost `desyn-render.conf`) for
exports, thumbnails, AI previews, describe, server-side layout, text measurement and transaction application.

```sh
RENDER_WORKER_SECRET=$(openssl rand -hex 32) cargo run -p desyn-worker      # listens on :4110
```

## Endpoints

Every `POST` needs `x-desyn-secret: <RENDER_WORKER_SECRET>` (401 when missing, 403 when wrong; checked in constant
time before the body is read). Bodies are JSON, optionally `content-encoding: gzip`. JSON answers are gzip-compressed
when the caller sends `accept-encoding: gzip`.

| route | body | answer |
|---|---|---|
| `POST /v1/render` | `{ design, pageId?, region?, scale?, format, quality?, background?, pdf?, assetUrls? }` | file bytes, `content-type` per format |
| `POST /v1/thumbnail` | `{ design, pageId?, width? }` | WebP (default width 640) |
| `POST /v1/describe` | `{ design, pageId?, selection?, maxDepth?, ...DescribeOptions }` | `Description` JSON (section 7) |
| `POST /v1/layout` | `{ design }` | `{ design, changed }` (derived geometry with real fonts) |
| `POST /v1/measure` | `{ items: [{ text, style, paragraph, width? }] }` | `{ sizes: [{ w, h, lines, baseline }] }` |
| `POST /v1/apply` | `{ design, tx }` | `{ design, inverse, applied, dropped }` (core semantics incl. layout) |
| `GET /healthz` | no auth | `{ status: "ok", release }` (liveness) |
| `GET /readyz` | no auth | 200 ready / 503 draining, slots, queue, fonts, video support |
| `GET /metrics` | secret (or `METRICS_PUBLIC=true`) | Prometheus text format |

`format`: `png`, `jpeg` (`jpg`), `webp`, `svg`, `pdf`, `pptx`, `gif`, `mp4`, and additively `webm`.
`pageId`: a page id, omitted for the first page, `"all"` for pdf / pptx / gif / mp4 / webm (raster formats and SVG
answer 400 `multi_page_unsupported` for several pages: one call per page). Multi-page GIF and video play the
pages in order with their `durationMs` and `transition`.

Additive optional keys (ignored by older callers, never required):

* render: `timeMs` (animation pose of a still), `fps` (gif 15 / video 30 by default, at most `WORKER_MAX_FPS`),
  `durationMs` (single-page animations), `svgText: "text" | "text-system" | "outlines"`, `pdf.flatten`,
  `pdf.dpi` (36-2400, default 300; lowered automatically when a page would exceed `WORKER_MAX_PIXELS`),
  `strictAssets` (fail with 422 / 502 when an asset cannot be loaded instead of rendering without it), `audio`
  (mix sound into video, default true);
* thumbnail: `format` (`webp` | `png` | `jpeg`), `quality`, `background`, `assetUrls`;
* describe: `sampleImages` (decode page images for contrast checks of text on photos, default true), `assetUrls`;
* layout / apply: `assetUrls`; apply: `normalize` (default true);
* measure: `maxLines` per item, `assets` (font `AssetRef`s by id) + `assetUrls` for custom fonts.

Binary answers report what happened in headers: `x-desyn-pages`, `x-desyn-warnings` (count),
`x-desyn-missing-assets`, `x-desyn-failed-assets`, `x-desyn-missing-fonts` (comma lists). Every answer carries
`x-request-id` (the caller's when it is a safe token, otherwise generated).

Errors are `{ "error": { "code", "message", "details"? } }` with `x-desyn-error: <code>`:

| status | codes |
|---|---|
| 400 | `invalid_json`, `invalid_gzip`, `invalid_options`, `unsupported_format`, `page_not_found`, `multi_page_unsupported` |
| 401 / 403 | `unauthorized` / `forbidden` |
| 404 | `not_found` |
| 413 | `body_too_large`, `json_too_large`, `too_many_nodes`, `too_many_pages`, `too_many_pixels`, `too_long`, `too_many_items`, `too_much_text` |
| 415 | `unsupported_encoding` |
| 422 | `invalid_design` (layout / apply: details list the violations; every endpoint: child lists that are not a tree), `asset_fetch_failed` (strict, permanent) |
| 501 | `video_unavailable` (no ffmpeg / encoder) |
| 502 | `asset_fetch_failed` (strict, upstream error or timeout) |
| 503 | `overloaded` (queue full), `busy` (no slot in time), with `Retry-After` |
| 504 | `timeout` |
| 500 | `internal` |

Designs are validated against the document invariants: layout and apply refuse invalid designs (422, they return a
design that callers store); render, thumbnail and describe proceed and count a warning (the engine never panics on
invalid input, and a minor inconsistency must not block an export). One check is fatal everywhere: the `children`
lists must form a tree (no node listed twice, in one list or in two; root never listed; no cycle, attached or
detached), because tree walks follow child lists and a node listed twice per level is visited 2^depth times.
Mismatched `parent` fields (such as pages with `parent: null`) only warn.

## Assets and SSRF protection

Assets are fetched from `assetUrls[id]`, else `AssetRef.url` (the Convex callers send both). Only what the selected
pages draw is fetched: images and SVGs the nodes reference, font assets of the families the text uses, and for video
the audio / video files whose sound is mixed. Every URL is hostile until proven otherwise:

* `https` only; plain `http` for hosts in `ASSET_PRIVATE_HOSTS`, or everywhere with `ASSET_ALLOW_HTTP=true`;
* host must match `ASSET_HOST_ALLOWLIST` (default `*.amazonaws.com`: S3 virtual-hosted and path-style URLs);
* every resolved address must be public: loopback, RFC 1918, link-local (cloud metadata `169.254.169.254`), CGNAT,
  multicast, documentation, benchmarking, reserved, IPv6 ULA / link-local, and IPv4 embedded in IPv6 (mapped,
  NAT64, 6to4) are refused, except for hosts listed in `ASSET_PRIVATE_HOSTS`. The check runs in the HTTP client's
  DNS resolver, so the checked address is the connected address (no DNS rebinding), and again on every redirect
  (at most 3);
* no proxy from the environment, no credentials in URLs, per-asset (`ASSET_MAX_BYTES`, media `ASSET_MAX_MEDIA_BYTES`)
  and per-request (`ASSET_MAX_TOTAL_BYTES`, `ASSET_MAX_COUNT`) caps enforced while streaming, timeouts;
* signed query strings never appear in logs or error messages.

Fetched bytes are cached in memory by full URL (`ASSET_CACHE_BYTES`, `ASSET_CACHE_TTL_SECONDS`; Convex signs GET URLs
per hour, so repeated thumbnails and exports reuse them).

## Fonts

Each request gets a fresh text engine (custom fonts of one workspace never shape another's text) with:
1. the bundled OFL set compiled in (Inter, Instrument Sans / Serif, JetBrains Mono, Noto Sans Arabic / Hebrew,
   Noto Emoji);
2. the font directories in `FONTS_DIR` and `SYSTEM_FONTS_DIR` (indexed once at start; files are read per request
   only for the families it uses; Google's per-language CJK names map to the pan-CJK system collections);
3. design font assets (`AssetRef.kind == "font"`, registered under `AssetRef.family`);
4. Google Fonts on demand (`GOOGLE_FONTS=on|cache|off`), cached on disk in `FONT_CACHE_DIR`, one download per
   family / weight / style at a time, misses remembered for 30 minutes, at most `WORKER_FONT_FETCHES_PER_REQUEST`
   downloads per request.

## Video

MP4 (H.264 + AAC, `+faststart`) and WebM (VP9 + Opus; alpha when `background: "transparent"`) are encoded by an
ffmpeg subprocess fed with raw frames from `desyn_raster::export::frames::render_frames`. Audio nodes (`startMs` is
relative to the page start, trimmed, faded, with volume) and the sound of unmuted video nodes (looping when `loop`)
are mixed into the soundtrack; files ffmpeg cannot decode are skipped with a warning. Sound files are user uploads, so
ffmpeg opens them with `-protocol_whitelist file` and a `-format_whitelist` of plain audio / video containers: DASH
manifests, concat lists, SDP and playlists, which make ffmpeg read other local files or streams named inside them,
are refused. Every GIF (one page or a timeline) is encoded by the worker so the deadline is checked between frames.
Video nodes are drawn with
their poster frame (the renderer has no per-frame video decoding). Limits: `WORKER_MAX_VIDEO_SECONDS`,
`WORKER_MAX_FPS`, 4096 px per side, `WORKER_MAX_FRAME_PIXELS` (frames x pixels).

## Runtime model

CPU work (JSON parsing, rendering, describe, layout) runs on tokio's blocking pool behind `WORKER_CONCURRENCY` slots;
asset downloads run async without holding a slot. Requests wait for a slot at most `WORKER_QUEUE_TIMEOUT_MS`, and at
most `WORKER_QUEUE_LIMIT` may wait (503 + `Retry-After` beyond). Each request has a deadline
(`WORKER_REQUEST_TIMEOUT_MS`, video `WORKER_VIDEO_TIMEOUT_MS`): the caller gets 504 at the deadline, and frame
loops, ffmpeg and font downloads observe the cancellation. A caller that disconnects cancels its job the same way.
SIGTERM / SIGINT: `/readyz` turns 503, the listener
closes, in-flight requests finish within `WORKER_SHUTDOWN_GRACE_MS`.

Logs are JSON lines (`LOG_FORMAT=json`, default; `pretty` for development) filtered by `RUST_LOG` (default `info`),
one access line per request with `request_id`, `route`, `method`, `status`, `ms`, `bytes`, error code.

## Configuration (environment)

| variable | default | |
|---|---|---|
| `RENDER_WORKER_SECRET` | required | shared secret (>= 16 visible ASCII chars) |
| `RENDER_WORKER_SECRET_PREVIOUS` | | also accepted (rotation) |
| `PORT`, `HOST` | `4110`, `0.0.0.0` | the image sets `PORT=8080` |
| `WORKER_CONCURRENCY` | CPUs | CPU job slots (blocking pool) |
| `WORKER_QUEUE_LIMIT` / `WORKER_QUEUE_TIMEOUT_MS` | 16 x slots / 30000 | |
| `WORKER_REQUEST_TIMEOUT_MS` / `WORKER_VIDEO_TIMEOUT_MS` | 120000 / 290000 | |
| `WORKER_MAX_BODY_BYTES` / `WORKER_MAX_JSON_BYTES` | 64 MiB / 256 MiB | wire / decompressed |
| `WORKER_MAX_NODES` / `WORKER_MAX_PAGES` | 50000 / 500 | |
| `WORKER_MAX_PIXELS` | 64000000 | one page / frame |
| `WORKER_MAX_FRAME_PIXELS` | 8000000000 | animated exports in total |
| `WORKER_MAX_VIDEO_SECONDS` / `WORKER_MAX_FPS` | 300 / 60 | |
| `WORKER_MAX_MEASURE_ITEMS` / `WORKER_MAX_MEASURE_TEXT_BYTES` | 5000 / 4 MiB | |
| `WORKER_MAX_THUMBNAIL_WIDTH` | 2048 | |
| `ASSET_HOST_ALLOWLIST` | `*.amazonaws.com` | `host`, `*.suffix`, `*`; comma separated |
| `ASSET_PRIVATE_HOSTS` | | hosts allowed to resolve to private addresses (self-hosted MinIO) |
| `ASSET_ALLOW_HTTP` | `false` | |
| `ASSET_MAX_BYTES` / `ASSET_MAX_MEDIA_BYTES` / `ASSET_MAX_TOTAL_BYTES` / `ASSET_MAX_COUNT` | 64 MiB / 512 MiB / 1 GiB / 1000 | |
| `ASSET_FETCH_TIMEOUT_MS` / `ASSET_FETCH_CONCURRENCY` | 30000 / 8 | |
| `ASSET_CACHE_BYTES` / `ASSET_CACHE_TTL_SECONDS` | 256 MiB / 900 | |
| `FONTS_DIR`, `SYSTEM_FONTS_DIR` | | font directories (PATH-style lists allowed) |
| `FONT_CACHE_DIR` | `$TMPDIR/desyn-fonts` | Google Fonts disk cache |
| `GOOGLE_FONTS` / `GOOGLE_FONTS_ENDPOINT` | `on` / Google CSS2 | `on`, `cache` (offline), `off` |
| `WORKER_FONT_FETCHES_PER_REQUEST` | 16 | |
| `FFMPEG_PATH` / `FFMPEG_THREADS` | `ffmpeg` / 2 | |
| `LOG_FORMAT`, `RUST_LOG` | `json`, `info` | |
| `METRICS_PUBLIC` | `false` | serve `/metrics` without the secret |
| `WORKER_SHUTDOWN_GRACE_MS` | 25000 | |
| `DESYN_RELEASE` | crate version | reported by `/healthz`, `/metrics` |

Self-hosting with MinIO on the compose network: `ASSET_HOST_ALLOWLIST=minio ASSET_PRIVATE_HOSTS=minio` (plain http
is then allowed for that host).

## Verify

```sh
export CARGO_TARGET_DIR="$(git rev-parse --show-toplevel)/target/desyn-worker" CARGO_BUILD_JOBS=6
cargo fmt -p desyn-worker --check
cargo clippy -p desyn-worker --all-targets -- -D warnings
cargo test -p desyn-worker          # unit + tests/{api,assets,export,security}.rs (video skips without ffmpeg)
```

The integration tests start the server on an ephemeral port with a mock asset / Google Fonts server and cover every
endpoint, auth, limits, overload, timeouts, graceful shutdown, SSRF blocks (literal and resolved private addresses,
redirects, schemes), the allowlist, custom and Google fonts, every export format, multi-page PDF / PPTX / GIF and
MP4 / WebM with mixed audio (checked with ffprobe), and hostile inputs (exploding / cyclic child lists, sound
files that name other files or hosts).
