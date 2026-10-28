//! Router and middleware: request ids, structured access logs, metrics, shared-secret auth, response compression,
//! health / readiness / metrics endpoints.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

use axum::Router;
use axum::body::HttpBody;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::{Predicate, SizeAbove};
use tracing::Instrument;

use crate::AppState;
use crate::error::ApiError;
use crate::jobs;
use crate::metrics::Counter;

/// Header carrying the shared secret (DOCUMENT_MODEL section 8).
pub const SECRET_HEADER: &str = "x-desyn-secret";
/// Request id header (accepted from callers, generated otherwise, always echoed).
pub const REQUEST_ID_HEADER: &str = "x-request-id";

/// The request id of the current request (request extension).
#[derive(Debug, Clone)]
pub struct RequestId(pub String);

fn route_label(path: &str) -> &'static str {
    match path {
        "/v1/render" => "render",
        "/v1/thumbnail" => "thumbnail",
        "/v1/describe" => "describe",
        "/v1/layout" => "layout",
        "/v1/measure" => "measure",
        "/v1/apply" => "apply",
        "/healthz" => "healthz",
        "/readyz" => "readyz",
        "/metrics" => "metrics",
        _ => "other",
    }
}

fn request_id(headers: &HeaderMap) -> String {
    if let Some(v) = headers.get(REQUEST_ID_HEADER).and_then(|v| v.to_str().ok())
        && !v.is_empty()
        && v.len() <= 128
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
    {
        return v.to_string();
    }
    let mut b = [0u8; 12];
    if getrandom::fill(&mut b).is_err() {
        // Extremely unlikely; ids only correlate log lines.
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        return format!("t{t:x}");
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Counts a request as in flight until it is answered or dropped (a caller that disconnects mid-render drops the
/// handler future; the gauge must still come back down).
struct InFlight(Arc<AppState>);

impl InFlight {
    fn enter(state: Arc<AppState>) -> InFlight {
        state.metrics.in_flight(1);
        InFlight(state)
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.metrics.in_flight(-1);
    }
}

/// Outermost middleware: request id, span, access log, metrics.
async fn observe(State(state): State<Arc<AppState>>, mut req: Request, next: Next) -> Response {
    let started = Instant::now();
    let id = request_id(req.headers());
    let route = route_label(req.uri().path());
    let method = req.method().clone();
    req.extensions_mut().insert(RequestId(id.clone()));
    let span = tracing::info_span!("request", request_id = %id, method = %method, route);
    let in_flight = InFlight::enter(state.clone());
    let mut res = next.run(req).instrument(span.clone()).await;
    drop(in_flight);
    let elapsed = started.elapsed();
    let status = res.status().as_u16();
    state.metrics.request(route, status, elapsed);
    if let Ok(v) = HeaderValue::from_str(&id) {
        res.headers_mut().insert(REQUEST_ID_HEADER, v);
    }
    let ms = (elapsed.as_secs_f64() * 10_000.0).round() / 10.0;
    let error = res
        .headers()
        .get("x-desyn-error")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = res.body().size_hint().exact();
    span.in_scope(|| {
        let quiet = matches!(route, "healthz" | "readyz" | "metrics");
        if status >= 500 {
            tracing::error!(status, ms, error = error.as_deref(), "request failed");
        } else if status >= 400 {
            tracing::warn!(status, ms, error = error.as_deref(), "request rejected");
        } else if quiet {
            tracing::debug!(status, ms, "request");
        } else {
            tracing::info!(status, ms, bytes, "request");
        }
    });
    res
}

/// Shared-secret check before any body is read: 401 without the header, 403 with a wrong value. Digests are
/// compared in constant time (the lengths of the secrets do not leak either).
async fn auth(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let open = matches!(path, "/healthz" | "/readyz")
        || (path == "/metrics" && state.config.metrics_public);
    if open {
        return next.run(req).await;
    }
    let Some(provided) = req.headers().get(SECRET_HEADER) else {
        state.metrics.inc(Counter::Rejections, "missing_secret");
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "the x-desyn-secret header is required",
        )
        .into_response();
    };
    if !state.secret_matches(provided.as_bytes()) {
        state.metrics.inc(Counter::Rejections, "wrong_secret");
        return ApiError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "the x-desyn-secret header is not valid",
        )
        .into_response();
    }
    next.run(req).await
}

/// SHA-256 of a secret (compared in constant time).
pub fn secret_digest(secret: &[u8]) -> [u8; 32] {
    let d = Sha256::digest(secret);
    let mut out = [0u8; 32];
    out.copy_from_slice(d.as_slice());
    out
}

/// Constant-time membership test of `provided` among `digests`.
pub fn secret_in(digests: &[[u8; 32]], provided: &[u8]) -> bool {
    let d = secret_digest(provided);
    let mut ok = subtle::Choice::from(0u8);
    for s in digests {
        ok |= s.ct_eq(&d);
    }
    ok.into()
}

async fn healthz(State(state): State<Arc<AppState>>) -> Response {
    let body = serde_json::json!({ "status": "ok", "release": state.config.release });
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body.to_string(),
    )
        .into_response()
}

async fn readyz(State(state): State<Arc<AppState>>) -> Response {
    let draining = state.draining.load(Ordering::SeqCst);
    let body = serde_json::json!({
        "status": if draining { "draining" } else { "ready" },
        "release": state.config.release,
        "slots": { "total": state.config.concurrency, "free": state.gate.available() },
        "waiting": state.metrics.waiting(),
        "fonts": { "files": state.fonts.library().files(), "families": state.fonts.library().families() },
        "video": state.ffmpeg.as_ref().map(|f| serde_json::json!({ "mp4": f.mp4, "webm": f.webm, "ffmpeg": f.version })),
    });
    let status = if draining {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body.to_string(),
    )
        .into_response()
}

async fn metrics(State(state): State<Arc<AppState>>) -> Response {
    let text = state.metrics.render(
        &state.config.release,
        state.config.concurrency,
        state.started.elapsed(),
    );
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                "text/plain; version=0.0.4; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        text,
    )
        .into_response()
}

async fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "no such endpoint")
}

/// Compress JSON and SVG answers above 1 KiB when the caller accepts gzip (images, PDF and PPTX are compressed
/// formats already).
fn compressible(
    _: StatusCode,
    _: axum::http::Version,
    headers: &HeaderMap,
    _: &axum::http::Extensions,
) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("application/json") || ct.starts_with("image/svg+xml"))
}

/// The worker's router.
pub fn router(state: Arc<AppState>) -> Router {
    let predicate = SizeAbove::new(1024).and(compressible as fn(_, _, &_, &_) -> bool);
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/metrics", get(metrics))
        .route("/v1/render", post(jobs::render))
        .route("/v1/thumbnail", post(jobs::thumbnail))
        .route("/v1/describe", post(jobs::describe))
        .route("/v1/layout", post(jobs::layout))
        .route("/v1/measure", post(jobs::measure))
        .route("/v1/apply", post(jobs::apply))
        .fallback(not_found)
        .layer(CompressionLayer::new().gzip(true).compress_when(predicate))
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .layer(middleware::from_fn_with_state(state.clone(), observe))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_compare_by_digest() {
        let digests = [
            secret_digest(b"current-secret-123"),
            secret_digest(b"previous-secret-45"),
        ];
        assert!(secret_in(&digests, b"current-secret-123"));
        assert!(secret_in(&digests, b"previous-secret-45"));
        assert!(!secret_in(&digests, b"current-secret-12"));
        assert!(!secret_in(&digests, b""));
        assert!(!secret_in(&[], b"anything"));
    }

    #[test]
    fn request_ids_are_sanitized() {
        let mut h = HeaderMap::new();
        h.insert(REQUEST_ID_HEADER, HeaderValue::from_static("abc-123_x.y"));
        assert_eq!(request_id(&h), "abc-123_x.y");
        h.insert(
            REQUEST_ID_HEADER,
            HeaderValue::from_static("bad id with spaces"),
        );
        let generated = request_id(&h);
        assert_eq!(generated.len(), 24);
        assert!(generated.bytes().all(|b| b.is_ascii_hexdigit()));
    }
}
