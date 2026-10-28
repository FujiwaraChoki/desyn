//! The `Engine` object: one design, its renderer (text engine, decoded assets, caches) and the interactive frame.
//!
//! Thread safety: `Engine` is `Send + Sync`. Every method locks one internal mutex for its whole duration, so calls
//! from several threads are serialized and never observe a half-applied transaction. Rendering, exporting and
//! describing take milliseconds to seconds: call them off the main thread (the Swift `DesynEngine` actor does).
//!
//! Previews: a live gesture (drag, resize, typing) is shown with `preview` on top of the committed state and
//! replaced on every pointer move; `apply_transaction` (e.g. a remote transaction arriving mid-drag) applies to
//! the committed state and puts the preview back on top; `commit_preview` keeps it, `cancel_preview` drops it.

use std::sync::{Arc, Mutex, MutexGuard};

use desyn_core::geometry::{self as geo, node_obb, world_transform};
use desyn_core::hit::{self as core_hit, HitIndex};
use desyn_core::layout::{TextMeasureRequest, TextMeasurer, normalize_all};
use desyn_core::model::Op;
use desyn_core::model::{Design, Id, Node, ParagraphStyle, TextRun, TextStyle, Transaction};
use desyn_core::ops::ApplyResult as CoreApplyResult;
use desyn_core::snap::{self as core_snap, SnapTargets};
use desyn_core::{ApplyOptions, apply_transaction, validate_design};
use desyn_describe::{CompactOptions, DescribeError, DescribeOptions};
use desyn_raster::export::{
    self, AnimOptions, Background, ExportOptions, PageSelection, PdfOptions, SvgText,
};
use desyn_raster::{MemoryAssetStore, PageRenderOptions, Renderer};
use desyn_text::font::RequestReason;
use desyn_text::{FontDb, LaidOutText, TextEngine};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::convert::{finite_box, finite_point, finite_rect, parse_color, parse_opt_color, to_u32};
use crate::error::EngineError;
use crate::frame::{
    Frame, copy_rects, full_rect, page_info, render_frame, required_len, resolve_page,
};
use crate::sampler::SampleCache;
use crate::text;
use crate::transform::transform_ops;
use crate::types::*;

/// Default memory budget for decoded images.
const DEFAULT_ASSET_BUDGET_MB: u32 = 384;
/// Violations listed by `load` (the rest are counted).
const MAX_VIOLATIONS: usize = 50;

/// The Desyn engine for one open design.
///
/// Create one per open document (`Engine()`), `load` the design JSON, then apply transactions, render frames,
/// hit-test and export. Design content crosses as JSON strings; everything else is typed.
#[derive(uniffi::Object)]
pub struct Engine {
    state: Mutex<State>,
}

struct State {
    design: Option<Design>,
    renderer: Renderer,
    /// Bumped by every change that can affect geometry or pixels (design incl. previews, fonts, assets).
    revision: u64,
    /// Bumped by changes of the committed design only (load, apply, relayout, commit_preview): snap targets are
    /// taken from the committed state, so a live preview never snaps to itself and they survive previews.
    committed: u64,
    /// The live preview applied on top of the committed state.
    preview: Option<Preview>,
    hit: Option<HitCache>,
    snap: Option<SnapCache>,
    text: Option<TextCache>,
    frame: Option<Frame>,
    /// Sequence number of the last interactive frame.
    frame_seq: u64,
    samples: SampleCache,
}

/// A transaction shown on top of the committed state (live gestures).
struct Preview {
    tx: Transaction,
    normalize: bool,
    result: CoreApplyResult,
}

struct HitCache {
    revision: u64,
    page: Id,
    index: HitIndex,
}

struct SnapCache {
    revision: u64,
    page: Id,
    exclude: Vec<Id>,
    targets: SnapTargets,
}

struct TextCache {
    revision: u64,
    node: Id,
    laid: LaidOutText,
    transform: geo::Affine,
}

impl State {
    fn new(bundled_fonts: bool, asset_budget_mb: u32) -> State {
        let text = if bundled_fonts {
            TextEngine::with_bundled_fonts()
        } else {
            TextEngine::with_db(FontDb::new())
        };
        let mut renderer = Renderer::new(text, Box::new(MemoryAssetStore::new()));
        renderer
            .assets_mut()
            .set_budget((asset_budget_mb as usize).saturating_mul(1024 * 1024));
        State {
            design: None,
            renderer,
            revision: 0,
            committed: 0,
            preview: None,
            hit: None,
            snap: None,
            text: None,
            frame: None,
            frame_seq: 0,
            samples: SampleCache::default(),
        }
    }

    fn touch(&mut self) {
        self.revision += 1;
    }

    /// A change of the committed design.
    fn commit_change(&mut self) {
        self.committed += 1;
        self.touch();
    }

    /// Applies a transaction with the contract semantics and the real text engine as measurer.
    fn apply_raw(
        &mut self,
        tx: &Transaction,
        normalize: bool,
    ) -> Result<CoreApplyResult, EngineError> {
        let State {
            design, renderer, ..
        } = self;
        let design = design.as_mut().ok_or(EngineError::NoDesign)?;
        renderer.register_design_fonts(design);
        let result = apply_transaction(
            design,
            tx,
            ApplyOptions {
                normalize,
                measurer: Some(renderer.text_mut()),
                inverse_id: None,
            },
        );
        // Font assets added by the transaction become available to text layout right away.
        renderer.register_design_fonts(design);
        Ok(result)
    }

    /// Takes the active preview off the design (its inverse always applies to the state it produced).
    fn revert_preview(&mut self) -> Option<Preview> {
        let p = self.preview.take()?;
        let _ = self.apply_raw(&p.result.inverse, false);
        Some(p)
    }

    /// Applies `tx` as the preview over the committed state.
    fn set_preview(
        &mut self,
        tx: Transaction,
        normalize: bool,
    ) -> Result<CoreApplyResult, EngineError> {
        let result = self.apply_raw(&tx, normalize)?;
        self.preview = Some(Preview {
            tx,
            normalize,
            result: result.clone(),
        });
        Ok(result)
    }

    /// Runs `f` on the committed state: the active preview is taken off and put back unchanged (replaying its
    /// `applied` ops on the same base reproduces the previewed state exactly, without layout), so the revision
    /// and every cache keyed by it stay valid.
    fn with_committed<R>(&mut self, f: impl FnOnce(&mut State) -> R) -> R {
        let Some(p) = self.revert_preview() else {
            return f(self);
        };
        let out = f(self);
        let replay = Transaction::new(
            p.tx.id.clone(),
            p.tx.label.clone(),
            p.result.applied.clone(),
        );
        let _ = self.apply_raw(&replay, false);
        self.preview = Some(p);
        out
    }

    fn design(&self) -> Result<&Design, EngineError> {
        self.design.as_ref().ok_or(EngineError::NoDesign)
    }

    fn hit_index(&mut self, page: &str) -> Result<(&Design, &HitIndex), EngineError> {
        let design = self.design.as_ref().ok_or(EngineError::NoDesign)?;
        let fresh = self
            .hit
            .as_ref()
            .is_some_and(|h| h.revision == self.revision && h.page == page);
        if !fresh {
            self.hit = Some(HitCache {
                revision: self.revision,
                page: page.to_string(),
                index: HitIndex::build(design, page),
            });
        }
        let index = &self.hit.as_ref().expect("built above").index;
        Ok((design, index))
    }

    /// Snap targets of the committed state (cached per gesture: page, excluded ids and committed revision).
    fn snap_targets(&mut self, page: &str, exclude: &[Id]) -> Result<&SnapTargets, EngineError> {
        self.design()?;
        let fresh = self.snap.as_ref().is_some_and(|s| {
            s.revision == self.committed && s.page == page && s.exclude.as_slice() == exclude
        });
        if !fresh {
            let targets = self.with_committed(|s| {
                s.design
                    .as_ref()
                    .map(|d| SnapTargets::for_page(d, page, exclude))
            });
            self.snap = Some(SnapCache {
                revision: self.committed,
                page: page.to_string(),
                exclude: exclude.to_vec(),
                targets: targets.ok_or(EngineError::NoDesign)?,
            });
        }
        Ok(&self.snap.as_ref().expect("built above").targets)
    }

    fn laid_text(&mut self, id: &str) -> Result<&TextCache, EngineError> {
        let fresh = self
            .text
            .as_ref()
            .is_some_and(|t| t.revision == self.revision && t.node == id);
        if !fresh {
            let State {
                design, renderer, ..
            } = self;
            let design = design.as_ref().ok_or(EngineError::NoDesign)?;
            let node = match design.node(id) {
                Some(Node::Text(t)) => t,
                Some(_) => return Err(EngineError::NotText { id: id.to_string() }),
                None => return Err(EngineError::NodeNotFound { id: id.to_string() }),
            };
            renderer.register_design_fonts(design);
            let laid = renderer.text_mut().layout_node(node, Some(&design.styles));
            let transform = world_transform(design, id);
            self.text = Some(TextCache {
                revision: self.revision,
                node: id.to_string(),
                laid,
                transform,
            });
        }
        Ok(self.text.as_ref().expect("built above"))
    }

    fn page(&self, page: Option<&str>) -> Result<Id, EngineError> {
        resolve_page(self.design()?, page)
    }
}

fn ops_json(ops: &[Op]) -> String {
    serde_json::to_string(ops).expect("ops serialize")
}

fn outcome(result: &CoreApplyResult, revision: u64) -> ApplyOutcome {
    ApplyOutcome {
        applied_json: ops_json(&result.applied),
        inverse_json: serde_json::to_string(&result.inverse).expect("transaction serializes"),
        dropped: result
            .dropped
            .iter()
            .map(|d| DroppedOp {
                index: to_u32(d.index),
                reason: d.reason.as_str().to_string(),
            })
            .collect(),
        revision,
    }
}

fn num(v: f64) -> Value {
    serde_json::Number::from_f64(v)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn describe_error(e: DescribeError) -> EngineError {
    match e {
        DescribeError::NoPages => EngineError::PageNotFound {
            id: "(design has no pages)".into(),
        },
        DescribeError::PageNotFound(id) => EngineError::PageNotFound { id },
    }
}

fn describe_options(json: &str) -> Result<DescribeOptions, EngineError> {
    if json.trim().is_empty() {
        return Ok(DescribeOptions::default());
    }
    serde_json::from_str(json).map_err(EngineError::json)
}

/// One `/v1/measure` item.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeasureItem {
    text: Vec<TextRun>,
    style: TextStyle,
    paragraph: ParagraphStyle,
    #[serde(default)]
    width: Option<f64>,
    #[serde(default)]
    max_lines: Option<u32>,
}

/// `{ "items": [...] }` (worker body) or a bare array.
#[derive(Deserialize)]
#[serde(untagged)]
enum MeasureBody {
    Wrapped { items: Vec<MeasureItem> },
    Bare(Vec<MeasureItem>),
}

fn export_options(req: &ExportRequest) -> Result<ExportOptions, EngineError> {
    let pages = match &req.pages {
        ExportPages::First => PageSelection::First,
        ExportPages::Page { id } => PageSelection::Id(id.clone()),
        ExportPages::Index { index } => PageSelection::Index(*index as usize),
        ExportPages::All => PageSelection::All,
    };
    let background = match &req.background {
        ExportBackground::Page => Background::Page,
        ExportBackground::Transparent => Background::Transparent,
        ExportBackground::Color { hex } => Background::Color(parse_color(hex)?),
    };
    let region = req
        .region
        .map(|r| finite_rect(r, "export region"))
        .transpose()?;
    if let Some(t) = req.time_ms
        && !t.is_finite()
    {
        return Err(EngineError::arg("time_ms must be finite"));
    }
    let pdf = req
        .pdf
        .clone()
        .map_or_else(PdfOptions::default, |p| PdfOptions {
            bleed: p.bleed,
            crop_marks: p.crop_marks,
            cmyk: p.cmyk,
            flatten: p.flatten,
            dpi: p.dpi,
            title: p.title,
        });
    Ok(ExportOptions {
        format: req.format.into(),
        pages,
        scale: req.scale,
        dpi: req.dpi,
        quality: req.quality.clamp(1, 100),
        background,
        region,
        time_ms: req.time_ms,
        pdf,
        svg_text: if req.svg_outlines {
            SvgText::Outlines
        } else {
            SvgText::Text {
                embed_fonts: req.svg_embed_fonts,
            }
        },
        anim: AnimOptions {
            fps: req.fps,
            duration_ms: req.duration_ms,
            ..AnimOptions::default()
        },
        only: req.only.clone(),
        hidden: req.hidden.clone(),
    })
}

impl Engine {
    fn lock(&self) -> MutexGuard<'_, State> {
        match self.state.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                // A panic inside a call (reported to the caller as an internal error) may have left caches
                // half-built; the design itself is only mutated by the contract's apply, which never panics.
                // Drop the caches; a preview whose state is unknown is kept as committed (it was applied).
                let mut g = poisoned.into_inner();
                g.hit = None;
                g.snap = None;
                g.text = None;
                g.frame = None;
                g.preview = None;
                g.commit_change();
                self.state.clear_poison();
                g
            }
        }
    }
}

#[uniffi::export]
impl Engine {
    /// An engine with the bundled OFL fonts (Inter, Instrument Sans / Serif, JetBrains Mono, Noto Arabic /
    /// Hebrew / Emoji) and a 384 MB decoded-image budget.
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Engine::with_options(true, DEFAULT_ASSET_BUDGET_MB)
    }

    /// An engine with explicit options. `asset_budget_mb` bounds decoded images (minimum 16).
    #[uniffi::constructor]
    pub fn with_options(bundled_fonts: bool, asset_budget_mb: u32) -> Arc<Self> {
        Arc::new(Engine {
            state: Mutex::new(State::new(bundled_fonts, asset_budget_mb)),
        })
    }

    // ---------------------------------------------------------------- design

    /// Loads a design (`Design` JSON). With `normalize`, derived geometry (text boxes, auto-layout, groups) is
    /// recomputed with the real text engine and returned as ops to commit.
    pub fn load(&self, design_json: String, normalize: bool) -> Result<LoadResult, EngineError> {
        let mut design = Design::from_json(&design_json).map_err(EngineError::json)?;
        let mut s = self.lock();
        s.renderer.register_design_fonts(&design);
        let layout_ops = if normalize {
            let changes = normalize_all(&mut design, s.renderer.text_mut());
            geometry_ops(&changes).0
        } else {
            Vec::new()
        };
        let all = validate_design(&design);
        let mut violations: Vec<String> = all
            .iter()
            .take(MAX_VIOLATIONS)
            .map(|v| match &v.id {
                Some(id) => format!("{}: {} ({id})", v.code, v.message),
                None => format!("{}: {}", v.code, v.message),
            })
            .collect();
        if all.len() > MAX_VIOLATIONS {
            violations.push(format!("... and {} more", all.len() - MAX_VIOLATIONS));
        }
        s.design = Some(design);
        s.preview = None;
        s.frame = None;
        s.commit_change();
        Ok(LoadResult {
            pages: pages_of(s.design()?),
            layout_ops_json: ops_json(&layout_ops),
            violations,
            revision: s.revision,
        })
    }

    /// Closes the design and drops the frame buffer (fonts and decoded assets stay).
    pub fn unload(&self) {
        let mut s = self.lock();
        s.design = None;
        s.preview = None;
        s.frame = None;
        s.hit = None;
        s.snap = None;
        s.text = None;
        s.commit_change();
    }

    /// Whether a design is loaded.
    pub fn is_loaded(&self) -> bool {
        self.lock().design.is_some()
    }

    /// Counter that changes whenever the design, fonts or assets change.
    pub fn revision(&self) -> u64 {
        self.lock().revision
    }

    /// The current design as JSON (committed state plus the active preview; `canonical`: sorted keys and
    /// normalized numbers, for hashing / golden files).
    pub fn snapshot(&self, canonical: bool) -> Result<String, EngineError> {
        let s = self.lock();
        let d = s.design()?;
        Ok(if canonical {
            d.canonical_json()
        } else {
            d.to_json()
        })
    }

    /// sha256 of the canonical JSON of the design.
    pub fn design_hash(&self) -> Result<String, EngineError> {
        Ok(self.lock().design()?.hash())
    }

    /// Pages in order.
    pub fn pages(&self) -> Result<Vec<PageInfo>, EngineError> {
        Ok(pages_of(self.lock().design()?))
    }

    /// One node as JSON (`None` when the id does not exist).
    pub fn node_json(&self, id: String) -> Result<Option<String>, EngineError> {
        let s = self.lock();
        Ok(s.design()?
            .node(&id)
            .map(|n| serde_json::to_string(n).expect("node serializes")))
    }

    /// Applies a transaction (`Transaction` JSON) to the committed state with the contract semantics: invalid
    /// ops are dropped and reported, never thrown. `normalize` runs layout with real text metrics afterwards (use
    /// it for local edits; apply remote, already-normalized transactions and inverses with `false`). An active
    /// preview is taken off first and re-applied on top afterwards.
    pub fn apply_transaction(
        &self,
        tx_json: String,
        normalize: bool,
    ) -> Result<ApplyOutcome, EngineError> {
        let tx: Transaction = serde_json::from_str(&tx_json).map_err(EngineError::json)?;
        let mut s = self.lock();
        s.design()?;
        let preview = s.revert_preview();
        let result = s.apply_raw(&tx, normalize);
        if let Some(p) = preview {
            // The committed state changed under the preview: replay it in full (it may now drop ops).
            let _ = s.set_preview(p.tx, p.normalize);
        }
        s.commit_change();
        Ok(outcome(&result?, s.revision))
    }

    /// Shows a transaction on top of the committed state without committing it (drag, resize and typing
    /// previews). Each call replaces the previous preview; the outcome is relative to the committed state.
    pub fn preview(&self, tx_json: String, normalize: bool) -> Result<ApplyOutcome, EngineError> {
        let tx: Transaction = serde_json::from_str(&tx_json).map_err(EngineError::json)?;
        let mut s = self.lock();
        s.design()?;
        s.revert_preview();
        let result = s.set_preview(tx, normalize);
        s.touch();
        Ok(outcome(&result?, s.revision))
    }

    /// Keeps the active preview as committed state and returns its outcome (commit `applied_json` to the
    /// server, keep `inverse_json` for undo). `None` when no preview is active.
    pub fn commit_preview(&self) -> Option<ApplyOutcome> {
        let mut s = self.lock();
        let p = s.preview.take()?;
        s.commit_change();
        Some(outcome(&p.result, s.revision))
    }

    /// Drops the active preview (the committed state shows again). Returns whether one was active.
    pub fn cancel_preview(&self) -> bool {
        let mut s = self.lock();
        let had = s.revert_preview().is_some();
        if had {
            s.touch();
        }
        had
    }

    /// Whether a preview is active.
    pub fn has_preview(&self) -> bool {
        self.lock().preview.is_some()
    }

    /// Recomputes every derived box (text auto-resize, auto-layout, groups) of the committed state with the
    /// current fonts, e.g. after font bytes arrived. The design is updated; commit `ops_json` as one `system`
    /// transaction. An active preview is re-applied on top.
    pub fn relayout(&self) -> Result<LayoutOutcome, EngineError> {
        let mut s = self.lock();
        s.design()?;
        let preview = s.revert_preview();
        let State {
            design, renderer, ..
        } = &mut *s;
        let design = design.as_mut().ok_or(EngineError::NoDesign)?;
        renderer.register_design_fonts(design);
        let changes = normalize_all(design, renderer.text_mut());
        let (fwd, inv) = geometry_ops(&changes);
        if let Some(p) = preview {
            let _ = s.set_preview(p.tx, p.normalize);
        }
        if fwd.is_empty() {
            s.touch();
        } else {
            s.commit_change();
        }
        Ok(LayoutOutcome {
            ops_json: ops_json(&fwd),
            inverse_ops_json: ops_json(&inv),
        })
    }

    // ---------------------------------------------------------------- rendering

    /// Renders the interactive frame and returns a copy of all its pixels. Between renders of the same page and
    /// viewport only the damaged area is rasterized (`info.damage`).
    pub fn render(&self, request: RenderRequest) -> Result<RenderedFrame, EngineError> {
        let mut s = self.lock();
        let State {
            design,
            renderer,
            frame,
            frame_seq,
            ..
        } = &mut *s;
        let design = design.as_ref().ok_or(EngineError::NoDesign)?;
        let info = render_frame(design, renderer, frame, &request, *frame_seq + 1)?;
        *frame_seq = info.sequence;
        let f = frame.as_ref().expect("render_frame stores the frame");
        Ok(RenderedFrame {
            width: info.width,
            height: info.height,
            stride: info.width * 4,
            pixels: f.pixmap.data().to_vec(),
            info,
        })
    }

    /// Renders the interactive frame into caller memory: premultiplied RGBA8, `stride` bytes per row, at least
    /// `stride * (height - 1) + width * 4` bytes at `address` (e.g. `MTLBuffer.contents()` or a locked
    /// `CVPixelBuffer` base address). `buffer_sequence` is the `FrameInfo.sequence` the buffer currently shows
    /// (`0` = unknown): when it is the engine's previous frame only `info.damage` is copied, otherwise the whole
    /// frame is, so several buffers (double / triple buffering) and interleaved `render` calls stay correct.
    ///
    /// The caller guarantees that `address` points to `length` writable bytes that nothing else reads or writes
    /// for the duration of the call.
    pub fn render_into(
        &self,
        request: RenderRequest,
        address: u64,
        length: u64,
        stride: u32,
        buffer_sequence: u64,
    ) -> Result<FrameInfo, EngineError> {
        if address == 0 {
            return Err(EngineError::arg("null buffer address"));
        }
        let start = usize::try_from(address).map_err(|_| EngineError::arg("buffer address"))?;
        let length = usize::try_from(length).map_err(|_| EngineError::arg("buffer too large"))?;
        let needed = required_len(request.viewport.width, request.viewport.height, stride)?;
        if length < needed {
            return Err(EngineError::arg(format!(
                "buffer has {length} bytes, the frame needs {needed}"
            )));
        }
        if needed > isize::MAX as usize || start.checked_add(needed).is_none() {
            return Err(EngineError::arg("buffer exceeds the address space"));
        }
        let mut s = self.lock();
        let State {
            design,
            renderer,
            frame,
            frame_seq,
            ..
        } = &mut *s;
        let design = design.as_ref().ok_or(EngineError::NoDesign)?;
        let holds_previous =
            buffer_sequence != 0 && frame.as_ref().is_some_and(|f| f.seq == buffer_sequence);
        let info = render_frame(design, renderer, frame, &request, *frame_seq + 1)?;
        *frame_seq = info.sequence;
        let f = frame.as_ref().expect("render_frame stores the frame");
        // SAFETY: the caller guarantees `length` writable, unaliased bytes at `address` for this call (documented
        // above). Only the `needed <= length` bytes the frame covers are borrowed; `needed` fits `isize` and does
        // not wrap the address space (checked above). Copies stay inside them (`copy_rects` clamps to the frame).
        let dst = unsafe { std::slice::from_raw_parts_mut(start as *mut u8, needed) };
        let rects = if holds_previous && !info.full {
            info.damage.clone()
        } else {
            vec![full_rect(info.width, info.height)]
        };
        copy_rects(&f.pixmap, dst, stride as usize, &rects);
        Ok(info)
    }

    /// Forgets the interactive frame (frees its buffer; the next render is a full one).
    pub fn reset_frame(&self) {
        self.lock().frame = None;
    }

    /// Drops render, layout and text caches; `assets` also drops decoded images (e.g. on memory warnings).
    pub fn clear_caches(&self, assets: bool) {
        let mut s = self.lock();
        s.renderer.clear_caches(assets);
        s.frame = None;
        s.hit = None;
        s.snap = None;
        s.text = None;
        s.touch();
    }

    /// One-shot render of a page or region (thumbnails, previews); does not touch the interactive frame.
    pub fn render_page(&self, request: PageImageRequest) -> Result<RenderedFrame, EngineError> {
        let mut s = self.lock();
        let State {
            design, renderer, ..
        } = &mut *s;
        let design = design.as_ref().ok_or(EngineError::NoDesign)?;
        let page = resolve_page(design, request.page_id.as_deref())?;
        if let Some(t) = request.time_ms
            && !t.is_finite()
        {
            return Err(EngineError::arg("time_ms must be finite"));
        }
        let opts = PageRenderOptions {
            page: Some(page.clone()),
            scale: request.scale,
            region: request
                .region
                .map(|r| finite_rect(r, "region"))
                .transpose()?,
            transparent: request.transparent,
            background: parse_opt_color(request.background.as_deref())?,
            time_ms: request.time_ms,
            bleed: request.bleed,
            only: request.only.clone(),
            hidden: request.hidden.clone(),
            show_hidden: false,
        };
        let out = renderer.render_page(design, &opts)?;
        let info = page_info(page, &out.pixmap, &out.display_list);
        Ok(RenderedFrame {
            width: out.pixmap.width(),
            height: out.pixmap.height(),
            stride: out.pixmap.width() * 4,
            pixels: out.pixmap.data().to_vec(),
            info,
        })
    }

    // ---------------------------------------------------------------- picking and gestures

    /// Topmost node at a page point (the page's top-level child, or the deepest node with `deep`).
    pub fn hit_test(
        &self,
        page_id: Option<String>,
        point: DesignPoint,
        options: HitOptions,
    ) -> Result<Option<String>, EngineError> {
        let p = finite_point(point, "point")?;
        let mut s = self.lock();
        let page = s.page(page_id.as_deref())?;
        let (design, index) = s.hit_index(&page)?;
        Ok(index.hit_test(design, p, &options.into()))
    }

    /// Ancestor chain of the hit, from the page's top-level child down to the deepest node (empty on a miss).
    pub fn hit_path(
        &self,
        page_id: Option<String>,
        point: DesignPoint,
        options: HitOptions,
    ) -> Result<Vec<String>, EngineError> {
        let p = finite_point(point, "point")?;
        let mut s = self.lock();
        let page = s.page(page_id.as_deref())?;
        let (design, index) = s.hit_index(&page)?;
        Ok(index
            .hit_path(design, p, &options.into())
            .unwrap_or_default())
    }

    /// Every node under a page point, topmost first (context menus, "select layer below").
    pub fn nodes_at(
        &self,
        page_id: Option<String>,
        point: DesignPoint,
        options: HitOptions,
    ) -> Result<Vec<String>, EngineError> {
        let p = finite_point(point, "point")?;
        let s = self.lock();
        let page = s.page(page_id.as_deref())?;
        Ok(core_hit::nodes_at(s.design()?, &page, p, &options.into()))
    }

    /// Nodes selected by a marquee rectangle (page coordinates).
    pub fn marquee(
        &self,
        page_id: Option<String>,
        rect: DesignRect,
        mode: MarqueeMode,
        options: HitOptions,
    ) -> Result<Vec<String>, EngineError> {
        let r = finite_rect(rect, "marquee")?;
        let s = self.lock();
        let page = s.page(page_id.as_deref())?;
        Ok(core_hit::marquee(
            s.design()?,
            &page,
            r,
            mode.into(),
            &options.into(),
        ))
    }

    /// Oriented box of a node in page coordinates.
    pub fn node_bounds(&self, id: String) -> Result<Option<OrientedBox>, EngineError> {
        Ok(node_obb(self.lock().design()?, &id).map(Into::into))
    }

    /// Bounds of a selection (`None` when no id exists).
    pub fn selection_bounds(
        &self,
        ids: Vec<String>,
    ) -> Result<Option<SelectionBounds>, EngineError> {
        Ok(core_hit::selection_bounds(self.lock().design()?, &ids).map(Into::into))
    }

    /// Transform handles of a selection at `zoom` (points per design px).
    pub fn handles(
        &self,
        ids: Vec<String>,
        zoom: f64,
        style: HandleStyle,
    ) -> Result<Option<Handles>, EngineError> {
        let s = self.lock();
        Ok(core_hit::selection_bounds(s.design()?, &ids)
            .map(|b| core_hit::transform_handles(&b.obb, zoom, &style.into()).into()))
    }

    /// Which handle or rotate zone of the selection is under a page point.
    pub fn hit_handles(
        &self,
        ids: Vec<String>,
        zoom: f64,
        style: HandleStyle,
        point: DesignPoint,
    ) -> Result<Option<HandleHit>, EngineError> {
        let p = finite_point(point, "point")?;
        let s = self.lock();
        Ok(core_hit::selection_bounds(s.design()?, &ids).and_then(|b| {
            let h = core_hit::transform_handles(&b.obb, zoom, &style.into());
            core_hit::hit_handles(&h, p).map(Into::into)
        }))
    }

    /// Snaps a moving box (page coordinates, after the raw drag) to objects, the page, guides, the layout grid and
    /// equal spacing. `exclude` = the nodes being moved. Targets are cached per gesture.
    pub fn snap_move(
        &self,
        page_id: Option<String>,
        moving: DesignRect,
        exclude: Vec<String>,
        options: SnapOptions,
    ) -> Result<SnapResult, EngineError> {
        let r = finite_rect(moving, "moving box")?;
        let mut s = self.lock();
        let page = s.page(page_id.as_deref())?;
        let targets = s.snap_targets(&page, &exclude)?;
        Ok(core_snap::snap_move(r, targets, &options.into()).into())
    }

    /// Snaps the moving edges of a resize and reports width / height matches.
    pub fn snap_resize(
        &self,
        page_id: Option<String>,
        moving: DesignRect,
        edges: ResizeEdges,
        exclude: Vec<String>,
        options: SnapOptions,
    ) -> Result<SnapResult, EngineError> {
        let r = finite_rect(moving, "moving box")?;
        let mut s = self.lock();
        let page = s.page(page_id.as_deref())?;
        let targets = s.snap_targets(&page, &exclude)?;
        Ok(core_snap::snap_resize(r, edges.into(), targets, &options.into()).into())
    }

    /// Distances from a box to its nearest neighbors and the page edges (hold-to-measure).
    pub fn distance_labels(
        &self,
        page_id: Option<String>,
        moving: DesignRect,
        exclude: Vec<String>,
    ) -> Result<Vec<DistanceLabel>, EngineError> {
        let r = finite_rect(moving, "box")?;
        let mut s = self.lock();
        let page = s.page(page_id.as_deref())?;
        let targets = s.snap_targets(&page, &exclude)?;
        Ok(
            core_snap::distance_labels(r, &targets.objects, targets.page)
                .into_iter()
                .map(|l| DistanceLabel {
                    from: l.from.into(),
                    to: l.to.into(),
                    value: l.value,
                })
                .collect(),
        )
    }

    /// Ops (JSON `Op[]`) that carry the selection from box `from` (the selection box when the gesture started) to
    /// box `to` (move, resize, rotate); `flip_x` / `flip_y` mirror the content inside `to` (pass
    /// `ResizeResult.flip_x / flip_y`). The ops are computed against the committed state (an active preview is
    /// ignored), so each gesture step can `preview` them and pointer-up can `commit_preview`. The design is not
    /// changed.
    pub fn transform_selection(
        &self,
        ids: Vec<String>,
        from: OrientedBox,
        to: OrientedBox,
        flip_x: bool,
        flip_y: bool,
    ) -> Result<String, EngineError> {
        let from = finite_box(from, "from")?;
        let to = finite_box(to, "to")?;
        let mut s = self.lock();
        s.design()?;
        // Relative to the committed state, so the ops can replace the previous step's preview.
        let ops = s.with_committed(|s| {
            s.design
                .as_mut()
                .map(|d| transform_ops(d, &ids, &from, &to, flip_x, flip_y))
        });
        Ok(ops_json(&ops.ok_or(EngineError::NoDesign)?))
    }

    // ---------------------------------------------------------------- text

    /// Measures text (`{ "items": [{ text: TextRun[], style, paragraph, width?, maxLines? }] }`, the worker's
    /// `/v1/measure` body, or a bare array) with the engine's fonts.
    pub fn measure(&self, request_json: String) -> Result<Vec<TextSize>, EngineError> {
        let body: MeasureBody = serde_json::from_str(&request_json).map_err(EngineError::json)?;
        let items = match body {
            MeasureBody::Wrapped { items } | MeasureBody::Bare(items) => items,
        };
        let mut s = self.lock();
        let State {
            design, renderer, ..
        } = &mut *s;
        if let Some(d) = design.as_ref() {
            renderer.register_design_fonts(d);
        }
        Ok(items
            .iter()
            .map(|it| {
                let m = renderer.text_mut().measure(&TextMeasureRequest {
                    runs: &it.text,
                    style: &it.style,
                    paragraph: &it.paragraph,
                    max_width: it.width.filter(|w| w.is_finite() && *w >= 0.0),
                    max_lines: it.max_lines,
                });
                TextSize {
                    width: m.width,
                    height: m.height,
                    lines: m.lines,
                    baseline: m.baseline,
                }
            })
            .collect())
    }

    /// Lines and box of a text node, with the transform from its box to the page (native editing overlays).
    pub fn text_layout(&self, node_id: String) -> Result<TextLayout, EngineError> {
        let mut s = self.lock();
        let t = s.laid_text(&node_id)?;
        Ok(text::layout_record(&node_id, &t.laid, t.transform.into()))
    }

    /// Caret position under a page point.
    pub fn text_hit_test(
        &self,
        node_id: String,
        point: DesignPoint,
    ) -> Result<TextPosition, EngineError> {
        let p = finite_point(point, "point")?;
        let mut s = self.lock();
        let t = s.laid_text(&node_id)?;
        let local = t.transform.inverse().map(|inv| inv.apply(p)).unwrap_or(p);
        let pos = t.laid.hit_test_point(local.x, local.y);
        Ok(text::from_engine_position(&t.laid, pos))
    }

    /// Caret bar for a position (box-local; map with `TextLayout.transform`).
    pub fn text_caret(
        &self,
        node_id: String,
        position: TextPosition,
    ) -> Result<CaretRect, EngineError> {
        let mut s = self.lock();
        Ok(text::caret(&s.laid_text(&node_id)?.laid, position))
    }

    /// Selection highlight rectangles (box-local, bidi-aware).
    pub fn text_selection_rects(
        &self,
        node_id: String,
        range: TextRange,
    ) -> Result<Vec<DesignRect>, EngineError> {
        let mut s = self.lock();
        Ok(text::selection_rects(&s.laid_text(&node_id)?.laid, range))
    }

    /// Word around a UTF-16 offset (double tap).
    pub fn text_word_range(&self, node_id: String, index: u32) -> Result<TextRange, EngineError> {
        let mut s = self.lock();
        Ok(text::word_range(&s.laid_text(&node_id)?.laid, index))
    }

    /// Visual line showing a position.
    pub fn text_line_range(
        &self,
        node_id: String,
        position: TextPosition,
    ) -> Result<TextRange, EngineError> {
        let mut s = self.lock();
        Ok(text::line_range(&s.laid_text(&node_id)?.laid, position))
    }

    /// Paragraph containing a UTF-16 offset (triple tap).
    pub fn text_paragraph_range(
        &self,
        node_id: String,
        index: u32,
    ) -> Result<TextRange, EngineError> {
        let mut s = self.lock();
        Ok(text::paragraph_range(&s.laid_text(&node_id)?.laid, index))
    }

    /// Moves a caret (arrow keys, word / line jumps). `x` keeps the column for `Up` / `Down` (box-local).
    pub fn text_move(
        &self,
        node_id: String,
        position: TextPosition,
        movement: TextMovement,
        x: Option<f64>,
    ) -> Result<TextPosition, EngineError> {
        let mut s = self.lock();
        Ok(text::move_caret(
            &s.laid_text(&node_id)?.laid,
            position,
            movement,
            x,
        ))
    }

    /// The text node converted to outlines (box coordinates): replace it with a `path` node of the same box and
    /// transform to "convert text to paths".
    pub fn text_outline(&self, node_id: String) -> Result<TextOutline, EngineError> {
        let mut s = self.lock();
        let laid = s.laid_text(&node_id)?.laid.clone();
        let State {
            design, renderer, ..
        } = &mut *s;
        let design = design.as_ref().ok_or(EngineError::NoDesign)?;
        let Some(Node::Text(node)) = design.node(&node_id) else {
            return Err(EngineError::NotText { id: node_id });
        };
        Ok(text::outline(renderer.text_mut(), node, &laid))
    }

    // ---------------------------------------------------------------- understanding

    /// Semantic description of a page for the AI and the design check (DOCUMENT_MODEL section 7). `options_json`
    /// is a `DescribeOptions` object (`""` = defaults); returns `Description` JSON.
    pub fn describe(&self, options_json: String) -> Result<String, EngineError> {
        let opts = describe_options(&options_json)?;
        let mut s = self.lock();
        let State {
            design,
            renderer,
            samples,
            ..
        } = &mut *s;
        let design = design.as_ref().ok_or(EngineError::NoDesign)?;
        renderer.register_design_fonts(design);
        let mut sampler = samples.sampler(design, renderer);
        let d = desyn_describe::describe(design, &opts, renderer.text_mut(), Some(&mut sampler))
            .map_err(describe_error)?;
        Ok(serde_json::to_string(&d).expect("description serializes"))
    }

    /// Lint issues of a page (`Issue[]` JSON; each may carry `fix` ops to apply as one transaction).
    pub fn lint(&self, options_json: String) -> Result<String, EngineError> {
        let opts = describe_options(&options_json)?;
        let mut s = self.lock();
        let State {
            design,
            renderer,
            samples,
            ..
        } = &mut *s;
        let design = design.as_ref().ok_or(EngineError::NoDesign)?;
        renderer.register_design_fonts(design);
        let mut sampler = samples.sampler(design, renderer);
        let issues = desyn_describe::lint(design, &opts, renderer.text_mut(), Some(&mut sampler))
            .map_err(describe_error)?;
        Ok(serde_json::to_string(&issues).expect("issues serialize"))
    }

    /// Token-budgeted plain-text description (on-device / BYOK model prompts). Design content inside is
    /// untrusted data: wrap it as such in prompts.
    pub fn describe_text(
        &self,
        options_json: String,
        max_tokens: u32,
    ) -> Result<String, EngineError> {
        let opts = describe_options(&options_json)?;
        let mut s = self.lock();
        let State {
            design,
            renderer,
            samples,
            ..
        } = &mut *s;
        let design = design.as_ref().ok_or(EngineError::NoDesign)?;
        renderer.register_design_fonts(design);
        let mut sampler = samples.sampler(design, renderer);
        let d = desyn_describe::describe(design, &opts, renderer.text_mut(), Some(&mut sampler))
            .map_err(describe_error)?;
        Ok(desyn_describe::compact_text(
            &d,
            &CompactOptions {
                max_tokens: (max_tokens as usize).max(64),
                ..CompactOptions::default()
            },
        ))
    }

    /// Design tokens (palette, type scale, spacing, radii, named styles) of one page or all pages (JSON).
    pub fn design_tokens(&self, page_id: Option<String>) -> Result<String, EngineError> {
        let mut s = self.lock();
        let State {
            design, renderer, ..
        } = &mut *s;
        let design = design.as_ref().ok_or(EngineError::NoDesign)?;
        renderer.register_design_fonts(design);
        let t = desyn_describe::design_tokens(design, page_id.as_deref(), renderer.text_mut())
            .map_err(describe_error)?;
        Ok(serde_json::to_string(&t).expect("tokens serialize"))
    }

    // ---------------------------------------------------------------- export

    /// Exports to one file (PNG / JPEG / WebP / SVG of one page; PDF / PPTX of one or all pages; GIF).
    pub fn export(&self, request: ExportRequest) -> Result<ExportResult, EngineError> {
        let opts = export_options(&request)?;
        let mut s = self.lock();
        let State {
            design, renderer, ..
        } = &mut *s;
        let design = design.as_ref().ok_or(EngineError::NoDesign)?;
        Ok(export::export(renderer, design, &opts)?.into())
    }

    /// Exports every selected page to its own file (e.g. PNG per page).
    pub fn export_pages(&self, request: ExportRequest) -> Result<Vec<ExportedPage>, EngineError> {
        let opts = export_options(&request)?;
        let mut s = self.lock();
        let State {
            design, renderer, ..
        } = &mut *s;
        let design = design.as_ref().ok_or(EngineError::NoDesign)?;
        Ok(export::export_pages(renderer, design, &opts)?
            .into_iter()
            .map(|(page_id, out)| ExportedPage {
                page_id,
                result: out.into(),
            })
            .collect())
    }

    // ---------------------------------------------------------------- fonts and assets

    /// Registers font bytes (TTF / OTF / TTC / WOFF / WOFF2). `family` overrides the family name (design font
    /// assets use `AssetRef.family`). Call `relayout` afterwards when text metrics may have changed.
    pub fn set_font(
        &self,
        bytes: Vec<u8>,
        family: Option<String>,
    ) -> Result<Vec<FontFace>, EngineError> {
        let mut s = self.lock();
        let text = s.renderer.text_mut();
        let ids = match family.as_deref().map(str::trim) {
            Some(f) if !f.is_empty() => text.add_font_as(bytes, f),
            _ => text.add_font(bytes),
        }
        .map_err(|e| EngineError::Font {
            detail: e.to_string(),
        })?;
        let faces = ids
            .iter()
            .filter_map(|id| text.db().face(*id))
            .map(|f| FontFace {
                family: f.family.clone(),
                subfamily: f.subfamily.clone(),
                postscript_name: f.postscript_name.clone().unwrap_or_default(),
                weight: f.weight,
                weight_min: f.weight_range.0,
                weight_max: f.weight_range.1,
                italic: !matches!(f.style, desyn_text::font::FaceStyle::Normal),
            })
            .collect();
        s.touch();
        Ok(faces)
    }

    /// Registered font families, in registration order (font pickers).
    pub fn font_families(&self) -> Vec<String> {
        self.lock()
            .renderer
            .text()
            .db()
            .families()
            .into_iter()
            .map(|f| f.name)
            .collect()
    }

    /// Fonts text layout needed but did not have since the last call; fetch them and `set_font`.
    pub fn take_font_requests(&self) -> Vec<FontRequest> {
        self.lock()
            .renderer
            .text_mut()
            .take_font_requests()
            .into_iter()
            .map(|r| FontRequest {
                family: r.family,
                weight: r.weight,
                italic: r.italic,
                reason: match r.reason {
                    RequestReason::Family => FontRequestReason::Family,
                    RequestReason::Fallback => FontRequestReason::Fallback,
                    RequestReason::Emoji => FontRequestReason::Emoji,
                },
            })
            .collect()
    }

    /// Provides the bytes of an asset (`AssetRef.id`): images, SVGs, fonts, video posters.
    pub fn set_asset(&self, id: String, bytes: Vec<u8>) {
        let mut s = self.lock();
        s.renderer.assets_mut().insert(id, bytes);
        let State {
            design, renderer, ..
        } = &mut *s;
        if let Some(d) = design.as_ref() {
            renderer.register_design_fonts(d);
        }
        s.touch();
    }

    /// Forgets the bytes of an asset.
    pub fn remove_asset(&self, id: String) {
        let mut s = self.lock();
        s.renderer.assets_mut().remove(&id);
        s.touch();
    }

    /// Asset ids requested since the last call that had no bytes.
    pub fn take_missing_assets(&self) -> Vec<String> {
        let mut v = self.lock().renderer.assets_mut().take_missing();
        v.sort();
        v
    }
}

fn pages_of(design: &Design) -> Vec<PageInfo> {
    Renderer::page_ids(design)
        .iter()
        .enumerate()
        .filter_map(|(i, id)| match design.node(id) {
            Some(Node::Page(p)) => Some(PageInfo {
                id: id.clone(),
                name: p.base.name.clone(),
                index: to_u32(i),
                width: p.base.width,
                height: p.base.height,
                bleed: p.bleed,
            }),
            _ => None,
        })
        .collect()
}

/// Normalization changes as forward and inverse `update` ops (only the keys that changed, like the core's
/// normalized `applied`). The inverse list is already reversed.
fn geometry_ops(changes: &[desyn_core::layout::GeometryChange]) -> (Vec<Op>, Vec<Op>) {
    let mut fwd = Vec::new();
    let mut inv = Vec::new();
    for ch in changes {
        let mut set = Map::new();
        let mut old = Map::new();
        for (k, b, a) in [
            ("x", ch.before.x, ch.after.x),
            ("y", ch.before.y, ch.after.y),
            ("width", ch.before.width, ch.after.width),
            ("height", ch.before.height, ch.after.height),
        ] {
            if a != b {
                set.insert(k.to_string(), num(a));
                old.insert(k.to_string(), num(b));
            }
        }
        if set.is_empty() {
            continue;
        }
        fwd.push(Op::update_set(ch.id.clone(), set));
        inv.push(Op::update_set(ch.id.clone(), old));
    }
    inv.reverse();
    (fwd, inv)
}
