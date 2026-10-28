//! API errors: one JSON shape for every failure, `{ "error": { "code", "message", "details"? } }`, with the status
//! telling callers whether a retry can help (5xx / 429 / 503 are retried by the Convex client, 4xx are not).

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use desyn_raster::RenderError;
use serde_json::{Value, json};

/// An error answered to the caller.
#[derive(Debug, Clone)]
pub struct ApiError {
    /// HTTP status.
    pub status: StatusCode,
    /// Stable machine code (`invalid_json`, `too_many_nodes`, ...).
    pub code: &'static str,
    /// Human-readable message (never contains secrets or signed URLs).
    pub message: String,
    /// Structured details (validation violations, missing assets). Boxed: `serde_json::Value` grows when workspace
    /// feature unification enables `preserve_order`, and errors travel in every `Result`.
    pub details: Option<Box<Value>>,
    /// `Retry-After` seconds.
    pub retry_after: Option<u64>,
}

impl ApiError {
    /// Error with a status, code and message.
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            code,
            message: message.into(),
            details: None,
            retry_after: None,
        }
    }

    /// 400.
    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    /// 413.
    pub fn too_large(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, code, message)
    }

    /// 500.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }

    /// 503 with `Retry-After`.
    pub fn unavailable(code: &'static str, message: impl Into<String>, retry_after: u64) -> Self {
        let mut e = Self::new(StatusCode::SERVICE_UNAVAILABLE, code, message);
        e.retry_after = Some(retry_after);
        e
    }

    /// 504.
    pub fn timeout() -> Self {
        Self::new(
            StatusCode::GATEWAY_TIMEOUT,
            "timeout",
            "the request did not finish within the worker's deadline",
        )
    }

    /// Adds details.
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(Box::new(details));
        self
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {}: {}",
            self.status.as_u16(),
            self.code,
            self.message
        )
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": { "code": self.code, "message": self.message } });
        if let Some(d) = self.details {
            body["error"]["details"] = *d;
        }
        let mut res = (self.status, body.to_string()).into_response();
        let h = res.headers_mut();
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if let Some(s) = self.retry_after {
            h.insert(header::RETRY_AFTER, HeaderValue::from(s));
        }
        // The code is also exposed as a header so log lines and callers can classify failures without the body.
        h.insert("x-desyn-error", HeaderValue::from_static(self.code));
        res
    }
}

impl From<RenderError> for ApiError {
    fn from(e: RenderError) -> Self {
        let msg = e.to_string();
        match e {
            RenderError::NoPage(_) => ApiError::bad_request("page_not_found", msg),
            RenderError::InvalidOptions(_) => ApiError::bad_request("invalid_options", msg),
            RenderError::Parse(_) => ApiError::bad_request("invalid_design", msg),
            RenderError::TooLarge(_) => ApiError::too_large("too_many_pixels", msg),
            RenderError::Unsupported(_) => {
                ApiError::new(StatusCode::NOT_IMPLEMENTED, "unsupported", msg)
            }
            RenderError::Encode(_) | RenderError::Io(_) => ApiError::internal(msg),
        }
    }
}

/// Result alias.
pub type ApiResult<T> = Result<T, ApiError>;
