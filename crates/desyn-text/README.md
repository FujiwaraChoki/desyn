# desyn-text

Desyn's text engine: fonts (TTF / OTF / TTC / WOFF / WOFF2, variable fonts), CSS font matching, per-script and emoji
fallback, harfrust shaping, bidi, UAX #14 line breaking with a hyphenation hook, rich paragraph layout (lists,
justification, ellipsis, vertical alignment, auto-resize), caret / selection geometry, glyph outlines, COLR color
glyphs and text on paths. Implements `desyn_core::layout::TextMeasurer`. Builds for `wasm32-unknown-unknown`.

* API: [`API.md`](API.md) (and `cargo doc -p desyn-text`).
* Bundled fonts, versions and licenses: [`fonts/README.md`](fonts/README.md).

## Verify

```sh
cd crates/desyn-text
export CARGO_TARGET_DIR="$(git rev-parse --show-toplevel)/target/desyn-text" CARGO_BUILD_JOBS=6
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo clippy --target wasm32-unknown-unknown --all-features -- -D warnings   # `fetch` is native-only and compiles out
cargo test --all-features                       # offline; the fetch test runs against a local HTTP server
cargo test --release --test perf -- --nocapture # 2k-character paragraph < 2 ms
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner \
  cargo test --target wasm32-unknown-unknown --test wasm                       # runs inside Node's wasm runtime
cargo build --release --target wasm32-unknown-unknown --features bundled
cargo bench --bench text
```
