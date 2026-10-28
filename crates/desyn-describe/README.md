# desyn-describe

Semantic description and lint ("design check") of a Desyn page: the `Description` of
`docs/DOCUMENT_MODEL.md` section 7, built on `desyn-core` (model, geometry, outlines, color math) and `desyn-text`
(real line breaks). The AI reads it through `read_design` / `critique`; the editor's design check shows its
issues and applies their fixes. Deterministic, no model calls, native and `wasm32-unknown-unknown`.

What it produces for one page:

* **Tree** (`DNode`s, back-to-front, page-space boxes, accumulated rotation, resolved text style and colors through
  `$style` / `$var`, fill summaries, image kinds, inferred `semantic` labels, flags, visual `weight`).
* **Semantic groups** (`groups`): product card, card, CTA button (shape + short label), logo lockup, image with
  caption, header, footer, nav bar, list, grid of cards, stat, quote, text block, labelled icon; explicit roles win.
  Found from containers, a containment forest of loose shapes ("content on a surface"), type-size-aware proximity
  and repetition.
* **Reading order** (XY-cut over the semantic units, z-aware for overlays, right-to-left pages read right column
  first), dominant **direction**.
* **Palette**, **fonts**, **type scale**, **grid** (margins, shared alignment lines, spacing rhythm), **hierarchy**
  (visual weight ranking).
* **Issues** with severity, ids, message, a one-line `hint` and (when safe) `fix` ops: 30 rules under the 15
  contract `IssueCode`s, including contrast against the composited backdrop (gradients, translucent layers, blend
  modes, photos through an `ImageSampler`), text overflow / truncation / clipping, orphans and widows, off-page,
  safe area and print bleed, near-miss alignment, uneven spacing, font / size / color counts, brand kit
  violations, image resolution for print, alt text, empty and unnamed layers. Table in `API.md`.
* **Design tokens** (palette with usage counts, type scale, spacing scale, radii, named styles).
* **Compact renderings** for prompts: `compact_value` (the exact `compactDescription` shape of `@desyn/ai`) and
  `compact_text` (token-budgeted, stable, one line per entry; design strings cannot forge lines).

## Use

```rust
use desyn_describe::{describe, DescribeOptions, PixelSampler, compact_text, CompactOptions};

let mut engine = desyn_text::TextEngine::new();      // register the design's fonts (add_font_as) for exact breaks
let mut images = PixelSampler::new();                 // optional: decoded RGBA of image assets
images.insert(asset_id, width, height, rgba);
let desc = describe(&design, &DescribeOptions::default(), &mut engine, Some(&mut images))?;
let prompt = compact_text(&desc, &CompactOptions { max_tokens: 1500, ..Default::default() });
```

`DescribeOptions` deserializes from the worker / wasm request JSON:
`{ pageId?, selection?, maxDepth? (alias depth), includeHidden?, includeStyles?, detail?: "summary" | "full",
maxNodes?, lint?, brand?: BrandKit }`.

CLI for inspection: `cargo run --example describe -- design.json [--json] [--tokens N] [--page ID] [--summary]`
(accepts a `Design` or a fixture file).

## Verify

```sh
cd crates/desyn-describe
export CARGO_TARGET_DIR="$(git rev-parse --show-toplevel)/target/desyn-describe" CARGO_BUILD_JOBS=6
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo clippy --target wasm32-unknown-unknown -- -D warnings
cargo test                                   # unit + fixtures + JSON Schema contract + behavior + robustness
cargo test --release --test perf -- --nocapture
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner \
  cargo test --target wasm32-unknown-unknown --test wasm
DESYN_UPDATE_FIXTURES=1 cargo test --test fixtures   # regenerate tests/fixtures/*.json after changing a case
cargo bench --bench describe
```

Fixtures (`tests/fixtures/*.json`) are plain JSON (`description`, `design`, `options`, synthetic `images`,
`expect`) so other hosts can run them; `scripts/compare-ts.ts` diffs the TypeScript approximation in `@desyn/ai`
against the engine output on all of them.
