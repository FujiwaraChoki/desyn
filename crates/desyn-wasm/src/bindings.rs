//! wasm-bindgen facade. JSON strings in and out (one parse on each side, no per-field marshalling); the frame
//! buffer is read in place through [`Engine::frame_ptr`] / [`Engine::frame_len`] as a view into wasm memory.

use wasm_bindgen::prelude::*;

use crate::engine::{EngineCore, formats, to_json};
use crate::protocol::{
    HandlesRequest, HitRequest, MarqueeRequest, MeasureItem, RenderRequest, ResizeRequest,
    RotateRequest, SnapRequest, TextQuery,
};

fn parse<T: serde::de::DeserializeOwned>(what: &str, json: &str) -> Result<T, JsError> {
    serde_json::from_str(json).map_err(|e| JsError::new(&format!("invalid {what}: {e}")))
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

/// Installs a panic hook that reports Rust panics on the console before the instance traps (the host then
/// re-creates the engine).
#[wasm_bindgen(start)]
pub fn start() {
    std::panic::set_hook(Box::new(|info| {
        console_error(&format!("desyn-wasm panic: {info}"));
    }));
}

/// Engine build information: `{ version, formats }`.
#[wasm_bindgen(js_name = engineInfo)]
pub fn engine_info() -> String {
    to_json(&serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "formats": formats(),
        "exporters": cfg!(feature = "exporters"),
    }))
}

/// The Desyn engine (one per open document).
#[wasm_bindgen]
pub struct Engine {
    core: EngineCore,
}

#[wasm_bindgen]
impl Engine {
    /// New engine; `seed` (32 bytes from `crypto.getRandomValues`) seeds id generation.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: &[u8]) -> Engine {
        Engine {
            core: EngineCore::new(seed),
        }
    }

    /// Loads a design JSON. Returns `LoadInfo` JSON.
    pub fn load(&mut self, design: &str) -> Result<String, JsError> {
        Ok(to_json(&self.core.load(design)?))
    }

    /// Applies a transaction JSON. Returns `{ inverse, applied, dropped }` JSON.
    #[wasm_bindgen(js_name = applyTransaction)]
    pub fn apply_transaction(&mut self, tx: &str, normalize: bool) -> Result<String, JsError> {
        Ok(to_json(&self.core.apply(tx, normalize)?))
    }

    /// Shows a transaction as a live preview (replaces the previous preview). Returns its result JSON.
    pub fn preview(&mut self, tx: &str, normalize: bool) -> Result<String, JsError> {
        Ok(to_json(&self.core.preview(tx, normalize)?))
    }

    /// Commits the active preview. Returns its result JSON, or `null` without a preview.
    #[wasm_bindgen(js_name = commitPreview)]
    pub fn commit_preview(&mut self) -> String {
        to_json(&self.core.commit_preview())
    }

    /// Reverts the active preview. Returns whether one was active.
    #[wasm_bindgen(js_name = cancelPreview)]
    pub fn cancel_preview(&mut self) -> bool {
        self.core.cancel_preview()
    }

    /// Recomputes derived boxes with the current fonts. Returns a result JSON (`applied` = geometry updates).
    pub fn relayout(&mut self) -> Result<String, JsError> {
        Ok(to_json(&self.core.relayout()?))
    }

    /// A fresh 12-character id.
    #[wasm_bindgen(js_name = newId)]
    pub fn new_id(&mut self) -> String {
        self.core.new_id()
    }

    /// The design JSON (committed state plus the active preview).
    pub fn snapshot(&self) -> String {
        self.core.snapshot()
    }

    /// Pages JSON.
    pub fn pages(&self) -> String {
        to_json(&self.core.pages())
    }

    /// Registers font bytes. Returns `FontInfo` JSON.
    #[wasm_bindgen(js_name = setFont)]
    pub fn set_font(&mut self, bytes: &[u8], family: Option<String>) -> Result<String, JsError> {
        Ok(to_json(&self.core.set_font(bytes, family.as_deref())?))
    }

    /// Registers asset bytes (decoded immediately; errors are thrown). Returns `AssetInfo` JSON.
    #[wasm_bindgen(js_name = setAsset)]
    pub fn set_asset(&mut self, id: &str, bytes: &[u8]) -> Result<String, JsError> {
        Ok(to_json(&self.core.set_asset(id, bytes)?))
    }

    /// Forgets an asset's bytes.
    #[wasm_bindgen(js_name = removeAsset)]
    pub fn remove_asset(&mut self, id: &str) {
        self.core.remove_asset(id);
    }

    /// Missing assets / fonts noticed outside render calls. Returns `PendingRequests` JSON.
    #[wasm_bindgen(js_name = takeRequests)]
    pub fn take_requests(&mut self) -> String {
        to_json(&self.core.take_requests())
    }

    /// Renders the viewport into the frame buffer. Returns `FrameInfo` JSON.
    pub fn render(&mut self, request: &str) -> Result<String, JsError> {
        let req: RenderRequest = parse("render request", request)?;
        Ok(to_json(&self.core.render(&req)?))
    }

    /// Address of the frame bytes (straight RGBA) in wasm memory.
    #[wasm_bindgen(js_name = framePtr)]
    pub fn frame_ptr(&self) -> usize {
        self.core.frame_bytes().as_ptr() as usize
    }

    /// Length of the frame bytes.
    #[wasm_bindgen(js_name = frameLen)]
    pub fn frame_len(&self) -> usize {
        self.core.frame_bytes().len()
    }

    /// Frame width in device pixels.
    #[wasm_bindgen(js_name = frameWidth)]
    pub fn frame_width(&self) -> u32 {
        self.core.frame_size().0
    }

    /// Frame height in device pixels.
    #[wasm_bindgen(js_name = frameHeight)]
    pub fn frame_height(&self) -> u32 {
        self.core.frame_size().1
    }

    /// Hit test. Returns `HitResult` JSON.
    #[wasm_bindgen(js_name = hitTest)]
    pub fn hit_test(&mut self, request: &str) -> Result<String, JsError> {
        let req: HitRequest = parse("hit request", request)?;
        Ok(to_json(&self.core.hit_test(&req)?))
    }

    /// Marquee selection. Returns an id array JSON.
    pub fn marquee(&mut self, request: &str) -> Result<String, JsError> {
        let req: MarqueeRequest = parse("marquee request", request)?;
        Ok(to_json(&self.core.marquee(&req)?))
    }

    /// Snapping. Returns `SnapResult` JSON (+ `distances`).
    pub fn snap(&mut self, request: &str) -> Result<String, JsError> {
        let req: SnapRequest = parse("snap request", request)?;
        Ok(to_json(&self.core.snap(&req)?))
    }

    /// Selection bounds and transform handles. Returns `HandlesResult` JSON.
    pub fn handles(&mut self, request: &str) -> Result<String, JsError> {
        let req: HandlesRequest = parse("handles request", request)?;
        Ok(to_json(&self.core.handles(&req)))
    }

    /// Resize math. Returns `ResizeResult` JSON.
    #[wasm_bindgen(js_name = resizeBox)]
    pub fn resize_box(&self, request: &str) -> Result<String, JsError> {
        let req: ResizeRequest = parse("resize request", request)?;
        Ok(to_json(&self.core.resize_box(&req)))
    }

    /// Rotation math (degrees).
    #[wasm_bindgen(js_name = rotationDelta)]
    pub fn rotation_delta(&self, request: &str) -> Result<f64, JsError> {
        let req: RotateRequest = parse("rotate request", request)?;
        Ok(self.core.rotation_delta(&req))
    }

    /// Page-space bounds of nodes (`null` for unknown ids). `ids` is a JSON array.
    pub fn bounds(&self, ids: &str) -> Result<String, JsError> {
        let ids: Vec<String> = parse("ids", ids)?;
        Ok(to_json(&self.core.bounds(&ids)))
    }

    /// Text measuring. `items` is a JSON array of `MeasureItem`. Returns `MeasureResult[]` JSON.
    pub fn measure(&mut self, items: &str) -> Result<String, JsError> {
        let items: Vec<MeasureItem> = parse("measure items", items)?;
        Ok(to_json(&self.core.measure(&items)))
    }

    /// Semantic description. Returns `Description` JSON.
    pub fn describe(&mut self, options: &str) -> Result<String, JsError> {
        Ok(to_json(&self.core.describe(options)?))
    }

    /// Token-budgeted text description for prompts.
    #[wasm_bindgen(js_name = describeCompact)]
    pub fn describe_compact(
        &mut self,
        options: &str,
        max_tokens: usize,
    ) -> Result<String, JsError> {
        Ok(self.core.describe_compact(options, max_tokens)?)
    }

    /// Lint. Returns `Issue[]` JSON.
    pub fn lint(&mut self, options: &str) -> Result<String, JsError> {
        Ok(to_json(&self.core.lint(options)?))
    }

    /// Exports the design. Returns the file bytes; metadata via [`Engine::export_info`].
    pub fn export(&mut self, request: &str) -> Result<Vec<u8>, JsError> {
        Ok(self.core.export(request)?)
    }

    /// Metadata of the last export (`ExportInfo` JSON or `null`).
    #[wasm_bindgen(js_name = exportInfo)]
    pub fn export_info(&self) -> String {
        to_json(&self.core.last_export())
    }

    /// Layout of a text node for an editing overlay. Returns `TextLayoutInfo` JSON.
    #[wasm_bindgen(js_name = textLayout)]
    pub fn text_layout(&mut self, node_id: &str) -> Result<String, JsError> {
        Ok(to_json(&self.core.text_layout(node_id)?))
    }

    /// Caret / hit / selection / movement / range query. Returns `TextQueryResult` JSON.
    #[wasm_bindgen(js_name = textQuery)]
    pub fn text_query(&mut self, query: &str) -> Result<String, JsError> {
        let q: TextQuery = parse("text query", query)?;
        Ok(to_json(&self.core.text_query(&q)?))
    }

    /// Text converted to outlines. Returns `TextOutline` JSON.
    #[wasm_bindgen(js_name = outlineText)]
    pub fn outline_text(&mut self, node_id: &str) -> Result<String, JsError> {
        Ok(to_json(&self.core.outline_text(node_id)?))
    }
}
