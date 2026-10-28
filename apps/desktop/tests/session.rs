//! The canvas view model driven like a user would: pointer gestures, keyboard commands, text and pen editing,
//! guides, clipboard, undo / redo and tile rendering — no UI required.

use std::time::Duration;

use desyn_core::geometry::{Point, Rect, node_aabb};
use desyn_core::model::{DesignKind, GuideAxis, Node};
use desyn_desktop::canvas::session::{Feedback, PlacingImage};
use desyn_desktop::canvas::text::{Format, Move};
use desyn_desktop::canvas::{Button, ClipboardContent, EditorSession, Mods, Pointer, Tool};
use desyn_desktop::doc::Document;
use desyn_raster::{NoAssets, Renderer};
use desyn_text::TextEngine;

fn session() -> EditorSession {
    let doc = Document::blank("Test", DesignKind::Poster, 1000.0, 800.0);
    let r = Renderer::new(TextEngine::with_bundled_fonts(), Box::new(NoAssets));
    let mut s = EditorSession::new(doc, r);
    s.prefs.rulers = false;
    s.set_viewport(1200.0, 1000.0, 1.0);
    // 1:1 with the page origin at screen (100, 100) keeps the arithmetic readable.
    s.camera.zoom = 1.0;
    s.camera.x = -100.0;
    s.camera.y = -100.0;
    s
}

fn at(x: f64, y: f64) -> Pointer {
    Pointer::at(x + 100.0, y + 100.0)
}

fn with(mut p: Pointer, mods: Mods) -> Pointer {
    p.mods = mods;
    p
}

fn drag(s: &mut EditorSession, from: (f64, f64), to: (f64, f64), mods: Mods) {
    s.pointer_down(with(at(from.0, from.1), mods));
    let steps = 6;
    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        s.pointer_move(with(
            at(from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t),
            mods,
        ));
    }
    s.pointer_up(with(at(to.0, to.1), mods));
}

fn bounds(s: &EditorSession, id: &str) -> Rect {
    let r = node_aabb(&s.doc.design, id).unwrap();
    let round = |v: f64| (v * 1000.0).round() / 1000.0;
    Rect {
        x: round(r.x),
        y: round(r.y),
        w: round(r.w),
        h: round(r.h),
    }
}

fn add_rect(s: &mut EditorSession, x: f64, y: f64, w: f64, h: f64) -> String {
    s.set_tool(Tool::Rect);
    drag(s, (x, y), (x + w, y + h), Mods::default());
    assert_eq!(
        s.tool,
        Tool::Select,
        "tools return to select after one shape"
    );
    s.selection[0].clone()
}

#[test]
fn draw_select_move_resize_rotate() {
    let mut s = session();
    let id = add_rect(&mut s, 100.0, 100.0, 200.0, 100.0);
    assert_eq!(
        bounds(&s, &id),
        Rect {
            x: 100.0,
            y: 100.0,
            w: 200.0,
            h: 100.0
        }
    );
    // Click empty canvas clears, click the shape selects it.
    s.pointer_down(at(600.0, 600.0));
    s.pointer_up(at(600.0, 600.0));
    assert!(s.selection.is_empty());
    s.pointer_down(at(150.0, 150.0));
    s.pointer_up(at(150.0, 150.0));
    assert_eq!(s.selection, vec![id.clone()]);
    // Move by dragging; snapping is off for exact numbers.
    s.prefs.snap.enabled = false;
    drag(&mut s, (150.0, 150.0), (180.0, 170.0), Mods::default());
    assert_eq!(
        bounds(&s, &id),
        Rect {
            x: 130.0,
            y: 120.0,
            w: 200.0,
            h: 100.0
        }
    );
    // Shift constrains moves to one axis.
    drag(
        &mut s,
        (150.0, 150.0),
        (200.0, 160.0),
        Mods {
            shift: true,
            ..Default::default()
        },
    );
    assert_eq!(
        bounds(&s, &id),
        Rect {
            x: 180.0,
            y: 120.0,
            w: 200.0,
            h: 100.0
        }
    );
    // Resize from the bottom-right handle; shift keeps the aspect ratio.
    drag(
        &mut s,
        (380.0, 220.0),
        (480.0, 260.0),
        Mods {
            shift: true,
            ..Default::default()
        },
    );
    assert_eq!(
        bounds(&s, &id),
        Rect {
            x: 180.0,
            y: 120.0,
            w: 300.0,
            h: 150.0
        }
    );
    // Alt resizes about the center.
    drag(
        &mut s,
        (480.0, 195.0),
        (500.0, 195.0),
        Mods {
            alt: true,
            ..Default::default()
        },
    );
    assert_eq!(
        bounds(&s, &id),
        Rect {
            x: 160.0,
            y: 120.0,
            w: 340.0,
            h: 150.0
        }
    );
    // Rotate from just outside the top-right corner, shift snaps to 15° steps.
    let c = Point::new(330.0, 195.0);
    let start = (500.0 + 10.0, 120.0 - 10.0);
    let a = (start.1 - c.y).atan2(start.0 - c.x) + 37f64.to_radians();
    let r = 200.0;
    drag(
        &mut s,
        start,
        (c.x + r * a.cos(), c.y + r * a.sin()),
        Mods {
            shift: true,
            ..Default::default()
        },
    );
    let rot = s.doc.design.node(&id).unwrap().base().rotation;
    assert!(
        (rot - 30.0).abs() < 1e-6 || (rot - 45.0).abs() < 1e-6,
        "snapped rotation, got {rot}"
    );
    // Undo walks back one gesture at a time.
    s.undo();
    assert_eq!(s.doc.design.node(&id).unwrap().base().rotation, 0.0);
    s.undo();
    assert_eq!(
        bounds(&s, &id),
        Rect {
            x: 180.0,
            y: 120.0,
            w: 300.0,
            h: 150.0
        }
    );
    s.redo();
    assert_eq!(
        bounds(&s, &id),
        Rect {
            x: 160.0,
            y: 120.0,
            w: 340.0,
            h: 150.0
        }
    );
}

#[test]
fn snapping_and_smart_distances() {
    let mut s = session();
    let a = add_rect(&mut s, 100.0, 100.0, 100.0, 100.0);
    let b = add_rect(&mut s, 400.0, 300.0, 100.0, 100.0);
    s.select(vec![b.clone()]);
    // Drag b so its left edge lands 3 px from a's left edge: it snaps.
    s.pointer_down(at(450.0, 350.0));
    s.pointer_move(at(400.0, 350.0));
    s.pointer_move(at(153.0, 350.0));
    assert!(!s.feedback.guides.is_empty(), "alignment guide shown");
    assert!(!s.feedback.distances.is_empty(), "smart distances shown");
    let o = s.overlay();
    assert!(o.count(desyn_desktop::canvas::overlay::Role::Snap) > 0);
    s.pointer_up(at(153.0, 350.0));
    assert_eq!(bounds(&s, &b).x, 100.0);
    assert_eq!(bounds(&s, &a).x, 100.0);
    assert!(matches!(s.feedback, Feedback { ref guides, .. } if guides.is_empty()));
}

#[test]
fn marquee_shift_click_and_keyboard_commands() {
    let mut s = session();
    let a = add_rect(&mut s, 100.0, 100.0, 50.0, 50.0);
    let b = add_rect(&mut s, 200.0, 100.0, 50.0, 50.0);
    let c = add_rect(&mut s, 400.0, 400.0, 50.0, 50.0);
    drag(&mut s, (50.0, 50.0), (300.0, 200.0), Mods::default());
    assert_eq!(s.selection.len(), 2);
    s.pointer_down(with(
        at(425.0, 425.0),
        Mods {
            shift: true,
            ..Default::default()
        },
    ));
    s.pointer_up(with(
        at(425.0, 425.0),
        Mods {
            shift: true,
            ..Default::default()
        },
    ));
    assert_eq!(s.selection.len(), 3);
    s.nudge(1.0, 0.0, false);
    s.nudge(1.0, 0.0, true);
    assert_eq!(bounds(&s, &a).x, 111.0);
    s.undo();
    assert_eq!(
        bounds(&s, &a).x,
        100.0,
        "nudges coalesce into one undo step"
    );
    s.group();
    let g = s.selection[0].clone();
    assert!(matches!(s.doc.design.node(&g), Some(Node::Group(_))));
    s.ungroup();
    assert_eq!(s.selection.len(), 3);
    s.select(vec![a.clone(), b.clone(), c.clone()]);
    s.align(desyn_core::arrange::Alignment::Top);
    assert_eq!(bounds(&s, &c).y, 100.0);
    s.duplicate();
    assert_eq!(s.selection.len(), 3);
    assert_ne!(s.selection[0], a);
    s.delete();
    assert!(s.selection.is_empty());
    assert_eq!(s.doc.design.node(&s.page).unwrap().child_ids().len(), 3);
    s.select_all();
    assert_eq!(s.selection.len(), 3);
    s.select_sibling(1);
    assert_eq!(s.selection.len(), 1);
    s.escape();
    assert!(s.selection.is_empty());
}

#[test]
fn alt_drag_duplicates() {
    let mut s = session();
    s.prefs.snap.enabled = false;
    let a = add_rect(&mut s, 100.0, 100.0, 50.0, 50.0);
    drag(
        &mut s,
        (125.0, 125.0),
        (325.0, 125.0),
        Mods {
            alt: true,
            ..Default::default()
        },
    );
    assert_eq!(bounds(&s, &a).x, 100.0, "original stays");
    assert_ne!(s.selection[0], a);
    assert_eq!(bounds(&s, &s.selection[0].clone()).x, 300.0);
    s.undo();
    assert_eq!(s.doc.design.node(&s.page).unwrap().child_ids().len(), 1);
}

#[test]
fn text_tool_typing_formatting_and_commit() {
    let mut s = session();
    s.set_tool(Tool::Text);
    s.pointer_down(at(100.0, 100.0));
    s.pointer_up(at(100.0, 100.0));
    assert!(s.text.is_some());
    s.text_insert("Hello world");
    s.text_move(Move::WordLeft, false);
    s.text_move(Move::LineEnd, true);
    s.text_format(Format::Bold);
    let geo = s.text_geometry().expect("caret geometry");
    assert!(!geo.selection.is_empty());
    s.escape();
    assert!(s.text.is_none());
    assert_eq!(s.tool, Tool::Select, "escape leaves the text tool");
    let id = s.selection[0].clone();
    let Some(Node::Text(t)) = s.doc.design.node(&id) else {
        panic!("text node")
    };
    assert_eq!(t.runs.len(), 2);
    assert_eq!(t.runs[1].text, "world");
    assert!(
        t.base.width > 50.0,
        "auto width measured with real fonts: {}",
        t.base.width
    );
    assert_eq!(s.doc.history().len(), 1, "creating and typing is one step");
    // Double-click edits again; emptying the text deletes the layer.
    s.pointer_down(at(110.0, 100.0));
    s.pointer_up(at(110.0, 100.0));
    let mut p = at(110.0, 100.0);
    p.clicks = 2;
    s.pointer_down(p);
    s.pointer_up(p);
    assert!(s.text.is_some());
    s.select_all();
    s.text_delete(false, desyn_desktop::canvas::text::DeleteUnit::Grapheme);
    s.escape();
    assert!(s.doc.design.node(&id).is_none());
    s.undo();
    assert!(s.doc.design.node(&id).is_some());
    // An empty new text leaves nothing behind.
    s.set_tool(Tool::Text);
    s.pointer_down(at(500.0, 500.0));
    s.pointer_up(at(500.0, 500.0));
    s.escape();
    assert_eq!(s.doc.design.node(&s.page).unwrap().child_ids().len(), 1);
}

#[test]
fn pen_draws_and_edits() {
    let mut s = session();
    s.set_tool(Tool::Pen);
    s.pointer_down(at(100.0, 100.0));
    s.pointer_up(at(100.0, 100.0));
    drag(&mut s, (200.0, 100.0), (240.0, 140.0), Mods::default());
    s.pointer_down(at(150.0, 200.0));
    s.pointer_up(at(150.0, 200.0));
    s.pointer_down(at(100.0, 100.0));
    s.pointer_up(at(100.0, 100.0));
    assert!(s.pen.is_none(), "closing the path finishes it");
    let id = s.selection[0].clone();
    assert!(matches!(s.doc.design.node(&id), Some(Node::Path(_))));
    // Double-click enters point editing; dragging an anchor reshapes.
    let mut p = at(150.0, 140.0);
    s.pointer_down(p);
    s.pointer_up(p);
    p.clicks = 2;
    s.pointer_down(p);
    s.pointer_up(p);
    assert!(s.pen.is_some());
    drag(&mut s, (150.0, 200.0), (150.0, 260.0), Mods::default());
    s.escape();
    let b = bounds(&s, &id);
    assert!((b.y + b.h - 260.0).abs() < 0.01, "{b:?}");
}

#[test]
fn guides_from_rulers() {
    let mut s = session();
    s.prefs.rulers = true;
    // Drag from the left ruler (x < 20 px) onto the page.
    s.pointer_down(Pointer::at(10.0, 300.0));
    s.pointer_move(Pointer::at(200.0, 300.0));
    s.pointer_up(Pointer::at(300.0, 300.0));
    let Some(Node::Page(p)) = s.doc.design.node(&s.page) else {
        panic!()
    };
    let g = p.guides.clone().unwrap();
    assert_eq!(g.len(), 1);
    assert_eq!(g[0].axis, GuideAxis::X);
    assert_eq!(g[0].pos, 100.0, "screen 200 is page 100");
    // Drag it back into the ruler to remove it.
    s.pointer_down(Pointer::at(200.0, 400.0));
    s.pointer_move(Pointer::at(100.0, 400.0));
    s.pointer_move(Pointer::at(5.0, 400.0));
    s.pointer_up(Pointer::at(5.0, 400.0));
    let Some(Node::Page(p)) = s.doc.design.node(&s.page) else {
        panic!()
    };
    assert!(p.guides.clone().unwrap_or_default().is_empty());
}

#[test]
fn clipboard_paste_offsets_and_text() {
    let mut s = session();
    let a = add_rect(&mut s, 100.0, 100.0, 50.0, 50.0);
    let Some(ClipboardContent::Layers(c, png)) = s.copy() else {
        panic!("layers")
    };
    assert!(png.is_some_and(|p| p.starts_with(b"\x89PNG")));
    s.paste_text(&c.json, false);
    let p1 = s.selection[0].clone();
    assert_ne!(p1, a);
    assert_eq!(bounds(&s, &p1).x, 116.0);
    s.paste_text(&c.json, false);
    assert_eq!(bounds(&s, &s.selection[0].clone()).x, 132.0);
    s.paste_text(&c.json, true);
    assert_eq!(
        bounds(&s, &s.selection[0].clone()).x,
        100.0,
        "paste in place"
    );
    s.paste_text("Plain words", false);
    assert!(matches!(
        s.doc.design.node(&s.selection[0]),
        Some(Node::Text(_))
    ));
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20"/></svg>"#;
    assert!(s.paste_bytes(
        std::sync::Arc::from(&svg[..]),
        Some("dot.svg"),
        Some(Point::new(600.0, 600.0))
    ));
    let dropped = s.selection[0].clone();
    assert_eq!(
        bounds(&s, &dropped),
        Rect {
            x: 480.0,
            y: 480.0,
            w: 40.0,
            h: 40.0
        }
    );
}

#[test]
fn image_tool_places_a_picture() {
    let mut s = session();
    let img = image::RgbaImage::from_pixel(200, 100, image::Rgba([255, 0, 0, 255]));
    let mut png = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png, image::ImageFormat::Png).unwrap();
    s.start_placing(PlacingImage {
        bytes: png.into_inner().into(),
        name: "red.png".into(),
        size: (200.0, 100.0),
    });
    drag(&mut s, (100.0, 100.0), (300.0, 300.0), Mods::default());
    let id = s.selection[0].clone();
    assert_eq!(
        bounds(&s, &id),
        Rect {
            x: 100.0,
            y: 150.0,
            w: 200.0,
            h: 100.0
        }
    );
    assert_eq!(s.tool, Tool::Select);
}

#[test]
fn zoom_pan_pages_and_tiles() {
    let mut s = session();
    let before = s.camera.to_page(Point::new(500.0, 500.0));
    s.scroll(
        Point::new(0.0, 100.0),
        true,
        Point::new(500.0, 500.0),
        Mods {
            primary: true,
            ..Default::default()
        },
    );
    assert!(s.camera.zoom > 1.0);
    let after = s.camera.to_page(Point::new(500.0, 500.0));
    assert!(
        before.distance(after) < 1e-9,
        "zoom keeps the point under the cursor"
    );
    s.scroll(
        Point::new(10.0, 20.0),
        true,
        Point::new(0.0, 0.0),
        Mods::default(),
    );
    s.pinch(0.5, Point::new(100.0, 100.0));
    s.space = true;
    s.pointer_down(Pointer::at(100.0, 100.0));
    let x0 = s.camera.x;
    s.pointer_move(Pointer::at(150.0, 100.0));
    s.pointer_up(Pointer::at(150.0, 100.0));
    assert!(s.camera.x < x0, "space-drag pans");
    s.space = false;
    s.add_page();
    assert_eq!(s.doc.design.page_ids().len(), 2);
    assert_eq!(s.page, s.doc.design.page_ids()[1]);
    s.step_page(-1);
    assert_eq!(s.page, s.doc.design.page_ids()[0]);
    s.fit_page();
    let pass = s.render_tiles(Duration::from_secs(10));
    assert!(pass.rendered > 0 && pass.pending == 0);
    // Middle button pans too and right button does nothing to the document.
    let mut p = Pointer::at(10.0, 10.0);
    p.button = Button::Right;
    s.pointer_down(p);
    s.pointer_up(p);
    assert!(s.selection.is_empty());
}

#[test]
fn enter_groups_and_deep_select() {
    let mut s = session();
    let a = add_rect(&mut s, 100.0, 100.0, 50.0, 50.0);
    let b = add_rect(&mut s, 200.0, 100.0, 50.0, 50.0);
    s.select(vec![a.clone(), b.clone()]);
    s.group();
    let g = s.selection[0].clone();
    s.escape();
    // A click selects the group, mod+click the child, double-click enters the group.
    s.pointer_down(at(120.0, 120.0));
    s.pointer_up(at(120.0, 120.0));
    assert_eq!(s.selection, vec![g.clone()]);
    let deep = Mods {
        primary: true,
        ..Default::default()
    };
    s.pointer_down(with(at(220.0, 120.0), deep));
    s.pointer_up(with(at(220.0, 120.0), deep));
    assert_eq!(s.selection, vec![b.clone()]);
    s.select(vec![g.clone()]);
    let mut p = at(120.0, 120.0);
    p.clicks = 2;
    s.pointer_down(p);
    s.pointer_up(p);
    assert_eq!(s.selection, vec![a.clone()]);
    assert_eq!(s.scope.as_deref(), Some(g.as_str()));
    s.select_parent();
    assert_eq!(s.selection, vec![g]);
}

#[test]
fn activity_glow_is_part_of_the_overlay() {
    let mut s = session();
    let a = add_rect(&mut s, 100.0, 100.0, 50.0, 50.0);
    let glows = |s: &EditorSession| {
        s.overlay()
            .prims
            .iter()
            .filter(|p| matches!(p, desyn_desktop::canvas::overlay::Prim::Glow { .. }))
            .count()
    };
    assert_eq!(glows(&s), 0);
    s.activity = vec![a.clone()];
    s.flashes = vec![(a, 1.0)];
    assert_eq!(glows(&s), 2);
}

#[test]
fn typing_checkpoints_commit_but_undo_as_one_step() {
    let mut s = session();
    let before = s.doc.design.canonical_json();
    s.set_tool(Tool::Text);
    s.pointer_down(at(100.0, 100.0));
    s.pointer_up(at(100.0, 100.0));
    s.take_events();
    s.text_insert("Hello");
    assert!(s.checkpoint_text(), "a pause commits the text so far");
    let changes: Vec<_> = s
        .take_events()
        .into_iter()
        .filter_map(|e| match e {
            desyn_desktop::canvas::SessionEvent::Changed(c) => Some(c),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(changes.len(), 1, "sync sees the typed text while editing");
    assert!(s.text.is_some(), "the layer stays in edit mode");
    assert!(!s.checkpoint_text(), "nothing new to commit");
    s.text_insert(" world");
    assert!(s.checkpoint_text());
    s.text_insert("!");
    s.escape();
    let id = s.selection[0].clone();
    let Some(Node::Text(t)) = s.doc.design.node(&id) else {
        panic!("text node")
    };
    assert_eq!(t.runs[0].text, "Hello world!");
    assert_eq!(
        s.doc.history().len(),
        1,
        "one undo step for the whole session"
    );
    s.undo();
    assert_eq!(s.doc.design.canonical_json(), before);
    // Emptying the text after a checkpoint deletes the layer it created.
    s.redo();
    s.edit_text(&id, true);
    s.text_insert("Bye");
    assert!(s.checkpoint_text());
    s.select_all();
    s.text_delete(false, desyn_desktop::canvas::text::DeleteUnit::Grapheme);
    s.escape();
    assert!(s.doc.design.node(&id).is_none());
    s.undo();
    let Some(Node::Text(t)) = s.doc.design.node(&id) else {
        panic!("restored")
    };
    assert_eq!(t.runs[0].text, "Hello world!");
}

#[test]
fn a_design_without_pages_does_not_panic() {
    let mut d = Document::blank("Empty", DesignKind::Poster, 100.0, 100.0);
    let page = d.design.page_ids()[0].clone();
    d.design.nodes.shift_remove(&page);
    if let Some(Node::Root(r)) = d.design.nodes.get_mut("root") {
        r.children.clear();
    }
    let mut s = EditorSession::new(
        d,
        Renderer::new(TextEngine::with_bundled_fonts(), Box::new(NoAssets)),
    );
    s.set_viewport(800.0, 600.0, 1.0);
    let _ = s.render_tiles(Duration::from_millis(20));
    let _ = s.overlay();
    s.set_tool(Tool::Rect);
    s.pointer_down(at(10.0, 10.0));
    s.pointer_move(at(50.0, 50.0));
    s.pointer_up(at(50.0, 50.0));
    s.select_all();
    s.zoom_to_fit_all();
    s.add_page();
    assert_eq!(s.doc.design.page_ids().len(), 1);
}
