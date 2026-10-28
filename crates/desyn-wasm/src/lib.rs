//! Desyn engine for the web: a `wasm-bindgen` facade over `desyn-core` (model, transactions, layout, hit
//! testing, snapping), `desyn-text` (fonts, shaping, caret geometry), `desyn-describe` (describe / lint) and
//! `desyn-raster` (display lists, rasterizer, exporters).
//!
//! * [`EngineCore`] holds the state in plain Rust (natively testable); [`bindings::Engine`] exposes it to
//!   JavaScript with JSON strings in and out and the frame buffer as a view into wasm memory.
//! * Rendering is incremental: damage rectangles, whole-pixel scroll reuse and time-budgeted tiles
//!   ([`frame`]).
//! * Feature `exporters` adds PDF / PPTX / GIF (the lazily loaded second module).
//!
//! See `README.md` for the JavaScript surface (`packages/engine` wraps it in a worker).

pub mod bindings;
mod clock;
pub mod engine;
pub mod frame;
pub mod protocol;
pub mod text;

pub use engine::{EngineCore, EngineError, formats, parse_color};
