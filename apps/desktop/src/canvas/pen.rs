//! The pen tool and bezier path editing. Paths are edited as anchors with in / out handles in page coordinates
//! and written back as `path` nodes (SVG path data in the node's local box, DOCUMENT_MODEL §3), keeping the node's
//! rotation and flips.
//!
//! Drawing: click adds a corner anchor, click-drag pulls symmetric handles (alt: only the outgoing handle),
//! clicking the first anchor closes the path, Enter / Escape / double-click finishes, Backspace removes the last
//! anchor. Editing (double-click a path, or Enter on a selected path): drag anchors and handles (alt breaks the
//! handle symmetry), click a segment to insert an anchor, double-click an anchor to toggle smooth / corner,
//! Delete removes the selected anchor, clicking outside or Escape commits.

use desyn_core::Op;
use desyn_core::builder::decompose_prefer;
use desyn_core::geometry::{Affine, Point, Rect, parent_world_transform, world_transform};
use desyn_core::model::{Design, FillRule, Id, Node, NodeType, PathData, Stroke};
use desyn_core::paths::kurbo::{self, BezPath, PathEl};
use desyn_core::paths::{bez_bounds, bez_to_svg, parse_svg_path};
use serde_json::{Map, json};

use crate::doc::edit::num;

/// One anchor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Anchor {
    /// Position (page coordinates).
    pub p: Point,
    /// Incoming handle (equal to `p` when absent).
    pub hin: Point,
    /// Outgoing handle (equal to `p` when absent).
    pub hout: Point,
}

impl Anchor {
    /// Corner anchor without handles.
    pub fn corner(p: Point) -> Anchor {
        Anchor { p, hin: p, hout: p }
    }

    /// Has visible handles.
    pub fn is_smooth(&self) -> bool {
        self.hin.distance(self.p) > 1e-6 || self.hout.distance(self.p) > 1e-6
    }

    fn translate(&mut self, d: Point) {
        self.p = self.p + d;
        self.hin = self.hin + d;
        self.hout = self.hout + d;
    }
}

/// A sub-path.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SubPath {
    /// Anchors in order.
    pub anchors: Vec<Anchor>,
    /// Closed with Z.
    pub closed: bool,
    /// Index of the node `paths` entry it came from (fill rule group).
    pub group: usize,
}

/// Which handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// Incoming.
    In,
    /// Outgoing.
    Out,
}

/// Something under the pointer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PenHit {
    /// An anchor `(sub, index)`.
    Anchor(usize, usize),
    /// A handle.
    Handle(usize, usize, Side),
    /// A segment from anchor `index` to the next, at curve parameter `t`.
    Segment(usize, usize, f64),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Drag {
    /// New anchor being pulled out (drawing).
    Pull {
        sub: usize,
        idx: usize,
        break_symmetry: bool,
    },
    /// Moving an anchor.
    Anchor { sub: usize, idx: usize, last: Point },
    /// Moving a handle.
    Handle {
        sub: usize,
        idx: usize,
        side: Side,
        break_symmetry: bool,
    },
}

/// A pen session (drawing a new path or editing one).
#[derive(Debug, Clone)]
pub struct PenSession {
    /// Path node being edited (`None` while drawing a new path).
    pub target: Option<Id>,
    /// Parent for a new path.
    pub parent: Id,
    /// Sub-paths in page coordinates.
    pub subs: Vec<SubPath>,
    /// Fill rules of the node's `paths` groups.
    pub rules: Vec<FillRule>,
    /// Drawing mode: clicks add anchors to the last sub-path.
    pub drawing: bool,
    /// Selected anchor.
    pub selected: Option<(usize, usize)>,
    /// Pointer position for the rubber band.
    pub hover: Option<Point>,
    drag: Option<Drag>,
    /// Something changed (preview needed).
    pub dirty: bool,
}

/// Bezier from sub-paths.
pub fn to_bez(subs: &[SubPath], group: Option<usize>) -> BezPath {
    let mut b = BezPath::new();
    let kp = |p: Point| kurbo::Point::new(p.x, p.y);
    for s in subs.iter().filter(|s| group.is_none_or(|g| s.group == g)) {
        let Some(first) = s.anchors.first() else {
            continue;
        };
        b.move_to(kp(first.p));
        let n = s.anchors.len();
        let segs = if s.closed { n } else { n.saturating_sub(1) };
        for i in 0..segs {
            let a = s.anchors[i];
            let c = s.anchors[(i + 1) % n];
            if a.hout.distance(a.p) < 1e-9 && c.hin.distance(c.p) < 1e-9 {
                b.line_to(kp(c.p));
            } else {
                b.curve_to(kp(a.hout), kp(c.hin), kp(c.p));
            }
        }
        if s.closed {
            b.close_path();
        }
    }
    b
}

/// Parses path data into sub-paths, mapping points through `t` (local box -> page).
pub fn parse(d: &str, t: &Affine, group: usize) -> Vec<SubPath> {
    let Ok(b) = parse_svg_path(d) else {
        return Vec::new();
    };
    let mut out: Vec<SubPath> = Vec::new();
    let m = |p: kurbo::Point| t.apply(Point::new(p.x, p.y));
    let mut cur: Option<SubPath> = None;
    let mut last = kurbo::Point::ZERO;
    for el in b.elements() {
        match *el {
            PathEl::MoveTo(p) => {
                if let Some(s) = cur.take().filter(|s| !s.anchors.is_empty()) {
                    out.push(s);
                }
                cur = Some(SubPath {
                    anchors: vec![Anchor::corner(m(p))],
                    closed: false,
                    group,
                });
                last = p;
            }
            PathEl::LineTo(p) => {
                cur.get_or_insert_with(|| SubPath {
                    anchors: vec![Anchor::corner(m(last))],
                    closed: false,
                    group,
                })
                .anchors
                .push(Anchor::corner(m(p)));
                last = p;
            }
            PathEl::QuadTo(q, p) => {
                let c1 = last + (q - last) * (2.0 / 3.0);
                let c2 = p + (q - p) * (2.0 / 3.0);
                push_curve(&mut cur, m(c1), m(c2), m(p), m(last), group);
                last = p;
            }
            PathEl::CurveTo(c1, c2, p) => {
                push_curve(&mut cur, m(c1), m(c2), m(p), m(last), group);
                last = p;
            }
            PathEl::ClosePath => {
                if let Some(mut s) = cur.take() {
                    s.closed = true;
                    // A final anchor on top of the first one is the same anchor.
                    if s.anchors.len() > 1 {
                        let lastp = *s.anchors.last().expect("non-empty");
                        if lastp.p.distance(s.anchors[0].p) < 1e-6 {
                            s.anchors.pop();
                            s.anchors[0].hin = lastp.hin;
                        }
                    }
                    if let Some(first) = s.anchors.first() {
                        last = kurbo::Point::new(first.p.x, first.p.y);
                        if let Some(inv) = t.inverse() {
                            let lp = inv.apply(first.p);
                            last = kurbo::Point::new(lp.x, lp.y);
                        }
                    }
                    out.push(s);
                }
            }
        }
    }
    if let Some(s) = cur.filter(|s| !s.anchors.is_empty()) {
        out.push(s);
    }
    out
}

fn push_curve(
    cur: &mut Option<SubPath>,
    c1: Point,
    c2: Point,
    p: Point,
    start: Point,
    group: usize,
) {
    let s = cur.get_or_insert_with(|| SubPath {
        anchors: vec![Anchor::corner(start)],
        closed: false,
        group,
    });
    if let Some(prev) = s.anchors.last_mut() {
        prev.hout = c1;
    }
    s.anchors.push(Anchor {
        p,
        hin: c2,
        hout: p,
    });
}

fn cubic_point(a: Point, b: Point, c: Point, d: Point, t: f64) -> Point {
    let mt = 1.0 - t;
    a * (mt * mt * mt) + b * (3.0 * mt * mt * t) + c * (3.0 * mt * t * t) + d * (t * t * t)
}

impl PenSession {
    /// Starts drawing a new path into `parent`.
    pub fn draw(parent: Id) -> PenSession {
        PenSession {
            target: None,
            parent,
            subs: Vec::new(),
            rules: vec![FillRule::Nonzero],
            drawing: true,
            selected: None,
            hover: None,
            drag: None,
            dirty: false,
        }
    }

    /// Starts editing a path node.
    pub fn edit(d: &Design, id: &str) -> Option<PenSession> {
        let Some(Node::Path(p)) = d.node(id) else {
            return None;
        };
        let w = world_transform(d, id);
        let mut subs = Vec::new();
        let mut rules = Vec::new();
        for (g, pd) in p.paths.iter().enumerate() {
            subs.extend(parse(&pd.d, &w, g));
            rules.push(pd.fill_rule);
        }
        Some(PenSession {
            target: Some(id.to_string()),
            parent: p.base.parent.clone().unwrap_or_default(),
            subs,
            rules,
            drawing: false,
            selected: None,
            hover: None,
            drag: None,
            dirty: false,
        })
    }

    /// Whether a drag is in progress.
    pub fn dragging(&self) -> bool {
        self.drag.is_some()
    }

    /// Hit test in page coordinates with a tolerance in page px.
    pub fn hit(&self, p: Point, tol: f64) -> Option<PenHit> {
        if let Some((si, ai)) = self.selected {
            let a = self.subs.get(si)?.anchors.get(ai)?;
            for (side, h) in [(Side::In, a.hin), (Side::Out, a.hout)] {
                if h.distance(a.p) > 1e-6 && h.distance(p) <= tol {
                    return Some(PenHit::Handle(si, ai, side));
                }
            }
        }
        for (si, s) in self.subs.iter().enumerate() {
            for (ai, a) in s.anchors.iter().enumerate() {
                if a.p.distance(p) <= tol {
                    return Some(PenHit::Anchor(si, ai));
                }
            }
        }
        for (si, s) in self.subs.iter().enumerate() {
            let n = s.anchors.len();
            let segs = if s.closed { n } else { n.saturating_sub(1) };
            for i in 0..segs {
                let a = s.anchors[i];
                let c = s.anchors[(i + 1) % n];
                let mut best: Option<(f64, f64)> = None;
                let steps = 48;
                for k in 0..=steps {
                    let t = k as f64 / steps as f64;
                    let q = cubic_point(a.p, a.hout, c.hin, c.p, t);
                    let dist = q.distance(p);
                    if best.is_none_or(|b| dist < b.0) {
                        best = Some((dist, t));
                    }
                }
                if let Some((dist, t)) = best
                    && dist <= tol
                    && t > 0.02
                    && t < 0.98
                {
                    return Some(PenHit::Segment(si, i, t));
                }
            }
        }
        None
    }

    /// Pointer down. `close_tol` = page distance that counts as clicking an anchor. Returns `false` when the
    /// click is outside the path in edit mode (the caller then commits and leaves).
    pub fn pointer_down(&mut self, p: Point, tol: f64, alt: bool, click_count: usize) -> bool {
        if self.drawing {
            if self.subs.is_empty() {
                self.subs.push(SubPath::default());
            }
            let si = self.subs.len() - 1;
            let s = &mut self.subs[si];
            if click_count >= 2 {
                // Double click finishes (the first click of the pair already placed the anchor).
                self.drawing = false;
                return true;
            }
            if s.anchors.len() >= 2 && s.anchors[0].p.distance(p) <= tol {
                s.closed = true;
                self.drawing = false;
                self.drag = Some(Drag::Handle {
                    sub: si,
                    idx: 0,
                    side: Side::In,
                    break_symmetry: alt,
                });
                self.selected = Some((si, 0));
                self.dirty = true;
                return true;
            }
            s.anchors.push(Anchor::corner(p));
            let idx = s.anchors.len() - 1;
            self.selected = Some((si, idx));
            self.drag = Some(Drag::Pull {
                sub: si,
                idx,
                break_symmetry: alt,
            });
            self.dirty = true;
            return true;
        }
        match self.hit(p, tol) {
            Some(PenHit::Handle(sub, idx, side)) => {
                self.drag = Some(Drag::Handle {
                    sub,
                    idx,
                    side,
                    break_symmetry: alt,
                });
                true
            }
            Some(PenHit::Anchor(sub, idx)) => {
                if click_count >= 2 {
                    self.toggle_smooth(sub, idx);
                }
                self.selected = Some((sub, idx));
                self.drag = Some(Drag::Anchor { sub, idx, last: p });
                true
            }
            Some(PenHit::Segment(sub, idx, t)) => {
                let new = self.split(sub, idx, t);
                self.selected = Some((sub, new));
                self.drag = Some(Drag::Anchor {
                    sub,
                    idx: new,
                    last: p,
                });
                self.dirty = true;
                true
            }
            None => false,
        }
    }

    /// Pointer move.
    pub fn pointer_move(&mut self, p: Point, alt: bool) {
        self.hover = Some(p);
        let Some(drag) = self.drag else { return };
        match drag {
            Drag::Pull {
                sub,
                idx,
                break_symmetry,
            } => {
                let Some(a) = self.subs.get_mut(sub).and_then(|s| s.anchors.get_mut(idx)) else {
                    return;
                };
                a.hout = p;
                if !(break_symmetry || alt) {
                    a.hin = a.p * 2.0 - p;
                }
            }
            Drag::Anchor { sub, idx, last } => {
                let Some(a) = self.subs.get_mut(sub).and_then(|s| s.anchors.get_mut(idx)) else {
                    return;
                };
                a.translate(p - last);
                self.drag = Some(Drag::Anchor { sub, idx, last: p });
            }
            Drag::Handle {
                sub,
                idx,
                side,
                break_symmetry,
            } => {
                let Some(a) = self.subs.get_mut(sub).and_then(|s| s.anchors.get_mut(idx)) else {
                    return;
                };
                let (this, other) = match side {
                    Side::In => (&mut a.hin, &mut a.hout),
                    Side::Out => (&mut a.hout, &mut a.hin),
                };
                *this = p;
                if !(break_symmetry || alt) {
                    // Keep the opposite handle collinear, preserving its length.
                    let len = other.distance(a.p);
                    let dir = (a.p - p).normalize();
                    if len > 1e-6 {
                        *other = a.p + dir * len;
                    } else {
                        *other = a.p * 2.0 - p;
                    }
                }
            }
        }
        self.dirty = true;
    }

    /// Pointer up.
    pub fn pointer_up(&mut self) {
        self.drag = None;
    }

    /// Splits segment `idx` of `sub` at `t`; returns the new anchor index.
    pub fn split(&mut self, sub: usize, idx: usize, t: f64) -> usize {
        let s = &mut self.subs[sub];
        let n = s.anchors.len();
        let a = s.anchors[idx];
        let c = s.anchors[(idx + 1) % n];
        // de Casteljau.
        let p01 = a.p.lerp(a.hout, t);
        let p12 = a.hout.lerp(c.hin, t);
        let p23 = c.hin.lerp(c.p, t);
        let p012 = p01.lerp(p12, t);
        let p123 = p12.lerp(p23, t);
        let m = p012.lerp(p123, t);
        let straight = a.hout.distance(a.p) < 1e-9 && c.hin.distance(c.p) < 1e-9;
        let new = if straight {
            Anchor::corner(m)
        } else {
            Anchor {
                p: m,
                hin: p012,
                hout: p123,
            }
        };
        if !straight {
            s.anchors[idx].hout = p01;
            let ci = (idx + 1) % n;
            s.anchors[ci].hin = p23;
        }
        s.anchors.insert(idx + 1, new);
        idx + 1
    }

    /// Toggles an anchor between corner and smooth.
    pub fn toggle_smooth(&mut self, sub: usize, idx: usize) {
        let s = &mut self.subs[sub];
        let n = s.anchors.len();
        let a = s.anchors[idx];
        if a.is_smooth() {
            s.anchors[idx] = Anchor::corner(a.p);
        } else if n >= 2 {
            let prev = if idx > 0 {
                s.anchors[idx - 1].p
            } else if s.closed {
                s.anchors[n - 1].p
            } else {
                a.p
            };
            let next = if idx + 1 < n {
                s.anchors[idx + 1].p
            } else if s.closed {
                s.anchors[0].p
            } else {
                a.p
            };
            let dir = (next - prev).normalize();
            let len_in = a.p.distance(prev) / 3.0;
            let len_out = a.p.distance(next) / 3.0;
            s.anchors[idx].hin = a.p - dir * len_in.max(1.0);
            s.anchors[idx].hout = a.p + dir * len_out.max(1.0);
        }
        self.dirty = true;
    }

    /// Removes the selected anchor (drawing: the last one). Returns `false` when nothing is left.
    pub fn remove_selected(&mut self) -> bool {
        let target = if self.drawing {
            self.subs
                .last()
                .and_then(|s| s.anchors.len().checked_sub(1))
                .map(|i| (self.subs.len() - 1, i))
        } else {
            self.selected
        };
        if let Some((si, ai)) = target
            && let Some(s) = self.subs.get_mut(si)
            && ai < s.anchors.len()
        {
            s.anchors.remove(ai);
            if s.anchors.len() < 2 {
                s.closed = false;
            }
            if s.anchors.is_empty() {
                self.subs.remove(si);
            }
            self.selected = None;
            self.dirty = true;
        }
        self.subs.iter().any(|s| s.anchors.len() >= 2)
            || (self.drawing && self.subs.iter().any(|s| !s.anchors.is_empty()))
    }

    /// Ops that write the session into the document (create or update the path node). `None` when the path has
    /// fewer than two anchors.
    pub fn ops(&self, d: &Design, new_id: impl FnOnce() -> Id) -> Option<Vec<Op>> {
        if !self.subs.iter().any(|s| s.anchors.len() >= 2) {
            return None;
        }
        let page_bez = to_bez(&self.subs, None);
        match &self.target {
            None => {
                let parent_world = match d.node(&self.parent).map(|n| n.node_type()) {
                    Some(NodeType::Page) | Some(NodeType::Root) | None => Affine::IDENTITY,
                    _ => world_transform(d, &self.parent),
                };
                let inv = parent_world.inverse().unwrap_or(Affine::IDENTITY);
                let local = transform_bez(&page_bez, &inv);
                let r = bez_bounds(&local).unwrap_or_default();
                let path = transform_bez(&local, &Affine::translate(-r.x, -r.y));
                let closed = self.subs.iter().any(|s| s.closed);
                let mut node = Node::path(
                    new_id(),
                    "Path",
                    bez_to_svg(&path),
                    r.x,
                    r.y,
                    r.w.max(0.0),
                    r.h.max(0.0),
                );
                if let Some(sh) = node.shaped_mut() {
                    if !closed {
                        sh.fills.clear();
                    }
                    sh.strokes = vec![Stroke::solid(
                        desyn_core::model::Color::new("#111111").expect("color"),
                        2.0,
                    )];
                }
                Some(vec![Op::create(vec![node], self.parent.clone(), None)])
            }
            Some(id) => {
                let n = d.node(id)?;
                let base = n.base().clone();
                let w = world_transform(d, id);
                let winv = w.inverse()?;
                let local_all = transform_bez(&page_bez, &winv);
                let r = bez_bounds(&local_all).unwrap_or(Rect {
                    x: 0.0,
                    y: 0.0,
                    w: base.width,
                    h: base.height,
                });
                let shift = Affine::translate(-r.x, -r.y);
                let paths: Vec<PathData> = self
                    .rules
                    .iter()
                    .enumerate()
                    .map(|(g, rule)| PathData {
                        d: bez_to_svg(&transform_bez(
                            &transform_bez(&to_bez(&self.subs, Some(g)), &winv),
                            &shift,
                        )),
                        fill_rule: *rule,
                        extra: Default::default(),
                    })
                    .filter(|p| !p.d.is_empty())
                    .collect();
                // New world transform: the old one shifted to the new box origin.
                let new_world = w * Affine::translate(r.x, r.y);
                let parent = match d
                    .node(base.parent.as_deref().unwrap_or("root"))
                    .map(|n| n.node_type())
                {
                    Some(NodeType::Page) | Some(NodeType::Root) | None => Affine::IDENTITY,
                    _ => parent_world_transform(d, id),
                };
                let local = parent.inverse().unwrap_or(Affine::IDENTITY) * new_world;
                let (x, y, rot, fx, fy) =
                    decompose_prefer(&local, r.w, r.h, base.flipped_x(), base.flipped_y());
                let mut set = Map::new();
                set.insert("paths".into(), serde_json::to_value(paths).ok()?);
                set.insert("x".into(), num(x));
                set.insert("y".into(), num(y));
                set.insert("width".into(), num(r.w.max(0.0)));
                set.insert("height".into(), num(r.h.max(0.0)));
                set.insert("rotation".into(), num(rot));
                set.insert("flipX".into(), json!(fx));
                set.insert("flipY".into(), json!(fy));
                Some(vec![Op::update_set(id.clone(), set)])
            }
        }
    }
}

/// Maps a bezier through an affine transform.
pub fn transform_bez(b: &BezPath, t: &Affine) -> BezPath {
    let mut out = b.clone();
    out.apply_affine(t.to_kurbo());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::Document;
    use desyn_core::layout::ApproxMeasurer;
    use desyn_core::model::DesignKind;

    #[test]
    fn draw_a_closed_curve() {
        let mut doc = Document::blank("P", DesignKind::Poster, 500.0, 500.0);
        let page = doc.design.page_ids()[0].clone();
        let mut s = PenSession::draw(page);
        s.pointer_down(Point::new(100.0, 100.0), 4.0, false, 1);
        s.pointer_up();
        s.pointer_down(Point::new(200.0, 100.0), 4.0, false, 1);
        s.pointer_move(Point::new(240.0, 140.0), false);
        s.pointer_up();
        let a = s.subs[0].anchors[1];
        assert_eq!(a.hout, Point::new(240.0, 140.0));
        assert_eq!(a.hin, Point::new(160.0, 60.0), "symmetric handle");
        s.pointer_down(Point::new(150.0, 200.0), 4.0, false, 1);
        s.pointer_up();
        // Click near the first anchor closes and finishes.
        s.pointer_down(Point::new(101.0, 101.0), 4.0, false, 1);
        s.pointer_up();
        assert!(s.subs[0].closed && !s.drawing);
        let ops = s.ops(&doc.design, || "pathpathpath".into()).unwrap();
        doc.apply(ops, "Draw path", &mut ApproxMeasurer).unwrap();
        let Some(Node::Path(p)) = doc.design.node("pathpathpath") else {
            panic!()
        };
        assert!(
            p.paths[0].d.contains('C') && p.paths[0].d.ends_with('Z'),
            "{}",
            p.paths[0].d
        );
        assert_eq!(p.base.x, 100.0);
        assert!(!p.shape.fills.is_empty() && !p.shape.strokes.is_empty());
        // Edit: parse back to the same anchors in page space.
        let e = PenSession::edit(&doc.design, "pathpathpath").unwrap();
        assert_eq!(e.subs[0].anchors.len(), 3);
        for (x, y) in e.subs[0].anchors.iter().zip(&s.subs[0].anchors) {
            assert!(
                x.p.distance(y.p) < 1e-3
                    && x.hin.distance(y.hin) < 1e-3
                    && x.hout.distance(y.hout) < 1e-3
            );
        }
    }

    #[test]
    fn edit_rotated_path_keeps_world_position() {
        let mut doc = Document::blank("P", DesignKind::Poster, 500.0, 500.0);
        let page = doc.design.page_ids()[0].clone();
        let mut n = Node::path(
            "pathpathpath",
            "P",
            "M0 0L100 0L100 50",
            100.0,
            100.0,
            100.0,
            50.0,
        );
        n.base_mut().rotation = 30.0;
        doc.apply(
            vec![Op::create(vec![n], page, None)],
            "add",
            &mut ApproxMeasurer,
        );
        let mut e = PenSession::edit(&doc.design, "pathpathpath").unwrap();
        let before: Vec<Point> = e.subs[0].anchors.iter().map(|a| a.p).collect();
        // Drag the last anchor outward, then insert a point on the first segment.
        let last = before[2];
        assert!(e.pointer_down(last, 2.0, false, 1));
        e.pointer_move(last + Point::new(30.0, 30.0), false);
        e.pointer_up();
        let mid = before[0].lerp(before[1], 0.5);
        assert!(e.pointer_down(mid, 2.0, false, 1));
        e.pointer_up();
        assert!(
            !e.pointer_down(Point::new(10.0, 450.0), 2.0, false, 1),
            "outside"
        );
        let ops = e.ops(&doc.design, || unreachable!()).unwrap();
        doc.apply(ops, "edit", &mut ApproxMeasurer).unwrap();
        let again = PenSession::edit(&doc.design, "pathpathpath").unwrap();
        let pts: Vec<Point> = again.subs[0].anchors.iter().map(|a| a.p).collect();
        assert_eq!(pts.len(), 4);
        assert!(pts[0].distance(before[0]) < 1e-3);
        assert!(pts[1].distance(mid) < 1e-3);
        assert!(pts[3].distance(last + Point::new(30.0, 30.0)) < 1e-3);
        assert!((doc.design.node("pathpathpath").unwrap().base().rotation - 30.0).abs() < 1e-6);
    }

    #[test]
    fn remove_and_toggle() {
        let mut s = PenSession::draw("p".into());
        for x in [0.0, 50.0, 100.0] {
            s.pointer_down(Point::new(x, 0.0), 1.0, false, 1);
            s.pointer_up();
        }
        assert!(s.remove_selected());
        assert_eq!(s.subs[0].anchors.len(), 2);
        s.drawing = false;
        s.toggle_smooth(0, 1);
        assert!(s.subs[0].anchors[1].is_smooth());
        s.toggle_smooth(0, 1);
        assert!(!s.subs[0].anchors[1].is_smooth());
    }
}
