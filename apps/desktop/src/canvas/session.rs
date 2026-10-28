//! `EditorSession`: the canvas view model. It owns the open document, the renderer and tile cache, the camera,
//! selection, tools and gestures, and turns pointer / keyboard input into document transactions. It has no UI
//! dependency: the GPUI canvas element forwards events and paints [`EditorSession::overlay`] and the tiles, and the
//! unit tests drive it directly (`tests/` and the tests below).

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use desyn_core::arrange::{Alignment, DistributeAxis, ZOrder};
use desyn_core::geometry::{
    Affine, OrientedBox, Point, Rect, node_aabb, node_obb, world_transform,
};
use desyn_core::hit::{
    HandleHit, HandleKind, HandleStyle, HitIndex, HitOptions, MarqueeMode, ResizeOptions,
    hit_handles, marquee, resize_box, rotation_delta, selection_bounds, transform_handles,
};
use desyn_core::model::{Guide, GuideAxis, Id, Node, NodeType, Op};
use desyn_core::snap::{
    DistanceLabel, ResizeEdges, SnapGuide, SnapTargets, SpacingGuide, distance_labels, snap_move,
    snap_resize,
};
use desyn_raster::Renderer;
use desyn_text::LaidOutText;
use serde_json::Map;

use super::camera::Camera;
use super::overlay::{Overlay, Prim, Role, fmt_px};
use super::pen::PenSession;
use super::rulers::RULER;
use super::text::{DeleteUnit, Format, Move, TextSession};
use super::tiles::{RenderPass, TileCache};
use super::tools::Tool;
use crate::doc::clipboard::{self, Copied};
use crate::doc::edit::{self, num};
use crate::doc::{Change, Document};
use crate::settings::SnapPrefs;

/// Pointer button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    /// Primary.
    Left,
    /// Wheel button (pans).
    Middle,
    /// Secondary (context menu, handled by the UI).
    Right,
}

/// Modifier keys. `primary` is ⌘ on macOS and Ctrl elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods {
    /// Shift.
    pub shift: bool,
    /// Alt / Option.
    pub alt: bool,
    /// ⌘ / Ctrl.
    pub primary: bool,
}

/// A pointer event in canvas-local logical px.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pointer {
    /// Position relative to the canvas element's top-left.
    pub pos: Point,
    /// Button.
    pub button: Button,
    /// Modifiers.
    pub mods: Mods,
    /// Click count (2 = double click).
    pub clicks: usize,
}

impl Pointer {
    /// A left-button pointer at a position (tests and scripts).
    pub fn at(x: f64, y: f64) -> Pointer {
        Pointer {
            pos: Point::new(x, y),
            button: Button::Left,
            mods: Mods::default(),
            clicks: 1,
        }
    }
}

/// Cursor the UI should show.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cursor {
    /// Arrow.
    Default,
    /// Crosshair (shape tools, pen).
    Crosshair,
    /// Open hand.
    Grab,
    /// Closed hand.
    Grabbing,
    /// I-beam.
    Text,
    /// Resize along a screen angle in degrees (0 = horizontal).
    Resize(f64),
    /// Rotate (the UI draws a rotate glyph).
    Rotate,
    /// Moving a guide (vertical line).
    ColResize,
    /// Moving a guide (horizontal line).
    RowResize,
    /// Alt-drag duplicate.
    Copy,
}

/// View preferences the session needs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewPrefs {
    /// Snapping.
    pub snap: SnapPrefs,
    /// Rulers visible (and guide creation from them).
    pub rulers: bool,
    /// Layout grid visible.
    pub layout_grid: bool,
    /// Pixel grid at high zoom.
    pub pixel_grid: bool,
    /// Smart distances.
    pub smart_distances: bool,
    /// Arrow nudge.
    pub nudge: f64,
    /// Shift+arrow nudge.
    pub big_nudge: f64,
}

impl Default for ViewPrefs {
    fn default() -> Self {
        let s = crate::settings::Settings::default();
        ViewPrefs {
            snap: s.snapping,
            rulers: s.rulers,
            layout_grid: s.layout_grid,
            pixel_grid: s.pixel_grid,
            smart_distances: s.smart_distances,
            nudge: s.nudge,
            big_nudge: s.big_nudge,
        }
    }
}

/// Things listeners care about (UI panels, extension modules, autosave).
#[derive(Debug, Clone)]
pub enum SessionEvent {
    /// Document transactions (applied ops) in order.
    Changed(Vec<Change>),
    /// Selection changed.
    Selection(Vec<Id>),
    /// The active page changed.
    Page(Id),
    /// Tool changed.
    Tool(Tool),
    /// A message for a toast.
    Notice(String),
    /// Text editing started / ended.
    TextEditing(bool),
}

/// An image waiting to be placed with the image tool.
#[derive(Debug, Clone)]
pub struct PlacingImage {
    /// File bytes.
    pub bytes: Arc<[u8]>,
    /// File name.
    pub name: String,
    /// Pixel size.
    pub size: (f64, f64),
}

#[derive(Debug, Clone)]
enum Gesture {
    Pan {
        last: Point,
    },
    Marquee {
        origin: Point,
        base: Vec<Id>,
        additive: bool,
    },
    Move(Box<MoveGesture>),
    Resize(Box<ResizeGesture>),
    Rotate {
        center: Point,
        start: Point,
        ids: Vec<Id>,
        base_rotation: f64,
    },
    Create {
        tool: Tool,
        origin: Point,
        current: Point,
        parent: Id,
        mods: Mods,
    },
    TextSelect,
    Pen,
    Guide {
        axis: GuideAxis,
        index: Option<usize>,
        pos: f64,
        remove: bool,
    },
}

#[derive(Debug, Clone)]
struct MoveGesture {
    origin: Point,
    origin_screen: Point,
    ids: Vec<Id>,
    start: Rect,
    active: bool,
    duplicate: Option<(Vec<Op>, Vec<Id>)>,
    targets: SnapTargets,
    toggle_off: Option<Id>,
}

#[derive(Debug, Clone)]
struct ResizeGesture {
    handle: HandleKind,
    start: OrientedBox,
    ids: Vec<Id>,
    keep_aspect_default: bool,
    targets: SnapTargets,
}

/// Snapping / measuring feedback of the current gesture.
#[derive(Debug, Clone, Default)]
pub struct Feedback {
    /// Alignment lines (page coordinates).
    pub guides: Vec<SnapGuide>,
    /// Equal-spacing indicators.
    pub spacing: Vec<SpacingGuide>,
    /// Smart distances.
    pub distances: Vec<DistanceLabel>,
    /// Size / angle pill: page anchor + text.
    pub pill: Option<(Point, String)>,
}

/// The canvas view model of one open design.
pub struct EditorSession {
    /// The document.
    pub doc: Document,
    /// Renderer (its text engine is the document's measurer).
    pub renderer: Renderer,
    /// Tiles of the active page.
    pub tiles: TileCache,
    /// Active page id.
    pub page: Id,
    /// Selected ids (top-level within the current scope).
    pub selection: Vec<Id>,
    /// Entered container (double-click on a group / frame).
    pub scope: Option<Id>,
    /// Camera.
    pub camera: Camera,
    /// Active tool.
    pub tool: Tool,
    /// View preferences.
    pub prefs: ViewPrefs,
    /// Hovered node.
    pub hover: Option<Id>,
    /// Text editing session.
    pub text: Option<TextSession>,
    /// Layout of the edited text (box-local) and the node's world transform.
    pub text_layout: Option<(LaidOutText, Affine)>,
    /// Pen session.
    pub pen: Option<PenSession>,
    /// Image waiting for placement.
    pub placing: Option<PlacingImage>,
    /// Layers an AI run or workflow is working on (pulsing sun glow, DESIGN_SYSTEM §4).
    pub activity: Vec<Id>,
    /// Layers that just changed under an AI run (a fading glow): id and remaining intensity 0..1.
    pub flashes: Vec<(Id, f64)>,
    /// Animation phase for the activity glow in radians (advanced by the UI each frame).
    pub glow_phase: f64,
    /// Space bar held (temporary hand).
    pub space: bool,
    /// Alt held (smart distances on hover).
    pub alt: bool,
    /// Gesture feedback.
    pub feedback: Feedback,
    /// Device px per logical px (window scale factor).
    pub device_scale: f64,
    gesture: Option<Gesture>,
    marquee: Option<Rect>,
    hit_index: Option<(u64, Id, HitIndex)>,
    synced_assets: HashSet<Id>,
    events: Vec<SessionEvent>,
    paste_count: u32,
    last_paste: Option<String>,
    last_pointer: Point,
    /// Undo group of the running text session once a checkpoint was committed.
    text_group: Option<String>,
}

/// Screen px a press must travel before it becomes a drag.
pub const DRAG_THRESHOLD: f64 = 3.0;
/// Pick slop in screen px.
pub const HIT_SLOP: f64 = 4.0;

impl EditorSession {
    /// A session over a document with a renderer that has the bundled fonts.
    pub fn new(doc: Document, renderer: Renderer) -> EditorSession {
        let page = doc.design.page_ids().first().cloned().unwrap_or_default();
        let mut s = EditorSession {
            doc,
            renderer,
            tiles: TileCache::default(),
            page,
            selection: Vec::new(),
            scope: None,
            camera: Camera::default(),
            tool: Tool::Select,
            prefs: ViewPrefs::default(),
            hover: None,
            text: None,
            text_layout: None,
            pen: None,
            placing: None,
            activity: Vec::new(),
            flashes: Vec::new(),
            glow_phase: 0.0,
            space: false,
            alt: false,
            feedback: Feedback::default(),
            device_scale: 1.0,
            gesture: None,
            marquee: None,
            hit_index: None,
            synced_assets: HashSet::new(),
            events: Vec::new(),
            paste_count: 0,
            last_paste: None,
            last_pointer: Point::new(0.0, 0.0),
            text_group: None,
        };
        s.sync_assets();
        s
    }

    // ---------------------------------------------------------------------------------------------------------
    // State helpers

    /// Takes pending events (changes are drained from the document here too).
    pub fn take_events(&mut self) -> Vec<SessionEvent> {
        let changes = self.doc.take_changes();
        if !changes.is_empty() {
            self.events.insert(0, SessionEvent::Changed(changes));
        }
        std::mem::take(&mut self.events)
    }

    fn notice(&mut self, s: impl Into<String>) {
        self.events.push(SessionEvent::Notice(s.into()));
    }

    /// Sets the selection (emits an event when it changes).
    pub fn select(&mut self, ids: Vec<Id>) {
        let mut ids: Vec<Id> = ids
            .into_iter()
            .filter(|i| self.doc.design.node(i).is_some())
            .collect();
        let mut seen = HashSet::new();
        ids.retain(|i| seen.insert(i.clone()));
        if ids != self.selection {
            self.selection = ids.clone();
            self.events.push(SessionEvent::Selection(ids));
        }
    }

    /// Sets the tool.
    pub fn set_tool(&mut self, tool: Tool) {
        if self.tool == tool {
            return;
        }
        self.finish_text();
        if tool != Tool::Pen {
            self.finish_pen();
        }
        if tool != Tool::Image {
            self.placing = None;
        }
        self.tool = tool;
        self.events.push(SessionEvent::Tool(tool));
    }

    /// Switches the active page.
    pub fn set_page(&mut self, page: &str) {
        if self.page == page || !self.doc.design.page_ids().iter().any(|p| p == page) {
            return;
        }
        self.finish_text();
        self.finish_pen();
        self.page = page.to_string();
        self.scope = None;
        self.select(Vec::new());
        self.fit_page();
        self.events.push(SessionEvent::Page(self.page.clone()));
    }

    /// Next / previous page (PageDown / PageUp).
    pub fn step_page(&mut self, dir: i32) {
        let pages = self.doc.design.page_ids().to_vec();
        if let Some(i) = pages.iter().position(|p| *p == self.page) {
            let j = (i as i64 + dir as i64).clamp(0, pages.len() as i64 - 1) as usize;
            let p = pages[j].clone();
            self.set_page(&p);
        }
    }

    /// Page size.
    pub fn page_rect(&self) -> Rect {
        self.doc
            .design
            .node(&self.page)
            .map(|n| Rect {
                x: 0.0,
                y: 0.0,
                w: n.base().width,
                h: n.base().height,
            })
            .unwrap_or_default()
    }

    /// Keeps derived state valid after the document changed under us (undo, sync, AI).
    pub fn reconcile(&mut self) {
        if (self.doc.design.node(&self.page).is_none()
            || !self.doc.design.page_ids().contains(&self.page))
            && let Some(first) = self.doc.design.page_ids().first().cloned()
        {
            self.page = first.clone();
            self.events.push(SessionEvent::Page(first));
        }
        let sel: Vec<Id> = self
            .selection
            .iter()
            .filter(|i| self.doc.design.node(i).is_some())
            .cloned()
            .collect();
        if sel != self.selection {
            self.select(sel);
        }
        if self
            .scope
            .as_ref()
            .is_some_and(|s| self.doc.design.node(s).is_none())
        {
            self.scope = None;
        }
        if self
            .hover
            .as_ref()
            .is_some_and(|h| self.doc.design.node(h).is_none())
        {
            self.hover = None;
        }
        if let Some(t) = &self.text
            && t.created.is_none()
            && self.doc.design.node(&t.node_id).is_none()
        {
            self.text = None;
            self.text_layout = None;
            self.events.push(SessionEvent::TextEditing(false));
        }
        self.sync_assets();
    }

    /// Hands new asset bytes to the renderer.
    pub fn sync_assets(&mut self) {
        for (id, bytes) in &self.doc.assets {
            if self.synced_assets.insert(id.clone()) {
                self.renderer.assets_mut().insert(id.clone(), bytes.clone());
            }
        }
    }

    fn measurer(&mut self) -> (&mut Document, &mut desyn_text::TextEngine) {
        (&mut self.doc, self.renderer.text_mut())
    }

    /// Applies ops as one undo step and selects `select` afterwards (when given).
    pub fn commit(&mut self, ops: Vec<Op>, label: &str, select: Option<Vec<Id>>) -> bool {
        let (doc, m) = self.measurer();
        let ok = doc.apply(ops, label, m).is_some();
        if ok {
            self.sync_assets();
            if let Some(s) = select {
                self.select(s);
            }
            self.reconcile();
        }
        ok
    }

    fn commit_coalescing(&mut self, ops: Vec<Op>, label: &str, key: &str) -> bool {
        let (doc, m) = self.measurer();
        let ok = doc.apply_coalescing(ops, label, Some(key), m).is_some();
        if ok {
            self.reconcile();
        }
        ok
    }

    fn preview(&mut self, ops: Vec<Op>) {
        let (doc, m) = self.measurer();
        doc.set_preview(ops, m);
        self.sync_assets();
    }

    fn cancel_preview(&mut self) {
        let (doc, m) = self.measurer();
        doc.cancel_preview(m);
    }

    /// Applies a transaction from elsewhere (sync, AI); see [`Document::apply_external`].
    pub fn apply_external(&mut self, tx: &desyn_core::Transaction, undoable: bool) -> bool {
        let (doc, m) = self.measurer();
        let ok = doc.apply_external(tx, undoable, m).is_some();
        self.reconcile();
        ok
    }

    fn ensure_hit_index(&mut self) {
        let rev = self.doc.revision();
        let stale = !matches!(&self.hit_index, Some((r, p, _)) if *r == rev && *p == self.page);
        if stale {
            let idx = HitIndex::build(&self.doc.design, &self.page);
            self.hit_index = Some((rev, self.page.clone(), idx));
        }
    }

    /// Hit path (page child .. deepest) at a page point.
    fn hit_path(&mut self, p: Point) -> Option<Vec<Id>> {
        self.ensure_hit_index();
        let opts = self.hit_opts(true);
        let (_, _, idx) = self.hit_index.as_ref()?;
        idx.hit_path(&self.doc.design, p, &opts)
    }

    /// Geometry step for gestures: whole design px, finer when zoomed in (so precise work stays possible).
    pub fn px_step(&self) -> f64 {
        let z = self.camera.zoom;
        if z >= 8.0 {
            0.125
        } else if z >= 4.0 {
            0.25
        } else if z >= 2.0 {
            0.5
        } else {
            1.0
        }
    }

    /// Rounds a page point to [`EditorSession::px_step`].
    pub fn snap_px(&self, p: Point) -> Point {
        let s = self.px_step();
        Point::new((p.x / s).round() * s, (p.y / s).round() * s)
    }

    fn hit_opts(&self, deep: bool) -> HitOptions {
        HitOptions {
            deep,
            include_locked: false,
            include_hidden: false,
            tolerance: HIT_SLOP / self.camera.zoom,
        }
    }

    /// The node a click at a page point selects, honoring the entered scope (mod+click = deepest).
    pub fn pick(&mut self, p: Point, deep: bool) -> Option<Id> {
        let path = self.hit_path(p)?;
        if deep {
            return path.last().cloned();
        }
        if let Some(scope) = &self.scope {
            if let Some(i) = path.iter().position(|x| x == scope) {
                return path.get(i + 1).or(path.get(i)).cloned();
            }
            self.scope = None;
        }
        path.first().cloned()
    }

    /// Deepest frame under a point (new shapes are created inside it), else the page.
    fn container_at(&mut self, p: Point) -> Id {
        let path = self.hit_path(p);
        path.and_then(|path| {
            path.iter()
                .rev()
                .find(
                    |id| matches!(self.doc.design.node(id), Some(Node::Frame(f)) if !f.base.locked),
                )
                .cloned()
        })
        .unwrap_or_else(|| self.page.clone())
    }

    fn selection_obb(&self) -> Option<OrientedBox> {
        let ids = edit::movable(&self.doc.design, &self.selection);
        selection_bounds(&self.doc.design, &ids).map(|b| b.obb)
    }

    fn handles(&self) -> Option<desyn_core::hit::Handles> {
        if self.text.is_some() || self.pen.is_some() {
            return None;
        }
        let ids = edit::unlocked(&self.doc.design, &self.selection);
        if ids.is_empty() {
            return None;
        }
        let b = selection_bounds(&self.doc.design, &ids)?;
        Some(transform_handles(
            &b.obb,
            self.camera.zoom,
            &HandleStyle::default(),
        ))
    }

    fn snap_targets(&self, exclude: &[Id]) -> SnapTargets {
        let mut ex: Vec<Id> = Vec::new();
        for id in exclude {
            ex.extend(self.doc.design.subtree_ids(id));
        }
        SnapTargets::for_page(&self.doc.design, &self.page, &ex)
    }

    fn snap_options(&self) -> desyn_core::snap::SnapOptions {
        let s = &self.prefs.snap;
        desyn_core::snap::SnapOptions {
            threshold: s.threshold / self.camera.zoom.max(1e-6),
            objects: s.objects,
            page: s.page,
            guides: s.guides,
            grid: s.grid && self.prefs.layout_grid,
            spacing: s.spacing,
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Pointer input

    fn in_ruler(&self, s: Point) -> Option<GuideAxis> {
        if !self.prefs.rulers {
            return None;
        }
        if s.y < RULER && s.x >= RULER {
            Some(GuideAxis::Y)
        } else if s.x < RULER && s.y >= RULER {
            Some(GuideAxis::X)
        } else {
            None
        }
    }

    fn guides(&self) -> Vec<Guide> {
        match self.doc.design.node(&self.page) {
            Some(Node::Page(p)) => p.guides.clone().unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    fn guide_at(&self, s: Point) -> Option<(usize, GuideAxis)> {
        if !self.prefs.rulers {
            return None;
        }
        self.guides().iter().enumerate().find_map(|(i, g)| {
            let d = match g.axis {
                GuideAxis::X => (self.camera.to_screen(Point::new(g.pos, 0.0)).x - s.x).abs(),
                GuideAxis::Y => (self.camera.to_screen(Point::new(0.0, g.pos)).y - s.y).abs(),
            };
            (d <= 3.0).then_some((i, g.axis))
        })
    }

    /// Pointer pressed.
    pub fn pointer_down(&mut self, ev: Pointer) -> Cursor {
        self.last_pointer = ev.pos;
        let p = self.camera.to_page(ev.pos);
        self.feedback = Feedback::default();
        if ev.button == Button::Middle
            || (ev.button == Button::Left && (self.space || self.tool == Tool::Hand))
        {
            self.gesture = Some(Gesture::Pan { last: ev.pos });
            return Cursor::Grabbing;
        }
        if ev.button != Button::Left {
            return Cursor::Default;
        }
        // Text editing: clicks inside the box move the caret; outside they finish editing.
        if self.text.is_some() {
            if let Some((laid, w)) = &self.text_layout
                && let Some(local) = w.inverse().map(|inv| inv.apply(p))
            {
                let tol = HIT_SLOP / self.camera.zoom;
                let (bw, bh) = (
                    laid.width.max(laid.content_width),
                    laid.height.max(laid.content_height),
                );
                if local.x >= -tol && local.y >= -tol && local.x <= bw + tol && local.y <= bh + tol
                {
                    let laid = laid.clone();
                    if let Some(t) = &mut self.text {
                        match ev.clicks {
                            2 => t.select_unit_at(&laid, local.x, local.y, false),
                            n if n >= 3 => t.select_unit_at(&laid, local.x, local.y, true),
                            _ => t.click(&laid, local.x, local.y, ev.mods.shift),
                        }
                    }
                    self.gesture = Some(Gesture::TextSelect);
                    return Cursor::Text;
                }
            }
            self.finish_text();
            if self.tool == Tool::Text {
                self.set_tool(Tool::Select);
            }
        }
        if let Some(pen) = &mut self.pen {
            let tol = 6.0 / self.camera.zoom;
            if pen.pointer_down(p, tol, ev.mods.alt, ev.clicks) {
                let done = !pen.drawing
                    && pen.target.is_none()
                    && pen.subs.first().is_some_and(|s| s.closed);
                let finished_by_double = !pen.drawing && pen.target.is_none() && ev.clicks >= 2;
                self.gesture = Some(Gesture::Pen);
                self.update_pen_preview();
                if finished_by_double {
                    self.finish_pen();
                    return Cursor::Default;
                }
                let _ = done;
                return Cursor::Crosshair;
            }
            self.finish_pen();
        }
        if let Some(axis) = self.in_ruler(ev.pos) {
            let pos = if axis == GuideAxis::X { p.x } else { p.y };
            self.gesture = Some(Gesture::Guide {
                axis,
                index: None,
                pos,
                remove: true,
            });
            return if axis == GuideAxis::X {
                Cursor::ColResize
            } else {
                Cursor::RowResize
            };
        }
        match self.tool {
            Tool::Select => self.select_down(ev, p),
            Tool::Hand => Cursor::Grabbing,
            Tool::Pen => {
                let parent = self.container_at(p);
                let mut pen = PenSession::draw(parent);
                pen.pointer_down(p, 6.0 / self.camera.zoom, ev.mods.alt, 1);
                self.pen = Some(pen);
                self.select(Vec::new());
                self.gesture = Some(Gesture::Pen);
                Cursor::Crosshair
            }
            Tool::Text => {
                if let Some(id) = self.pick(p, true)
                    && matches!(self.doc.design.node(&id), Some(Node::Text(_)))
                {
                    self.edit_text(&id, false);
                    self.text_click_at(p, false);
                    self.gesture = Some(Gesture::TextSelect);
                    return Cursor::Text;
                }
                let parent = self.container_at(p);
                self.gesture = Some(Gesture::Create {
                    tool: Tool::Text,
                    origin: p,
                    current: p,
                    parent,
                    mods: ev.mods,
                });
                Cursor::Text
            }
            t if t.creates_shape() || t == Tool::Image => {
                if t == Tool::Image && self.placing.is_none() {
                    self.notice("Choose an image to place first.");
                    return Cursor::Default;
                }
                let parent = self.container_at(p);
                let o = self.snap_px(p);
                self.gesture = Some(Gesture::Create {
                    tool: t,
                    origin: o,
                    current: o,
                    parent,
                    mods: ev.mods,
                });
                Cursor::Crosshair
            }
            _ => Cursor::Default,
        }
    }

    fn select_down(&mut self, ev: Pointer, p: Point) -> Cursor {
        if let Some((i, axis)) = self.guide_at(ev.pos) {
            let g = &self.guides()[i];
            self.gesture = Some(Gesture::Guide {
                axis,
                index: Some(i),
                pos: g.pos,
                remove: false,
            });
            return if axis == GuideAxis::X {
                Cursor::ColResize
            } else {
                Cursor::RowResize
            };
        }
        if let Some(h) = self.handles()
            && let Some(hit) = hit_handles(&h, p)
        {
            let ids = edit::unlocked(&self.doc.design, &self.selection);
            return match hit {
                HandleHit::Resize(kind) => {
                    let single = ids.len() == 1;
                    let node_kind = single
                        .then(|| self.doc.design.node(&ids[0]).map(|n| n.node_type()))
                        .flatten();
                    let aspect_locked = single
                        && self
                            .doc
                            .design
                            .node(&ids[0])
                            .is_some_and(|n| n.base().aspect_locked == Some(true));
                    let keep_aspect_default = kind.is_corner()
                        && (aspect_locked
                            || matches!(
                                node_kind,
                                Some(NodeType::Image) | Some(NodeType::Svg) | Some(NodeType::Text)
                            )
                            || !single);
                    let targets = self.snap_targets(&ids);
                    self.gesture = Some(Gesture::Resize(Box::new(ResizeGesture {
                        handle: kind,
                        start: h.bounds,
                        ids,
                        keep_aspect_default,
                        targets,
                    })));
                    Cursor::Resize(
                        h.resize
                            .iter()
                            .find(|x| x.kind == kind)
                            .map(|x| x.cursor_angle)
                            .unwrap_or(0.0),
                    )
                }
                HandleHit::Rotate(_) => {
                    let center = h.bounds.center();
                    let base_rotation = selection_bounds(&self.doc.design, &ids)
                        .map(|b| b.rotation)
                        .unwrap_or(0.0);
                    self.gesture = Some(Gesture::Rotate {
                        center,
                        start: p,
                        ids,
                        base_rotation,
                    });
                    Cursor::Rotate
                }
            };
        }
        let hit = self.pick(p, ev.mods.primary);
        match hit {
            Some(id) => {
                if ev.clicks >= 2 && !ev.mods.shift {
                    return self.double_click(&id, p);
                }
                let mut toggle_off = None;
                if ev.mods.shift {
                    if self.selection.contains(&id) {
                        // Removed on release unless the press becomes a drag (shift-drag moves on one axis).
                        toggle_off = Some(id);
                    } else {
                        let mut sel = self.selection.clone();
                        sel.push(id);
                        self.select(sel);
                    }
                } else if !self.selection.contains(&id) {
                    self.select(vec![id]);
                }
                let ids = edit::unlocked(&self.doc.design, &self.selection);
                if ids.is_empty() {
                    return Cursor::Default;
                }
                let start = desyn_core::geometry::selection_aabb(&self.doc.design, &ids)
                    .unwrap_or_default();
                let targets = self.snap_targets(&ids);
                self.gesture = Some(Gesture::Move(Box::new(MoveGesture {
                    origin: p,
                    origin_screen: ev.pos,
                    ids,
                    start,
                    active: false,
                    duplicate: None,
                    targets,
                    toggle_off,
                })));
                Cursor::Default
            }
            None => {
                if !ev.mods.shift {
                    self.scope = None;
                    self.select(Vec::new());
                }
                self.gesture = Some(Gesture::Marquee {
                    origin: p,
                    base: self.selection.clone(),
                    additive: ev.mods.shift,
                });
                Cursor::Default
            }
        }
    }

    fn double_click(&mut self, id: &str, p: Point) -> Cursor {
        let node = self.doc.design.node(id).cloned();
        match node {
            Some(Node::Text(_)) => {
                self.edit_text(id, false);
                self.text_click_at(p, false);
                if let Some((laid, w)) = &self.text_layout
                    && let Some(local) = w.inverse().map(|i| i.apply(p))
                {
                    let laid = laid.clone();
                    if let Some(t) = &mut self.text {
                        t.select_unit_at(&laid, local.x, local.y, false);
                    }
                }
                self.gesture = Some(Gesture::TextSelect);
                Cursor::Text
            }
            Some(Node::Path(_)) => {
                self.edit_path(id);
                Cursor::Crosshair
            }
            Some(n) if n.is_container() && !n.child_ids().is_empty() => {
                self.scope = Some(id.to_string());
                let inner = self.pick(p, false);
                self.select(inner.into_iter().collect());
                Cursor::Default
            }
            _ => Cursor::Default,
        }
    }

    /// Pointer moved (with or without a pressed button).
    pub fn pointer_move(&mut self, ev: Pointer) -> Cursor {
        self.last_pointer = ev.pos;
        let p = self.camera.to_page(ev.pos);
        let Some(g) = self.gesture.take() else {
            return self.hover_at(ev);
        };
        let (g, cursor) = self.drive(g, ev, p);
        self.gesture = g;
        cursor
    }

    fn drive(&mut self, g: Gesture, ev: Pointer, p: Point) -> (Option<Gesture>, Cursor) {
        match g {
            Gesture::Pan { last } => {
                self.camera.pan_by(ev.pos.x - last.x, ev.pos.y - last.y);
                (Some(Gesture::Pan { last: ev.pos }), Cursor::Grabbing)
            }
            Gesture::Marquee {
                origin,
                base,
                additive,
                ..
            } => {
                let r = Rect::from_points(origin, p);
                self.marquee = Some(r);
                let opts = self.hit_opts(false);
                let parent = self.scope.clone().unwrap_or_else(|| self.page.clone());
                let mut hits = marquee(
                    &self.doc.design,
                    &self.page,
                    r,
                    MarqueeMode::Intersect,
                    &opts,
                );
                if self.scope.is_some() {
                    // Inside a group: marquee picks its children.
                    let mut deep = HitOptions { deep: true, ..opts };
                    deep.tolerance = 0.0;
                    hits = marquee(
                        &self.doc.design,
                        &self.page,
                        r,
                        MarqueeMode::Intersect,
                        &deep,
                    )
                    .into_iter()
                    .filter_map(|id| self.child_of(&parent, &id))
                    .collect();
                }
                let mut sel = if additive { base.clone() } else { Vec::new() };
                for h in hits {
                    if !sel.contains(&h) {
                        sel.push(h);
                    }
                }
                self.select(sel);
                (
                    Some(Gesture::Marquee {
                        origin,
                        base,
                        additive,
                    }),
                    Cursor::Default,
                )
            }
            Gesture::Move(mut m) => {
                let moved = (ev.pos - m.origin_screen).length();
                if !m.active && moved < DRAG_THRESHOLD {
                    return (Some(Gesture::Move(m)), Cursor::Default);
                }
                m.active = true;
                let step = self.px_step();
                let mut dx = ((p.x - m.origin.x) / step).round() * step;
                let mut dy = ((p.y - m.origin.y) / step).round() * step;
                if ev.mods.shift {
                    if dx.abs() > dy.abs() {
                        dy = 0.0
                    } else {
                        dx = 0.0
                    }
                }
                if self.prefs.snap.enabled && !ev.mods.primary {
                    let moving = m.start.translate(dx, dy);
                    let res = snap_move(moving, &m.targets, &self.snap_options());
                    if !(ev.mods.shift && dx == 0.0) {
                        dx += res.dx;
                    }
                    if !(ev.mods.shift && dy == 0.0) {
                        dy += res.dy;
                    }
                    self.feedback.guides = res.guides;
                    self.feedback.spacing = res.spacing;
                } else {
                    self.feedback.guides.clear();
                    self.feedback.spacing.clear();
                }
                let moving = m.start.translate(dx, dy);
                self.feedback.distances = if self.prefs.smart_distances {
                    distance_labels(moving, &m.targets.objects, m.targets.page)
                } else {
                    Vec::new()
                };
                // Alt-drag duplicates (created once, then moved with the gesture).
                if ev.mods.alt && m.duplicate.is_none() {
                    self.cancel_preview();
                    let (d, g) = self.doc.split();
                    m.duplicate = Some(edit::duplicate(d, &m.ids, (0.0, 0.0), g));
                }
                let ops = {
                    self.cancel_preview();
                    let design = &mut self.doc.design;
                    match &m.duplicate {
                        Some((dup, new_ids)) => {
                            let mut b = desyn_core::builder::TxBuilder::new(design);
                            for op in dup {
                                let _ = b.push(op.clone());
                            }
                            for id in new_ids {
                                let _ = b.translate_in_page(id, dx, dy);
                            }
                            b.finish()
                        }
                        None => edit::translate(design, &m.ids, dx, dy),
                    }
                };
                self.preview(ops);
                self.feedback.pill = Some((
                    Point::new(moving.x + moving.w / 2.0, moving.bottom()),
                    format!("{}, {}", fmt_px(moving.x), fmt_px(moving.y)),
                ));
                let c = if m.duplicate.is_some() {
                    Cursor::Copy
                } else {
                    Cursor::Default
                };
                (Some(Gesture::Move(m)), c)
            }
            Gesture::Resize(r) => {
                let keep = r.keep_aspect_default != ev.mods.shift;
                let opts = ResizeOptions {
                    keep_aspect: keep,
                    from_center: ev.mods.alt,
                };
                let p = self.snap_px(p);
                let mut res = resize_box(&r.start, r.handle, p, &opts);
                let axis_aligned =
                    res.bounds.rotation_deg().abs() < 1e-6 && !res.flip_x && !res.flip_y;
                self.feedback.guides.clear();
                if self.prefs.snap.enabled
                    && !ev.mods.primary
                    && axis_aligned
                    && !keep
                    && !ev.mods.alt
                {
                    let aabb = res.bounds.aabb();
                    let (u, v) = r.handle.anchor();
                    let edges = ResizeEdges {
                        left: u == 0.0,
                        right: u == 1.0,
                        top: v == 0.0,
                        bottom: v == 1.0,
                    };
                    let s = snap_resize(aabb, edges, &r.targets, &self.snap_options());
                    // Re-run the resize with the snapped pointer.
                    let snapped = Point::new(p.x + s.dx, p.y + s.dy);
                    res = resize_box(&r.start, r.handle, snapped, &opts);
                    self.feedback.guides = s.guides;
                }
                let m = edit::box_map(&r.start, &res.bounds, res.flip_x, res.flip_y);
                self.cancel_preview();
                let ops = edit::transform_nodes(&mut self.doc.design, &r.ids, &m);
                self.preview(ops);
                let b = res.bounds;
                self.feedback.pill = Some((
                    b.aabb().center() + Point::new(0.0, b.aabb().h / 2.0),
                    format!("{} × {}", fmt_px(b.width), fmt_px(b.height)),
                ));
                let angle = r.start.rotation_deg();
                let base = match r.handle {
                    HandleKind::Top | HandleKind::Bottom => 90.0,
                    HandleKind::Left | HandleKind::Right => 0.0,
                    HandleKind::TopLeft | HandleKind::BottomRight => 45.0,
                    _ => 135.0,
                };
                (
                    Some(Gesture::Resize(r)),
                    Cursor::Resize((base + angle).rem_euclid(180.0)),
                )
            }
            Gesture::Rotate {
                center,
                start,
                ids,
                base_rotation,
                ..
            } => {
                let step = ev.mods.shift.then_some(15.0);
                let mut delta = rotation_delta(center, start, p, None);
                if let Some(s) = step {
                    // Snap the resulting angle (not the delta) to the step.
                    let target = ((base_rotation + delta) / s).round() * s;
                    delta = target - base_rotation;
                }
                self.cancel_preview();
                let ops = edit::rotate(&mut self.doc.design, &ids, center, delta);
                self.preview(ops);
                let shown = desyn_core::builder::normalize_degrees(base_rotation + delta);
                self.feedback.pill = Some((center, format!("{}°", fmt_px(shown))));
                (
                    Some(Gesture::Rotate {
                        center,
                        start,
                        ids,
                        base_rotation,
                    }),
                    Cursor::Rotate,
                )
            }
            Gesture::Create {
                tool,
                origin,
                parent,
                mods,
                ..
            } => {
                let mods = Mods {
                    shift: ev.mods.shift,
                    alt: ev.mods.alt,
                    ..mods
                };
                let p = self.snap_px(p);
                let r = create_rect(tool, origin, p, mods);
                self.feedback.pill = Some((
                    Point::new(r.x + r.w / 2.0, r.bottom()),
                    if matches!(tool, Tool::Line | Tool::Arrow) {
                        fmt_px(origin.distance(p))
                    } else {
                        format!("{} × {}", fmt_px(r.w), fmt_px(r.h))
                    },
                ));
                (
                    Some(Gesture::Create {
                        tool,
                        origin,
                        current: p,
                        parent,
                        mods,
                    }),
                    Cursor::Crosshair,
                )
            }
            Gesture::TextSelect => {
                if let Some((laid, w)) = &self.text_layout
                    && let Some(local) = w.inverse().map(|i| i.apply(p))
                {
                    let laid = laid.clone();
                    if let Some(t) = &mut self.text {
                        let anchor = t.anchor;
                        t.click(&laid, local.x, local.y, true);
                        t.anchor = anchor;
                    }
                }
                (Some(Gesture::TextSelect), Cursor::Text)
            }
            Gesture::Pen => {
                if let Some(pen) = &mut self.pen {
                    pen.pointer_move(p, ev.mods.alt);
                }
                self.update_pen_preview();
                (Some(Gesture::Pen), Cursor::Crosshair)
            }
            Gesture::Guide { axis, index, .. } => {
                let pos = if axis == GuideAxis::X { p.x } else { p.y };
                let pos = (pos * 10.0).round() / 10.0;
                let remove = self.in_ruler(ev.pos).is_some() || ev.pos.x < 0.0 || ev.pos.y < 0.0;
                if let Some(i) = index {
                    // Preview from the original guides (the preview is reverted first).
                    self.cancel_preview();
                    let mut guides = self.guides();
                    if remove {
                        guides.remove(i.min(guides.len().saturating_sub(1)));
                    } else if let Some(g) = guides.get_mut(i) {
                        g.pos = pos;
                    }
                    let ops = self.guides_op(guides);
                    self.preview(ops);
                }
                self.feedback.pill = Some((
                    if axis == GuideAxis::X {
                        Point::new(pos, p.y)
                    } else {
                        Point::new(p.x, pos)
                    },
                    fmt_px(pos),
                ));
                let c = if axis == GuideAxis::X {
                    Cursor::ColResize
                } else {
                    Cursor::RowResize
                };
                (
                    Some(Gesture::Guide {
                        axis,
                        index,
                        pos,
                        remove,
                    }),
                    c,
                )
            }
        }
    }

    fn child_of(&self, parent: &str, id: &str) -> Option<Id> {
        let mut cur = id.to_string();
        loop {
            let n = self.doc.design.node(&cur)?;
            let par = n.parent()?.to_string();
            if par == parent {
                return Some(cur);
            }
            cur = par;
        }
    }

    fn guides_op(&self, guides: Vec<Guide>) -> Vec<Op> {
        let mut set = Map::new();
        set.insert(
            "guides".into(),
            serde_json::to_value(guides).unwrap_or_default(),
        );
        vec![Op::update_set(self.page.clone(), set)]
    }

    /// Pointer released.
    pub fn pointer_up(&mut self, ev: Pointer) -> Cursor {
        self.last_pointer = ev.pos;
        let p = self.camera.to_page(ev.pos);
        let g = self.gesture.take();
        self.marquee = None;
        let pill = self.feedback.pill.take();
        let _ = pill;
        self.feedback.guides.clear();
        self.feedback.spacing.clear();
        self.feedback.distances.clear();
        match g {
            None
            | Some(Gesture::Pan { .. })
            | Some(Gesture::Marquee { .. })
            | Some(Gesture::TextSelect) => {}
            Some(Gesture::Move(m)) => {
                if m.active {
                    let label = if m.duplicate.is_some() {
                        "Duplicate"
                    } else {
                        "Move"
                    };
                    let new_sel = m.duplicate.as_ref().map(|(_, ids)| ids.clone());
                    self.commit_preview(label, new_sel);
                } else if let Some(id) = &m.toggle_off {
                    let sel: Vec<Id> = self
                        .selection
                        .iter()
                        .filter(|x| *x != id)
                        .cloned()
                        .collect();
                    self.select(sel);
                } else if !ev.mods.shift && self.selection.len() > 1 {
                    // A click (no drag) on a member of a multi-selection selects just that node.
                    if let Some(id) = self.pick(p, ev.mods.primary) {
                        self.select(vec![id]);
                    }
                }
            }
            Some(Gesture::Resize(_)) => self.commit_preview("Resize", None),
            Some(Gesture::Rotate { .. }) => self.commit_preview("Rotate", None),
            Some(Gesture::Create {
                tool,
                origin,
                parent,
                mods,
                ..
            }) => {
                let mods = Mods {
                    shift: ev.mods.shift,
                    alt: ev.mods.alt,
                    ..mods
                };
                let end = self.snap_px(p);
                self.create(
                    tool,
                    origin,
                    end,
                    &parent,
                    mods,
                    (ev.pos - self.camera.to_screen(origin)).length() < DRAG_THRESHOLD,
                );
            }
            Some(Gesture::Pen) => {
                if let Some(pen) = &mut self.pen {
                    pen.pointer_up();
                    if !pen.drawing && pen.target.is_none() {
                        // Closed or double-clicked: the new path is done.
                        self.finish_pen();
                    }
                }
            }
            Some(Gesture::Guide {
                axis,
                index,
                pos,
                remove,
            }) => match index {
                Some(_) => {
                    let label = if remove { "Remove guide" } else { "Move guide" };
                    self.commit_preview(label, None);
                }
                None if !remove => {
                    let mut guides = self.guides();
                    guides.push(Guide {
                        axis,
                        pos,
                        extra: Default::default(),
                    });
                    let ops = self.guides_op(guides);
                    self.commit(ops, "Add guide", None);
                }
                None => {}
            },
        }
        self.hover_at(ev)
    }

    fn commit_preview(&mut self, label: &str, select: Option<Vec<Id>>) {
        let (doc, m) = self.measurer();
        doc.seal_history();
        let ops = doc.preview_ops();
        match ops {
            Some(ops) => {
                doc.commit_preview(ops, label, m);
            }
            None => doc.cancel_preview(m),
        }
        if let Some(s) = select {
            self.select(s);
        }
        self.reconcile();
    }

    /// Cancels the running gesture (Escape while dragging).
    pub fn cancel_gesture(&mut self) -> bool {
        if self.gesture.take().is_some() {
            self.cancel_preview();
            self.marquee = None;
            self.feedback = Feedback::default();
            return true;
        }
        false
    }

    /// Whether a gesture is running (the UI keeps pointer capture).
    pub fn has_gesture(&self) -> bool {
        self.gesture.is_some()
    }

    fn hover_at(&mut self, ev: Pointer) -> Cursor {
        let p = self.camera.to_page(ev.pos);
        if self.tool != Tool::Select || self.pen.is_some() {
            // Hover outlines belong to selecting.
            self.hover = None;
        }
        if self.space || self.tool == Tool::Hand {
            return Cursor::Grab;
        }
        if let Some(pen) = &mut self.pen {
            pen.hover = Some(p);
            return Cursor::Crosshair;
        }
        if let Some(axis) = self.in_ruler(ev.pos) {
            return if axis == GuideAxis::X {
                Cursor::ColResize
            } else {
                Cursor::RowResize
            };
        }
        if self.tool == Tool::Select
            && let Some((_, axis)) = self.guide_at(ev.pos)
        {
            return if axis == GuideAxis::X {
                Cursor::ColResize
            } else {
                Cursor::RowResize
            };
        }
        if self.text.is_some() {
            if let Some((laid, w)) = &self.text_layout
                && let Some(local) = w.inverse().map(|i| i.apply(p))
                && local.x >= 0.0
                && local.y >= 0.0
                && local.x <= laid.width.max(laid.content_width)
                && local.y <= laid.height.max(laid.content_height)
            {
                return Cursor::Text;
            }
            return Cursor::Default;
        }
        match self.tool {
            Tool::Select => {
                if let Some(h) = self.handles()
                    && let Some(hit) = hit_handles(&h, p)
                {
                    self.hover = None;
                    return match hit {
                        HandleHit::Resize(k) => Cursor::Resize(
                            h.resize
                                .iter()
                                .find(|x| x.kind == k)
                                .map(|x| x.cursor_angle)
                                .unwrap_or(0.0),
                        ),
                        HandleHit::Rotate(_) => Cursor::Rotate,
                    };
                }
                let hit = self.pick(p, ev.mods.primary);
                if hit != self.hover {
                    self.hover = hit;
                }
                self.alt = ev.mods.alt;
                Cursor::Default
            }
            Tool::Text => Cursor::Text,
            Tool::Image if self.placing.is_none() => Cursor::Default,
            _ => Cursor::Crosshair,
        }
    }

    /// Clears hover (pointer left the canvas).
    pub fn pointer_left(&mut self) {
        self.hover = None;
    }

    /// Scroll wheel / trackpad scroll. `precise` = pixel deltas (trackpads).
    pub fn scroll(&mut self, delta: Point, precise: bool, at: Point, mods: Mods) {
        if mods.primary {
            let dy = if precise { delta.y } else { delta.y * 40.0 };
            let factor = (dy * 0.0025).exp();
            self.camera.zoom_by(factor, at);
            return;
        }
        let (mut dx, mut dy) = if precise {
            (delta.x, delta.y)
        } else {
            (delta.x * 40.0, delta.y * 40.0)
        };
        if mods.shift && dx == 0.0 {
            std::mem::swap(&mut dx, &mut dy);
        }
        self.camera.pan_by(dx, dy);
    }

    /// Pinch zoom (`delta` 0.1 = +10 %).
    pub fn pinch(&mut self, delta: f64, at: Point) {
        self.camera.zoom_by(1.0 + delta, at);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Creation

    fn create(
        &mut self,
        tool: Tool,
        origin: Point,
        end: Point,
        parent: &str,
        mods: Mods,
        click: bool,
    ) {
        let parent_world = match self.doc.design.node(parent).map(|n| n.node_type()) {
            Some(NodeType::Page) | Some(NodeType::Root) | None => Affine::IDENTITY,
            _ => world_transform(&self.doc.design, parent),
        };
        let inv = parent_world.inverse().unwrap_or(Affine::IDENTITY);
        let id = self.doc.new_id();
        let node = match tool {
            Tool::Text => {
                let o = inv.apply(origin);
                let width = (!click).then(|| (end.x - origin.x).abs().max(20.0));
                let x = if click {
                    o.x
                } else {
                    inv.apply(Point::new(origin.x.min(end.x), origin.y)).x
                };
                let mut n = Node::text(id.clone(), "", x, o.y - 14.0, width);
                n.base_mut().name = "Text".into();
                n.base_mut().parent = Some(parent.to_string());
                if let Some(session) = TextSession::create(n) {
                    self.select(Vec::new());
                    self.text = Some(session);
                    self.events.push(SessionEvent::TextEditing(true));
                    self.refresh_text();
                }
                return;
            }
            Tool::Image => {
                let Some(img) = self.placing.take() else {
                    return;
                };
                let at = if click {
                    origin
                } else {
                    Rect::from_points(origin, end).center()
                };
                let page = self.page.clone();
                let res = clipboard::paste_bytes(
                    &mut self.doc,
                    img.bytes.clone(),
                    Some(&img.name),
                    &page,
                    at,
                );
                match res {
                    Ok(mut pasted) => {
                        if !click {
                            // Fit the dragged box keeping the picture's aspect ratio.
                            let r = Rect::from_points(origin, end);
                            let s = (r.w / img.size.0).min(r.h / img.size.1);
                            let (w, h) = (img.size.0 * s, img.size.1 * s);
                            if let Some(Op::Create(c)) = pasted.ops.last_mut()
                                && let Some(n) = c.nodes.first_mut()
                            {
                                let b = n.base_mut();
                                b.width = (w * 100.0).round() / 100.0;
                                b.height = (h * 100.0).round() / 100.0;
                                b.x = r.center().x - b.width / 2.0;
                                b.y = r.center().y - b.height / 2.0;
                            }
                        }
                        let roots = pasted.roots.clone();
                        self.commit(pasted.ops, "Place image", Some(roots));
                    }
                    Err(e) => self.notice(e.0),
                }
                self.set_tool(Tool::Select);
                return;
            }
            _ => {
                let mut r = if click {
                    let (w, h) = default_size(tool);
                    Rect {
                        x: origin.x - w / 2.0,
                        y: origin.y - h / 2.0,
                        w,
                        h,
                    }
                } else {
                    create_rect(tool, origin, end, mods)
                };
                if matches!(tool, Tool::Line | Tool::Arrow) {
                    let (a, b) = if click {
                        (
                            Point::new(origin.x - 50.0, origin.y),
                            Point::new(origin.x + 50.0, origin.y),
                        )
                    } else {
                        (origin, constrain_angle(origin, end, mods.shift))
                    };
                    let (la, lb) = (inv.apply(a), inv.apply(b));
                    let len = la.distance(lb);
                    let mid = la.lerp(lb, 0.5);
                    let angle = (lb.y - la.y).atan2(lb.x - la.x).to_degrees();
                    let mut n = Node::line(id.clone(), tool.label(), mid.x - len / 2.0, mid.y, len);
                    n.base_mut().rotation = desyn_core::builder::normalize_degrees(angle);
                    if tool == Tool::Arrow
                        && let Node::Line(l) = &mut n
                    {
                        l.end_cap = desyn_core::model::Cap::Arrow;
                    }
                    n
                } else {
                    let tl = inv.apply(Point::new(r.x, r.y));
                    r.x = tl.x;
                    r.y = tl.y;
                    let round = |v: f64| (v * 100.0).round() / 100.0;
                    let (x, y, w, h) = (
                        round(r.x),
                        round(r.y),
                        round(r.w.max(1.0)),
                        round(r.h.max(1.0)),
                    );
                    match tool {
                        Tool::Frame => Node::frame(id.clone(), "Frame", x, y, w, h),
                        Tool::Ellipse => Node::ellipse(id.clone(), "Ellipse", x, y, w, h),
                        Tool::Polygon => Node::polygon(id.clone(), "Polygon", 6, x, y, w, h),
                        Tool::Star => Node::star(id.clone(), "Star", 5, 0.5, x, y, w, h),
                        _ => Node::rect(id.clone(), "Rectangle", x, y, w, h),
                    }
                }
            }
        };
        let label = format!("Add {}", tool.label().to_lowercase());
        self.commit(
            vec![Op::create(vec![node], parent, None)],
            &label,
            Some(vec![id]),
        );
        self.set_tool(Tool::Select);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Text editing

    /// Starts editing a text node.
    pub fn edit_text(&mut self, id: &str, select_all: bool) {
        self.finish_pen();
        if self.text.as_ref().is_some_and(|t| t.node_id == id) {
            return;
        }
        self.finish_text();
        let Some(Node::Text(t)) = self.doc.design.node(id) else {
            return;
        };
        if t.base.locked {
            return;
        }
        self.text = Some(TextSession::edit(t, select_all));
        self.select(vec![id.to_string()]);
        self.events.push(SessionEvent::TextEditing(true));
        self.refresh_text();
    }

    fn text_click_at(&mut self, p: Point, extend: bool) {
        if let Some((laid, w)) = &self.text_layout
            && let Some(local) = w.inverse().map(|i| i.apply(p))
        {
            let laid = laid.clone();
            if let Some(t) = &mut self.text {
                t.click(&laid, local.x, local.y, extend);
            }
        }
    }

    /// Re-applies the text preview and re-lays out the edited node.
    pub fn refresh_text(&mut self) {
        let Some(t) = &self.text else { return };
        let ops = t.ops();
        let id = t.node_id.clone();
        self.preview(ops);
        let Some(Node::Text(n)) = self.doc.design.node(&id) else {
            self.text_layout = None;
            return;
        };
        let n = n.clone();
        let w = world_transform(&self.doc.design, &id);
        let styles = self.doc.design.styles.clone();
        let laid = self.renderer.text_mut().layout_node(&n, Some(&styles));
        self.text_layout = Some((laid, w));
    }

    /// Commits the text typed so far while the layer stays in edit mode, so sync and observers see typing
    /// without waiting for the session to end (the UI calls this after 400 ms without typing, DOCUMENT_MODEL §6).
    /// Every checkpoint and the final commit of one session form a single undo step. Returns whether anything
    /// was committed.
    pub fn checkpoint_text(&mut self) -> bool {
        let Some(t) = &self.text else { return false };
        let Some(ops) = t.checkpoint_ops() else {
            return false;
        };
        let label = if t.created.is_some() {
            "Add text"
        } else {
            "Edit text"
        };
        if self.text_group.is_none() {
            self.doc.seal_history();
            self.text_group = Some(format!("text-{}", self.doc.new_id()));
        }
        let group = self.text_group.clone().unwrap_or_default();
        let (doc, m) = self.measurer();
        if doc.commit_preview_grouped(ops, label, &group, m).is_none() {
            return false;
        }
        if let Some(t) = &mut self.text {
            t.mark_checkpoint();
        }
        self.refresh_text();
        true
    }

    /// Ends text editing, committing the change as one step.
    pub fn finish_text(&mut self) {
        let Some(t) = self.text.take() else { return };
        self.text_layout = None;
        let id = t.node_id.clone();
        let group = self.text_group.take();
        let (doc, m) = self.measurer();
        match t.commit_ops() {
            Some(ops) => {
                let label = if t.created.is_some() {
                    "Add text"
                } else {
                    "Edit text"
                };
                match &group {
                    Some(g) => {
                        doc.commit_preview_grouped(ops, label, g, m);
                    }
                    None => {
                        doc.seal_history();
                        doc.commit_preview(ops, label, m);
                    }
                }
            }
            None => doc.cancel_preview(m),
        }
        if group.is_some() {
            // The next edit starts a new undo step.
            self.doc.seal_history();
        }
        self.events.push(SessionEvent::TextEditing(false));
        if self.doc.design.node(&id).is_some() {
            self.select(vec![id]);
        } else {
            self.select(Vec::new());
        }
        self.reconcile();
    }

    /// Runs `f` on the text session and its layout, then refreshes the preview.
    pub fn with_text(
        &mut self,
        f: impl FnOnce(&mut TextSession, &LaidOutText, &desyn_core::model::TextNode),
    ) {
        let Some((laid, _)) = &self.text_layout else {
            return;
        };
        let laid = laid.clone();
        let Some(t) = &self.text else { return };
        let node = match self.doc.design.node(&t.node_id) {
            Some(Node::Text(n)) => n.clone(),
            _ => return,
        };
        if let Some(t) = &mut self.text {
            f(t, &laid, &node);
        }
        self.refresh_text();
    }

    /// Types text.
    pub fn text_insert(&mut self, s: &str) {
        self.with_text(|t, _, _| t.insert(s));
    }

    /// Backspace / delete.
    pub fn text_delete(&mut self, forward: bool, unit: DeleteUnit) {
        self.with_text(|t, l, _| {
            if forward {
                t.delete_forward(l, unit)
            } else {
                t.backspace(l, unit)
            }
        });
    }

    /// Caret movement.
    pub fn text_move(&mut self, m: Move, extend: bool) {
        self.with_text(|t, l, _| t.move_caret(l, m, extend));
    }

    /// Formatting toggles.
    pub fn text_format(&mut self, f: Format) {
        self.with_text(|t, _, n| t.format(f, n));
    }

    /// Paragraph alignment / lists for the edited node.
    pub fn text_paragraph(&mut self, key: &str, value: serde_json::Value) {
        self.with_text(|t, _, n| t.set_paragraph(n, key, value));
    }

    /// The text range a link edit applies to (selection or word at the caret) and its current link.
    pub fn text_link_target(&self) -> Option<(std::ops::Range<usize>, Option<String>)> {
        let t = self.text.as_ref()?;
        let (laid, _) = self.text_layout.as_ref()?;
        let Some(Node::Text(n)) = self.doc.design.node(&t.node_id) else {
            return None;
        };
        Some(t.link_target(laid, n))
    }

    /// Sets or removes (`None`) the link of a text range while editing (see [`crate::canvas::text::normalize_link`]).
    pub fn text_set_link(&mut self, range: std::ops::Range<usize>, link: Option<String>) {
        self.with_text(|t, _, n| {
            t.set_link(range.clone(), link, n);
            // Keep the linked text selected so the change is visible.
            if !range.is_empty() {
                t.anchor = range.start;
                t.head = range.end;
            }
        });
    }

    /// Caret and selection rectangles in screen space plus the composition underline.
    pub fn text_geometry(&self) -> Option<TextGeometry> {
        let t = self.text.as_ref()?;
        let (laid, w) = self.text_layout.as_ref()?;
        let to_screen = |p: Point| self.camera.to_screen(w.apply(p));
        let c = laid.caret_rect(t.caret());
        let caret = [
            to_screen(Point::new(c.x, c.y)),
            to_screen(Point::new(c.x, c.y + c.height)),
        ];
        let quads = |r: std::ops::Range<usize>| -> Vec<[Point; 4]> {
            laid.selection_rects(r)
                .into_iter()
                .map(|r| {
                    [
                        to_screen(Point::new(r.x, r.y)),
                        to_screen(Point::new(r.x + r.w, r.y)),
                        to_screen(Point::new(r.x + r.w, r.y + r.h)),
                        to_screen(Point::new(r.x, r.y + r.h)),
                    ]
                })
                .collect()
        };
        let selection = quads(t.selection());
        let marked = t.marked.clone().map(quads).unwrap_or_default();
        let bounds = {
            let (bw, bh) = (
                laid.width.max(laid.content_width),
                laid.height.max(laid.content_height),
            );
            [
                Point::new(0.0, 0.0),
                Point::new(bw, 0.0),
                Point::new(bw, bh),
                Point::new(0.0, bh),
            ]
            .map(to_screen)
        };
        Some(TextGeometry {
            caret,
            selection,
            marked,
            bounds,
        })
    }

    // ---------------------------------------------------------------------------------------------------------
    // Pen

    /// Starts editing a path node's points.
    pub fn edit_path(&mut self, id: &str) {
        self.finish_text();
        self.finish_pen();
        if let Some(p) = PenSession::edit(&self.doc.design, id) {
            self.pen = Some(p);
            self.select(vec![id.to_string()]);
        }
    }

    fn update_pen_preview(&mut self) {
        let Some(pen) = &mut self.pen else { return };
        if !pen.dirty {
            return;
        }
        pen.dirty = false;
        let pen = pen.clone();
        self.cancel_preview();
        let preview_id = "penpreview00".to_string();
        if let Some(ops) = pen.ops(&self.doc.design, || preview_id) {
            self.preview(ops);
        }
    }

    /// Commits the pen session.
    pub fn finish_pen(&mut self) {
        let Some(pen) = self.pen.take() else { return };
        self.cancel_preview();
        let id = self.doc.new_id();
        let new_id = id.clone();
        match pen.ops(&self.doc.design, move || new_id) {
            Some(ops) => {
                let (label, sel) = match &pen.target {
                    Some(t) => ("Edit path", t.clone()),
                    None => ("Draw path", id),
                };
                self.doc.seal_history();
                self.commit(ops, label, Some(vec![sel]));
            }
            None => {
                if pen.target.is_some() {
                    self.notice("A path needs at least two points.");
                }
            }
        }
        if self.tool == Tool::Pen {
            self.tool = Tool::Select;
            self.events.push(SessionEvent::Tool(Tool::Select));
        }
    }

    /// Backspace in the pen: removes the last / selected anchor.
    pub fn pen_remove_point(&mut self) {
        if let Some(pen) = &mut self.pen {
            if !pen.remove_selected() && pen.drawing {
                self.pen = None;
                self.cancel_preview();
                return;
            }
            self.update_pen_preview();
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Commands (menus, shortcuts, palette)

    /// Escape: cancels the gesture, leaves text / pen / scope, resets the tool, then clears the selection.
    pub fn escape(&mut self) {
        if self.cancel_gesture() {
            return;
        }
        if self.text.is_some() {
            self.finish_text();
            // Like clicking outside the text: back to the select tool, the finished layer selected.
            if self.tool == Tool::Text {
                self.set_tool(Tool::Select);
            }
            return;
        }
        if self.pen.is_some() {
            self.finish_pen();
            return;
        }
        if self.tool != Tool::Select {
            self.set_tool(Tool::Select);
            return;
        }
        if let Some(scope) = self.scope.take() {
            self.select(vec![scope]);
            return;
        }
        self.select(Vec::new());
    }

    /// Enter: edit text / path, or step into a container.
    pub fn enter(&mut self) {
        let [id] = self.selection.as_slice() else {
            return;
        };
        let id = id.clone();
        match self.doc.design.node(&id).cloned() {
            Some(Node::Text(_)) => self.edit_text(&id, true),
            Some(Node::Path(_)) => self.edit_path(&id),
            Some(n) if n.is_container() && !n.child_ids().is_empty() => {
                self.scope = Some(id);
                let kids = edit::selectable_children(&self.doc.design, n.id());
                self.select(kids);
            }
            _ => {}
        }
    }

    /// Shift+Enter: select the parent.
    pub fn select_parent(&mut self) {
        let Some(first) = self.selection.first() else {
            return;
        };
        let Some(parent) = self
            .doc
            .design
            .node(first)
            .and_then(|n| n.parent())
            .map(str::to_string)
        else {
            return;
        };
        if self
            .doc
            .design
            .node(&parent)
            .is_some_and(|n| matches!(n.node_type(), NodeType::Page | NodeType::Root))
        {
            return;
        }
        self.scope = self
            .doc
            .design
            .node(&parent)
            .and_then(|n| n.parent())
            .filter(|p| *p != self.page)
            .map(str::to_string);
        self.select(vec![parent]);
    }

    /// Tab / shift+Tab: next / previous sibling.
    pub fn select_sibling(&mut self, dir: i32) {
        let parent = self
            .selection
            .first()
            .and_then(|f| self.doc.design.node(f))
            .and_then(|n| n.parent())
            .map(str::to_string)
            .or_else(|| self.scope.clone())
            .unwrap_or_else(|| self.page.clone());
        let kids = edit::selectable_children(&self.doc.design, &parent);
        if kids.is_empty() {
            return;
        }
        // Tab walks in visual order from the top layer down.
        let order: Vec<Id> = kids.into_iter().rev().collect();
        let cur = self
            .selection
            .first()
            .and_then(|f| order.iter().position(|k| k == f));
        let n = order.len() as i64;
        let i = match cur {
            Some(c) => (c as i64 + dir as i64).rem_euclid(n) as usize,
            None => {
                if dir > 0 {
                    0
                } else {
                    order.len() - 1
                }
            }
        };
        self.select(vec![order[i].clone()]);
    }

    /// Select all on the page (or inside the entered group).
    pub fn select_all(&mut self) {
        if let Some(t) = &mut self.text {
            t.select_all();
            return;
        }
        let parent = self.scope.clone().unwrap_or_else(|| self.page.clone());
        let ids = edit::selectable_children(&self.doc.design, &parent);
        self.select(ids);
    }

    /// Select matching layers.
    pub fn select_matching(&mut self) {
        let ids = edit::matching(&self.doc.design, &self.page, &self.selection);
        if !ids.is_empty() {
            self.scope = None;
            self.select(ids);
        }
    }

    /// Undo.
    pub fn undo(&mut self) {
        self.cancel_gesture();
        if self.text.is_some() {
            self.finish_text();
        }
        self.finish_pen();
        let (doc, m) = self.measurer();
        match doc.undo(m) {
            Some(label) => {
                self.reconcile();
                self.notice(format!("Undo {label}"));
            }
            None => self.notice("Nothing to undo"),
        }
    }

    /// Redo.
    pub fn redo(&mut self) {
        self.cancel_gesture();
        self.finish_text();
        self.finish_pen();
        let (doc, m) = self.measurer();
        match doc.redo(m) {
            Some(label) => {
                self.reconcile();
                self.notice(format!("Redo {label}"));
            }
            None => self.notice("Nothing to redo"),
        }
    }

    /// Delete the selection.
    pub fn delete(&mut self) {
        if self.pen.is_some() {
            self.pen_remove_point();
            return;
        }
        let ops = edit::delete(&self.doc.design, &self.selection);
        let n = self.selection.len();
        if self.commit(
            ops,
            if n == 1 { "Delete" } else { "Delete layers" },
            Some(Vec::new()),
        ) {
            self.scope = None;
        }
    }

    /// Nudge by the arrow distance (shift = big nudge).
    pub fn nudge(&mut self, dx: f64, dy: f64, big: bool) {
        let step = if big {
            self.prefs.big_nudge
        } else {
            self.prefs.nudge
        };
        let ops = edit::translate(&mut self.doc.design, &self.selection, dx * step, dy * step);
        self.commit_coalescing(ops, "Nudge", "nudge");
    }

    /// Duplicate (mod+D).
    pub fn duplicate(&mut self) {
        let (d, g) = self.doc.split();
        let (ops, ids) = edit::duplicate(d, &self.selection.clone(), (16.0, 16.0), g);
        self.commit(ops, "Duplicate", Some(ids));
    }

    /// Group (mod+G).
    pub fn group(&mut self) {
        let sel = self.selection.clone();
        let (d, g) = self.doc.split();
        if let Some((ops, id)) = edit::group(d, &sel, g) {
            self.commit(ops, "Group", Some(vec![id]));
        }
    }

    /// Ungroup (mod+shift+G).
    pub fn ungroup(&mut self) {
        let sel = self.selection.clone();
        let (ops, kids) = edit::ungroup(&mut self.doc.design, &sel);
        self.commit(ops, "Ungroup", Some(kids));
    }

    /// Frame selection (mod+alt+G).
    pub fn frame_selection(&mut self) {
        let sel = self.selection.clone();
        let (d, g) = self.doc.split();
        if let Some((ops, id)) = edit::frame_selection(d, &sel, g) {
            self.commit(ops, "Frame selection", Some(vec![id]));
        }
    }

    /// Add auto-layout (shift+A).
    pub fn add_auto_layout(&mut self) {
        let sel = self.selection.clone();
        let (d, g) = self.doc.split();
        if let Some((ops, id)) = edit::add_auto_layout(d, &sel, g) {
            self.commit(ops, "Add auto-layout", Some(vec![id]));
        }
    }

    /// Use as mask (mod+alt+M).
    pub fn use_as_mask(&mut self) {
        let sel = self.selection.clone();
        let (d, g) = self.doc.split();
        if let Some((ops, id)) = edit::use_as_mask(d, &sel, g) {
            self.commit(ops, "Use as mask", Some(vec![id]));
        }
    }

    /// Flip (shift+H / shift+V).
    pub fn flip(&mut self, horizontal: bool) {
        let sel = self.selection.clone();
        let ops = edit::flip(&mut self.doc.design, &sel, horizontal);
        self.commit(
            ops,
            if horizontal {
                "Flip horizontal"
            } else {
                "Flip vertical"
            },
            None,
        );
    }

    /// Lock / unlock (mod+shift+L).
    pub fn toggle_lock(&mut self) {
        let sel = edit::movable(&self.doc.design, &self.selection);
        let lock = !sel
            .iter()
            .all(|i| self.doc.design.node(i).is_some_and(|n| n.base().locked));
        let ops = edit::set_locked(&self.doc.design, &sel, lock);
        self.commit(ops, if lock { "Lock" } else { "Unlock" }, None);
    }

    /// Hide / show (mod+shift+H).
    pub fn toggle_visible(&mut self) {
        let sel = edit::movable(&self.doc.design, &self.selection);
        let show = sel
            .iter()
            .any(|i| self.doc.design.node(i).is_some_and(|n| !n.base().visible));
        let ops = edit::set_visible(&self.doc.design, &sel, show);
        self.commit(ops, if show { "Show" } else { "Hide" }, None);
    }

    /// Z-order.
    pub fn reorder(&mut self, z: ZOrder) {
        let ops = edit::reorder(&self.doc.design, &self.selection, z);
        let label = match z {
            ZOrder::BringForward => "Bring forward",
            ZOrder::SendBackward => "Send backward",
            ZOrder::BringToFront => "Bring to front",
            ZOrder::SendToBack => "Send to back",
        };
        self.commit(ops, label, None);
    }

    /// Align.
    pub fn align(&mut self, a: Alignment) {
        let sel = self.selection.clone();
        let ops = edit::align(&mut self.doc.design, &sel, a);
        self.commit(ops, "Align", None);
    }

    /// Distribute.
    pub fn distribute(&mut self, axis: DistributeAxis) {
        let sel = self.selection.clone();
        let ops = edit::distribute(&mut self.doc.design, &sel, axis);
        if ops.is_empty() {
            self.notice("Select three or more layers to distribute.");
            return;
        }
        self.commit(ops, "Distribute", None);
    }

    /// Renames a node.
    pub fn rename(&mut self, id: &str, name: &str) {
        let ops = edit::rename(&self.doc.design, id, name);
        self.commit(ops, "Rename", None);
    }

    /// Adds a page after the active one and shows it (mod+Enter).
    pub fn add_page(&mut self) {
        let page = self.page.clone();
        let (d, g) = self.doc.split();
        let (ops, id) = edit::add_page(d, Some(&page), Some(&page), g);
        if self.commit(ops, "Add page", Some(Vec::new())) {
            self.set_page(&id);
        }
    }

    /// Duplicates a page.
    pub fn duplicate_page(&mut self, page: &str) {
        let (d, g) = self.doc.split();
        if let Some((ops, id)) = edit::duplicate_page(d, page, g)
            && self.commit(ops, "Duplicate page", Some(Vec::new()))
        {
            self.set_page(&id);
        }
    }

    /// Deletes a page.
    pub fn delete_page(&mut self, page: &str) {
        let pages = self.doc.design.page_ids().to_vec();
        let ops = edit::delete_page(&self.doc.design, page);
        if ops.is_empty() {
            self.notice("A design needs at least one page.");
            return;
        }
        let idx = pages.iter().position(|p| p == page).unwrap_or(0);
        if self.commit(ops, "Delete page", Some(Vec::new())) && self.page == page {
            let pages = self.doc.design.page_ids().to_vec();
            let next = pages[idx.min(pages.len() - 1)].clone();
            self.page = String::new();
            self.set_page(&next);
        }
    }

    /// Moves a page.
    pub fn move_page(&mut self, page: &str, index: usize) {
        let ops = edit::move_page(&self.doc.design, page, index);
        self.commit(ops, "Move page", None);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Clipboard and import

    /// Copies the selection (or the selected text while editing). Returns what to put on the system clipboard.
    pub fn copy(&mut self) -> Option<ClipboardContent> {
        if let Some(t) = &self.text {
            let s = t.selected_text();
            return (!s.is_empty()).then_some(ClipboardContent::Text(s));
        }
        let c = clipboard::copy_selection(&self.doc, &self.selection)?;
        self.paste_count = 0;
        self.last_paste = Some(c.json.clone());
        let png = self.selection_png();
        Some(ClipboardContent::Layers(Box::new(c), png))
    }

    /// PNG of the selected layers at 2x (for pasting into other apps).
    pub fn selection_png(&mut self) -> Option<Vec<u8>> {
        let ids = edit::movable(&self.doc.design, &self.selection);
        let r = desyn_core::geometry::selection_aabb(&self.doc.design, &ids)?;
        let opts = desyn_raster::PageRenderOptions {
            page: Some(self.page.clone()),
            scale: (2.0f64).min(4096.0 / r.w.max(r.h).max(1.0)),
            region: Some(r),
            transparent: true,
            only: Some(ids),
            ..Default::default()
        };
        let page = self.renderer.render_page(&self.doc.design, &opts).ok()?;
        desyn_raster::export::bitmap::encode_png(&page.pixmap, None).ok()
    }

    /// Cut.
    pub fn cut(&mut self) -> Option<ClipboardContent> {
        if self.text.is_some() {
            let c = self.copy();
            self.text_delete(false, DeleteUnit::Grapheme);
            return c;
        }
        let c = self.copy()?;
        let ops = edit::delete(&self.doc.design, &self.selection);
        self.commit(ops, "Cut", Some(Vec::new()));
        Some(c)
    }

    fn paste_parent(&self) -> Id {
        if let Some(s) = &self.scope
            && self.doc.design.node(s).is_some_and(|n| n.is_container())
        {
            return s.clone();
        }
        self.page.clone()
    }

    fn viewport_center(&self) -> Point {
        self.camera.to_page(Point::new(
            self.camera.width / 2.0,
            self.camera.height / 2.0,
        ))
    }

    /// Pastes clipboard text: Desyn layers, SVG markup, or plain text (into the edited text while typing).
    pub fn paste_text(&mut self, text: &str, in_place: bool) {
        if self.text.is_some() {
            self.text_insert(text);
            return;
        }
        let parent = self.paste_parent();
        let center = self.viewport_center();
        if desyn_core::clipboard::ClipboardPayload::from_json(text).is_some() {
            let same = self.last_paste.as_deref() == Some(text);
            let payload =
                desyn_core::clipboard::ClipboardPayload::from_json(text).expect("checked");
            let visible = self.camera.visible().intersects(&payload.bounds);
            let (at, offset) = if in_place {
                (None, (0.0, 0.0))
            } else if same && visible && payload.source_design == self.doc.design.id {
                self.paste_count += 1;
                (
                    None,
                    (
                        16.0 * self.paste_count as f64,
                        16.0 * self.paste_count as f64,
                    ),
                )
            } else {
                (Some(center), (0.0, 0.0))
            };
            if let Some(p) = clipboard::paste_payload_text(&mut self.doc, text, &parent, at, offset)
            {
                if !p.missing_assets.is_empty() {
                    self.notice(format!(
                        "{} image(s) in the pasted layers are not available on this computer.",
                        p.missing_assets.len()
                    ));
                }
                let roots = p.roots.clone();
                self.commit(p.ops, "Paste", Some(roots));
            }
            return;
        }
        let trimmed = text.trim_start();
        if trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && trimmed.contains("<svg"))
        {
            self.paste_bytes(Arc::from(text.as_bytes()), Some("Pasted.svg"), None);
            return;
        }
        if text.trim().is_empty() {
            return;
        }
        let p = clipboard::paste_plain_text(&mut self.doc, text, &parent, center);
        let roots = p.roots.clone();
        self.commit(p.ops, "Paste text", Some(roots));
    }

    /// Pastes / drops image or SVG bytes at a screen point (or the viewport center).
    pub fn paste_bytes(
        &mut self,
        bytes: Arc<[u8]>,
        name: Option<&str>,
        at_screen: Option<Point>,
    ) -> bool {
        let at = at_screen
            .map(|s| self.camera.to_page(s))
            .unwrap_or_else(|| self.viewport_center());
        let parent = match at_screen {
            Some(_) => self.container_at(at),
            None => self.paste_parent(),
        };
        match clipboard::paste_bytes(&mut self.doc, bytes, name, &parent, at) {
            Ok(p) => {
                let roots = p.roots.clone();
                self.commit(
                    p.ops,
                    if at_screen.is_some() { "Drop" } else { "Paste" },
                    Some(roots),
                )
            }
            Err(e) => {
                self.notice(e.0);
                false
            }
        }
    }

    /// Image tool: remember the chosen picture until the user clicks or drags on the canvas.
    pub fn start_placing(&mut self, img: PlacingImage) {
        self.set_tool(Tool::Image);
        self.placing = Some(img);
    }

    // ---------------------------------------------------------------------------------------------------------
    // View

    /// Fits the active page (shift+1 also counts content outside the page).
    pub fn fit_page(&mut self) {
        let r = self.page_rect();
        self.camera.fit(&r, 64.0, 1.0);
    }

    /// Zoom to fit all content of the page (shift+1).
    pub fn zoom_to_fit_all(&mut self) {
        let mut r = self.page_rect();
        if let Some(n) = self.doc.design.node(&self.page) {
            for c in n.child_ids() {
                if let Some(b) = node_aabb(&self.doc.design, c) {
                    r = r.union(&b);
                }
            }
        }
        self.camera.fit(&r, 64.0, 8.0);
    }

    /// Zoom to the selection (shift+2).
    pub fn zoom_to_selection(&mut self) {
        let ids = edit::movable(&self.doc.design, &self.selection);
        match desyn_core::geometry::selection_aabb(&self.doc.design, &ids) {
            Some(r) => self.camera.fit(&r, 96.0, 16.0),
            None => self.zoom_to_fit_all(),
        }
    }

    /// 100 % about the viewport center (shift+0).
    pub fn zoom_actual(&mut self) {
        self.camera.zoom_at(
            1.0,
            Point::new(self.camera.width / 2.0, self.camera.height / 2.0),
        );
    }

    /// Updates the viewport size (canvas element bounds) and device scale.
    pub fn set_viewport(&mut self, width: f64, height: f64, device_scale: f64) {
        let first = self.camera.width == Camera::default().width
            && self.camera.height == Camera::default().height;
        self.camera.resize(width, height);
        self.device_scale = if device_scale.is_finite() && device_scale > 0.0 {
            device_scale
        } else {
            1.0
        };
        if first {
            self.fit_page();
        }
    }

    /// Brings tiles up to date and renders what the budget allows.
    pub fn render_tiles(&mut self, budget: Duration) -> RenderPass {
        let scale = self.camera.zoom * self.device_scale;
        let page = self.page.clone();
        self.tiles.sync(
            &mut self.renderer,
            &self.doc.design,
            &page,
            self.doc.revision(),
            scale,
        );
        let visible = self.camera.visible();
        self.tiles.render(&mut self.renderer, &visible, budget)
    }

    // ---------------------------------------------------------------------------------------------------------
    // Overlay

    /// Overlay primitives for the current state (screen coordinates).
    pub fn overlay(&self) -> Overlay {
        let mut o = Overlay::default();
        let cam = &self.camera;
        let d = &self.doc.design;
        let page = self.page_rect();
        // Layout grid.
        if self.prefs.layout_grid
            && let Some(Node::Page(pg)) = d.node(&self.page)
            && let Some(g) = &pg.grid
        {
            let n = g.columns.clamp(1, 200) as f64;
            let cw = (page.w - 2.0 * g.margin - g.gutter * (n - 1.0)) / n;
            if cw > 0.0 {
                for i in 0..n as usize {
                    let x0 = g.margin + i as f64 * (cw + g.gutter);
                    o.prims.push(Prim::Fill {
                        rect: cam.rect_to_screen(&Rect {
                            x: x0,
                            y: 0.0,
                            w: cw,
                            h: page.h,
                        }),
                        role: Role::Grid,
                    });
                }
            }
        }
        // Pixel grid.
        if self.prefs.pixel_grid && cam.zoom >= 8.0 {
            let v = cam.visible();
            let (x0, x1) = (
                v.x.floor().max(page.x),
                (v.x + v.w).ceil().min(page.right()),
            );
            let (y0, y1) = (
                v.y.floor().max(page.y),
                (v.y + v.h).ceil().min(page.bottom()),
            );
            if x1 > x0 && y1 > y0 && (x1 - x0) * (y1 - y0) < 1e6 {
                let mut x = x0;
                while x <= x1 {
                    o.line(
                        cam.to_screen(Point::new(x, y0)),
                        cam.to_screen(Point::new(x, y1)),
                        Role::PixelGrid,
                        1.0,
                        false,
                    );
                    x += 1.0;
                }
                let mut y = y0;
                while y <= y1 {
                    o.line(
                        cam.to_screen(Point::new(x0, y)),
                        cam.to_screen(Point::new(x1, y)),
                        Role::PixelGrid,
                        1.0,
                        false,
                    );
                    y += 1.0;
                }
            }
        }
        // Ruler guides.
        if self.prefs.rulers {
            for g in self.guides() {
                match g.axis {
                    GuideAxis::X => {
                        let x = cam.to_screen(Point::new(g.pos, 0.0)).x;
                        o.line(
                            Point::new(x, 0.0),
                            Point::new(x, cam.height),
                            Role::Guide,
                            1.0,
                            false,
                        );
                    }
                    GuideAxis::Y => {
                        let y = cam.to_screen(Point::new(0.0, g.pos)).y;
                        o.line(
                            Point::new(0.0, y),
                            Point::new(cam.width, y),
                            Role::Guide,
                            1.0,
                            false,
                        );
                    }
                }
            }
            if let Some(Gesture::Guide {
                axis,
                index: None,
                pos,
                remove: false,
            }) = &self.gesture
            {
                match axis {
                    GuideAxis::X => {
                        let x = cam.to_screen(Point::new(*pos, 0.0)).x;
                        o.line(
                            Point::new(x, 0.0),
                            Point::new(x, cam.height),
                            Role::Guide,
                            1.0,
                            true,
                        );
                    }
                    GuideAxis::Y => {
                        let y = cam.to_screen(Point::new(0.0, *pos)).y;
                        o.line(
                            Point::new(0.0, y),
                            Point::new(cam.width, y),
                            Role::Guide,
                            1.0,
                            true,
                        );
                    }
                }
            }
        }
        let obb_quad = |b: &OrientedBox| b.corners().map(|p| cam.to_screen(p));
        // Children of the entered scope.
        if let Some(s) = &self.scope
            && let Some(n) = d.node(s)
        {
            if let Some(b) = node_obb(d, s) {
                o.prims.push(Prim::Poly {
                    pts: obb_quad(&b).to_vec(),
                    role: Role::Scope,
                    width: 1.0,
                    fill: false,
                    dashed: true,
                });
            }
            for c in n.child_ids() {
                if let Some(b) = node_obb(d, c)
                    && !self.selection.contains(c)
                {
                    o.quad(obb_quad(&b), Role::Scope, 1.0);
                }
            }
        }
        // Hover.
        let gesture_active = matches!(
            self.gesture,
            Some(Gesture::Move(_)) | Some(Gesture::Resize(_)) | Some(Gesture::Rotate { .. })
        );
        if !gesture_active
            && self.text.is_none()
            && let Some(h) = &self.hover
            && !self.selection.contains(h)
            && let Some(b) = node_obb(d, h)
        {
            o.quad(obb_quad(&b), Role::Hover, 1.5);
        }
        // Selection.
        if self.pen.is_none() {
            let multi = self.selection.len() > 1;
            for id in &self.selection {
                if let Some(b) = node_obb(d, id) {
                    o.quad(obb_quad(&b), Role::Selection, if multi { 1.0 } else { 1.5 });
                }
            }
            if let Some(h) = self.handles() {
                if multi {
                    o.quad(obb_quad(&h.bounds), Role::Selection, 1.5);
                }
                let rot = h.bounds.rotation_deg();
                for hd in h.resize.iter().filter(|h| h.visible) {
                    o.prims.push(Prim::Handle {
                        center: cam.to_screen(hd.center),
                        size: 8.0,
                        rotation: rot,
                    });
                }
                if !gesture_active
                    && let Some(b) = selection_bounds(d, &edit::unlocked(d, &self.selection))
                {
                    let a = b.aabb;
                    o.prims.push(Prim::Label {
                        at: cam.to_screen(Point::new(a.x + a.w / 2.0, a.bottom()))
                            + Point::new(0.0, 14.0),
                        text: format!("{} × {}", fmt_px(b.obb.width), fmt_px(b.obb.height)),
                        role: Role::Selection,
                    });
                }
            } else if let Some(b) = self.selection_obb()
                && self.text.is_none()
                && !self.selection.is_empty()
            {
                // Locked selection: outline only.
                o.prims.push(Prim::Poly {
                    pts: obb_quad(&b).to_vec(),
                    role: Role::Selection,
                    width: 1.0,
                    fill: false,
                    dashed: true,
                });
            }
        }
        // Marquee.
        if let Some(r) = &self.marquee {
            let s = cam.rect_to_screen(r);
            o.prims.push(Prim::Poly {
                pts: vec![
                    Point::new(s.x, s.y),
                    Point::new(s.right(), s.y),
                    Point::new(s.right(), s.bottom()),
                    Point::new(s.x, s.bottom()),
                ],
                role: Role::Marquee,
                width: 1.0,
                fill: true,
                dashed: false,
            });
        }
        // Snap guides.
        for g in &self.feedback.guides {
            let (a, b) = match g.axis {
                desyn_core::snap::Axis::X => (Point::new(g.pos, g.from), Point::new(g.pos, g.to)),
                desyn_core::snap::Axis::Y => (Point::new(g.from, g.pos), Point::new(g.to, g.pos)),
            };
            o.line(cam.to_screen(a), cam.to_screen(b), Role::Snap, 1.0, false);
        }
        for sp in &self.feedback.spacing {
            for (s, e, cross) in &sp.segments {
                let (a, b) = match sp.axis {
                    desyn_core::snap::Axis::X => (Point::new(*s, *cross), Point::new(*e, *cross)),
                    desyn_core::snap::Axis::Y => (Point::new(*cross, *s), Point::new(*cross, *e)),
                };
                let (sa, sb) = (cam.to_screen(a), cam.to_screen(b));
                o.line(sa, sb, Role::Snap, 1.0, false);
                o.prims.push(Prim::Label {
                    at: sa.lerp(sb, 0.5),
                    text: fmt_px(sp.gap),
                    role: Role::Snap,
                });
            }
        }
        let mut distances = self.feedback.distances.clone();
        if self.alt && self.gesture.is_none() && !self.selection.is_empty() {
            let sel = edit::movable(d, &self.selection);
            if let Some(sr) = desyn_core::geometry::selection_aabb(d, &sel) {
                let other = self
                    .hover
                    .as_ref()
                    .filter(|h| !self.selection.contains(h))
                    .and_then(|h| node_aabb(d, h));
                distances = distance_labels(sr, other.as_slice(), Some(page));
            }
        }
        for dl in &distances {
            if dl.value.abs() < 0.005 {
                continue;
            }
            let (a, b) = (cam.to_screen(dl.from), cam.to_screen(dl.to));
            o.line(a, b, Role::Snap, 1.0, false);
            o.prims.push(Prim::Label {
                at: a.lerp(b, 0.5),
                text: fmt_px(dl.value),
                role: Role::Snap,
            });
        }
        // Text editing.
        if let Some(tg) = self.text_geometry() {
            o.prims.push(Prim::Poly {
                pts: tg.bounds.to_vec(),
                role: Role::Selection,
                width: 1.0,
                fill: false,
                dashed: false,
            });
            for q in &tg.selection {
                o.prims.push(Prim::Poly {
                    pts: q.to_vec(),
                    role: Role::TextSelection,
                    width: 0.0,
                    fill: true,
                    dashed: false,
                });
            }
            for q in &tg.marked {
                o.line(q[3], q[2], Role::Composition, 1.5, false);
            }
            if self.text.as_ref().is_some_and(|t| t.anchor == t.head) {
                o.prims.push(Prim::Line {
                    pts: tg.caret.to_vec(),
                    role: Role::Caret,
                    width: 1.5,
                    dashed: false,
                });
            }
        }
        // Pen.
        if let Some(pen) = &self.pen {
            let bez = super::pen::to_bez(&pen.subs, None);
            for poly in desyn_core::paths::flatten_bez(&bez, 0.25 / cam.zoom.max(1e-6)) {
                let pts: Vec<Point> = poly.points.iter().map(|p| cam.to_screen(*p)).collect();
                if poly.closed {
                    o.prims.push(Prim::Poly {
                        pts,
                        role: Role::Pen,
                        width: 1.5,
                        fill: false,
                        dashed: false,
                    });
                } else {
                    o.prims.push(Prim::Line {
                        pts,
                        role: Role::Pen,
                        width: 1.5,
                        dashed: false,
                    });
                }
            }
            if pen.drawing
                && let (Some(last), Some(h)) =
                    (pen.subs.last().and_then(|s| s.anchors.last()), pen.hover)
                && !pen.dragging()
            {
                o.line(
                    cam.to_screen(last.p),
                    cam.to_screen(h),
                    Role::Pen,
                    1.0,
                    true,
                );
            }
            for (si, s) in pen.subs.iter().enumerate() {
                for (ai, a) in s.anchors.iter().enumerate() {
                    let selected = pen.selected == Some((si, ai));
                    if selected || pen.drawing {
                        for h in [a.hin, a.hout] {
                            if h.distance(a.p) > 1e-6 {
                                o.line(cam.to_screen(a.p), cam.to_screen(h), Role::Pen, 1.0, false);
                                o.prims.push(Prim::Dot {
                                    center: cam.to_screen(h),
                                    radius: 3.0,
                                    role: Role::Pen,
                                    filled: true,
                                });
                            }
                        }
                    }
                    o.prims.push(Prim::Dot {
                        center: cam.to_screen(a.p),
                        radius: 4.0,
                        role: Role::Pen,
                        filled: selected,
                    });
                }
            }
        }
        // AI activity: pulsing glow while working, a fading "sunrise" after.
        let pulse = 0.55 + 0.45 * self.glow_phase.sin();
        for (id, intensity) in self
            .activity
            .iter()
            .map(|i| (i, pulse))
            .chain(self.flashes.iter().map(|(i, v)| (i, *v)))
        {
            if let Some(b) = node_obb(d, id) {
                o.prims.push(Prim::Glow {
                    pts: obb_quad(&b).to_vec(),
                    intensity,
                });
            }
        }
        // Gesture pills (size while resizing / creating, angle while rotating, position while moving).
        if let Some(Gesture::Create {
            tool,
            origin,
            current,
            mods,
            ..
        }) = &self.gesture
        {
            let r = create_rect(*tool, *origin, *current, *mods);
            if matches!(tool, Tool::Line | Tool::Arrow) {
                let e = constrain_angle(*origin, *current, mods.shift);
                o.line(
                    cam.to_screen(*origin),
                    cam.to_screen(e),
                    Role::Selection,
                    1.5,
                    false,
                );
            } else {
                let s = cam.rect_to_screen(&r);
                o.prims.push(Prim::Poly {
                    pts: vec![
                        Point::new(s.x, s.y),
                        Point::new(s.right(), s.y),
                        Point::new(s.right(), s.bottom()),
                        Point::new(s.x, s.bottom()),
                    ],
                    role: Role::Selection,
                    width: 1.5,
                    fill: false,
                    dashed: false,
                });
            }
        }
        if let Some((at, text)) = &self.feedback.pill {
            o.prims.push(Prim::Label {
                at: cam.to_screen(*at) + Point::new(0.0, 16.0),
                text: text.clone(),
                role: Role::Selection,
            });
        }
        o
    }
}

/// Screen-space text editing geometry.
#[derive(Debug, Clone, PartialEq)]
pub struct TextGeometry {
    /// Caret top and bottom.
    pub caret: [Point; 2],
    /// Selection quads.
    pub selection: Vec<[Point; 4]>,
    /// Composition quads.
    pub marked: Vec<[Point; 4]>,
    /// Text box corners.
    pub bounds: [Point; 4],
}

/// What a copy produced.
#[derive(Debug, Clone)]
pub enum ClipboardContent {
    /// Layers (payload JSON) with an optional PNG rendering for other apps.
    Layers(Box<Copied>, Option<Vec<u8>>),
    /// Plain text (copied from a text being edited).
    Text(String),
}

fn default_size(tool: Tool) -> (f64, f64) {
    match tool {
        Tool::Frame => (400.0, 300.0),
        _ => (100.0, 100.0),
    }
}

/// The box of a shape being dragged out (shift = square, alt = from the center).
pub fn create_rect(tool: Tool, origin: Point, p: Point, mods: Mods) -> Rect {
    if matches!(tool, Tool::Line | Tool::Arrow) {
        return Rect::from_points(origin, constrain_angle(origin, p, mods.shift));
    }
    let mut dx = p.x - origin.x;
    let mut dy = p.y - origin.y;
    if mods.shift {
        let m = dx.abs().max(dy.abs());
        dx = m * if dx < 0.0 { -1.0 } else { 1.0 };
        dy = m * if dy < 0.0 { -1.0 } else { 1.0 };
    }
    if mods.alt {
        Rect::from_points(
            Point::new(origin.x - dx, origin.y - dy),
            Point::new(origin.x + dx, origin.y + dy),
        )
    } else {
        Rect::from_points(origin, Point::new(origin.x + dx, origin.y + dy))
    }
}

/// Snaps a line end to 45° steps when `shift`.
pub fn constrain_angle(origin: Point, p: Point, shift: bool) -> Point {
    if !shift {
        return p;
    }
    let v = p - origin;
    let len = v.length();
    let a = v.y.atan2(v.x);
    let step = std::f64::consts::FRAC_PI_4;
    let snapped = (a / step).round() * step;
    Point::new(
        origin.x + len * snapped.cos(),
        origin.y + len * snapped.sin(),
    )
}

/// An `update` op setting a node's box (inspector-style edits from extension modules).
pub fn set_geometry(id: &str, x: f64, y: f64, w: f64, h: f64) -> Op {
    let mut s = Map::new();
    s.insert("x".into(), num(x));
    s.insert("y".into(), num(y));
    s.insert("width".into(), num(w));
    s.insert("height".into(), num(h));
    Op::update_set(id, s)
}
