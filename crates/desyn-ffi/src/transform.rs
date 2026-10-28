//! Turning a gesture on the selection box (move, resize, rotate, flip) into contract ops.
//!
//! The gesture maps the selection's oriented box `from` onto `to` (mirrored inside `to` for flips). Every selected node gets the same page-space
//! mapping: its new box is the old one carried through `M = to * scale(to.size / from.size) * from^-1`, read back
//! as `x / y / width / height / rotation / flips` in its parent (skew from non-uniform scaling of rotated nodes is
//! dropped, as in other editors). Groups and booleans have derived bounds, so their children are transformed
//! instead and the groups refit; frames keep their children (constraints apply when the transaction is
//! normalized). Path data is rescaled with its box; resizing text switches its auto-resize mode the way the web
//! editor does. Locked nodes stay where they are.

use desyn_core::arrange::top_level_selection;
use desyn_core::builder::{TxBuilder, decompose_prefer, round_geom};
use desyn_core::geometry::{Affine, OrientedBox, Point, parent_world_transform, world_transform};
use desyn_core::model::Op;
use desyn_core::model::{Design, Id, Node, NodeType};
use desyn_core::paths::VectorPath;
use serde_json::{Map, Value, json};
use std::collections::HashSet;

/// Scale factors below this are treated as unchanged (floating point noise from matrix round trips).
const EPS: f64 = 1e-9;

/// Ops that carry `ids` (top-level selection is taken) from box `from` to box `to`, mirrored inside `to` when
/// `flip_x` / `flip_y` (a resize dragged across the opposite edge). The design is left unchanged.
pub(crate) fn transform_ops(
    design: &mut Design,
    ids: &[Id],
    from: &OrientedBox,
    to: &OrientedBox,
    flip_x: bool,
    flip_y: bool,
) -> Vec<Op> {
    let mut target = *to;
    if flip_x {
        target.transform =
            target.transform * Affine::translate(to.width, 0.0) * Affine::scale(-1.0, 1.0);
    }
    if flip_y {
        target.transform =
            target.transform * Affine::translate(0.0, to.height) * Affine::scale(1.0, -1.0);
    }
    let Some(m) = gesture_matrix(from, &target) else {
        return Vec::new();
    };
    let top = top_level_selection(design, ids);
    let mut b = TxBuilder::new(design);
    let mut touched: Vec<Id> = Vec::new();
    let mut seen: HashSet<Id> = HashSet::new();
    for id in &top {
        transform_node(&mut b, id, &m, &mut touched, &mut seen);
    }
    // Groups around (and inside) the selection refit to their transformed children.
    let _ = b.refit_groups(touched.iter());
    b.finish()
}

/// `to * scale * from^-1`, or `None` when `from` is degenerate in a way no scale can express.
fn gesture_matrix(from: &OrientedBox, to: &OrientedBox) -> Option<Affine> {
    let inv = from.transform.inverse()?;
    let sx = if from.width.abs() > EPS {
        to.width / from.width
    } else {
        1.0
    };
    let sy = if from.height.abs() > EPS {
        to.height / from.height
    } else {
        1.0
    };
    let m = to.transform * Affine::scale(sx, sy) * inv;
    m.as_coeffs().iter().all(|v| v.is_finite()).then_some(m)
}

fn num(v: f64) -> Value {
    serde_json::Number::from_f64(v)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// `seen` guards against malformed documents (a node listed twice, or a cycle of groups): every node moves once.
fn transform_node(
    b: &mut TxBuilder<'_>,
    id: &str,
    m: &Affine,
    touched: &mut Vec<Id>,
    seen: &mut HashSet<Id>,
) {
    if !seen.insert(id.to_string()) {
        return;
    }
    let Some(node) = b.design.node(id) else {
        return;
    };
    if node.base().locked {
        return;
    }
    match node.node_type() {
        NodeType::Root | NodeType::Page => {}
        NodeType::Group | NodeType::Boolean => {
            let kids: Vec<Id> = node.child_ids().to_vec();
            for kid in kids {
                transform_node(b, &kid, m, touched, seen);
            }
            touched.push(id.to_string());
        }
        _ => {
            place_node(b, id, m);
            touched.push(id.to_string());
        }
    }
}

fn place_node(b: &mut TxBuilder<'_>, id: &str, m: &Affine) {
    let Some(node) = b.design.node(id) else {
        return;
    };
    let base = node.base().clone();
    let (w, h) = (base.width, base.height);
    let world = world_transform(b.design, id);
    let Some(parent_inv) = parent_world_transform(b.design, id).inverse() else {
        return;
    };
    // New local transform of the old-size box inside the parent.
    let local = parent_inv * *m * world;
    let ex = local.apply_vector(Point::new(1.0, 0.0)).length();
    let ey = local.apply_vector(Point::new(0.0, 1.0)).length();
    let kx = if w > EPS && ex > EPS { ex } else { 1.0 };
    let ky = if h > EPS && ey > EPS { ey } else { 1.0 };
    let (nw, nh) = (w * kx, h * ky);
    // Same placement for a box of the new size with a rigid transform.
    let rigid = local * Affine::scale(1.0 / kx, 1.0 / ky);
    let (x, y, rotation, flip_x, flip_y) =
        decompose_prefer(&rigid, nw, nh, base.flipped_x(), base.flipped_y());
    if ![x, y, rotation, nw, nh].iter().all(|v| v.is_finite()) {
        return;
    }

    let mut set = Map::new();
    set.insert("x".into(), num(round_geom(x)));
    set.insert("y".into(), num(round_geom(y)));
    set.insert("width".into(), num(round_geom(nw)));
    set.insert("height".into(), num(round_geom(nh)));
    set.insert("rotation".into(), num(round_geom(rotation)));
    let mut unset: Vec<&str> = Vec::new();
    for (key, on) in [("flipX", flip_x), ("flipY", flip_y)] {
        if on {
            set.insert(key.into(), Value::Bool(true));
        } else {
            unset.push(key);
        }
    }
    let resized_x = (kx - 1.0).abs() > 1e-6;
    let resized_y = (ky - 1.0).abs() > 1e-6;
    match node {
        Node::Path(p) if resized_x || resized_y => {
            let scale = Affine::scale(kx, ky);
            let paths: Vec<Value> = p
                .paths
                .iter()
                .map(|sp| {
                    let mut v = serde_json::to_value(sp).unwrap_or(Value::Null);
                    if let (Ok(parsed), Some(obj)) = (VectorPath::parse(&sp.d), v.as_object_mut()) {
                        obj.insert("d".into(), json!(parsed.transformed(&scale).to_svg()));
                    }
                    v
                })
                .collect();
            set.insert("paths".into(), Value::Array(paths));
        }
        Node::Text(t) => {
            let mode = t.auto_resize.as_str();
            if resized_y && mode != "none" {
                // A dragged height is a fixed box.
                set.insert("autoResize".into(), json!("none"));
            } else if resized_x && mode == "width" {
                // A dragged width wraps: the height follows the text.
                set.insert("autoResize".into(), json!("height"));
            }
        }
        _ => {}
    }
    // Ops that fail to apply (e.g. a node that became invalid) are simply not part of the gesture.
    let _ = b.update(id, set, &unset);
}
