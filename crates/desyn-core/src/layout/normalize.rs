//! Post-transaction normalization of derived geometry.

use rustc_hash::FxHashSet;

use super::auto_layout::Ctx;
use super::changes::{ChangeLog, Geo, GeometryChange, geo_of};
use super::constraints::constrain_box;
use super::groups;
use super::measure::{TextMeasurer, measure_text_node};
use crate::model::{AutoResize, Design, HConstraint, Id, Node, NodeType, VConstraint};
use crate::ops::DirtySet;

/// Normalizes everything (worker `/v1/layout`).
pub fn normalize_all(d: &mut Design, m: &mut dyn TextMeasurer) -> Vec<GeometryChange> {
    let dirty = DirtySet::all(d);
    normalize(d, m, &dirty)
}

/// Recomputes derived geometry affected by `dirty` and returns every change (in application order):
///
/// 1. constraints of children of containers resized by ops (children whose geometry the ops set explicitly are left
///    alone, which keeps re-applying an `applied` op list idempotent),
/// 2. text auto-resize (`width`: both axes from the text, `height`: height for the fixed width),
/// 3. group / boolean bounds and auto-layout containers on the dirty nodes' ancestor chains, deepest first; an
///    auto-layout container lays out its whole subtree (fill / hug / stretch, wrap, grid, baseline).
pub fn normalize(
    d: &mut Design,
    m: &mut dyn TextMeasurer,
    dirty: &DirtySet,
) -> Vec<GeometryChange> {
    let mut log = ChangeLog::default();
    let mut ctx = Ctx::new(m);
    let explicit: FxHashSet<String> = dirty.explicit_geometry.iter().cloned().collect();
    let mut touched: FxHashSet<Id> = FxHashSet::default();

    // 1. Constraints, top-down.
    let mut depths = Depths::default();
    let mut resized: Vec<(usize, &Id, &(f64, f64))> = dirty
        .resized
        .iter()
        .filter(|(id, _)| d.node(id).is_some())
        .map(|(id, old)| (depths.of(d, id), id, old))
        .collect();
    resized.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
    let resized: Vec<(&Id, &(f64, f64))> =
        resized.into_iter().map(|(_, id, old)| (id, old)).collect();
    for (id, old) in resized {
        let Some(n) = d.node(id) else { continue };
        if n.layout().is_some()
            || matches!(n, Node::Group(_) | Node::Boolean(_) | Node::Root(_))
            || !n.is_container()
        {
            continue;
        }
        let new = (n.base().width, n.base().height);
        apply_constraints(d, &mut log, id, *old, new, &explicit, &mut ctx);
        for c in d
            .node(id)
            .map(|n| n.child_ids().to_vec())
            .unwrap_or_default()
        {
            touched.insert(c);
        }
    }

    // 2. Text auto-resize outside auto-layout parents (auto-layout measures its own text children).
    let mut seeds: Vec<Id> = dirty
        .nodes
        .iter()
        .chain(dirty.containers.iter())
        .chain(touched.iter())
        .filter(|id| d.node(id).is_some())
        .cloned()
        .collect();
    seeds.sort();
    seeds.dedup();
    for id in &seeds {
        let in_layout = d
            .node(id)
            .and_then(Node::parent)
            .and_then(|p| d.node(p))
            .is_some_and(|p| p.layout().is_some());
        if !in_layout {
            resize_text(d, &mut log, &mut ctx, id);
        }
    }

    // 3. Ancestor closure: groups and auto-layout containers, deepest first.
    let mut closure: FxHashSet<Id> = FxHashSet::default();
    for id in &seeds {
        let mut cur = Some(id.clone());
        while let Some(c) = cur {
            if !closure.insert(c.clone()) {
                break;
            }
            cur = d.node(&c).and_then(Node::parent).map(str::to_string);
        }
    }
    let mut work: Vec<(usize, Id)> = closure
        .into_iter()
        .filter(|id| {
            d.node(id).is_some_and(|n| {
                n.layout().is_some() || matches!(n, Node::Group(_) | Node::Boolean(_))
            })
        })
        .map(|id| (depths.of(d, &id), id))
        .collect();
    work.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    for (_, id) in work {
        let Some(n) = d.node(&id) else { continue };
        match n {
            Node::Group(_) | Node::Boolean(_) if n.layout().is_none() => {
                groups::fit(d, &id, &mut log)
            }
            _ => {
                let parent_has_layout = n
                    .parent()
                    .and_then(|p| d.node(p))
                    .is_some_and(|p| p.layout().is_some());
                if parent_has_layout {
                    continue; // the parent lays this container out at its final size
                }
                // Earlier steps may have written geometry since the last measurement.
                ctx.invalidate();
                let (w, h) = ctx.measure(d, &id, None, None);
                ctx.arrange(d, &mut log, &id, w, h, &explicit);
            }
        }
    }
    log.finish(d)
}

/// Memoized node depths: a node's depth is its parent's plus one, so computing the depths of a whole ancestor chain
/// is linear (calling `Design::depth` per node would be quadratic in the nesting depth).
#[derive(Default)]
struct Depths(rustc_hash::FxHashMap<Id, usize>);

impl Depths {
    fn of(&mut self, d: &Design, id: &str) -> usize {
        if let Some(v) = self.0.get(id) {
            return *v;
        }
        // Climb to the first memoized ancestor (or the top), then assign depths on the way back down.
        let mut chain: Vec<&str> = vec![id];
        let mut seen: FxHashSet<&str> = FxHashSet::default();
        seen.insert(id);
        let mut base = 0usize;
        let mut cur = d.node(id).and_then(Node::parent);
        while let Some(p) = cur {
            if let Some(v) = self.0.get(p) {
                base = v + 1;
                break;
            }
            if !seen.insert(p) {
                break;
            }
            chain.push(p);
            cur = d.node(p).and_then(Node::parent);
        }
        let top = chain.len();
        for (i, n) in chain.iter().enumerate() {
            // `chain[top - 1]` is the shallowest unmemoized node; it sits at `base` (0 when it is the root).
            self.0.insert((*n).to_string(), base + (top - 1 - i));
        }
        base + top - 1
    }
}

/// Applies the text node's auto-resize mode to its box.
fn resize_text(d: &mut Design, log: &mut ChangeLog, ctx: &mut Ctx<'_>, id: &str) {
    let Some(Node::Text(t)) = d.node(id) else {
        return;
    };
    let g = Geo {
        x: t.base.x,
        y: t.base.y,
        width: t.base.width,
        height: t.base.height,
    };
    let new = match t.auto_resize {
        AutoResize::None => return,
        AutoResize::Width => {
            let r = measure_text_node(ctx.m, t, None);
            Geo {
                width: r.width,
                height: r.height,
                ..g
            }
        }
        AutoResize::Height => {
            let r = measure_text_node(ctx.m, t, Some(t.base.width));
            Geo {
                height: r.height,
                ..g
            }
        }
    };
    log.set(d, id, new);
}

/// Applies children's constraints for a container resized from `old` to `new`, recursing into resized non-layout
/// containers and laying out resized auto-layout children.
pub(crate) fn apply_constraints(
    d: &mut Design,
    log: &mut ChangeLog,
    id: &str,
    old: (f64, f64),
    new: (f64, f64),
    explicit: &FxHashSet<String>,
    ctx: &mut Ctx<'_>,
) {
    if old == new || ctx.depth >= super::auto_layout::MAX_LAYOUT_DEPTH {
        return;
    }
    ctx.depth += 1;
    cascade_constraints(d, log, id, old, new, explicit, ctx);
    ctx.depth -= 1;
}

fn cascade_constraints(
    d: &mut Design,
    log: &mut ChangeLog,
    id: &str,
    old: (f64, f64),
    new: (f64, f64),
    explicit: &FxHashSet<String>,
    ctx: &mut Ctx<'_>,
) {
    let Some(n) = d.node(id) else { return };
    if n.layout().is_some() || n.node_type() == NodeType::Root {
        return;
    }
    let children: Vec<Id> = n.child_ids().to_vec();
    for c in children {
        if explicit.contains(&c) {
            continue;
        }
        let Some(cn) = d.node(&c) else { continue };
        let cons = cn.base().constraints_or_default();
        if cons.h == HConstraint::Left && cons.v == VConstraint::Top {
            continue;
        }
        let Some(g) = geo_of(d, &c) else { continue };
        let (x, y, w, h) = constrain_box(&cons, (g.x, g.y, g.width, g.height), old, new);
        log.set(
            d,
            &c,
            Geo {
                x,
                y,
                width: w,
                height: h,
            },
        );
        let resized = (w, h) != (g.width, g.height);
        if !resized {
            continue;
        }
        let Some(cn) = d.node(&c) else { continue };
        if cn.layout().is_some() {
            ctx.arrange(d, log, &c, w, h, explicit);
        } else if cn.is_container() && !matches!(cn, Node::Group(_) | Node::Boolean(_)) {
            apply_constraints(d, log, &c, (g.width, g.height), (w, h), explicit, ctx);
        } else if matches!(cn, Node::Text(_)) {
            resize_text(d, log, ctx, &c);
        }
    }
}
