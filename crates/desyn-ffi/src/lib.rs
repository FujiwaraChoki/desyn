//! UniFFI facade of the Desyn engine for Swift (iOS) and Kotlin.
//!
//! The same engine surface as the wasm build (SPEC section 5): [`Engine`] loads a design, applies transactions with
//! the contract semantics, renders premultiplied RGBA frames with damage tracking (into a returned buffer or caller
//! memory), hit-tests, computes handles / snapping / marquee selection, lays out text with caret geometry, measures,
//! describes and lints, exports PNG / JPEG / WebP / SVG / PDF / PPTX / GIF and accepts font and asset bytes.
//!
//! Design content crosses the boundary as JSON strings (the Convex wire format); geometry and options are typed
//! records. See `README.md` for the Swift usage, threading model and build.

mod convert;
mod engine;
mod error;
mod frame;
mod sampler;
mod text;
mod transform;
mod types;

pub use engine::Engine;
pub use error::EngineError;
pub use types::*;

uniffi::setup_scaffolding!();

/// Version of this engine build (the crate version).
#[uniffi::export]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// New box after dragging `handle` of `bounds` to `pointer` (page coordinates). The opposite handle (or the
/// center with `from_center`) stays fixed; crossing it flips the box.
#[uniffi::export]
pub fn resize_box(
    bounds: OrientedBox,
    handle: HandleKind,
    pointer: DesignPoint,
    options: ResizeOptions,
) -> ResizeResult {
    desyn_core::hit::resize_box(
        &bounds.into(),
        handle.into(),
        pointer.into(),
        &options.into(),
    )
    .into()
}

/// Rotation in degrees between the pointer's start and current positions around `center`, snapped to `step`
/// degrees when given (e.g. 15 while Shift is held).
#[uniffi::export]
pub fn rotation_delta(
    center: DesignPoint,
    start: DesignPoint,
    pointer: DesignPoint,
    step: Option<f64>,
) -> f64 {
    desyn_core::hit::rotation_delta(center.into(), start.into(), pointer.into(), step)
}

/// Handles of an arbitrary box (live gesture previews before the transaction is applied).
#[uniffi::export]
pub fn handles_for_box(bounds: OrientedBox, zoom: f64, style: HandleStyle) -> Handles {
    desyn_core::hit::transform_handles(&bounds.into(), zoom, &style.into()).into()
}

/// Corners of an oriented box in page coordinates (top-left, top-right, bottom-right, bottom-left).
#[uniffi::export]
pub fn box_corners(bounds: OrientedBox) -> Vec<DesignPoint> {
    let b: desyn_core::geometry::OrientedBox = bounds.into();
    b.corners().into_iter().map(Into::into).collect()
}
