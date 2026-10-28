# desyn-ffi

The Desyn engine for Swift (iOS / macOS) and Kotlin through [UniFFI](https://mozilla.github.io/uniffi-rs/) 0.32
(proc-macro mode, no UDL). It wraps `desyn-core` (model, transactions, layout, hit testing, snapping),
`desyn-text` (fonts, shaping, caret geometry), `desyn-describe` (describe / lint) and `desyn-raster` (rendering
and every exporter) behind the same surface as the wasm engine (SPEC section 5), so the iOS app renders and edits
exactly like the web and desktop apps.

The Swift side lives in `apps/ios/DesynEngine` (SwiftPM package: generated `DesynFFI` module + the
`DesynEngine` actor, CGImage / Metal helpers). Build it with `scripts/build-ios-engine.sh`.

## Surface

Design content crosses as **JSON strings** (the Convex wire format of DOCUMENT_MODEL section 6: `Design`,
`Transaction`, `Op[]`, `DescribeOptions`, `Description`, `Issue[]`); everything else is typed records and enums.
Geometry is in design px, page coordinates unless noted. Swift names are the lowerCamelCase forms
(`apply_transaction` -> `applyTransaction(txJson:normalize:)`).

| group | `Engine` methods |
|---|---|
| lifecycle | `Engine()` (bundled fonts, 384 MB image budget), `Engine.with_options(bundled_fonts, asset_budget_mb)`, `load(design_json, normalize) -> LoadResult`, `unload`, `is_loaded`, `revision`, `snapshot(canonical)`, `design_hash`, `pages`, `node_json(id)` |
| editing | `apply_transaction(tx_json, normalize) -> ApplyOutcome { applied_json, inverse_json, dropped, revision }`, `relayout() -> LayoutOutcome`, `transform_selection(ids, from, to, flip_x, flip_y) -> ops JSON` |
| previews | `preview(tx_json, normalize) -> ApplyOutcome`, `commit_preview() -> Option<ApplyOutcome>`, `cancel_preview() -> bool`, `has_preview` |
| rendering | `render(RenderRequest) -> RenderedFrame` (returned pixels), `render_into(RenderRequest, address, length, stride, buffer_sequence) -> FrameInfo` (caller memory), `render_page(PageImageRequest) -> RenderedFrame` (thumbnails), `reset_frame`, `clear_caches(assets)` |
| picking | `hit_test`, `hit_path`, `nodes_at`, `marquee`, `node_bounds`, `selection_bounds`, `handles`, `hit_handles` |
| snapping | `snap_move`, `snap_resize`, `distance_labels` (targets cached per gesture: same page + same `exclude`) |
| text | `measure(request_json)` (worker `/v1/measure` body), `text_layout(node_id)`, `text_hit_test`, `text_caret`, `text_selection_rects`, `text_word_range`, `text_line_range`, `text_paragraph_range`, `text_move` (UTF-16 offsets), `text_outline(node_id) -> TextOutline` (convert to paths) |
| understanding | `describe(options_json)`, `lint(options_json)`, `describe_text(options_json, max_tokens)`, `design_tokens(page_id)` |
| export | `export(ExportRequest) -> ExportResult` (PNG, JPEG, WebP, SVG, PDF, PPTX, GIF), `export_pages(ExportRequest)` |
| fonts / assets | `set_font(bytes, family) -> [FontFace]`, `font_families`, `take_font_requests`, `set_asset(id, bytes)`, `remove_asset`, `take_missing_assets` |

Free functions: `engine_version`, `resize_box(bounds, handle, pointer, options) -> ResizeResult`,
`rotation_delta(center, start, pointer, step)`, `handles_for_box(bounds, zoom, style)`, `box_corners(bounds)`.
Errors: `EngineError` (`InvalidJson`, `NoDesign`, `PageNotFound`, `NodeNotFound`, `NotText`, `InvalidArgument`,
`Render`, `Font`); nothing panics on bad input (UniFFI turns an unexpected panic into an internal error).

Record names avoid Apple SDK collisions (`MacTypes.h` declares `Point`, `Rect` and `Handle`): the geometry records
are `DesignPoint`, `DesignRect`, `ResizeHandle`, `PixelRect`, `Affine` (CGAffineTransform layout:
`a b c d tx ty`), `OrientedBox` (`transform` maps the local box `(0,0)..(width,height)` to page coordinates).

### Rendering model

* Pixels are **premultiplied RGBA8**, bytes in R, G, B, A order, sRGB encoded: `CGImage` with
  `premultipliedLast | byteOrder32Big`, or an `.rgba8Unorm` Metal texture drawn with premultiplied blending.
* The engine keeps one interactive frame. Rendering the same page, viewport and canvas color again only rasterizes
  the damage (`FrameInfo.damage`, device pixels); anything else is a full redraw (`FrameInfo.full`).
* Every interactive frame has a `sequence` number; damage is relative to frame `sequence - 1`. `render_into`
  takes the sequence the caller's buffer currently shows and copies only the damage when it is the previous
  frame (the whole frame otherwise), so several buffers and interleaved `render` calls stay correct.
* `render_into` writes into caller memory (`MTLBuffer.contents()`, a locked `CVPixelBuffer`, a heap buffer):
  `stride >= width * 4`, `length >= stride * (height - 1) + width * 4`. The caller guarantees the memory is valid
  and unaliased for the duration of the call.
* Missing asset bytes and font families never fail a render: they are listed in `FrameInfo.missing_assets` /
  `missing_fonts` (and `take_missing_assets` / `take_font_requests`); fetch, `set_asset` / `set_font`, render
  again (and `relayout` when text metrics changed).

### Editing model

Local edits: build a transaction, `apply_transaction(tx, normalize: true)` (real text metrics, auto-layout,
groups), commit **`applied_json`** (the ops in normal form including derived geometry) with the same id / label
through `designs.commit`, keep `inverse_json` for undo (apply it with `normalize: false`). Remote transactions
(`designOps.since`) are applied with `normalize: false`.

Gestures (same model as the wasm engine): `transform_selection` turns a gesture on the selection box (move,
resize, rotate, flip; `from` = box at gesture start, `to` = current box, e.g. from `resize_box`) into ops computed
against the **committed** state. On every pointer move, wrap them in a transaction and `preview` it: the preview
replaces the previous one and is drawn on top of the committed state. On pointer-up, `commit_preview` keeps it and
returns its outcome (commit `applied_json` through `designs.commit`, keep `inverse_json` for undo);
`cancel_preview` drops it. A remote transaction applied mid-gesture goes under the preview, which is replayed on
top (its ops may then be dropped, e.g. when the dragged node was deleted). Snap targets come from the committed
state, so the preview never snaps to itself. `snapshot` / `design_hash` / rendering / hit testing see the
committed state plus the preview.

### Thread safety

`Engine` is `Send + Sync`: every method takes one internal mutex for its whole duration, so calls from any thread
are serialized and never observe a half-applied transaction. Long calls (full renders, exports, describe) block
their caller, so never call from the main thread: the Swift `DesynEngine` actor runs every call on its own serial
dispatch queue (a custom executor, off the main thread and off the cooperative pool), and `DesynEngine.core` is
available for a dedicated render thread. A poisoned lock (a panic inside a call) drops the caches and recovers.

Stack: GCD queue threads on iOS have 512 KB of stack. Release builds handle 1024 nested groups on it (the
renderer caps its own recursion at 128 levels); unoptimized (`--debug`) builds overflow near 64 levels, so use
them only for development (`tests/robustness.rs`).

## Build and verify

```sh
cd crates/desyn-ffi
export CARGO_TARGET_DIR="$(git rev-parse --show-toplevel)/target/desyn-ffi" CARGO_BUILD_JOBS=6
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test                                        # render / editing / text / analysis / perf (offline)
cargo test --release --test perf -- --nocapture   # budgets asserted in release
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps

# Bindings (any OS). The generated Swift wrapper is committed:
scripts/build-ios-engine.sh --bindings-only       # regenerate apps/ios/DesynEngine/Sources/DesynFFI/DesynFFI.swift
scripts/build-ios-engine.sh --check               # fail when it is stale
cargo run --features bindgen-cli --bin uniffi-bindgen -- generate \
  --library $CARGO_TARGET_DIR/debug/libdesyn_ffi.so --language kotlin --out-dir /tmp/desyn-kotlin   # Kotlin

# macOS + Xcode: static libraries for device / simulator / macOS + XCFramework + Swift wrapper
scripts/build-ios-engine.sh
swift test --package-path apps/ios/DesynEngine
```

Cargo features: `bundled-fonts` (default; Inter, Instrument Sans / Serif, JetBrains Mono, Noto Arabic / Hebrew /
Emoji compiled in, ~5.5 MB), `bindgen-cli` (the `uniffi-bindgen` binary; host only). Binding settings live in
`uniffi.toml` (Swift module `DesynFFI`, C module `DesynFFIC`, Kotlin package `app.desyn.engine`).
