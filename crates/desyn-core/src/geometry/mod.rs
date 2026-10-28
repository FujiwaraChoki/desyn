//! Geometry: points, rects, affine transforms, node transforms, oriented boxes and distance helpers.
//!
//! Coordinates are design pixels, y grows downward, rotation is degrees clockwise about the node center
//! and flips mirror about the center. "World" means page-local coordinates: a page's own `x`/`y` (its position on the
//! infinite canvas) are not part of node world transforms.

mod node;
mod primitives;

pub use node::*;
pub use primitives::*;
