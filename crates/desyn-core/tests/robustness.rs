//! Hostile and extreme documents: every engine entry point must finish quickly, never panic and keep the design
//! valid. Documents reach the engine from untrusted clients and AI output (wasm in the browser, the worker on the
//! server), so absurd but schema-valid values (counts up to 2^53 - 1, coordinates near 1e300) must be harmless.

mod common;

use std::time::{Duration, Instant};

use common::*;
use desyn_core::geometry::Point;
use desyn_core::hit::{HitIndex, HitOptions, hit_test};
use desyn_core::paths::{
    MAX_COORDINATE, MAX_POLYGON_VERTICES, Shape, StrokeStyle, boolean, ellipse_path, flatten_bez,
    node_outline, parse_svg_path, stroke_outline,
};
use desyn_core::snap::SnapTargets;
use desyn_core::*;
use serde_json::json;

/// Runs `f` on a thread and fails when it panics or takes longer than `limit` (generous: debug builds are slow).
fn bounded<T: Send + 'static>(
    name: &str,
    limit: Duration,
    f: impl FnOnce() -> T + Send + 'static,
) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    let start = Instant::now();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(limit) {
        Ok(v) => v,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            panic!("{name}: still running after {:?}", start.elapsed())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => panic!("{name}: panicked"),
    }
}

const LIMIT: Duration = Duration::from_secs(10);

fn hit_opts() -> HitOptions {
    HitOptions {
        tolerance: 2.0,
        deep: true,
        ..Default::default()
    }
}

fn node_json(n: Node) -> serde_json::Value {
    serde_json::to_value(n).unwrap()
}

#[test]
fn counts_accept_every_safe_integer_like_zod() {
    let mut poly = node_json(Node::polygon("aaaaaaaaaaaa", "P", 5, 0.0, 0.0, 10.0, 10.0));
    poly["sides"] = json!(MAX_SAFE_INTEGER);
    let n: Node = serde_json::from_value(poly.clone()).expect("2^53 - 1 sides is a valid count");
    assert!(validate_node(&n).is_ok());
    // zod's z.int() rejects 2^53 and beyond; so does the core.
    poly["sides"] = json!(9_007_199_254_740_992.0);
    assert!(serde_json::from_value::<Node>(poly.clone()).is_err());
    poly["sides"] = json!(4_294_967_296u64);
    assert!(
        serde_json::from_value::<Node>(poly).is_ok(),
        "counts above u32::MAX are valid"
    );

    // The same op the TS applier accepts must apply here too.
    let mut d = design();
    let mut star = node_json(Node::star(
        "bbbbbbbbbbbb",
        "S",
        5,
        0.4,
        0.0,
        0.0,
        10.0,
        10.0,
    ));
    star["points"] = json!(MAX_SAFE_INTEGER);
    let r = apply(
        &mut d,
        &tx_json(json!([{"op": "create", "parent": PAGE, "nodes": [star]}])),
    );
    assert!(r.dropped.is_empty(), "{:?}", r.dropped);
    let canonical = d.canonical_json();
    assert!(
        canonical.contains("\"points\":9007199254740991"),
        "round-trips exactly"
    );
}

#[test]
fn huge_polygons_and_stars_are_bounded() {
    let mut d = design();
    d.push_child(
        PAGE,
        Node::polygon(
            "aaaaaaaaaaaa",
            "P",
            MAX_SAFE_INTEGER,
            0.0,
            0.0,
            400.0,
            400.0,
        ),
    );
    d.push_child(
        PAGE,
        Node::star(
            "bbbbbbbbbbbb",
            "S",
            MAX_SAFE_INTEGER,
            0.5,
            500.0,
            0.0,
            400.0,
            400.0,
        ),
    );
    let (hits, sizes) = bounded("huge polygon / star", LIMIT, move || {
        let hits = (
            hit_test(&d, PAGE, Point::new(200.0, 200.0), &hit_opts()),
            hit_test(&d, PAGE, Point::new(700.0, 200.0), &hit_opts()),
        );
        let sizes = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]
            .map(|id| node_outline(&d, id, 0.2).unwrap().path.elements().len());
        (hits, sizes)
    });
    assert_eq!(hits.0.as_deref(), Some("aaaaaaaaaaaa"));
    assert_eq!(hits.1.as_deref(), Some("bbbbbbbbbbbb"));
    for s in sizes {
        assert!(s as u64 <= MAX_POLYGON_VERTICES + 2, "{s} path elements");
    }
}

#[test]
fn paths_with_huge_coordinates_never_hang_or_panic() {
    for d_str in [
        "M0 0C1e300 0 1e300 1e300 0 1e300Z",
        "M0 0C1e140 0 1e140 1e140 0 1e140Z",
        "M0 0A1e300 1e300 0 1 1 1e300 0Z",
        "M0 0Q1e200 1e200 5 5Z",
        "M0 0L100 0L100 100Z M0 0C1e300 0 1e300 1e300 0 1e300Z",
    ] {
        let s = d_str.to_string();
        bounded(d_str, LIMIT, move || {
            let mut d = design();
            let mut n = Node::path("aaaaaaaaaaaa", "P", s.clone(), 0.0, 0.0, 100.0, 100.0);
            if let Node::Path(p) = &mut n {
                p.shape.strokes = vec![Stroke::solid(Color::new("#000000").unwrap(), 4.0)];
            }
            d.push_child(PAGE, n);
            let _ = hit_test(&d, PAGE, Point::new(5.0, 5.0), &hit_opts());
            let _ = HitIndex::build(&d, PAGE).hit_test(&d, Point::new(50.0, 1.0), &hit_opts());
            let outline = node_outline(&d, "aaaaaaaaaaaa", 0.05).unwrap();
            let _ = flatten_bez(&outline.path, 0.05);
            let shapes = [
                Shape {
                    path: parse_svg_path(&s).unwrap(),
                    fill_rule: FillRule::Nonzero,
                },
                Shape {
                    path: parse_svg_path("M0 0L50 0L50 50Z").unwrap(),
                    fill_rule: FillRule::Evenodd,
                },
            ];
            for op in [
                BoolOp::Union,
                BoolOp::Subtract,
                BoolOp::Intersect,
                BoolOp::Exclude,
            ] {
                let _ = boolean(&shapes, op, 0.05);
            }
        });
    }
}

#[test]
fn out_of_range_paths_flatten_to_nothing() {
    let p = parse_svg_path("M0 0L1e200 0L0 1e200Z").unwrap();
    const { assert!(1e200 > MAX_COORDINATE) };
    assert!(flatten_bez(&p, 0.1).is_empty());
    // In-range huge paths still flatten, with a bounded number of points.
    let p = parse_svg_path("M0 0C1e140 0 1e140 1e140 0 1e140Z").unwrap();
    let polys = flatten_bez(&p, 0.1);
    let n: usize = polys.iter().map(|p| p.points.len()).sum();
    assert!(n > 2 && n < 1 << 20, "{n} points");
}

#[test]
fn huge_shapes_strokes_and_dashes_are_bounded() {
    let els = bounded("ellipse 1e300", LIMIT, || {
        ellipse_path(1e300, 1e300, None).elements().len()
    });
    assert!(els < 200, "{els} elements");
    let els = bounded("hairline dashes on a long line", LIMIT, || {
        let line = parse_svg_path("M0 0L1e12 0").unwrap();
        let style = StrokeStyle {
            width: 2.0,
            cap: StrokeCap::Butt,
            join: StrokeJoin::Round,
            miter_limit: 4.0,
            dash: vec![0.001, 0.001],
        };
        stroke_outline(&line, &style, 0.2).elements().len()
    });
    assert!(
        els < 100,
        "dashes beyond the budget stroke solid ({els} elements)"
    );
    bounded("huge round-capped stroke", LIMIT, || {
        let p = parse_svg_path("M0 0C1e100 0 1e100 1e100 0 1e100").unwrap();
        let style = StrokeStyle {
            width: 1e90,
            cap: StrokeCap::Round,
            join: StrokeJoin::Round,
            miter_limit: 4.0,
            dash: vec![],
        };
        stroke_outline(&p, &style, 0.01)
    });
    bounded("line with huge stroke and caps", LIMIT, || {
        let mut d = design();
        let mut n = Node::line("aaaaaaaaaaaa", "L", 0.0, 0.0, 1e300);
        if let Node::Line(l) = &mut n {
            l.strokes[0].width = 1e300;
            l.start_cap = Cap::Circle;
            l.end_cap = Cap::Arrow;
        }
        d.push_child(PAGE, n);
        let _ = node_outline(&d, "aaaaaaaaaaaa", 0.2);
        hit_test(&d, PAGE, Point::new(50.0, 50.0), &hit_opts())
    });
    bounded("rect with huge smoothed corners", LIMIT, || {
        let mut d = design();
        let mut n = Node::rect("aaaaaaaaaaaa", "R", 0.0, 0.0, 1e300, 1e300);
        if let Node::Rect(r) = &mut n {
            r.shape.corner_radius = CornerRadius::Uniform(1e299);
            r.shape.corner_smoothing = Some(0.6);
        }
        d.push_child(PAGE, n);
        node_outline(&d, "aaaaaaaaaaaa", 0.2).map(|o| o.path.elements().len())
    });
}

#[test]
fn layout_overflow_keeps_the_design_valid() {
    let mut d = design();
    let mut frame = Node::frame("ffffffffffff", "F", 0.0, 0.0, 100.0, 100.0);
    if let Node::Frame(f) = &mut frame {
        f.container.layout = Some(AutoLayout {
            mode: LayoutMode::Row,
            gap: 1.7e308,
            row_gap: None,
            padding: [1.7e308; 4],
            main_align: MainAlign::Center,
            cross_align: CrossAlign::Center,
            wrap: None,
            columns: None,
            reverse: None,
            extra: Default::default(),
        });
    }
    frame.base_mut().sizing = Some(Sizing {
        h: SizingMode::Hug,
        v: SizingMode::Hug,
        extra: Default::default(),
    });
    let mut kids = vec![frame];
    for (i, id) in ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]
        .iter()
        .enumerate()
    {
        kids.push(
            Node::rect(*id, "R", 0.0, 0.0, 1.7e308, 10.0 * i as f64).with_parent("ffffffffffff"),
        );
    }
    if let Node::Frame(f) = &mut kids[0] {
        f.container.children = vec![
            "aaaaaaaaaaaa".into(),
            "bbbbbbbbbbbb".into(),
            "cccccccccccc".into(),
        ];
    }
    let t = tx(vec![Op::create(kids, PAGE, None)]);
    let r = bounded("overflowing auto-layout", LIMIT, move || {
        let r = apply_norm(&mut d, &t);
        (r, d)
    });
    let (r, d) = r;
    assert!(r.dropped.is_empty(), "{:?}", r.dropped);
    assert!(validate_design(&d).is_empty(), "{:?}", validate_design(&d));
    let applied = serde_json::to_string(&r.applied).unwrap();
    assert!(
        !applied.contains("null"),
        "derived updates are JSON numbers: {applied}"
    );
    for n in d.nodes.values() {
        let b = n.base();
        assert!(b.x.is_finite() && b.y.is_finite() && b.width.is_finite() && b.height.is_finite());
    }
}

#[test]
fn huge_grid_column_counts() {
    let mut d = design();
    let mut frame = Node::frame("ffffffffffff", "F", 0.0, 0.0, 300.0, 300.0);
    if let Node::Frame(f) = &mut frame {
        f.container.layout = Some(AutoLayout {
            mode: LayoutMode::Grid,
            gap: 0.0,
            row_gap: None,
            padding: [0.0; 4],
            main_align: MainAlign::Start,
            cross_align: CrossAlign::Start,
            wrap: None,
            columns: Some(MAX_SAFE_INTEGER),
            reverse: None,
            extra: Default::default(),
        });
    }
    d.push_child(PAGE, frame);
    for id in ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"] {
        d.push_child("ffffffffffff", Node::rect(id, "R", 50.0, 50.0, 10.0, 10.0));
    }
    // Page layout grid with an absurd column count.
    if let Some(Node::Page(p)) = d.node_mut(PAGE) {
        p.grid = Some(LayoutGrid {
            columns: MAX_SAFE_INTEGER,
            gutter: 0.0,
            margin: 0.0,
            baseline: Some(1e-300),
            extra: Default::default(),
        });
    }
    let (d, targets) = bounded("huge grid columns", LIMIT, move || {
        let mut d = d;
        desyn_core::layout::normalize_all(&mut d, &mut desyn_core::layout::ApproxMeasurer);
        let t = SnapTargets::for_page(&d, PAGE, &[]);
        (d, t.grid.len())
    });
    assert!(targets <= 10_000, "{targets} grid snap lines");
    // Every item sits in the first row, one tiny column each (the count only shrinks the column width).
    for id in ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"] {
        let (x, y, _, _) = geo(&d, id);
        assert!((0.0..1e-6).contains(&x), "{id}: x = {x}");
        assert_eq!(y, 0.0);
    }
    assert!(validate_design(&d).is_empty());
}

/// A chain of `n` nested containers (`kind` 0 = groups, 1 = booleans, 2 = hugging auto-layout frames) ending in a rect.
fn nested(n: usize, kind: u8) -> Design {
    let mut d = design();
    let mut parent = PAGE.to_string();
    for i in 0..n {
        let id = format!("g{i:011}");
        let node = match kind {
            0 => Node::group(&id, "G", 1.0, 1.0, 10.0, 10.0),
            1 => Node::boolean(&id, "B", BoolOp::Union, 1.0, 1.0, 10.0, 10.0),
            _ => {
                let mut f = Node::frame(&id, "F", 1.0, 1.0, 10.0, 10.0);
                if let Node::Frame(fr) = &mut f {
                    fr.container.layout = Some(AutoLayout {
                        mode: if i % 2 == 0 {
                            LayoutMode::Row
                        } else {
                            LayoutMode::Column
                        },
                        gap: 1.0,
                        row_gap: None,
                        padding: [1.0; 4],
                        main_align: MainAlign::Center,
                        cross_align: CrossAlign::Baseline,
                        wrap: None,
                        columns: None,
                        reverse: None,
                        extra: Default::default(),
                    });
                }
                f.base_mut().sizing = Some(Sizing {
                    h: SizingMode::Hug,
                    v: SizingMode::Fill,
                    extra: Default::default(),
                });
                f
            }
        };
        d.push_child(&parent, node);
        parent = id;
    }
    d.push_child(&parent, Node::rect("leaf00000000", "R", 0.0, 0.0, 5.0, 5.0));
    d
}

/// Every entry point on a chain of 20,000 nested containers, on a thread with a wasm-sized stack (1 MiB in release;
/// debug frames are several times larger, so debug runs get 8 MiB): nothing may overflow the stack, hang or break
/// the design's validity.
#[test]
fn deeply_nested_designs_fit_small_stacks() {
    const DEPTH: usize = 20_000;
    let stack = if cfg!(debug_assertions) {
        8 << 20
    } else {
        1 << 20
    };
    for kind in [0u8, 1, 2] {
        let d = nested(DEPTH, kind);
        let start = Instant::now();
        let h = std::thread::Builder::new()
            .stack_size(stack)
            .spawn(move || {
                let o = hit_opts();
                let leaf = "leaf00000000".to_string();
                let top = "g00000000000".to_string();
                let mut ids = vec![leaf.clone(), PAGE.to_string()];
                d.sort_by_paint_order(&mut ids);
                assert_eq!(ids, [PAGE.to_string(), leaf.clone()]);
                assert_eq!(d.depth(&leaf), DEPTH + 2);
                assert!(validate_design(&d).is_empty());
                let _ = hit_test(&d, PAGE, Point::new(3.0, 3.0), &o);
                let _ = desyn_core::hit::nodes_at(&d, PAGE, Point::new(3.0, 3.0), &o);
                let _ = HitIndex::build(&d, PAGE).hit_test(&d, Point::new(3.0, 3.0), &o);
                let _ = node_outline(&d, &top, 0.2);
                let _ = desyn_core::geometry::node_aabb(&d, &leaf);
                let _ = SnapTargets::for_page(&d, PAGE, std::slice::from_ref(&leaf));
                // Diff both ways reconstructs the design.
                let empty = design();
                let mut rebuilt = empty.clone();
                let r = apply(
                    &mut rebuilt,
                    &desyn_core::diff::diff_designs(&empty, &d, "tx0000000002"),
                );
                assert!(r.dropped.is_empty());
                assert_eq!(rebuilt.canonical_json(), d.canonical_json());
                let _ = desyn_core::diff::diff_ops(&d, &empty);
                let mut ids = desyn_core::ids::SequentialIds::new("n");
                let c =
                    desyn_core::clipboard::clone_subtree(&d, &top, &mut ids, &Default::default());
                assert!(c.is_some());
                assert!(desyn_core::clipboard::copy(&d, std::slice::from_ref(&top)).is_some());
                // Normalization and a normalized round trip.
                let mut n = d.clone();
                desyn_core::layout::normalize_all(&mut n, &mut desyn_core::layout::ApproxMeasurer);
                assert!(validate_design(&n).is_empty());
                let before = n.canonical_json();
                let t = tx_json(json!([
                    {"op": "update", "id": top, "set": {"width": 50, "height": 50}},
                    {"op": "update", "id": leaf, "set": {"width": 7}}
                ]));
                let r = apply_norm(&mut n, &t);
                assert!(r.dropped.is_empty());
                let inv = apply(&mut n, &r.inverse);
                assert!(inv.dropped.is_empty());
                assert_eq!(n.canonical_json(), before);
                // Deleting and restoring the whole chain.
                let r = apply(&mut n, &tx_json(json!([{"op": "delete", "id": top}])));
                assert!(r.dropped.is_empty());
                assert!(apply(&mut n, &r.inverse).dropped.is_empty());
                assert_eq!(n.canonical_json(), before);
            })
            .unwrap();
        assert!(h.join().is_ok(), "kind {kind}: panicked");
        assert!(
            start.elapsed() < Duration::from_secs(60),
            "kind {kind}: took {:?}",
            start.elapsed()
        );
    }
}
