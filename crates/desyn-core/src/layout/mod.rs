//! Layout: auto-layout (row / column / grid), constraints, group bounds and text auto-resize.
//!
//! [`normalize`] recomputes derived geometry after a transaction (DOCUMENT_MODEL invariant 4 and 5) and reports every
//! change so the applier can include it in `applied` and the inverse. It is idempotent: running it on a normalized
//! design changes nothing.

mod auto_layout;
mod changes;
mod constraints;
mod groups;
mod measure;
mod normalize;

pub use auto_layout::{LayoutItem, LayoutPlan, MAX_LAYOUT_DEPTH, plan_auto_layout};
pub use changes::{Geo, GeometryChange};
pub use constraints::constrain_box;
pub use groups::fit_group_bounds;
pub use measure::*;
pub use normalize::{normalize, normalize_all};
