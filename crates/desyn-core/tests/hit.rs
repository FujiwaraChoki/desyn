mod common;

use common::*;
use desyn_core::geometry::{Point, Rect};
use desyn_core::hit::*;
use desyn_core::*;

fn p(x: f64, y: f64) -> Point {
    Point::new(x, y)
}

fn scene() -> Design {
    let mut d = design();
    d.push_child(
        PAGE,
        Node::rect("rectbottom01", "bottom", 0.0, 0.0, 200.0, 200.0),
    );
    d.push_child(
        PAGE,
        Node::ellipse("ellipse00001", "ellipse", 100.0, 100.0, 100.0, 100.0),
    );
    let mut rot = Node::rect("rotated00001", "rot", 400.0, 400.0, 200.0, 20.0);
    rot.base_mut().rotation = 90.0;
    d.push_child(PAGE, rot);
    let mut g = Node::group("group0000001", "g", 600.0, 0.0, 100.0, 100.0);
    if let Node::Group(gr) = &mut g {
        gr.container.children.clear();
    }
    d.push_child(PAGE, g);
    d.push_child(
        "group0000001",
        Node::rect("ingroup00001", "in", 0.0, 0.0, 50.0, 50.0),
    );
    let mut f = Node::frame("frame0000001", "frame", 0.0, 600.0, 100.0, 100.0);
    if let Node::Frame(fr) = &mut f {
        fr.container.clip = true;
    }
    d.push_child(PAGE, f);
    d.push_child(
        "frame0000001",
        Node::rect("clipped00001", "clipped", 50.0, 50.0, 200.0, 200.0),
    );
    d
}

#[test]
fn topmost_and_shapes() {
    let d = scene();
    let o = HitOptions::default();
    assert_eq!(
        hit_test(&d, PAGE, p(10.0, 10.0), &o).as_deref(),
        Some("rectbottom01")
    );
    assert_eq!(
        hit_test(&d, PAGE, p(150.0, 150.0), &o).as_deref(),
        Some("ellipse00001")
    );
    // Ellipse corner region falls through to the rect below.
    assert_eq!(
        hit_test(&d, PAGE, p(105.0, 105.0), &o).as_deref(),
        Some("rectbottom01")
    );
    assert_eq!(hit_test(&d, PAGE, p(300.0, 300.0), &o), None);
}

#[test]
fn rotation_groups_and_clip() {
    let d = scene();
    let o = HitOptions::default();
    // Rect rotated 90° about its center (500, 410): it now spans x 490..510, y 310..510.
    assert_eq!(
        hit_test(&d, PAGE, p(500.0, 320.0), &o).as_deref(),
        Some("rotated00001")
    );
    assert_eq!(hit_test(&d, PAGE, p(420.0, 410.0), &o), None);
    // Shallow hit returns the group, deep returns the child; empty group area is not hit.
    assert_eq!(
        hit_test(&d, PAGE, p(610.0, 10.0), &o).as_deref(),
        Some("group0000001")
    );
    assert_eq!(
        hit_test(&d, PAGE, p(610.0, 10.0), &HitOptions { deep: true, ..o }).as_deref(),
        Some("ingroup00001")
    );
    assert_eq!(hit_test(&d, PAGE, p(690.0, 90.0), &o), None);
    assert_eq!(
        hit_path(&d, PAGE, p(610.0, 10.0), &o).unwrap(),
        vec!["group0000001".to_string(), "ingroup00001".to_string()]
    );
    // Clipped child outside the frame is not hit.
    assert_eq!(
        hit_test(&d, PAGE, p(140.0, 690.0), &HitOptions { deep: true, ..o }),
        None
    );
    assert_eq!(
        hit_test(&d, PAGE, p(90.0, 690.0), &HitOptions { deep: true, ..o }).as_deref(),
        Some("clipped00001")
    );
    // Frame background itself is hittable.
    assert_eq!(
        hit_test(&d, PAGE, p(10.0, 610.0), &HitOptions { deep: true, ..o }).as_deref(),
        Some("frame0000001")
    );
}

#[test]
fn locked_hidden_and_tolerance() {
    let mut d = scene();
    d.node_mut("ellipse00001").unwrap().base_mut().locked = true;
    let o = HitOptions::default();
    assert_eq!(
        hit_test(&d, PAGE, p(150.0, 150.0), &o).as_deref(),
        Some("rectbottom01")
    );
    assert_eq!(
        hit_test(
            &d,
            PAGE,
            p(150.0, 150.0),
            &HitOptions {
                include_locked: true,
                ..o
            }
        )
        .as_deref(),
        Some("ellipse00001")
    );
    d.node_mut("rectbottom01").unwrap().base_mut().visible = false;
    assert_eq!(hit_test(&d, PAGE, p(10.0, 10.0), &o), None);
    // Tolerance extends hits just outside a shape.
    assert_eq!(hit_test(&d, PAGE, p(511.0, 320.0), &o), None);
    assert_eq!(
        hit_test(
            &d,
            PAGE,
            p(511.0, 320.0),
            &HitOptions {
                tolerance: 2.0,
                ..o
            }
        )
        .as_deref(),
        Some("rotated00001")
    );
}

#[test]
fn strokes_lines_and_masks() {
    let mut d = design();
    // Unfilled rect with a stroke: only the band hits.
    let mut r = Node::rect("strokerect01", "s", 10.0, 10.0, 100.0, 100.0);
    if let Node::Rect(rr) = &mut r {
        rr.shape.fills.clear();
        rr.shape.strokes = vec![Stroke::solid(Color::new("#000000").unwrap(), 4.0)];
    }
    d.push_child(PAGE, r);
    let o = HitOptions::default();
    assert_eq!(hit_test(&d, PAGE, p(60.0, 60.0), &o), None);
    assert_eq!(
        hit_test(&d, PAGE, p(11.0, 60.0), &o).as_deref(),
        Some("strokerect01")
    );
    assert_eq!(
        hit_test(&d, PAGE, p(8.5, 60.0), &o).as_deref(),
        Some("strokerect01")
    );
    assert_eq!(hit_test(&d, PAGE, p(7.5, 60.0), &o), None);
    // Slop reaches across the page edge, content beyond the clip plus slop is not hit.
    assert_eq!(
        hit_test(
            &d,
            PAGE,
            p(-1.0, 60.0),
            &HitOptions {
                tolerance: 20.0,
                ..o
            }
        )
        .as_deref(),
        Some("strokerect01")
    );
    assert_eq!(
        hit_test(
            &d,
            PAGE,
            p(-30.0, 60.0),
            &HitOptions {
                tolerance: 20.0,
                ..o
            }
        ),
        None
    );
    // Line with an arrow head.
    let mut l = Node::line("line00000001", "l", 200.0, 200.0, 100.0);
    if let Node::Line(ln) = &mut l {
        ln.end_cap = Cap::Triangle;
    }
    d.push_child(PAGE, l);
    assert_eq!(
        hit_test(&d, PAGE, p(250.0, 200.5), &o).as_deref(),
        Some("line00000001")
    );
    assert_eq!(hit_test(&d, PAGE, p(250.0, 205.0), &o), None);
    assert_eq!(
        hit_test(&d, PAGE, p(295.0, 202.0), &o).as_deref(),
        Some("line00000001"),
        "inside the arrow head"
    );
    // Mask: an ellipse mask limits the following sibling.
    let mut m = Node::ellipse("maskellipse1", "mask", 500.0, 500.0, 100.0, 100.0);
    m.base_mut().mask = Some(true);
    d.push_child(PAGE, m);
    d.push_child(
        PAGE,
        Node::rect("maskedrect01", "masked", 500.0, 500.0, 100.0, 100.0),
    );
    assert_eq!(
        hit_test(&d, PAGE, p(550.0, 550.0), &o).as_deref(),
        Some("maskedrect01")
    );
    assert_eq!(
        hit_test(&d, PAGE, p(502.0, 502.0), &o),
        None,
        "corner is outside the ellipse mask"
    );
}

#[test]
fn marquee_and_nodes_at() {
    let d = scene();
    let o = HitOptions::default();
    let contain = marquee(
        &d,
        PAGE,
        Rect::new(-10.0, -10.0, 260.0, 260.0),
        MarqueeMode::Contain,
        &o,
    );
    assert_eq!(
        contain,
        vec!["rectbottom01".to_string(), "ellipse00001".to_string()]
    );
    let inter = marquee(
        &d,
        PAGE,
        Rect::new(150.0, 150.0, 10.0, 10.0),
        MarqueeMode::Intersect,
        &o,
    );
    assert_eq!(
        inter,
        vec!["rectbottom01".to_string(), "ellipse00001".to_string()]
    );
    let deep = marquee(
        &d,
        PAGE,
        Rect::new(590.0, -10.0, 70.0, 70.0),
        MarqueeMode::Contain,
        &HitOptions { deep: true, ..o },
    );
    assert_eq!(deep, vec!["ingroup00001".to_string()]);
    let at = nodes_at(&d, PAGE, p(150.0, 150.0), &o);
    assert_eq!(
        at,
        vec!["ellipse00001".to_string(), "rectbottom01".to_string()]
    );
}

/// Random scenes (nesting, rotation, flips, clipping, masks, outside / inside strokes, booleans, hidden and locked
/// nodes, lines, text): `HitIndex` must answer exactly like the direct traversal for every option combination.
#[test]
fn index_equals_direct_traversal_on_random_scenes() {
    let mut seed = 0x5eed_u64;
    let mut rnd = move || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) as f64 / (1u64 << 31) as f64
    };
    for scene in 0..60 {
        let mut d = design();
        let mut containers = vec![PAGE.to_string()];
        for i in 0..40 {
            let id = format!("n{scene:03}{i:08}");
            let parent = containers[(rnd() * containers.len() as f64) as usize].clone();
            let (x, y) = (rnd() * 300.0, rnd() * 300.0);
            let (w, h) = (20.0 + rnd() * 200.0, 20.0 + rnd() * 200.0);
            let kind = (rnd() * 9.0) as u32;
            let mut n = match kind {
                0 => Node::frame(&id, "f", x, y, w, h),
                1 => Node::group(&id, "g", x, y, w, h),
                2 => Node::ellipse(&id, "e", x, y, w, h),
                3 => Node::star(&id, "s", 5, 0.5, x, y, w, h),
                4 => Node::line(&id, "l", x, y, w),
                5 => Node::text(&id, "Hello world", x, y, Some(w)),
                6 => Node::boolean(&id, "b", BoolOp::Union, x, y, w, h),
                _ => Node::rect(&id, "r", x, y, w, h),
            };
            {
                let b = n.base_mut();
                if rnd() < 0.3 {
                    b.rotation = (rnd() * 360.0).round();
                }
                b.flip_x = (rnd() < 0.15).then_some(true);
                b.flip_y = (rnd() < 0.15).then_some(true);
                b.visible = rnd() > 0.1;
                b.locked = rnd() < 0.1;
                b.mask = (rnd() < 0.12).then_some(true);
            }
            if let Some(c) = n.container_mut() {
                c.clip = rnd() < 0.6;
                c.children.clear();
            }
            if rnd() < 0.4 {
                let mut st = Stroke::solid(Color::new("#000000").unwrap(), 2.0 + rnd() * 12.0);
                st.align = [
                    StrokeAlign::Inside,
                    StrokeAlign::Center,
                    StrokeAlign::Outside,
                ][(rnd() * 3.0) as usize];
                let clear_fills = rnd() < 0.5;
                match &mut n {
                    Node::Line(l) => l.strokes = vec![st],
                    other => {
                        if let Some(s) = other.shaped_mut() {
                            s.strokes.push(st);
                            if clear_fills {
                                s.fills.clear();
                            }
                        }
                    }
                }
            }
            let is_container = n.is_container();
            d.push_child(&parent, n);
            if is_container {
                containers.push(id);
            }
        }
        let idx = HitIndex::build(&d, PAGE);
        for flags in 0..8u32 {
            let o = HitOptions {
                deep: flags & 1 != 0,
                include_locked: flags & 2 != 0,
                include_hidden: flags & 4 != 0,
                tolerance: if flags % 3 == 0 { 0.0 } else { 3.0 },
            };
            for _ in 0..150 {
                let pt = p(rnd() * 560.0 - 20.0, rnd() * 560.0 - 20.0);
                let (a, b) = (idx.hit_path(&d, pt, &o), hit_path(&d, PAGE, pt, &o));
                if a != b {
                    let involved: Vec<String> = a
                        .iter()
                        .chain(b.iter())
                        .flatten()
                        .map(|id| serde_json::to_string(d.node(id).unwrap()).unwrap())
                        .collect();
                    panic!(
                        "scene {scene} at {pt:?} with {o:?}: index {a:?} != direct {b:?}\n{}",
                        involved.join("\n")
                    );
                }
            }
        }
    }
}

/// Clipping limits a container's children, not its own paint: a clipping frame's centered stroke is hittable just
/// outside the frame box, while a child clipped away there is not.
#[test]
fn clipping_frame_stroke_is_hittable_outside_its_box() {
    let mut d = design();
    let mut f = Node::frame("frame0000001", "f", 100.0, 100.0, 100.0, 100.0);
    if let Node::Frame(fr) = &mut f {
        fr.container.clip = true;
        fr.shape.fills.clear();
        fr.shape.strokes = vec![Stroke::solid(Color::new("#000000").unwrap(), 8.0)];
    }
    d.push_child(PAGE, f);
    d.push_child(
        "frame0000001",
        Node::rect("rect00000001", "r", 50.0, 50.0, 200.0, 200.0),
    );
    let o = HitOptions::default();
    let idx = HitIndex::build(&d, PAGE);
    // 3 px right of the frame's right edge: inside the stroke band, outside the clip.
    let pt = p(203.0, 150.0);
    assert_eq!(hit_test(&d, PAGE, pt, &o).as_deref(), Some("frame0000001"));
    assert_eq!(hit_path(&d, PAGE, pt, &o), idx.hit_path(&d, pt, &o));
    // Farther right the child would be under the point but is clipped away.
    assert_eq!(hit_test(&d, PAGE, p(230.0, 150.0), &o), None);
    assert_eq!(
        nodes_at(&d, PAGE, pt, &HitOptions { deep: true, ..o }),
        vec!["frame0000001".to_string()]
    );
}
