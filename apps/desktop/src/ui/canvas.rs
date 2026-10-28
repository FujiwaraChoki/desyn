//! The canvas element: paints the raster tiles (desyn-raster output uploaded as GPU textures), the dot grid,
//! overlays (selection, handles, snapping, guides, pen, text caret), rulers, and routes pointer, wheel, pinch and
//! IME input to the [`EditorSession`](crate::canvas::EditorSession).

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use desyn_core::geometry::Point;
use gpui::{
    App, Bounds, Corners, CursorStyle, DispatchPhase, Element, ElementId, ElementInputHandler,
    Entity, GlobalElementId, Hitbox, HitboxBehavior, Hsla, IntoElement, LayoutId, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, PathBuilder, PinchEvent, Pixels, RenderImage,
    ScrollDelta, ScrollWheelEvent, SharedString, Style, TextRun, Window, fill, point, px, relative,
    size,
};
use smallvec::SmallVec;

use super::components::t;
use super::editor::EditorView;
use super::theme::{MONO, SANS, Theme, alpha};
use crate::canvas::overlay::{Prim, Role};
use crate::canvas::rulers::{self, RULER};
use crate::canvas::session::{Button, Mods, Pointer};

use crate::canvas::{Cursor, Tool};

/// Frame budget for tile rendering while idle and while interacting.
const IDLE_BUDGET: Duration = Duration::from_millis(14);
const BUSY_BUDGET: Duration = Duration::from_millis(6);

/// The canvas.
pub struct CanvasElement {
    view: Entity<EditorView>,
}

impl CanvasElement {
    /// Canvas of an editor.
    pub fn new(view: Entity<EditorView>) -> CanvasElement {
        CanvasElement { view }
    }
}

impl IntoElement for CanvasElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

/// Everything paint needs, computed in prepaint.
pub struct Prepaint {
    hitbox: Hitbox,
    tiles: Vec<(Bounds<Pixels>, Arc<RenderImage>)>,
    prims: Vec<Prim>,
    theme: Theme,
    cursor: CursorStyle,
    rotate_glyph: bool,
    rulers: Option<RulerPaint>,
    dots: Vec<Bounds<Pixels>>,
    page_screen: Bounds<Pixels>,
    retired: Vec<Arc<RenderImage>>,
    editing_text: bool,
    pen_cursor: bool,
}

struct RulerPaint {
    top: Vec<(f32, bool, Option<String>)>,
    left: Vec<(f32, bool, Option<String>)>,
    sel_x: Option<(f32, f32)>,
    sel_y: Option<(f32, f32)>,
}

fn pt(origin: gpui::Point<Pixels>, p: Point) -> gpui::Point<Pixels> {
    point(origin.x + px(p.x as f32), origin.y + px(p.y as f32))
}

pub(crate) fn to_bgra(pixmap: &desyn_raster::tiny_skia::Pixmap) -> Option<Arc<RenderImage>> {
    let mut data = desyn_raster::export::bitmap::pixmap_rgba(pixmap);
    for px in data.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
    let buf = image::RgbaImage::from_raw(pixmap.width(), pixmap.height(), data)?;
    let frames: SmallVec<[image::Frame; 1]> = smallvec::smallvec![image::Frame::new(buf)];
    Some(Arc::new(RenderImage::new(frames)))
}

fn cursor_style(c: Cursor) -> (CursorStyle, bool) {
    match c {
        Cursor::Default => (CursorStyle::Arrow, false),
        Cursor::Crosshair => (CursorStyle::Crosshair, false),
        Cursor::Grab => (CursorStyle::OpenHand, false),
        Cursor::Grabbing => (CursorStyle::ClosedHand, false),
        Cursor::Text => (CursorStyle::IBeam, false),
        Cursor::Rotate => (CursorStyle::Arrow, true),
        Cursor::ColResize => (CursorStyle::ResizeColumn, false),
        Cursor::RowResize => (CursorStyle::ResizeRow, false),
        Cursor::Copy => (CursorStyle::DragCopy, false),
        Cursor::Resize(a) => {
            let a = a.rem_euclid(180.0);
            let s = if !(22.5..157.5).contains(&a) {
                CursorStyle::ResizeLeftRight
            } else if a < 67.5 {
                CursorStyle::ResizeUpLeftDownRight
            } else if a < 112.5 {
                CursorStyle::ResizeUpDown
            } else {
                CursorStyle::ResizeUpRightDownLeft
            };
            (s, false)
        }
    }
}

impl Element for CanvasElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        style.position = gpui::Position::Absolute;
        style.inset.top = px(0.0).into();
        style.inset.left = px(0.0).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepaint {
        let th = t(window, cx);
        let scale = window.scale_factor() as f64;
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
        self.view.update(cx, |v, _cx| {
            v.canvas_bounds = Some(bounds);
            let (w, h) = (
                f32::from(bounds.size.width) as f64,
                f32::from(bounds.size.height) as f64,
            );
            // The floating tool dock (20 px margin + 48 px dock + breathing room) covers the bottom.
            v.session.camera.bottom_inset = if v.focus_mode { 0.0 } else { 80.0 };
            v.session.set_viewport(w, h, scale);
            // Advance AI glow animations.
            if !v.session.activity.is_empty() || !v.session.flashes.is_empty() {
                let dt = v
                    .last_frame
                    .map(|t| t.elapsed().as_secs_f64())
                    .unwrap_or(0.0)
                    .min(0.1);
                v.session.glow_phase = (v.session.glow_phase + dt * 3.0) % std::f64::consts::TAU;
                for f in &mut v.session.flashes {
                    f.1 -= dt / 0.9;
                }
                v.session.flashes.retain(|f| f.1 > 0.0);
                window.request_animation_frame();
            }
            let budget = if v.session.has_gesture() {
                BUSY_BUDGET
            } else {
                IDLE_BUDGET
            };
            let pass = v.session.render_tiles(budget);
            if pass.pending > 0 {
                window.request_animation_frame();
            }
            v.last_frame = Some(Instant::now());
            // Upload new tiles; retire textures nobody draws anymore.
            let cam = v.session.camera;
            let origin = bounds.origin;
            let mut tiles = Vec::new();
            let visible = cam.visible();
            // The previous zoom level (scaled stand-ins) first, then the current level on top.
            let sets: Vec<(bool, Vec<(desyn_core::geometry::Rect, u64)>)> = v
                .session
                .tiles
                .previous()
                .map(|set| (false, set))
                .into_iter()
                .chain(std::iter::once((true, v.session.tiles.current())))
                .map(|(cur, set)| {
                    (
                        cur,
                        set.tiles
                            .iter()
                            .map(|(k, t)| (set.tile_rect(*k), t.uid))
                            .collect(),
                    )
                })
                .collect();
            for (is_current, list) in &sets {
                for (r, uid) in list {
                    if !r.intersects(&visible) {
                        continue;
                    }
                    let img = match v.tile_images.get(uid) {
                        Some(i) => i.clone(),
                        None => {
                            let set = if *is_current {
                                v.session.tiles.current()
                            } else {
                                v.session.tiles.previous().expect("previous level exists")
                            };
                            let Some(tile) = set.tiles.values().find(|t| t.uid == *uid) else {
                                continue;
                            };
                            let Some(i) = to_bgra(&tile.pixmap) else {
                                continue;
                            };
                            v.tile_images.insert(*uid, i.clone());
                            i
                        }
                    };
                    let s = cam.rect_to_screen(r);
                    tiles.push((
                        Bounds::new(
                            pt(origin, Point::new(s.x, s.y)),
                            size(px(s.w as f32), px(s.h as f32)),
                        ),
                        img,
                    ));
                }
            }
            let all_live: HashSet<u64> = v.session.tiles.live_uids().collect();
            let stale: Vec<u64> = v
                .tile_images
                .keys()
                .filter(|u| !all_live.contains(u))
                .copied()
                .collect();
            for u in stale {
                if let Some(img) = v.tile_images.remove(&u) {
                    v.retired_images.push(img);
                }
            }
            // Overlay and rulers.
            let prims = v.session.overlay().prims;
            let (cursor, rotate_glyph) = cursor_style(v.cursor);
            let rulers = v.session.prefs.rulers.then(|| ruler_paint(&v.session));
            let page = cam.rect_to_screen(&v.session.page_rect());
            let dots = dot_grid(&cam, bounds);
            let retired = std::mem::take(&mut v.retired_images);
            Prepaint {
                hitbox,
                tiles,
                prims,
                theme: th,
                cursor,
                rotate_glyph,
                rulers,
                dots,
                page_screen: Bounds::new(
                    pt(origin, Point::new(page.x, page.y)),
                    size(px(page.w as f32), px(page.h as f32)),
                ),
                retired,
                editing_text: v.session.text.is_some(),
                pen_cursor: v.session.tool == Tool::Pen || v.session.pen.is_some(),
            }
        })
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        p: &mut Prepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let th = p.theme;
        for img in p.retired.drain(..) {
            let _ = window.drop_image(img);
        }
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            // Dot grid around the page.
            for d in &p.dots {
                window.paint_quad(fill(*d, th.canvas_dot));
            }
            // Page tiles (raster output).
            for (b, img) in &p.tiles {
                let _ = window.paint_image(*b, *b, Corners::default(), img.clone(), 0, false);
            }
            // Hairline around white pages on the light canvas and around dark pages on the dark one.
            window.paint_quad(gpui::outline(
                p.page_screen,
                alpha(th.fg, 0.06),
                gpui::BorderStyle::Solid,
            ));
            for prim in &p.prims {
                paint_prim(prim, bounds.origin, &th, window, cx);
            }
            if let Some(r) = &p.rulers {
                paint_rulers(r, bounds, &th, window, cx);
            }
            if p.rotate_glyph {
                let m = window.mouse_position();
                paint_rotate_glyph(m, &th, window);
            }
        });
        let cursor = if p.pen_cursor && p.cursor == CursorStyle::Arrow {
            CursorStyle::Crosshair
        } else {
            p.cursor
        };
        window.set_cursor_style(cursor, &p.hitbox);
        if p.editing_text {
            let focus = self.view.read(cx).focus.clone();
            window.handle_input(
                &focus,
                ElementInputHandler::new(bounds, self.view.clone()),
                cx,
            );
        }
        register_mouse(&self.view, &p.hitbox, bounds, window);
    }
}

fn mods_of(m: &gpui::Modifiers) -> Mods {
    Mods {
        shift: m.shift,
        alt: m.alt,
        primary: m.secondary(),
    }
}

fn local(bounds: Bounds<Pixels>, p: gpui::Point<Pixels>) -> Point {
    Point::new(
        f32::from(p.x - bounds.left()) as f64,
        f32::from(p.y - bounds.top()) as f64,
    )
}

fn register_mouse(
    view: &Entity<EditorView>,
    hitbox: &Hitbox,
    bounds: Bounds<Pixels>,
    window: &mut Window,
) {
    window.on_mouse_event({
        let view = view.clone();
        let hitbox = hitbox.clone();
        move |e: &MouseDownEvent, phase, window, cx| {
            if phase != DispatchPhase::Bubble || !hitbox.is_hovered(window) {
                return;
            }
            let button = match e.button {
                MouseButton::Left => Button::Left,
                MouseButton::Middle => Button::Middle,
                MouseButton::Right => Button::Right,
                _ => return,
            };
            view.update(cx, |v, cx| {
                window.focus(&v.focus, cx);
                if v.menu.is_some() {
                    v.menu = None;
                }
                let ev = Pointer {
                    pos: local(bounds, e.position),
                    button,
                    mods: mods_of(&e.modifiers),
                    clicks: e.click_count,
                };
                if button == Button::Right {
                    // Right click selects what is under the pointer first, then shows the context menu.
                    let page = v.session.camera.to_page(ev.pos);
                    if let Some(id) = v.session.pick(page, false)
                        && !v.session.selection.contains(&id)
                    {
                        v.session.select(vec![id]);
                    }
                    v.after(cx);
                    v.show_context_menu(e.position, window, cx);
                    return;
                }
                v.cursor = v.session.pointer_down(ev);
                v.after(cx);
            });
            cx.stop_propagation();
        }
    });
    window.on_mouse_event({
        let view = view.clone();
        let hitbox = hitbox.clone();
        move |e: &MouseMoveEvent, phase, window, cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            view.update(cx, |v, cx| {
                let dragging = v.session.has_gesture();
                if !dragging && !hitbox.is_hovered(window) {
                    if v.session.hover.is_some() {
                        v.session.pointer_left();
                        cx.notify();
                    }
                    return;
                }
                let ev = Pointer {
                    pos: local(bounds, e.position),
                    button: Button::Left,
                    mods: mods_of(&e.modifiers),
                    clicks: 1,
                };
                v.cursor = v.session.pointer_move(ev);
                v.after(cx);
            });
        }
    });
    window.on_mouse_event({
        let view = view.clone();
        move |e: &MouseUpEvent, phase, _window, cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            view.update(cx, |v, cx| {
                if !v.session.has_gesture() {
                    return;
                }
                let ev = Pointer {
                    pos: local(bounds, e.position),
                    button: Button::Left,
                    mods: mods_of(&e.modifiers),
                    clicks: e.click_count,
                };
                v.cursor = v.session.pointer_up(ev);
                v.after(cx);
            });
        }
    });
    window.on_mouse_event({
        let view = view.clone();
        let hitbox = hitbox.clone();
        move |e: &ScrollWheelEvent, phase, window, cx| {
            if phase != DispatchPhase::Bubble || !hitbox.should_handle_scroll(window) {
                return;
            }
            let (d, precise) = match e.delta {
                ScrollDelta::Pixels(p) => (
                    Point::new(f32::from(p.x) as f64, f32::from(p.y) as f64),
                    true,
                ),
                ScrollDelta::Lines(l) => (Point::new(l.x as f64, l.y as f64), false),
            };
            view.update(cx, |v, cx| {
                v.session
                    .scroll(d, precise, local(bounds, e.position), mods_of(&e.modifiers));
                cx.notify();
            });
            cx.stop_propagation();
        }
    });
    window.on_mouse_event({
        let view = view.clone();
        let hitbox = hitbox.clone();
        move |e: &PinchEvent, phase, window, cx| {
            if phase != DispatchPhase::Bubble || !hitbox.is_hovered(window) {
                return;
            }
            view.update(cx, |v, cx| {
                v.session.pinch(e.delta as f64, local(bounds, e.position));
                cx.notify();
            });
        }
    });
}

fn dot_grid(cam: &crate::canvas::camera::Camera, bounds: Bounds<Pixels>) -> Vec<Bounds<Pixels>> {
    // Dots sit on a page-space lattice so they move with the design; the step doubles until dots are >= 20 px
    // apart on screen.
    let mut step = 8.0;
    while step * cam.zoom < 20.0 {
        step *= 2.0;
    }
    while step * cam.zoom > 48.0 && step > 1.0 {
        step /= 2.0;
    }
    let v = cam.visible();
    let x0 = (v.x / step).floor() as i64;
    let y0 = (v.y / step).floor() as i64;
    let x1 = ((v.x + v.w) / step).ceil() as i64;
    let y1 = ((v.y + v.h) / step).ceil() as i64;
    let mut out = Vec::new();
    if (x1 - x0) * (y1 - y0) > 20_000 {
        return out;
    }
    let r = 0.6f32;
    for j in y0..=y1 {
        for i in x0..=x1 {
            let s = cam.to_screen(Point::new(i as f64 * step, j as f64 * step));
            out.push(Bounds::new(
                pt(bounds.origin, s) - point(px(r), px(r)),
                size(px(r * 2.0), px(r * 2.0)),
            ));
        }
    }
    out
}

fn role_color(role: Role, th: &Theme) -> Hsla {
    match role {
        Role::Selection | Role::Caret | Role::Pen => th.accent,
        Role::Hover => alpha(th.accent, 0.7),
        Role::Scope => alpha(th.fg, 0.28),
        Role::Marquee => th.accent,
        Role::Snap => th.snap,
        Role::Guide => th.guide,
        Role::Grid => alpha(th.sun_lo, 0.07),
        Role::PixelGrid => alpha(th.fg, 0.08),
        Role::TextSelection => alpha(th.accent, 0.28),
        Role::Composition => th.accent,
        Role::PageEdge => alpha(th.fg, 0.1),
    }
}

fn stroke_path(
    pts: &[gpui::Point<Pixels>],
    closed: bool,
    width: f32,
    dashed: bool,
    color: Hsla,
    window: &mut Window,
) {
    if pts.len() < 2 {
        return;
    }
    let mut b = PathBuilder::stroke(px(width));
    if dashed {
        b = b.dash_array(&[px(4.0), px(3.0)]);
    }
    b.move_to(pts[0]);
    for p in &pts[1..] {
        b.line_to(*p);
    }
    if closed {
        b.line_to(pts[0]);
    }
    if let Ok(path) = b.build() {
        window.paint_path(path, color);
    }
}

fn fill_path(pts: &[gpui::Point<Pixels>], color: Hsla, window: &mut Window) {
    if pts.len() < 3 {
        return;
    }
    let mut b = PathBuilder::fill();
    b.move_to(pts[0]);
    for p in &pts[1..] {
        b.line_to(*p);
    }
    b.close();
    if let Ok(path) = b.build() {
        window.paint_path(path, color);
    }
}

fn paint_prim(
    prim: &Prim,
    origin: gpui::Point<Pixels>,
    th: &Theme,
    window: &mut Window,
    cx: &mut App,
) {
    match prim {
        Prim::Poly {
            pts,
            role,
            width,
            fill,
            dashed,
        } => {
            let ps: Vec<_> = pts.iter().map(|p| pt(origin, *p)).collect();
            if *fill {
                let c = match role {
                    Role::Marquee => alpha(th.accent, 0.08),
                    other => role_color(*other, th),
                };
                fill_path(&ps, c, window);
            }
            if *width > 0.0 {
                stroke_path(
                    &ps,
                    true,
                    *width as f32,
                    *dashed,
                    role_color(*role, th),
                    window,
                );
            }
        }
        Prim::Line {
            pts,
            role,
            width,
            dashed,
        } => {
            let ps: Vec<_> = pts.iter().map(|p| pt(origin, *p)).collect();
            stroke_path(
                &ps,
                false,
                *width as f32,
                *dashed,
                role_color(*role, th),
                window,
            );
        }
        Prim::Handle {
            center,
            size: s,
            rotation,
        } => {
            let c = pt(origin, *center);
            let half = *s as f32 / 2.0;
            if rotation.abs() < 0.01 {
                let b = Bounds::new(
                    c - point(px(half), px(half)),
                    size(px(*s as f32), px(*s as f32)),
                );
                // 1 px dark outline, sun border, white face (DESIGN_SYSTEM §3).
                window.paint_quad(fill(
                    Bounds::new(
                        b.origin - point(px(1.0), px(1.0)),
                        b.size + size(px(2.0), px(2.0)),
                    ),
                    alpha(gpui::black(), 0.55),
                ));
                window.paint_quad(gpui::quad(
                    b,
                    px(1.5),
                    gpui::white(),
                    px(1.5),
                    th.accent,
                    gpui::BorderStyle::Solid,
                ));
            } else {
                let r = rotation.to_radians() as f32;
                let corner = |dx: f32, dy: f32| {
                    point(
                        c.x + px(dx * r.cos() - dy * r.sin()),
                        c.y + px(dx * r.sin() + dy * r.cos()),
                    )
                };
                let q = [
                    corner(-half, -half),
                    corner(half, -half),
                    corner(half, half),
                    corner(-half, half),
                ];
                fill_path(&q, gpui::white(), window);
                stroke_path(&q, true, 1.5, false, th.accent, window);
            }
        }
        Prim::Dot {
            center,
            radius,
            role,
            filled,
        } => {
            let c = pt(origin, *center);
            let r = *radius as f32;
            let b = Bounds::new(c - point(px(r), px(r)), size(px(r * 2.0), px(r * 2.0)));
            let col = role_color(*role, th);
            window.paint_quad(gpui::quad(
                b,
                px(r),
                if *filled { col } else { gpui::white() },
                px(1.5),
                col,
                gpui::BorderStyle::Solid,
            ));
        }
        Prim::Fill { rect, role } => {
            let b = Bounds::new(
                pt(origin, Point::new(rect.x, rect.y)),
                size(px(rect.w as f32), px(rect.h as f32)),
            );
            window.paint_quad(fill(b, role_color(*role, th)));
        }
        Prim::Glow { pts, intensity } => {
            let ps: Vec<_> = pts.iter().map(|p| pt(origin, *p)).collect();
            let i = (*intensity as f32).clamp(0.0, 1.0);
            // Layered strokes approximate a soft outer glow.
            for (w, a) in [(14.0, 0.06), (9.0, 0.10), (5.0, 0.18), (2.0, 0.55)] {
                stroke_path(&ps, true, w, false, alpha(th.accent, a * i), window);
            }
        }
        Prim::Label { at, text, role } => {
            let (bg, fg) = match role {
                Role::Snap => (th.snap, gpui::white()),
                _ => (th.accent_solid, th.accent_ink),
            };
            paint_pill(pt(origin, *at), text, bg, fg, window, cx);
        }
    }
}

fn shape(
    text: &str,
    family: &'static str,
    size_px: f32,
    color: Hsla,
    window: &mut Window,
) -> gpui::ShapedLine {
    let font = gpui::Font {
        family: family.into(),
        ..window.text_style().font()
    };
    let run = TextRun {
        len: text.len(),
        font,
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    window.text_system().shape_line(
        SharedString::from(text.to_string()),
        px(size_px),
        &[run],
        None,
    )
}

fn paint_pill(
    center: gpui::Point<Pixels>,
    text: &str,
    bg: Hsla,
    fg: Hsla,
    window: &mut Window,
    cx: &mut App,
) {
    let line = shape(text, SANS, 11.0, fg, window);
    let w = line.width + px(12.0);
    let h = px(18.0);
    let b = Bounds::new(point(center.x - w / 2.0, center.y - h / 2.0), size(w, h));
    window.paint_quad(gpui::quad(
        b,
        px(5.0),
        bg,
        px(0.0),
        bg,
        gpui::BorderStyle::Solid,
    ));
    let _ = line.paint(
        point(b.origin.x + px(6.0), b.origin.y + px(2.0)),
        px(14.0),
        gpui::TextAlign::Left,
        None,
        window,
        cx,
    );
}

fn paint_rotate_glyph(m: gpui::Point<Pixels>, th: &Theme, window: &mut Window) {
    // A small curved arrow next to the pointer (GPUI has no rotate cursor).
    let c = point(m.x + px(14.0), m.y + px(14.0));
    let r = 7.0f32;
    let mut pts = Vec::new();
    for i in 0..=16 {
        let a = (200.0 + i as f32 * 14.0).to_radians();
        pts.push(point(c.x + px(r * a.cos()), c.y + px(r * a.sin())));
    }
    stroke_path(&pts, false, 3.5, false, alpha(gpui::black(), 0.6), window);
    stroke_path(&pts, false, 1.5, false, th.accent, window);
    let end = pts[pts.len() - 1];
    fill_path(
        &[
            end + point(px(-4.0), px(-2.0)),
            end + point(px(3.0), px(-3.0)),
            end + point(px(1.0), px(4.0)),
        ],
        th.accent,
        window,
    );
}

fn ruler_paint(s: &crate::canvas::EditorSession) -> RulerPaint {
    let cam = &s.camera;
    let unit = match s.doc.design.node(&s.page) {
        Some(desyn_core::model::Node::Page(p)) => p.unit.as_str().to_string(),
        _ => "px".into(),
    };
    let top = rulers::ticks(cam.x, cam.zoom, cam.width, &unit)
        .into_iter()
        .filter(|t| t.screen >= RULER)
        .map(|t| {
            (
                t.screen as f32,
                t.major,
                t.major.then(|| rulers::label(t.value, &unit)),
            )
        })
        .collect();
    let left = rulers::ticks(cam.y, cam.zoom, cam.height, &unit)
        .into_iter()
        .filter(|t| t.screen >= RULER)
        .map(|t| {
            (
                t.screen as f32,
                t.major,
                t.major.then(|| rulers::label(t.value, &unit)),
            )
        })
        .collect();
    let sel = crate::doc::edit::movable(&s.doc.design, &s.selection);
    let aabb = desyn_core::geometry::selection_aabb(&s.doc.design, &sel);
    let sel_x = aabb.map(|r| {
        (
            cam.to_screen(Point::new(r.x, 0.0)).x as f32,
            cam.to_screen(Point::new(r.right(), 0.0)).x as f32,
        )
    });
    let sel_y = aabb.map(|r| {
        (
            cam.to_screen(Point::new(0.0, r.y)).y as f32,
            cam.to_screen(Point::new(0.0, r.bottom())).y as f32,
        )
    });
    RulerPaint {
        top,
        left,
        sel_x,
        sel_y,
    }
}

fn paint_rulers(
    r: &RulerPaint,
    bounds: Bounds<Pixels>,
    th: &Theme,
    window: &mut Window,
    cx: &mut App,
) {
    let o = bounds.origin;
    let w = bounds.size.width;
    let h = bounds.size.height;
    let rp = px(RULER as f32);
    let bg = th.surface1;
    window.paint_quad(fill(Bounds::new(o, size(w, rp)), bg));
    window.paint_quad(fill(Bounds::new(o, size(rp, h)), bg));
    if let Some((a, b)) = r.sel_x {
        window.paint_quad(fill(
            Bounds::new(
                point(o.x + px(a.max(RULER as f32)), o.y),
                size(px((b - a).max(1.0)), rp),
            ),
            th.accent_soft,
        ));
    }
    if let Some((a, b)) = r.sel_y {
        window.paint_quad(fill(
            Bounds::new(
                point(o.x, o.y + px(a.max(RULER as f32))),
                size(rp, px((b - a).max(1.0))),
            ),
            th.accent_soft,
        ));
    }
    window.paint_quad(fill(
        Bounds::new(point(o.x, o.y + rp - px(1.0)), size(w, px(1.0))),
        th.border_subtle,
    ));
    window.paint_quad(fill(
        Bounds::new(point(o.x + rp - px(1.0), o.y), size(px(1.0), h)),
        th.border_subtle,
    ));
    for (x, major, label) in &r.top {
        let len = if *major { 8.0 } else { 4.0 };
        window.paint_quad(fill(
            Bounds::new(
                point(o.x + px(*x), o.y + rp - px(len)),
                size(px(1.0), px(len)),
            ),
            alpha(th.fg, if *major { 0.35 } else { 0.18 }),
        ));
        if let Some(l) = label {
            let line = shape(l, MONO, 9.0, th.faint, window);
            let _ = line.paint(
                point(o.x + px(*x + 3.0), o.y + px(2.0)),
                px(11.0),
                gpui::TextAlign::Left,
                None,
                window,
                cx,
            );
        }
    }
    for (y, major, label) in &r.left {
        let len = if *major { 8.0 } else { 4.0 };
        window.paint_quad(fill(
            Bounds::new(
                point(o.x + rp - px(len), o.y + px(*y)),
                size(px(len), px(1.0)),
            ),
            alpha(th.fg, if *major { 0.35 } else { 0.18 }),
        ));
        if let Some(l) = label {
            // Stacked digits read top to bottom in the narrow ruler.
            for (i, ch) in l.chars().enumerate() {
                let line = shape(&ch.to_string(), MONO, 9.0, th.faint, window);
                let _ = line.paint(
                    point(o.x + px(3.0), o.y + px(*y + 2.0 + i as f32 * 9.0)),
                    px(10.0),
                    gpui::TextAlign::Left,
                    None,
                    window,
                    cx,
                );
            }
        }
    }
    // Corner square.
    window.paint_quad(fill(Bounds::new(o, size(rp, rp)), bg));
}
