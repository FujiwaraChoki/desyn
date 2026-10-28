//! [`EngineCore`]: the whole engine state behind the wasm facade, in plain Rust (natively testable).

use std::collections::BTreeSet;
use std::sync::Arc;

use desyn_core::geometry::{Point, Rect};
use desyn_core::hit::{
    HitIndex, hit_handles, marquee, nodes_at, resize_box, rotation_delta, selection_bounds,
    transform_handles,
};
use desyn_core::ids::{IdGen, RandomIds};
use desyn_core::layout::{TextMeasureRequest, TextMeasurer, normalize_all};
use desyn_core::model::{AssetKind, Design, Fill, Id, Node, Transaction, TxSource};
use desyn_core::snap::{SnapTargets, distance_labels, snap_move, snap_resize};
use desyn_core::{ApplyOptions, ApplyResult, apply_transaction};
use desyn_describe::{DescribeOptions, ImageSample, ImageSampler};
use desyn_raster::assets::AssetIssue;
use desyn_raster::display::{BuildOptions, damage_rects};
use desyn_raster::export::{
    self, AnimOptions, Background, ExportOptions, Format, PageSelection, PdfOptions, SvgText,
};
use desyn_raster::{Color4, DisplayList, RasterImage, RasterOptions, Renderer, Viewport};
use desyn_text::{FontRequest, LaidOutText, font::RequestReason};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::clock::now_ms;
use crate::frame::{Frame, MAX_FRAME_SIDE, ViewChange};
use crate::protocol::{
    AssetInfo, ExportInfo, ExportRequest, FaceSummary, FontInfo, FontRequestInfo, FrameInfo,
    HandlesRequest, HandlesResult, HitRequest, HitResult, LoadInfo, MarqueeRequest, MeasureItem,
    MeasureResult, PageInfo, PendingRequests, RenderRequest, ResizeRequest, RotateRequest,
    SnapRequest, TextQuery,
};
use crate::text::{self, TextLayoutInfo, TextOutline, TextQueryResult};

/// Engine errors (become `Error` objects in JavaScript).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError(pub String);

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EngineError {}

fn err(msg: impl Into<String>) -> EngineError {
    EngineError(msg.into())
}

fn parse<T: serde::de::DeserializeOwned>(what: &str, json: &str) -> Result<T, EngineError> {
    serde_json::from_str(json).map_err(|e| err(format!("invalid {what}: {e}")))
}

/// Serializes engine output (all output types serialize infallibly).
pub fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|e| format!("{{\"error\":{:?}}}", e.to_string()))
}

/// A live drag / typing preview: applied on top of the committed state and reverted before anything else.
struct Preview {
    tx: Transaction,
    normalize: bool,
    result: ApplyResult,
}

/// What a frame shows besides the design (a change redraws the whole frame).
#[derive(Debug, Clone, PartialEq)]
struct FrameKey {
    page: Id,
    hidden: Vec<Id>,
    show_hidden: bool,
    time_ms: Option<u64>,
    background: Option<[u8; 4]>,
    page_shadow: bool,
}

/// What the cached display list was built from.
#[derive(Debug, Clone, PartialEq)]
struct BuildKey {
    version: u64,
    resources: u64,
    page: Id,
    hidden: Vec<Id>,
    show_hidden: bool,
    time_ms: Option<u64>,
    scale_bucket: i32,
}

struct HitCache {
    version: u64,
    page: Id,
    index: HitIndex,
}

struct SnapCache {
    committed: u64,
    page: Id,
    exclude: Vec<Id>,
    targets: SnapTargets,
}

/// The engine.
pub struct EngineCore {
    design: Design,
    loaded: bool,
    renderer: Renderer,
    /// Bumps on every change of `design` (previews included).
    version: u64,
    /// Bumps on committed changes only (snap targets survive previews).
    committed: u64,
    preview: Option<Preview>,
    hit: Option<HitCache>,
    snap: Option<SnapCache>,
    frame: Frame,
    frame_key: Option<FrameKey>,
    dl: Option<DisplayList>,
    build_key: Option<BuildKey>,
    text_cache: Option<(Id, u64, LaidOutText)>,
    ids: RandomIds,
    last_export: Option<ExportInfo>,
    reported_assets: BTreeSet<Id>,
    /// Font families the renderer found missing that were already reported.
    reported_fonts: BTreeSet<String>,
    /// Bumps when fonts or asset bytes change (display lists must be rebuilt).
    resources: u64,
    /// Smoothed rasterization cost (ms per device megapixel; 0 = not measured yet).
    ms_per_mpx: f64,
}

impl std::fmt::Debug for EngineCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineCore")
            .field("design", &self.design.id)
            .field("version", &self.version)
            .field("frame", &self.frame.size())
            .finish()
    }
}

fn empty_design() -> Design {
    Design::new(
        "empty0000000".to_string(),
        String::new(),
        desyn_core::model::DesignKind::Custom,
    )
}

fn color_bytes(c: &Option<Color4>) -> Option<[u8; 4]> {
    c.map(|c| c.to_rgba8())
}

fn time_key(t: Option<f64>) -> Option<u64> {
    t.filter(|t| t.is_finite()).map(f64::to_bits)
}

/// Device-scale bucket for display lists: the next power of two at or above the scale, so flattening is never
/// coarser than the pixels it lands on and zooming within an octave reuses the build.
fn scale_bucket(scale: f64) -> i32 {
    scale.max(1e-3).log2().ceil().clamp(-10.0, 10.0) as i32
}

fn reason(r: RequestReason) -> &'static str {
    match r {
        RequestReason::Family => "family",
        RequestReason::Fallback => "fallback",
        RequestReason::Emoji => "emoji",
    }
}

fn font_info(r: FontRequest) -> FontRequestInfo {
    FontRequestInfo {
        family: r.family,
        weight: r.weight,
        italic: r.italic,
        reason: reason(r.reason),
    }
}

/// Parses `#rrggbb` / `#rrggbbaa` (any case).
pub fn parse_color(s: &str) -> Option<Color4> {
    Color4::parse_hex(&s.trim().to_ascii_lowercase())
}

impl Default for EngineCore {
    fn default() -> Self {
        Self::new(&[])
    }
}

impl EngineCore {
    /// Engine with no design loaded. `seed` (from the platform CSPRNG) seeds id generation.
    pub fn new(seed: &[u8]) -> Self {
        let mut words = [0u64; 4];
        for (i, b) in seed.iter().take(32).enumerate() {
            words[i / 8] |= u64::from(*b) << ((i % 8) * 8);
        }
        EngineCore {
            design: empty_design(),
            loaded: false,
            renderer: Renderer::empty(),
            version: 0,
            committed: 0,
            preview: None,
            hit: None,
            snap: None,
            frame: Frame::default(),
            frame_key: None,
            dl: None,
            build_key: None,
            text_cache: None,
            ids: RandomIds::from_seed(words),
            last_export: None,
            reported_assets: BTreeSet::new(),
            reported_fonts: BTreeSet::new(),
            ms_per_mpx: 0.0,
            resources: 0,
        }
    }

    /// The current design (committed state plus the active preview).
    pub fn design(&self) -> &Design {
        &self.design
    }

    /// The renderer (fonts, assets, caches).
    pub fn renderer_mut(&mut self) -> &mut Renderer {
        &mut self.renderer
    }

    /// Change counter (previews included).
    pub fn version(&self) -> u64 {
        self.version
    }

    fn bump(&mut self, committed: bool) {
        self.version += 1;
        if committed {
            self.committed += 1;
        }
    }

    fn require_loaded(&self) -> Result<(), EngineError> {
        if self.loaded {
            Ok(())
        } else {
            Err(err("no design loaded"))
        }
    }

    // ------------------------------------------------------------------------------------------------------
    // Document

    /// Loads a design (replaces the current one; fonts and asset bytes stay registered).
    pub fn load(&mut self, json: &str) -> Result<LoadInfo, EngineError> {
        let design = Design::from_json(json).map_err(|e| err(format!("invalid design: {e}")))?;
        if !matches!(design.root(), Some(Node::Root(_))) {
            return Err(err("invalid design: nodes[\"root\"] is missing"));
        }
        let violations = desyn_core::model::validate_design(&design)
            .into_iter()
            .take(50)
            .map(|v| match v.id {
                Some(id) => format!("{} ({id}): {}", v.code, v.message),
                None => format!("{}: {}", v.code, v.message),
            })
            .collect();
        self.design = design;
        self.loaded = true;
        self.preview = None;
        self.hit = None;
        self.snap = None;
        self.dl = None;
        self.build_key = None;
        self.frame_key = None;
        self.text_cache = None;
        self.reported_assets.clear();
        self.reported_fonts.clear();
        self.bump(true);
        Ok(LoadInfo {
            id: self.design.id.clone(),
            pages: self.pages(),
            node_count: self.design.nodes.len(),
            violations,
        })
    }

    /// Pages in order.
    pub fn pages(&self) -> Vec<PageInfo> {
        self.design
            .page_ids()
            .iter()
            .filter_map(|id| match self.design.node(id) {
                Some(Node::Page(p)) => Some(PageInfo {
                    id: id.clone(),
                    name: p.base.name.clone(),
                    width: p.base.width,
                    height: p.base.height,
                }),
                _ => None,
            })
            .collect()
    }

    /// The design as JSON (committed state plus the active preview).
    pub fn snapshot(&self) -> String {
        self.design.to_json()
    }

    fn apply_raw(&mut self, tx: &Transaction, normalize: bool) -> ApplyResult {
        let opts = ApplyOptions {
            normalize,
            measurer: if normalize {
                Some(self.renderer.text_mut())
            } else {
                None
            },
            inverse_id: None,
        };
        apply_transaction(&mut self.design, tx, opts)
    }

    /// Reverts the active preview; returns it so it can be re-applied.
    fn revert_preview(&mut self) -> Option<(Transaction, bool)> {
        let p = self.preview.take()?;
        self.apply_raw(&p.result.inverse, false);
        self.bump(false);
        Some((p.tx, p.normalize))
    }

    fn set_preview(&mut self, tx: Transaction, normalize: bool) -> ApplyResult {
        let result = self.apply_raw(&tx, normalize);
        self.bump(false);
        self.preview = Some(Preview {
            tx,
            normalize,
            result: result.clone(),
        });
        result
    }

    /// Applies a transaction to the committed state (an active preview is re-applied on top).
    pub fn apply(&mut self, tx_json: &str, normalize: bool) -> Result<ApplyResult, EngineError> {
        self.require_loaded()?;
        let tx: Transaction = parse("transaction", tx_json)?;
        let preview = self.revert_preview();
        let result = self.apply_raw(&tx, normalize);
        self.bump(true);
        if let Some((ptx, pn)) = preview {
            self.set_preview(ptx, pn);
        }
        Ok(result)
    }

    /// Shows a transaction without committing it (drag / resize / typing previews). Each call replaces the
    /// previous preview; the result is relative to the committed state.
    pub fn preview(&mut self, tx_json: &str, normalize: bool) -> Result<ApplyResult, EngineError> {
        self.require_loaded()?;
        let tx: Transaction = parse("transaction", tx_json)?;
        self.revert_preview();
        Ok(self.set_preview(tx, normalize))
    }

    /// Keeps the active preview as committed state; returns its result (commit `applied` to the server, keep
    /// `inverse` for undo). `None` when no preview is active.
    pub fn commit_preview(&mut self) -> Option<ApplyResult> {
        let p = self.preview.take()?;
        self.bump(true);
        Some(p.result)
    }

    /// Drops the active preview. Returns whether one was active.
    pub fn cancel_preview(&mut self) -> bool {
        let had = self.revert_preview().is_some();
        if had {
            self.bump(true);
        }
        had
    }

    /// Recomputes every derived box with the current fonts (text auto-resize, auto-layout, groups). Returns the
    /// changes as a `system` transaction result (commit `applied` so other clients see the same boxes).
    pub fn relayout(&mut self) -> Result<ApplyResult, EngineError> {
        self.require_loaded()?;
        let preview = self.revert_preview();
        let changes = normalize_all(&mut self.design, self.renderer.text_mut());
        let mut applied = Vec::new();
        let mut inverse_ops = Vec::new();
        for c in &changes {
            let geo = |g: &desyn_core::layout::Geo| {
                let mut m = Map::new();
                m.insert("x".into(), json!(g.x));
                m.insert("y".into(), json!(g.y));
                m.insert("width".into(), json!(g.width));
                m.insert("height".into(), json!(g.height));
                m
            };
            applied.push(desyn_core::model::Op::update_set(
                c.id.clone(),
                geo(&c.after),
            ));
            inverse_ops.push(desyn_core::model::Op::update_set(
                c.id.clone(),
                geo(&c.before),
            ));
        }
        inverse_ops.reverse();
        let tx_id = self.ids.next_id();
        let mut inverse = Transaction::new(
            desyn_core::ops::inverse_tx_id(&tx_id),
            "Relayout".to_string(),
            inverse_ops,
        );
        inverse.source = TxSource::System;
        if !changes.is_empty() {
            self.bump(true);
        }
        if let Some((ptx, pn)) = preview {
            self.set_preview(ptx, pn);
        }
        Ok(ApplyResult {
            inverse,
            applied,
            dropped: Vec::new(),
        })
    }

    /// A fresh node / transaction id (seeded generator).
    pub fn new_id(&mut self) -> Id {
        self.ids.next_id()
    }

    // ------------------------------------------------------------------------------------------------------
    // Fonts and assets

    /// Registers font bytes (TTF / OTF / TTC / WOFF / WOFF2), optionally under a family name.
    pub fn set_font(
        &mut self,
        bytes: &[u8],
        family: Option<&str>,
    ) -> Result<FontInfo, EngineError> {
        let text = self.renderer.text_mut();
        let ids = match family.map(str::trim).filter(|f| !f.is_empty()) {
            Some(f) => text.add_font_as(bytes.to_vec(), f),
            None => text.add_font(bytes.to_vec()),
        }
        .map_err(|e| err(format!("font rejected: {e}")))?;
        let db = self.renderer.text().db();
        let faces = ids
            .iter()
            .filter_map(|id| db.face(*id))
            .map(|f| FaceSummary {
                family: f.family.clone(),
                weight: f.weight,
                weight_range: (f.weight_range.0 != f.weight_range.1).then_some(f.weight_range),
                italic: !matches!(f.style, desyn_text::font::FaceStyle::Normal),
                axes: f.axes.iter().map(|a| a.tag.clone()).collect(),
            })
            .collect();
        self.text_cache = None;
        self.resources += 1;
        Ok(FontInfo { faces })
    }

    /// Registers the bytes of a design asset and decodes them right away so problems surface here (the bytes
    /// are dropped again when they cannot be used).
    pub fn set_asset(&mut self, id: &str, bytes: &[u8]) -> Result<AssetInfo, EngineError> {
        let asset = self.design.assets.get(id).cloned();
        let kind = asset.as_ref().map(|a| a.kind);
        self.reported_assets.remove(id);
        self.resources += 1;
        match kind {
            Some(AssetKind::Font) => {
                let family = asset
                    .as_ref()
                    .and_then(|a| a.family.clone())
                    .or_else(|| asset.as_ref().and_then(|a| a.name.clone()));
                let info = self.set_font(bytes, family.as_deref())?;
                Ok(AssetInfo {
                    id: id.to_string(),
                    kind: "font",
                    width: None,
                    height: None,
                    families: info.faces.into_iter().map(|f| f.family).collect(),
                })
            }
            Some(AssetKind::Svg) => {
                let cache = self.renderer.assets_mut();
                cache.insert(id, bytes.to_vec());
                // Validate with an empty font database, then drop that parse so the render parse sees the
                // registered fonts.
                let probe = desyn_text::FontDb::new();
                let r = cache.svg_asset(id, asset.as_ref(), &probe);
                cache.invalidate(id);
                match r {
                    Ok(tree) => Ok(AssetInfo {
                        id: id.to_string(),
                        kind: "svg",
                        width: Some(tree.size().width().round() as u32),
                        height: Some(tree.size().height().round() as u32),
                        families: Vec::new(),
                    }),
                    Err(issue) => {
                        cache.remove(id);
                        let m = match issue {
                            AssetIssue::Invalid(m) => m,
                            AssetIssue::Missing => "no bytes".into(),
                        };
                        Err(err(format!("svg {id}: {m}")))
                    }
                }
            }
            Some(AssetKind::Image) | None => {
                let cache = self.renderer.assets_mut();
                cache.insert(id, bytes.to_vec());
                match cache.image(id, asset.as_ref()) {
                    Ok(img) => Ok(AssetInfo {
                        id: id.to_string(),
                        kind: "image",
                        width: Some(img.width()),
                        height: Some(img.height()),
                        families: Vec::new(),
                    }),
                    Err(issue) => {
                        cache.remove(id);
                        let m = match issue {
                            AssetIssue::Invalid(m) => m,
                            AssetIssue::Missing => "no bytes".into(),
                        };
                        Err(err(format!("image {id}: {m}")))
                    }
                }
            }
            Some(_) => {
                // Video / audio / lottie / data: kept for exporters that embed them; nothing to decode here.
                self.renderer.assets_mut().insert(id, bytes.to_vec());
                Ok(AssetInfo {
                    id: id.to_string(),
                    kind: "data",
                    width: None,
                    height: None,
                    families: Vec::new(),
                })
            }
        }
    }

    /// Forgets an asset's bytes.
    pub fn remove_asset(&mut self, id: &str) {
        self.renderer.assets_mut().remove(id);
        self.reported_assets.remove(id);
        self.resources += 1;
    }

    /// Missing assets and fonts noticed since the last call (apply, measure, describe, text queries, renders).
    pub fn take_requests(&mut self) -> PendingRequests {
        let mut missing: BTreeSet<Id> = self
            .renderer
            .assets_mut()
            .take_missing()
            .into_iter()
            .collect();
        missing.retain(|id| self.reported_assets.insert(id.clone()));
        PendingRequests {
            missing_assets: missing.into_iter().collect(),
            font_requests: self
                .renderer
                .text_mut()
                .take_font_requests()
                .into_iter()
                .map(font_info)
                .collect(),
        }
    }

    // ------------------------------------------------------------------------------------------------------
    // Rendering

    fn resolve_page(&self, page: Option<&str>) -> Option<Id> {
        let pages = self.design.page_ids();
        match page {
            Some(p) if pages.iter().any(|x| x == p) => Some(p.to_string()),
            _ => pages
                .iter()
                .find(|p| matches!(self.design.node(p), Some(Node::Page(_))))
                .cloned(),
        }
    }

    /// Renders the viewport into the frame buffer (only what changed; see [`crate::frame`]).
    pub fn render(&mut self, req: &RenderRequest) -> Result<FrameInfo, EngineError> {
        self.require_loaded()?;
        let vp = req
            .viewport
            .ok_or_else(|| err("render: viewport is required"))?;
        if !(vp.zoom.is_finite() && vp.zoom > 0.0 && vp.zoom <= 4096.0) {
            return Err(err(format!("render: zoom {} out of range", vp.zoom)));
        }
        if !(vp.dpr.is_finite() && vp.dpr > 0.0 && vp.dpr <= 8.0) {
            return Err(err(format!("render: dpr {} out of range", vp.dpr)));
        }
        if !(vp.x.is_finite() && vp.y.is_finite()) {
            return Err(err("render: viewport origin must be finite"));
        }
        if vp.width == 0
            || vp.height == 0
            || vp.width > MAX_FRAME_SIDE
            || vp.height > MAX_FRAME_SIDE
        {
            return Err(err(format!(
                "render: frame {}x{} (1..={MAX_FRAME_SIDE} px per side)",
                vp.width, vp.height
            )));
        }
        let page = self
            .resolve_page(req.page_id.as_deref())
            .ok_or_else(|| err("render: the design has no pages"))?;
        let background = match &req.background {
            Some(s) => Some(parse_color(s).ok_or_else(|| err(format!("render: bad color {s:?}")))?),
            None => None,
        };
        let straight = background.is_none_or(|c| c.a < 1.0);
        let view = Viewport {
            x: vp.x,
            y: vp.y,
            zoom: vp.zoom,
            width: vp.width,
            height: vp.height,
            device_scale: vp.dpr,
        };
        let mut hidden = req.hidden.clone();
        hidden.sort();
        hidden.dedup();
        let key = FrameKey {
            page: page.clone(),
            hidden: hidden.clone(),
            show_hidden: req.show_hidden,
            time_ms: time_key(req.time_ms),
            background: color_bytes(&background),
            page_shadow: req.page_shadow,
        };
        let change = self.frame.set_view(view, straight);
        let mut full = change == ViewChange::Full;
        if self.frame_key.as_ref() != Some(&key) || req.force {
            self.frame.invalidate_all();
            self.frame_key = Some(key);
            full = true;
        }

        // Display list.
        let bucket = scale_bucket(view.scale());
        let build_key = BuildKey {
            version: self.version,
            resources: self.resources,
            page: page.clone(),
            hidden: hidden.clone(),
            show_hidden: req.show_hidden,
            time_ms: time_key(req.time_ms),
            scale_bucket: bucket,
        };
        let mut info = FrameInfo {
            page_id: Some(page.clone()),
            ..Default::default()
        };
        if self.build_key.as_ref() != Some(&build_key) || self.dl.is_none() {
            let t0 = now_ms();
            let opts = BuildOptions {
                page: Some(page.clone()),
                show_hidden: req.show_hidden,
                background: true,
                only: None,
                hidden,
                time_ms: req.time_ms.filter(|t| t.is_finite()),
                vector: false,
                bleed: false,
                raster_scale: 2f64.powi(bucket),
            };
            let new = self
                .renderer
                .build(&self.design, &opts)
                .map_err(|e| err(format!("render: {e}")))?;
            info.build_ms = now_ms() - t0;
            info.built = true;
            let same_frame = self
                .build_key
                .as_ref()
                .is_some_and(|k| k.page == build_key.page && k.hidden == build_key.hidden);
            if !full
                && same_frame
                && let (Some(old), Some(bounds)) = (&self.dl, self.frame.bounds())
            {
                for r in damage_rects(old, &new, &view.transform(), bounds, 16) {
                    self.frame.invalidate(r);
                }
            } else if !full {
                self.frame.invalidate_all();
                full = true;
            }
            info.warnings = new.warnings.clone();
            // The renderer consumes the text engine's requests while building; it reports families only.
            for family in &new.missing_fonts {
                if self.reported_fonts.insert(family.clone()) {
                    info.font_requests.push(FontRequestInfo {
                        family: family.clone(),
                        weight: 400.0,
                        italic: false,
                        reason: if family.to_ascii_lowercase().contains("emoji") {
                            "emoji"
                        } else {
                            "family"
                        },
                    });
                }
            }
            for id in &new.missing_assets {
                if self.reported_assets.insert(id.clone()) {
                    info.missing_assets.push(id.clone());
                }
            }
            self.dl = Some(new);
            self.build_key = Some(build_key);
        }

        // Rasterize pending regions (tiles under a budget).
        let t0 = now_ms();
        let budget = req.budget_ms.filter(|b| b.is_finite() && *b > 0.0);
        // Full redraws (zoom, resize, page switch) start with cold caches, so the cost estimate does not hold:
        // they always go tile by tile under a budget.
        let tiled = budget.is_some_and(|b| full || self.estimate_ms(&self.frame.pending()) > b);
        let deadline = t0 + budget.unwrap_or(f64::INFINITY);
        let work = self.frame.take_work(tiled);
        let Some(dl) = self.dl.as_ref() else {
            return Err(err("render: no display list"));
        };
        let transform = view.transform();
        let page_device = req
            .page_shadow
            .then(|| transform.transform_rect_bbox(&dl.page_rect()));
        let mut rest = work.into_iter();
        for r in rest.by_ref() {
            let Some(pixmap) = self.frame.pixmap_mut() else {
                break;
            };
            let opts = RasterOptions {
                transform,
                region: Some(r),
                background: if req.page_shadow { None } else { background },
            };
            self.renderer.rasterize(dl, &mut pixmap.as_mut(), &opts);
            if req.page_shadow {
                self.frame
                    .paint_under(&r, page_device, view.device_scale, background);
            }
            if straight {
                self.frame.demultiply_rect(&r);
            }
            info.rects
                .push([r.x(), r.y(), r.width() as i32, r.height() as i32]);
            if tiled && now_ms() >= deadline {
                break;
            }
        }
        self.frame.restore(rest.collect());
        info.raster_ms = now_ms() - t0;
        let drawn_mpx: f64 = info
            .rects
            .iter()
            .map(|r| f64::from(r[2]) * f64::from(r[3]) / 1e6)
            .sum();
        if drawn_mpx > 0.02 {
            let sample = info.raster_ms / drawn_mpx;
            self.ms_per_mpx = if self.ms_per_mpx == 0.0 {
                sample
            } else {
                self.ms_per_mpx * 0.7 + sample * 0.3
            };
        }
        info.pending = self.frame.pending().len();
        info.full = full;
        info.scroll = match change {
            ViewChange::Scrolled(dx, dy) => Some([dx, dy]),
            _ => None,
        };
        let (w, h) = self.frame.size();
        info.width = w;
        info.height = h;
        let more = self.take_requests();
        info.missing_assets.extend(more.missing_assets);
        info.missing_assets.sort();
        info.missing_assets.dedup();
        info.font_requests.extend(more.font_requests);
        Ok(info)
    }

    /// Expected rasterization time of the given device rectangles. Unmeasured engines assume large areas are
    /// expensive so the first big frame is progressive.
    fn estimate_ms(&self, rects: &[desyn_raster::tiny_skia::IntRect]) -> f64 {
        let mpx: f64 = rects
            .iter()
            .map(|r| f64::from(r.width()) * f64::from(r.height()) / 1e6)
            .sum();
        if self.ms_per_mpx > 0.0 {
            mpx * self.ms_per_mpx
        } else if mpx > 2.0 {
            f64::INFINITY
        } else {
            0.0
        }
    }

    /// Frame bytes to present (straight RGBA, `width * height * 4`).
    pub fn frame_bytes(&self) -> &[u8] {
        let straight = self
            .frame_key
            .as_ref()
            .is_some_and(|k| k.background.is_none_or(|b| b[3] < 255));
        self.frame.present(straight)
    }

    /// Frame size.
    pub fn frame_size(&self) -> (u32, u32) {
        self.frame.size()
    }

    // ------------------------------------------------------------------------------------------------------
    // Interaction geometry

    fn ensure_hit_index(&mut self, page: &str) {
        let stale = self
            .hit
            .as_ref()
            .is_none_or(|h| h.version != self.version || h.page != page);
        if stale {
            self.hit = Some(HitCache {
                version: self.version,
                page: page.to_string(),
                index: HitIndex::build(&self.design, page),
            });
        }
    }

    /// Hit test at a page point.
    pub fn hit_test(&mut self, req: &HitRequest) -> Result<HitResult, EngineError> {
        self.require_loaded()?;
        let page = self
            .resolve_page(req.page_id.as_deref())
            .ok_or_else(|| err("hitTest: the design has no pages"))?;
        let p = Point::new(req.x, req.y);
        if !(p.x.is_finite() && p.y.is_finite()) {
            return Err(err("hitTest: point must be finite"));
        }
        if req.all {
            let all = nodes_at(&self.design, &page, p, &req.options);
            return Ok(HitResult {
                id: all.first().cloned(),
                path: Vec::new(),
                all,
            });
        }
        let opts = req.options;
        self.ensure_hit_index(&page);
        let index = &self.hit.as_ref().expect("hit index was just built").index;
        let path = index.hit_path(&self.design, p, &opts).unwrap_or_default();
        let id = if opts.deep {
            path.last().cloned()
        } else {
            path.first().cloned()
        };
        Ok(HitResult {
            id,
            path,
            all: Vec::new(),
        })
    }

    /// Nodes inside / touching a page rectangle.
    pub fn marquee(&mut self, req: &MarqueeRequest) -> Result<Vec<Id>, EngineError> {
        self.require_loaded()?;
        let page = self
            .resolve_page(req.page_id.as_deref())
            .ok_or_else(|| err("marquee: the design has no pages"))?;
        Ok(marquee(
            &self.design,
            &page,
            req.rect,
            req.mode,
            &req.options,
        ))
    }

    /// Snaps a moving or resizing selection.
    pub fn snap(&mut self, req: &SnapRequest) -> Result<Value, EngineError> {
        self.require_loaded()?;
        let from_ids = req
            .ids
            .first()
            .and_then(|id| self.design.page_of(id))
            .map(str::to_string);
        let page = self
            .resolve_page(req.page_id.as_deref().or(from_ids.as_deref()))
            .ok_or_else(|| err("snap: the design has no pages"))?;
        let mut exclude = req.ids.clone();
        exclude.sort();
        let stale = self.snap.as_ref().is_none_or(|s| {
            s.committed != self.committed || s.page != page || s.exclude != exclude
        });
        if stale {
            // Targets are taken from the committed state so a live preview never snaps to itself.
            let preview = self.revert_preview();
            let targets = SnapTargets::for_page(&self.design, &page, &exclude);
            if let Some((ptx, pn)) = preview {
                self.set_preview(ptx, pn);
            }
            self.snap = Some(SnapCache {
                committed: self.committed,
                page: page.clone(),
                exclude,
                targets,
            });
        }
        let targets = &self
            .snap
            .as_ref()
            .expect("snap targets were just built")
            .targets;
        let result = match req.edges {
            Some(edges) => snap_resize(req.rect, edges, targets, &req.options),
            None => snap_move(req.rect, targets, &req.options),
        };
        let mut out = serde_json::to_value(&result).unwrap_or(Value::Null);
        if req.distances
            && let Value::Object(m) = &mut out
        {
            let moved = req.rect.translate(result.dx, result.dy);
            let labels = distance_labels(moved, &targets.objects, targets.page);
            m.insert(
                "distances".into(),
                serde_json::to_value(labels).unwrap_or(Value::Null),
            );
        }
        Ok(out)
    }

    /// Selection bounds, transform handles and the handle under a point.
    pub fn handles(&mut self, req: &HandlesRequest) -> HandlesResult {
        let bounds = selection_bounds(&self.design, &req.ids);
        let handles = bounds.map(|b| transform_handles(&b.obb, req.zoom, &req.style));
        let hit = match (&handles, req.point) {
            (Some(h), Some(p)) => hit_handles(h, p),
            _ => None,
        };
        HandlesResult {
            bounds,
            handles,
            hit,
        }
    }

    /// Resize math.
    pub fn resize_box(&self, req: &ResizeRequest) -> desyn_core::hit::ResizeResult {
        resize_box(&req.bounds, req.handle, req.pointer, &req.options)
    }

    /// Rotation math.
    pub fn rotation_delta(&self, req: &RotateRequest) -> f64 {
        rotation_delta(req.center, req.start, req.pointer, req.step)
    }

    /// Page-space bounds of nodes (axis-aligned), `None` for unknown ids.
    pub fn bounds(&self, ids: &[Id]) -> Vec<Option<Rect>> {
        ids.iter()
            .map(|id| desyn_core::geometry::node_aabb(&self.design, id))
            .collect()
    }

    // ------------------------------------------------------------------------------------------------------
    // Text

    /// Measures text with the renderer's shaper (DocHost `measure`).
    pub fn measure(&mut self, items: &[MeasureItem]) -> Vec<MeasureResult> {
        let text = self.renderer.text_mut();
        items
            .iter()
            .map(|it| {
                let m = text.measure(&TextMeasureRequest {
                    runs: &it.text,
                    style: &it.style,
                    paragraph: &it.paragraph,
                    max_width: it.width.filter(|w| w.is_finite() && *w >= 0.0),
                    max_lines: it.max_lines,
                });
                MeasureResult {
                    w: m.width,
                    h: m.height,
                    lines: m.lines,
                    baseline: m.baseline,
                }
            })
            .collect()
    }

    fn laid_out(&mut self, id: &str) -> Result<&LaidOutText, EngineError> {
        let node = text::text_node(&self.design, id)
            .ok_or_else(|| err(format!("{id} is not a text node")))?
            .clone();
        let fresh = self
            .text_cache
            .as_ref()
            .is_some_and(|(cid, v, _)| cid == id && *v == self.version);
        if !fresh {
            let laid = self
                .renderer
                .text_mut()
                .layout_node(&node, Some(&self.design.styles));
            self.text_cache = Some((id.to_string(), self.version, laid));
        }
        Ok(&self.text_cache.as_ref().expect("layout was just cached").2)
    }

    /// Layout of a text node for an editing overlay.
    pub fn text_layout(&mut self, id: &str) -> Result<TextLayoutInfo, EngineError> {
        self.require_loaded()?;
        let laid = self.laid_out(id)?.clone();
        let node = text::text_node(&self.design, id).ok_or_else(|| err("not a text node"))?;
        Ok(text::layout_info(&self.design, node, &laid))
    }

    /// Caret / hit / selection / movement / range queries.
    pub fn text_query(&mut self, q: &TextQuery) -> Result<TextQueryResult, EngineError> {
        self.require_loaded()?;
        let id = match q {
            TextQuery::Caret { node_id, .. }
            | TextQuery::Hit { node_id, .. }
            | TextQuery::Selection { node_id, .. }
            | TextQuery::Move { node_id, .. }
            | TextQuery::Range { node_id, .. } => node_id.clone(),
        };
        self.laid_out(&id)?;
        let laid = &self.text_cache.as_ref().expect("layout cached").2;
        text::query(&self.design, laid, q).ok_or_else(|| err("textQuery: unsupported query"))
    }

    /// Text converted to vector outlines (SVG path data in the node box).
    pub fn outline_text(&mut self, id: &str) -> Result<TextOutline, EngineError> {
        self.require_loaded()?;
        let laid = self.laid_out(id)?.clone();
        let node = text::text_node(&self.design, id)
            .ok_or_else(|| err("not a text node"))?
            .clone();
        Ok(text::outline(self.renderer.text_mut(), &node, &laid))
    }

    // ------------------------------------------------------------------------------------------------------
    // Describe / lint

    fn page_images(&mut self, page: Option<&str>) -> CacheSampler {
        let mut ids: BTreeSet<Id> = BTreeSet::new();
        if let Some(page) = page {
            self.design.walk(page, &mut |n: &Node, _| {
                if let Node::Image(img) = n {
                    ids.insert(img.asset_id.clone());
                }
                for f in n.fills() {
                    if let Fill::Image(f) = f {
                        ids.insert(f.asset_id.clone());
                    }
                }
                true
            });
        }
        let mut images = std::collections::HashMap::new();
        for id in ids {
            let asset = self.design.assets.get(&id);
            if let Ok(img) = self.renderer.assets_mut().image(&id, asset) {
                images.insert(id, img);
            }
        }
        CacheSampler { images }
    }

    /// Semantic description (DOCUMENT_MODEL section 7).
    pub fn describe(&mut self, opts_json: &str) -> Result<Value, EngineError> {
        self.require_loaded()?;
        let opts: DescribeOptions = parse("describe options", opts_json)?;
        let page = desyn_describe::resolve_page(&self.design, &opts)
            .map(|(p, _)| p.base.id.clone())
            .map_err(|e| err(format!("describe: {e:?}")))?;
        let mut sampler = self.page_images(Some(&page));
        let d = desyn_describe::describe(
            &self.design,
            &opts,
            self.renderer.text_mut(),
            Some(&mut sampler),
        )
        .map_err(|e| err(format!("describe: {e:?}")))?;
        serde_json::to_value(&d).map_err(|e| err(e.to_string()))
    }

    /// Lint issues only.
    pub fn lint(&mut self, opts_json: &str) -> Result<Value, EngineError> {
        self.require_loaded()?;
        let opts: DescribeOptions = parse("lint options", opts_json)?;
        let page = desyn_describe::resolve_page(&self.design, &opts)
            .map(|(p, _)| p.base.id.clone())
            .map_err(|e| err(format!("lint: {e:?}")))?;
        let mut sampler = self.page_images(Some(&page));
        let issues = desyn_describe::lint(
            &self.design,
            &opts,
            self.renderer.text_mut(),
            Some(&mut sampler),
        )
        .map_err(|e| err(format!("lint: {e:?}")))?;
        serde_json::to_value(&issues).map_err(|e| err(e.to_string()))
    }

    /// Compact text description for model prompts (token budgeted).
    pub fn describe_compact(
        &mut self,
        opts_json: &str,
        max_tokens: usize,
    ) -> Result<String, EngineError> {
        let v = self.describe(opts_json)?;
        let d: desyn_describe::Description =
            serde_json::from_value(v).map_err(|e| err(e.to_string()))?;
        let o = desyn_describe::CompactOptions {
            max_tokens,
            ..Default::default()
        };
        Ok(desyn_describe::compact_text(&d, &o))
    }

    // ------------------------------------------------------------------------------------------------------
    // Export

    /// Exports the design. The metadata of the last export is available from [`EngineCore::last_export`].
    pub fn export(&mut self, req_json: &str) -> Result<Vec<u8>, EngineError> {
        self.require_loaded()?;
        let req: ExportRequest = parse("export options", req_json)?;
        let opts = export_options(&req)?;
        let out = export::export(&mut self.renderer, &self.design, &opts)
            .map_err(|e| err(format!("export: {e}")))?;
        self.last_export = Some(ExportInfo {
            mime: out.mime.to_string(),
            extension: out.extension.to_string(),
            pages: out.pages,
            bytes: out.bytes.len(),
            missing_assets: out.missing_assets,
            missing_fonts: out.missing_fonts,
            warnings: out.warnings,
        });
        Ok(out.bytes)
    }

    /// Metadata of the last successful export.
    pub fn last_export(&self) -> Option<&ExportInfo> {
        self.last_export.as_ref()
    }
}

/// Formats compiled into this build.
pub fn formats() -> Vec<&'static str> {
    let mut v = vec!["png", "jpeg", "webp", "svg"];
    if cfg!(feature = "exporters") {
        v.extend(["pdf", "pptx", "gif"]);
    }
    v
}

fn export_options(req: &ExportRequest) -> Result<ExportOptions, EngineError> {
    let format: Format = req
        .format
        .parse()
        .map_err(|e: desyn_raster::RenderError| err(e.to_string()))?;
    if matches!(format, Format::Pdf | Format::Pptx | Format::Gif) && !cfg!(feature = "exporters") {
        return Err(err(format!(
            "unsupported: {} export needs the exporters module",
            format.extension()
        )));
    }
    let pages = match (&req.page_id, req.page_index) {
        (Some(p), _) if p == "all" => PageSelection::All,
        (Some(p), _) => PageSelection::Id(p.clone()),
        (None, Some(i)) => PageSelection::Index(i),
        (None, None) => PageSelection::First,
    };
    let background = match req.background.as_deref() {
        None | Some("page") => Background::Page,
        Some("transparent") => Background::Transparent,
        Some(c) => Background::Color(
            parse_color(c).ok_or_else(|| err(format!("export: bad background {c:?}")))?,
        ),
    };
    let pdf_defaults = PdfOptions::default();
    let pdf = match &req.pdf {
        Some(p) => PdfOptions {
            bleed: p.bleed,
            crop_marks: p.crop_marks,
            cmyk: p.cmyk,
            flatten: p.flatten,
            dpi: p.dpi.unwrap_or(pdf_defaults.dpi),
            title: p.title.clone(),
        },
        None => pdf_defaults,
    };
    let svg_text = match req.svg_text.as_deref() {
        None | Some("text") => SvgText::Text { embed_fonts: true },
        Some("text-no-fonts") => SvgText::Text { embed_fonts: false },
        Some("outlines") => SvgText::Outlines,
        Some(other) => return Err(err(format!("export: svgText {other:?}"))),
    };
    let anim_defaults = AnimOptions::default();
    let quality = req.quality.unwrap_or(90).clamp(1, 100);
    Ok(ExportOptions {
        format,
        pages,
        scale: req.scale.unwrap_or(1.0),
        dpi: req.dpi,
        quality,
        background,
        region: req.region,
        time_ms: req.time_ms,
        pdf,
        svg_text,
        anim: AnimOptions {
            fps: req.fps.unwrap_or(anim_defaults.fps),
            duration_ms: req.duration_ms,
            max_frames: req.max_frames.unwrap_or(anim_defaults.max_frames),
        },
        only: req.only.clone(),
        hidden: req.hidden.clone(),
    })
}

/// [`ImageSampler`] over images decoded by the renderer's asset cache (premultiplied pixels).
struct CacheSampler {
    images: std::collections::HashMap<Id, Arc<RasterImage>>,
}

/// At most this many pixels are read per sample.
const MAX_SAMPLES: usize = 4096;

impl ImageSampler for CacheSampler {
    fn sample(&mut self, asset_id: &str, region: Rect) -> Option<ImageSample> {
        use desyn_core::color::Rgba;
        let img = self.images.get(asset_id)?;
        let p = img.pixmap();
        let (iw, ih) = (p.width() as usize, p.height() as usize);
        if iw == 0 || ih == 0 {
            return None;
        }
        let (w, h) = (iw as f64, ih as f64);
        let x0 = ((region.x.clamp(0.0, 1.0) * w).floor() as usize).min(iw - 1);
        let y0 = ((region.y.clamp(0.0, 1.0) * h).floor() as usize).min(ih - 1);
        let x1 = (((region.x + region.w).clamp(0.0, 1.0) * w).ceil() as usize).clamp(x0 + 1, iw);
        let y1 = (((region.y + region.h).clamp(0.0, 1.0) * h).ceil() as usize).clamp(y0 + 1, ih);
        let step = (((x1 - x0) * (y1 - y0)) as f64 / MAX_SAMPLES as f64)
            .sqrt()
            .ceil()
            .max(1.0) as usize;
        let data = p.data();
        let (mut sr, mut sg, mut sb, mut sa, mut n) = (0.0, 0.0, 0.0, 0.0, 0.0);
        let mut darkest: Option<(f64, Rgba)> = None;
        let mut lightest: Option<(f64, Rgba)> = None;
        let mut y = y0;
        while y < y1 {
            let mut x = x0;
            while x < x1 {
                let i = (y * iw + x) * 4;
                let a = f64::from(data[i + 3]) / 255.0;
                // Premultiplied -> straight.
                let un = |c: u8| {
                    if a > 0.0 {
                        (f64::from(c) / 255.0 / a).min(1.0)
                    } else {
                        0.0
                    }
                };
                let c = Rgba::new(un(data[i]), un(data[i + 1]), un(data[i + 2]), a);
                sr += c.r * a;
                sg += c.g * a;
                sb += c.b * a;
                sa += a;
                n += 1.0;
                if a > 0.5 {
                    let l = c.relative_luminance();
                    if darkest.is_none_or(|(d, _)| l < d) {
                        darkest = Some((l, c));
                    }
                    if lightest.is_none_or(|(d, _)| l > d) {
                        lightest = Some((l, c));
                    }
                }
                x += step;
            }
            y += step;
        }
        if n == 0.0 {
            return None;
        }
        let average = if sa > 0.0 {
            Rgba::new(sr / sa, sg / sa, sb / sa, sa / n)
        } else {
            Rgba::TRANSPARENT
        };
        Some(ImageSample {
            average,
            darkest: darkest.map(|d| d.1).unwrap_or(average),
            lightest: lightest.map(|d| d.1).unwrap_or(average),
        })
    }
}
