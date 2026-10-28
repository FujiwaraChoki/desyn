# desyn-wasm

The Desyn engine for the web: a `wasm-bindgen` facade over `desyn-core` (model, transactions, layout, hit testing,
snapping), `desyn-text` (fonts, shaping, caret geometry), `desyn-describe` (describe / lint) and `desyn-raster`
(display lists, rasterizer, exporters). `packages/engine` (`@desyn/engine`) runs it in a Web Worker and is the
only intended consumer; build it with `pnpm --filter @desyn/engine build:wasm`.

* `EngineCore` (`src/engine.rs`) holds all state in plain Rust and is tested natively; `bindings::Engine` exposes
  it to JavaScript with JSON strings in and out (one parse per side, no per-field marshalling) and the frame buffer
  as a view into wasm memory (`framePtr` / `frameLen`).
* Two builds of the same crate: `desyn_engine.wasm` (interactive: PNG / JPEG / WebP / SVG export) and
  `desyn_export.wasm` (feature `exporters`: + PDF / PPTX / GIF), loaded lazily by the host on the first such export.

## JavaScript surface (`Engine`)

| method | in | out |
|---|---|---|
| `new Engine(seed)` | 32 random bytes | |
| `load(json)` | Design JSON | `LoadInfo { id, pages, nodeCount, violations }` |
| `applyTransaction(tx, normalize)` | Transaction JSON | `{ inverse, applied, dropped }` (`applied` includes derived geometry when normalizing) |
| `preview(tx, normalize)` / `commitPreview()` / `cancelPreview()` | live drag / typing previews on top of the committed state; `commitPreview` returns the net result (commit `applied`, keep `inverse`) |
| `relayout()` | | `{ applied, inverse }` derived boxes re-measured with the fonts now loaded |
| `render(request)` | `{ viewport: {x, y, zoom, width, height, dpr}, pageId?, background?, pageShadow?, hidden?, showHidden?, timeMs?, budgetMs?, force? }` | `FrameInfo { width, height, rects, scroll, pending, full, built, buildMs, rasterMs, missingAssets, fontRequests, warnings }` |
| `framePtr()` / `frameLen()` / `frameWidth()` / `frameHeight()` | | straight RGBA frame in wasm memory |
| `hitTest`, `marquee`, `snap`, `handles`, `resizeBox`, `rotationDelta`, `bounds` | JSON requests (page coordinates) | JSON |
| `measure(items)` | DocHost `MeasureItem[]` | `{ w, h, lines, baseline }[]` |
| `describe(opts)` / `lint(opts)` / `describeCompact(opts, maxTokens)` | `DescribeOptions` | `Description` / `Issue[]` / text |
| `export(request)` + `exportInfo()` | `{ format, pageId \| "all", scale, dpi, quality, background, region, timeMs, pdf, svgText, fps, durationMs, maxFrames, only, hidden }` | bytes + `{ mime, extension, pages, bytes, missingAssets, missingFonts, warnings }` |
| `setFont(bytes, family?)` / `setAsset(id, bytes)` / `removeAsset(id)` | font / asset bytes (decoded immediately, errors thrown) | `FontInfo` / `AssetInfo` |
| `takeRequests()` | | missing assets and fonts noticed outside `render` |
| `textLayout(nodeId)` / `textQuery(query)` / `outlineText(nodeId)` | caret / hit / selection / move / range queries, UTF-16 indices, page coordinates | geometry JSON |
| `snapshot()`, `pages()`, `newId()`, `engineInfo()` | | |

All shapes are mirrored in `packages/engine/src/protocol.ts`.

## Rendering

The frame buffer is updated incrementally (`src/frame.rs`):

* **Damage**: after a transaction only the device rectangles whose display-list layers changed are redrawn.
* **Scrolling**: a pan by whole device pixels shifts the pixels and draws only the exposed strips (`FrameInfo.scroll`
  tells the host to shift its canvas too).
* **Progressive tiles**: with `budgetMs`, full redraws and expensive areas are cut into 512 px tiles drawn nearest
  to the viewport center first; the rest stays `pending` for the next call. A smoothed ms-per-megapixel estimate
  decides when tiling is needed.
* **Presentation**: with an opaque pasteboard every pixel is opaque, so the premultiplied buffer is already straight
  RGBA and is read in place; with a translucent pasteboard a straight copy is kept for redrawn rectangles only.
* **Page shadow**: optional soft shadow under the page on the pasteboard: an analytic Gaussian-blurred rectangle
  (two `erf` factors per pixel, so no banding), ambient + contact layers, softer on light pasteboards.
* **Progressive leftovers** are kept apart from new damage and never merged into bounding boxes, so damage during
  a progressive render (a drag right after a zoom) does not restart it.
* Display lists are rebuilt when the design, fonts / asset bytes, page, hidden nodes, animation time or the
  device-scale octave change; the renderer's incremental build cache keeps that cheap.

## Verify

```sh
cd crates/desyn-wasm
export CARGO_TARGET_DIR="$(git rev-parse --show-toplevel)/target/desyn-wasm" CARGO_BUILD_JOBS=6
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo clippy --target wasm32-unknown-unknown --all-targets --all-features -- -D warnings
cargo test --release && cargo test --release --features exporters
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner cargo test --target wasm32-unknown-unknown --test wasm
cargo run --release --example tiles -- social 2.4 2     # progressive render timing per call
```
