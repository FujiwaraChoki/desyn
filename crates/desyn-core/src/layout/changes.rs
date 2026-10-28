//! Geometry change log used by normalization.

use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};

use crate::model::{Design, Id};

/// The derived geometry fields of a node.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Geo {
    /// X.
    pub x: f64,
    /// Y.
    pub y: f64,
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
}

/// One node's geometry before and after normalization.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GeometryChange {
    /// Node id.
    pub id: Id,
    /// Before.
    pub before: Geo,
    /// After.
    pub after: Geo,
}

/// Records the original geometry of every node the layout touches.
#[derive(Default)]
pub(crate) struct ChangeLog {
    order: Vec<Id>,
    before: FxHashMap<Id, Geo>,
}

pub(crate) fn geo_of(d: &Design, id: &str) -> Option<Geo> {
    d.node(id).map(|n| {
        let b = n.base();
        Geo {
            x: b.x,
            y: b.y,
            width: b.width,
            height: b.height,
        }
    })
}

impl ChangeLog {
    /// Sets a node's geometry, remembering the original values. Negative sizes are clamped to 0, and a component
    /// that overflowed to a non-finite value (only possible with absurd input such as paddings near `f64::MAX`)
    /// keeps its old value: the design must stay valid and every derived `update` must serialize to JSON numbers.
    pub fn set(&mut self, d: &mut Design, id: &str, g: Geo) {
        let Some(n) = d.node_mut(id) else { return };
        let b = n.base_mut();
        let old = Geo {
            x: b.x,
            y: b.y,
            width: b.width,
            height: b.height,
        };
        let pick = |v: f64, old: f64| if v.is_finite() { v } else { old };
        let new = Geo {
            x: pick(g.x, old.x),
            y: pick(g.y, old.y),
            width: pick(g.width, old.width).max(0.0),
            height: pick(g.height, old.height).max(0.0),
        };
        if old == new {
            return;
        }
        if !self.before.contains_key(id) {
            self.before.insert(id.to_string(), old);
            self.order.push(id.to_string());
        }
        b.x = new.x;
        b.y = new.y;
        b.width = new.width;
        b.height = new.height;
    }

    pub fn finish(self, d: &Design) -> Vec<GeometryChange> {
        let mut out = Vec::with_capacity(self.order.len());
        for id in self.order {
            let before = self.before[&id];
            if let Some(after) = geo_of(d, &id)
                && after != before
            {
                out.push(GeometryChange { id, before, after });
            }
        }
        out
    }
}
