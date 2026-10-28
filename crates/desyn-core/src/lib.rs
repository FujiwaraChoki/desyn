//! Desyn engine core.
//!
//! See `API.md` in this crate for the full public API overview used by the text, describe, raster, wasm, ffi,
//! worker and desktop crates.

#![warn(missing_docs)]

pub mod arrange;
pub mod builder;
pub mod canonical;
pub mod clipboard;
pub mod color;
pub mod diff;
pub mod geometry;
pub mod hit;
pub mod ids;
mod jssort;
pub mod layout;
pub mod model;
pub mod ops;
pub mod paths;
pub mod plans;
pub mod snap;

pub use model::*;
pub use ops::{ApplyOptions, ApplyResult, DirtySet, DropReason, Dropped, apply_transaction};
