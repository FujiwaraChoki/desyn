//! Plain HTTP on the network runtime: the native sign-in exchange, presigned uploads, image previews, Iconify and
//! the update feed. Every call has a timeout and a response size cap.

use std::time::Duration;

use serde_json::Value as Json;

use super::value::CloudError;

/// Default size cap for downloads (images, exports): 64 MB.
pub const MAX_DOWNLOAD: usize = 64 * 1024 * 1024;

/// A shared HTTP client.
pub fn client() -> reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            super::runtime::runtime();
            reqwest::Client::builder()
                .user_agent(format!("Desyn-Desktop/{}", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(120))
                .build()
                .expect("http client")
        })
        .clone()
}

fn net(e: reqwest::Error) -> CloudError {
    if e.is_timeout() || e.is_connect() || e.is_request() {
        CloudError::network(e.to_string())
    } else {
        CloudError::server(e.to_string())
    }
}

async fn read_capped(res: reqwest::Response, max: usize) -> Result<Vec<u8>, CloudError> {
    if let Some(len) = res.content_length()
        && len as usize > max
    {
        return Err(CloudError::server(format!(
            "response too large ({len} bytes)"
        )));
    }
    let mut out = Vec::new();
    let mut res = res;
    while let Some(chunk) = res.chunk().await.map_err(net)? {
        if out.len() + chunk.len() > max {
            return Err(CloudError::server("response too large".to_string()));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// GET bytes (with the content type), at most `max` bytes. Must run on the network runtime.
pub async fn get_bytes(url: &str, max: usize) -> Result<(Vec<u8>, Option<String>), CloudError> {
    let res = client().get(url).send().await.map_err(net)?;
    let status = res.status();
    if !status.is_success() {
        return Err(CloudError::server(format!("{status} for {}", redact(url))));
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_string());
    Ok((read_capped(res, max).await?, mime))
}

/// GET JSON. Must run on the network runtime.
pub async fn get_json(url: &str, bearer: Option<&str>) -> Result<Json, CloudError> {
    let mut req = client().get(url).header("accept", "application/json");
    if let Some(b) = bearer {
        req = req.bearer_auth(b);
    }
    let res = req.send().await.map_err(net)?;
    let status = res.status();
    let bytes = read_capped(res, 8 * 1024 * 1024).await?;
    parse_json_response(status, &bytes)
}

/// POST JSON and read a JSON answer (error statuses become [`CloudError`]s carrying the body's `error`).
pub async fn post_json(url: &str, body: &Json, bearer: Option<&str>) -> Result<Json, CloudError> {
    let mut req = client()
        .post(url)
        .header("accept", "application/json")
        .json(body);
    if let Some(b) = bearer {
        req = req.bearer_auth(b);
    }
    let res = req.send().await.map_err(net)?;
    let status = res.status();
    let bytes = read_capped(res, 8 * 1024 * 1024).await?;
    parse_json_response(status, &bytes)
}

fn parse_json_response(status: reqwest::StatusCode, bytes: &[u8]) -> Result<Json, CloudError> {
    let body: Json = serde_json::from_slice(bytes).unwrap_or(Json::Null);
    if status.is_success() {
        return Ok(body);
    }
    let error = body
        .get("error")
        .map(|e| match e {
            Json::String(s) => s.clone(),
            other => other
                .get("message")
                .and_then(Json::as_str)
                .unwrap_or("error")
                .to_string(),
        })
        .unwrap_or_else(|| status.to_string());
    let code = match status.as_u16() {
        401 => "UNAUTHENTICATED",
        403 => "FORBIDDEN",
        404 => "NOT_FOUND",
        429 => "RATE_LIMITED",
        400 => "INVALID_ARGUMENT",
        s if s >= 500 => "SERVER",
        _ => "SERVER",
    };
    Err(CloudError {
        code: code.into(),
        message: error,
        data: body,
    })
}

/// PUT bytes to a presigned URL with exactly the signed headers.
pub async fn put_presigned(
    url: &str,
    headers: &[(String, String)],
    bytes: Vec<u8>,
) -> Result<(), CloudError> {
    let mut req = client().put(url);
    for (k, v) in headers {
        // reqwest sets content-length from the body; a duplicate header would break the signature.
        if !k.eq_ignore_ascii_case("content-length") {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    let res = req.body(bytes).send().await.map_err(net)?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(CloudError::server(format!(
            "upload failed ({})",
            res.status()
        )))
    }
}

/// URL without its query string (signed URLs carry credentials in the query; never log them).
pub fn redact(url: &str) -> String {
    url.split('?').next().unwrap_or(url).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_carry_the_server_reason() {
        let e = parse_json_response(
            reqwest::StatusCode::BAD_REQUEST,
            br#"{"error":"invalid_grant"}"#,
        )
        .unwrap_err();
        assert_eq!(e.code, "INVALID_ARGUMENT");
        assert_eq!(e.message, "invalid_grant");
        let ok = parse_json_response(reqwest::StatusCode::OK, br#"{"token":"t"}"#).unwrap();
        assert_eq!(ok["token"], "t");
        assert_eq!(
            redact("https://s3/x.png?X-Amz-Signature=abc"),
            "https://s3/x.png"
        );
    }
}
