//! Hit testing: point picking (topmost, honoring visibility, locks, clipping, masks, rotation, stroke bands, text
//! boxes), marquee selection, nodes under a point, selection bounds and transform-handle geometry.
//!
//! All points are page coordinates (design px); screen tolerances must be divided by the zoom factor.

mod handles;
mod index;
mod pick;

pub use handles::*;
pub use index::HitIndex;
pub use pick::{
    HitOptions, MarqueeMode, hit_path, hit_test, marquee, node_world_transform, nodes_at,
};
