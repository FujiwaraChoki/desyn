//! Vector paths: SVG path data parse/serialize, flattening, bounds, transforms, shape-to-path (rect with per-corner
//! radii and corner smoothing, ellipse arcs/donuts, polygon, star, line caps), node outlines, boolean operations
//! (`i_overlay`) and stroke outlining (`kurbo`).
//!
//! Geometry uses `kurbo::BezPath` as the working representation; [`VectorPath`] keeps SVG commands (including arcs)
//! for lossless editing.

mod boolean;
mod flatten;
mod outline;
mod shapes;
mod stroke;
mod svg;

pub use boolean::{Shape, boolean, contours_to_bez};
pub use flatten::{MAX_COORDINATE, Polyline, flatten_bez, polylines_contain, polylines_distance};
pub use outline::{MAX_OUTLINE_DEPTH, Outline, line_outline, node_outline, node_path_data};
pub use shapes::*;
pub use stroke::{StrokeStyle, aligned_stroke_outline, stroke_outline};
pub use svg::{PathCommand, PathParseError, VectorPath, bez_bounds, bez_to_svg, parse_svg_path};

/// Re-export of kurbo so downstream crates use the same version.
pub use kurbo;
