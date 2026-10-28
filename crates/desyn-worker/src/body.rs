//! Request bodies: size-capped reads (before decompression and after), gzip (`content-encoding: gzip`, used by the
//! Convex client above 1 MB) and JSON decoding.

use std::io::Read;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, StatusCode, header};
use serde::de::DeserializeOwned;

use crate::error::{ApiError, ApiResult};

/// A request body as received.
#[derive(Debug, Clone)]
pub struct RawBody {
    bytes: Bytes,
    gzip: bool,
}

impl RawBody {
    /// Body from raw bytes (tests).
    pub fn new(bytes: Bytes, gzip: bool) -> Self {
        RawBody { bytes, gzip }
    }

    /// Size on the wire.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// True for an empty body.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Decompresses (when gzip) and parses JSON. CPU work: call it inside a job.
    pub fn json<T: DeserializeOwned>(&self, max_json_bytes: usize) -> ApiResult<T> {
        if self.bytes.is_empty() {
            return Err(ApiError::bad_request(
                "invalid_json",
                "the request body is empty",
            ));
        }
        let parsed = if self.gzip {
            let mut out = Vec::new();
            let mut dec =
                flate2::read::MultiGzDecoder::new(&self.bytes[..]).take(max_json_bytes as u64 + 1);
            dec.read_to_end(&mut out).map_err(|e| {
                ApiError::bad_request("invalid_gzip", format!("the gzip body is invalid: {e}"))
            })?;
            if out.len() > max_json_bytes {
                return Err(ApiError::too_large(
                    "json_too_large",
                    format!("the decompressed body exceeds {max_json_bytes} bytes"),
                ));
            }
            serde_json::from_slice(&out)
        } else {
            serde_json::from_slice(&self.bytes)
        };
        parsed.map_err(|e| ApiError::bad_request("invalid_json", format!("invalid request: {e}")))
    }
}

/// Reads a body of at most `max_bytes`, checking `content-length` first.
pub async fn read(headers: &HeaderMap, body: Body, max_bytes: usize) -> ApiResult<RawBody> {
    let gzip = match headers
        .get(header::CONTENT_ENCODING)
        .map(|v| v.to_str().unwrap_or("?").trim().to_ascii_lowercase())
        .as_deref()
    {
        None | Some("" | "identity") => false,
        Some("gzip" | "x-gzip") => true,
        Some(other) => {
            return Err(ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_encoding",
                format!("content-encoding {other:?} is not supported (use gzip or none)"),
            ));
        }
    };
    if let Some(len) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        && len > max_bytes as u64
    {
        return Err(body_too_large(max_bytes));
    }
    let bytes = axum::body::to_bytes(body, max_bytes).await.map_err(|e| {
        // `to_bytes` reports the length limit through its error source chain.
        let mut src: Option<&(dyn std::error::Error + 'static)> = Some(&e);
        while let Some(s) = src {
            if s.is::<http_body_util::LengthLimitError>() {
                return body_too_large(max_bytes);
            }
            src = s.source();
        }
        ApiError::bad_request(
            "body_read_failed",
            format!("the request body could not be read: {e}"),
        )
    })?;
    Ok(RawBody { bytes, gzip })
}

fn body_too_large(max: usize) -> ApiError {
    ApiError::too_large(
        "body_too_large",
        format!("the request body exceeds {max} bytes"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[derive(serde::Deserialize, Debug)]
    struct T {
        a: u32,
    }

    #[test]
    fn decodes_plain_and_gzip() {
        let plain = RawBody::new(Bytes::from_static(br#"{"a":3}"#), false);
        assert_eq!(plain.json::<T>(100).unwrap().a, 3);
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(br#"{"a":4}"#).unwrap();
        let gz = RawBody::new(Bytes::from(enc.finish().unwrap()), true);
        assert_eq!(gz.json::<T>(100).unwrap().a, 4);
        assert_eq!(gz.json::<T>(3).unwrap_err().code, "json_too_large");
        assert_eq!(
            RawBody::new(Bytes::from_static(b"nope"), true)
                .json::<T>(100)
                .unwrap_err()
                .code,
            "invalid_gzip"
        );
        assert_eq!(
            RawBody::new(Bytes::from_static(b"{"), false)
                .json::<T>(100)
                .unwrap_err()
                .code,
            "invalid_json"
        );
        assert_eq!(
            RawBody::new(Bytes::new(), false)
                .json::<T>(100)
                .unwrap_err()
                .code,
            "invalid_json"
        );
    }

    #[test]
    fn gzip_bomb_is_capped() {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        enc.write_all(&vec![b' '; 10_000_000]).unwrap();
        let gz = RawBody::new(Bytes::from(enc.finish().unwrap()), true);
        assert!(gz.len() < 100_000);
        assert_eq!(gz.json::<T>(1_000_000).unwrap_err().code, "json_too_large");
    }
}
