# desyn-core

The Desyn engine core (Rust, edition 2024): document model (serde mirror of `docs/DOCUMENT_MODEL.md`), transactions
with exact inverses, canonical JSON, geometry, vector paths and booleans, layout, hit testing, snapping, arrangement
builders, diff, clipboard, color math and plans. Shared by `desyn-text`, `desyn-describe`, `desyn-raster`,
`desyn-wasm`, `desyn-ffi`, `desyn-worker` and the desktop app. Compiles for `wasm32-unknown-unknown`.

**API overview: [API.md](API.md).**

## Verify

```sh
export CARGO_TARGET_DIR=$PWD/../../target/desyn-core CARGO_BUILD_JOBS=6
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo clippy --target wasm32-unknown-unknown -- -D warnings
cargo test --all-features                       # unit, conformance fixtures, property tests
cargo test --release --test perf -- --nocapture # performance budgets (asserted in release)
cargo test --release --test robustness          # hostile documents: huge counts / coordinates, 20k-deep nesting on a 1 MiB stack
cargo build --target wasm32-unknown-unknown
cargo bench --bench core                        # criterion benches
```

Conformance: `tests/conformance.rs` runs every case in `spec/fixtures/{canonical,nodes,ops,layout}`. The `layout`
fixtures are Rust-only; regenerate them with `python3 scripts/gen_layout_fixtures.py ../../spec/fixtures/layout`.
