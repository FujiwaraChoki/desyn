//! Endpoint handlers. Each request runs in up to three phases:
//! 1. parse + validate + plan assets (CPU slot),
//! 2. fetch assets (async I/O, no slot held),
//! 3. render / compute (CPU slot).

pub mod doc;
pub mod render;
pub mod video;

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;

use crate::AppState;
use crate::body;
use crate::config::{AssetConfig, Limits};
use crate::error::ApiResult;
use crate::fonts::FontService;
use crate::metrics::Counter;
use crate::net::FetchReport;
use crate::plan::{self, AssetNeeds};
use crate::runtime::{Cancel, run_job};

/// Longest value of a reporting header (ids / family lists are cut beyond it).
const MAX_HEADER_LIST: usize = 2000;

/// Facts about a binary output, reported in `x-desyn-*` headers.
#[derive(Debug, Clone, Default)]
pub struct StillMeta {
    /// Pages included.
    pub pages: usize,
    /// Assets that had no bytes (no URL, or not decodable).
    pub missing_assets: Vec<String>,
    /// Assets whose fetch failed.
    pub failed_assets: Vec<String>,
    /// Font families that were not available (fallback fonts were used).
    pub missing_fonts: Vec<String>,
    /// Non-fatal problems.
    pub warnings: Vec<String>,
}

/// A rendered file.
#[derive(Debug, Clone)]
pub struct Output {
    /// File bytes.
    pub bytes: Vec<u8>,
    /// MIME type.
    pub mime: &'static str,
    /// Report.
    pub meta: StillMeta,
}

fn header_list(items: &[String]) -> Option<HeaderValue> {
    if items.is_empty() {
        return None;
    }
    let mut s = String::new();
    for it in items {
        // Keep header-safe characters only (family names come from documents).
        let clean: String = it
            .chars()
            .filter(|c| c.is_ascii_graphic() || *c == ' ')
            .filter(|c| *c != ',')
            .collect();
        if clean.is_empty() {
            continue;
        }
        if s.len() + clean.len() + 1 > MAX_HEADER_LIST {
            s.push_str(",...");
            break;
        }
        if !s.is_empty() {
            s.push(',');
        }
        s.push_str(&clean);
    }
    HeaderValue::from_str(&s).ok()
}

fn binary_response(out: Output) -> Response {
    let Output { bytes, mime, meta } = out;
    let mut res = bytes.into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("x-desyn-pages", HeaderValue::from(meta.pages as u64));
    h.insert(
        "x-desyn-warnings",
        HeaderValue::from(meta.warnings.len() as u64),
    );
    if let Some(v) = header_list(&meta.missing_assets) {
        h.insert("x-desyn-missing-assets", v);
    }
    if let Some(v) = header_list(&meta.failed_assets) {
        h.insert("x-desyn-failed-assets", v);
    }
    if let Some(v) = header_list(&meta.missing_fonts) {
        h.insert("x-desyn-missing-fonts", v);
    }
    if !meta.warnings.is_empty() {
        tracing::info!(warnings = ?meta.warnings, "render warnings");
    }
    res
}

fn json_response(bytes: Vec<u8>) -> Response {
    let mut res = bytes.into_response();
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// Prepared jobs expose the assets they need.
pub trait NeedsAssets {
    /// Assets to fetch before the compute phase.
    fn needs(&self) -> &AssetNeeds;
}

impl NeedsAssets for render::PreparedRender {
    fn needs(&self) -> &AssetNeeds {
        &self.needs
    }
}
impl NeedsAssets for render::PreparedThumbnail {
    fn needs(&self) -> &AssetNeeds {
        &self.needs
    }
}
impl NeedsAssets for doc::PreparedDescribe {
    fn needs(&self) -> &AssetNeeds {
        &self.needs
    }
}
impl NeedsAssets for doc::PreparedLayout {
    fn needs(&self) -> &AssetNeeds {
        &self.needs
    }
}
impl NeedsAssets for doc::PreparedMeasure {
    fn needs(&self) -> &AssetNeeds {
        &self.needs
    }
}
impl NeedsAssets for doc::PreparedApply {
    fn needs(&self) -> &AssetNeeds {
        &self.needs
    }
}

/// Phase 1 (parse + prepare in a CPU slot) and phase 2 (asset fetch) for any endpoint.
async fn prepare<Req, Prep, F>(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    body: Body,
    cancel: &Cancel,
    prepare: F,
) -> ApiResult<(Prep, FetchReport)>
where
    Req: DeserializeOwned,
    Prep: NeedsAssets + Send + 'static,
    F: FnOnce(Req, &Limits, &AssetConfig) -> ApiResult<Prep> + Send + 'static,
{
    let raw = body::read(headers, body, state.config.limits.max_body_bytes).await?;
    let limits = state.config.limits.clone();
    let acfg = state.config.assets.clone();
    let prepared = run_job(&state.gate, cancel, move |_| {
        let req: Req = raw.json(limits.max_json_bytes)?;
        prepare(req, &limits, &acfg)
    })
    .await?;
    let report = fetch(state, prepared.needs(), cancel).await;
    Ok((prepared, report))
}

async fn fetch(state: &Arc<AppState>, needs: &AssetNeeds, cancel: &Cancel) -> FetchReport {
    if needs.items.is_empty() {
        return FetchReport::default();
    }
    state
        .fetcher
        .fetch_all(needs.items.clone(), cancel.deadline().into())
        .await
}

type Compute<Prep, R> = fn(Prep, FetchReport, &FontService, &Cancel) -> ApiResult<R>;

/// The JSON endpoints share one shape: prepare, fetch fonts / images, compute, answer JSON.
async fn json_endpoint<Req, Prep>(
    state: Arc<AppState>,
    headers: HeaderMap,
    body: Body,
    prep: fn(Req, &Limits, &AssetConfig) -> ApiResult<Prep>,
    compute: Compute<Prep, Vec<u8>>,
) -> ApiResult<Response>
where
    Req: DeserializeOwned + 'static,
    Prep: NeedsAssets + Send + 'static,
{
    let cancel = Cancel::new(Instant::now() + state.config.request_timeout);
    let (prepared, report) = prepare(&state, &headers, body, &cancel, prep).await?;
    let st = state.clone();
    let bytes = run_job(&state.gate, &cancel, move |c| {
        compute(prepared, report, &st.fonts, c)
    })
    .await?;
    state.metrics.output_bytes(bytes.len() as u64);
    Ok(json_response(bytes))
}

/// `POST /v1/render`.
pub async fn render(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    let started = Instant::now();
    let cancel = Cancel::new(started + state.config.request_timeout);
    let raw = body::read(&headers, body, state.config.limits.max_body_bytes).await?;
    let limits = state.config.limits.clone();
    let acfg = state.config.assets.clone();
    let ffmpeg = state.ffmpeg.clone();
    let prepared = run_job(&state.gate, &cancel, move |_| {
        let req: render::RenderRequest = raw.json(limits.max_json_bytes)?;
        render::prepare(req, &limits, &acfg, ffmpeg.as_ref())
    })
    .await?;
    // Video gets the longer deadline from the start of the request.
    let cancel = if prepared.is_video() {
        Cancel::new(started + state.config.video_timeout)
    } else {
        cancel
    };
    let report = fetch(&state, &prepared.needs, &cancel).await;
    plan::check_strict(prepared.strict, &prepared.needs, &report)?;
    let label = prepared.format_label();
    let st = state.clone();
    let out = run_job(&state.gate, &cancel, move |c| {
        render::execute(prepared, report, &st.fonts, &st.video, c)
    })
    .await?;
    state.metrics.inc(Counter::Renders, label);
    state.metrics.output_bytes(out.bytes.len() as u64);
    tracing::info!(
        format = label,
        bytes = out.bytes.len(),
        pages = out.meta.pages,
        "rendered"
    );
    Ok(binary_response(out))
}

/// `POST /v1/thumbnail`.
pub async fn thumbnail(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    let cancel = Cancel::new(Instant::now() + state.config.request_timeout);
    let (prepared, report) =
        prepare(&state, &headers, body, &cancel, render::prepare_thumbnail).await?;
    let st = state.clone();
    let out = run_job(&state.gate, &cancel, move |c| {
        render::execute_thumbnail(prepared, report, &st.fonts, c)
    })
    .await?;
    state.metrics.inc(Counter::Renders, "thumbnail");
    state.metrics.output_bytes(out.bytes.len() as u64);
    Ok(binary_response(out))
}

/// `POST /v1/describe`.
pub async fn describe(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    json_endpoint(
        state,
        headers,
        body,
        doc::prepare_describe,
        doc::execute_describe,
    )
    .await
}

/// `POST /v1/layout`.
pub async fn layout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    json_endpoint(
        state,
        headers,
        body,
        doc::prepare_layout,
        doc::execute_layout,
    )
    .await
}

/// `POST /v1/measure`.
pub async fn measure(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    json_endpoint(
        state,
        headers,
        body,
        doc::prepare_measure,
        doc::execute_measure,
    )
    .await
}

/// `POST /v1/apply`.
pub async fn apply(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    json_endpoint(state, headers, body, doc::prepare_apply, doc::execute_apply).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_lists_are_sanitized_and_capped() {
        let v = header_list(&["a1".into(), "Bad\nName, Inc".into(), "é".into()]).unwrap();
        assert_eq!(v.to_str().unwrap(), "a1,BadName Inc");
        let many: Vec<String> = (0..1000).map(|i| format!("asset{i:07}")).collect();
        let v = header_list(&many).unwrap();
        assert!(v.len() <= MAX_HEADER_LIST + 4);
        assert!(v.to_str().unwrap().ends_with(",..."));
        assert!(header_list(&[]).is_none());
    }
}
