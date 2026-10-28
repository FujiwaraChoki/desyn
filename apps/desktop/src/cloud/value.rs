//! Conversions between JSON and Convex values, and the error type every cloud call returns.
//!
//! Convex function arguments use `v.number()` (float64) for every number in this API, so JSON numbers become
//! `Float64`; results come back as JSON. Design content itself crosses the boundary as JSON strings
//! (DOCUMENT_MODEL change log, Convex wire format), so no `$`-prefixed keys ever reach these converters.

use std::collections::BTreeMap;

use base64::Engine as _;
use serde_json::{Map, Number, Value as Json};

/// JSON -> Convex value.
pub fn to_convex(v: &Json) -> convex::Value {
    match v {
        Json::Null => convex::Value::Null,
        Json::Bool(b) => convex::Value::Boolean(*b),
        Json::Number(n) => convex::Value::Float64(n.as_f64().unwrap_or(0.0)),
        Json::String(s) => convex::Value::String(s.clone()),
        Json::Array(a) => convex::Value::Array(a.iter().map(to_convex).collect()),
        Json::Object(o) => {
            convex::Value::Object(o.iter().map(|(k, v)| (k.clone(), to_convex(v))).collect())
        }
    }
}

/// Convex value -> JSON (int64 as numbers, bytes as base64, non-finite floats as null).
pub fn to_json(v: convex::Value) -> Json {
    match v {
        convex::Value::Null => Json::Null,
        convex::Value::Int64(i) => Json::Number(i.into()),
        // Integral floats become JSON integers so typed views can use integer fields (seq, counts).
        convex::Value::Float64(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => {
            Json::Number((f as i64).into())
        }
        convex::Value::Float64(f) => Number::from_f64(f).map(Json::Number).unwrap_or(Json::Null),
        convex::Value::Boolean(b) => Json::Bool(b),
        convex::Value::String(s) => Json::String(s),
        convex::Value::Bytes(b) => {
            Json::String(base64::engine::general_purpose::STANDARD.encode(b))
        }
        convex::Value::Array(a) => Json::Array(a.into_iter().map(to_json).collect()),
        convex::Value::Object(o) => Json::Object(
            o.into_iter()
                .map(|(k, v)| (k, to_json(v)))
                .collect::<Map<_, _>>(),
        ),
    }
}

/// Arguments object for a Convex call (`args` must be a JSON object; anything else becomes `{}`).
pub fn args(v: &Json) -> BTreeMap<String, convex::Value> {
    match v {
        Json::Object(o) => o.iter().map(|(k, v)| (k.clone(), to_convex(v))).collect(),
        _ => BTreeMap::new(),
    }
}

/// What went wrong with a cloud call.
#[derive(Debug, Clone, PartialEq)]
pub struct CloudError {
    /// `NETWORK` (no connection / timeout), `SERVER` (unexpected failure) or the server's app error code
    /// (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_ARGUMENT`, `CONFLICT`, `EXPIRED`, `LIMIT_REACHED`,
    /// `FEATURE_UNAVAILABLE`, `RATE_LIMITED`, `NOT_CONFIGURED`, `EMAIL_NOT_VERIFIED`, ...).
    pub code: String,
    /// Human-readable message (from the server when it sent one).
    pub message: String,
    /// Extra fields of an app error (`limit`, `feature`, `retryAfterMs`, `reason`, ...).
    pub data: Json,
}

impl CloudError {
    /// A connectivity problem (retry later).
    pub fn network(msg: impl Into<String>) -> CloudError {
        CloudError {
            code: "NETWORK".into(),
            message: msg.into(),
            data: Json::Null,
        }
    }

    /// An unexpected server failure.
    pub fn server(msg: impl Into<String>) -> CloudError {
        CloudError {
            code: "SERVER".into(),
            message: msg.into(),
            data: Json::Null,
        }
    }

    /// From a Convex function result error.
    pub fn from_convex(message: String, data: convex::Value) -> CloudError {
        let data = to_json(data);
        let code = data
            .get("code")
            .and_then(Json::as_str)
            .unwrap_or("SERVER")
            .to_string();
        let message = data
            .get("message")
            .and_then(Json::as_str)
            .map(str::to_string)
            .unwrap_or(message);
        CloudError {
            code,
            message,
            data,
        }
    }

    /// From an uncaught server error message ("[CONVEX M(designs/designs:commit)] Uncaught Error: ...").
    pub fn from_message(message: String) -> CloudError {
        let clean = message
            .split("Uncaught Error: ")
            .nth(1)
            .map(|s| s.lines().next().unwrap_or(s).trim().to_string())
            .unwrap_or_else(|| message.lines().next().unwrap_or("").to_string());
        let lower = clean.to_ascii_lowercase();
        let code = if lower.contains("unauthenticated") || lower.contains("not authenticated") {
            "UNAUTHENTICATED"
        } else {
            "SERVER"
        };
        CloudError {
            code: code.into(),
            message: clean,
            data: Json::Null,
        }
    }

    /// Worth retrying later without user action (connectivity, rate limits, server hiccups).
    pub fn is_transient(&self) -> bool {
        matches!(
            self.code.as_str(),
            "NETWORK" | "SERVER" | "RATE_LIMITED" | "INTERNAL"
        )
    }

    /// The session is gone (sign in again).
    pub fn is_auth(&self) -> bool {
        self.code == "UNAUTHENTICATED"
    }

    /// Message for a toast: says what to do next (DESIGN_SYSTEM §7).
    pub fn friendly(&self) -> String {
        match self.code.as_str() {
            "NETWORK" => {
                "You're offline. Changes are kept on this computer and sync when you reconnect."
                    .into()
            }
            "UNAUTHENTICATED" => "Your session ended. Sign in again to keep syncing.".into(),
            "FEATURE_UNAVAILABLE" => {
                let feature = self
                    .data
                    .get("feature")
                    .and_then(Json::as_str)
                    .unwrap_or("");
                if feature.is_empty() {
                    "This needs Desyn Pro.".into()
                } else {
                    format!("This needs Desyn Pro ({feature}).")
                }
            }
            "LIMIT_REACHED" => format!("{} Upgrade to Pro or free some space.", self.message),
            "RATE_LIMITED" => "Too many requests right now. Try again in a moment.".into(),
            "NOT_CONFIGURED" if !self.message.is_empty() => self.message.clone(),
            "NOT_CONFIGURED" => "This isn't set up on this server.".into(),
            // Uncaught server exceptions arrive as "[Request ID: …] Server Error": nothing a person can act on.
            _ if self.message.contains("Server Error") => {
                "The server ran into a problem. Try again in a moment.".into()
            }
            _ if !self.message.is_empty() => self.message.clone(),
            _ => "Something went wrong. Try again.".into(),
        }
    }
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CloudError {}

/// Maps a Convex function result to JSON or a [`CloudError`].
pub fn result(r: convex::FunctionResult) -> Result<Json, CloudError> {
    match r {
        convex::FunctionResult::Value(v) => Ok(to_json(v)),
        convex::FunctionResult::ConvexError(e) => Err(CloudError::from_convex(e.message, e.data)),
        convex::FunctionResult::ErrorMessage(m) => Err(CloudError::from_message(m)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_roundtrip() {
        let v = json!({ "a": 1, "b": [true, null, "x"], "c": { "d": 2.5 } });
        let c = to_convex(&v);
        assert_eq!(
            to_json(c),
            json!({ "a": 1, "b": [true, null, "x"], "c": { "d": 2.5 } })
        );
        assert_eq!(to_json(convex::Value::Int64(7)), json!(7));
        assert_eq!(
            to_json(convex::Value::Bytes(vec![0, 16, 131])),
            json!("ABCD")
        );
        assert_eq!(args(&json!([1])).len(), 0);
    }

    #[test]
    fn app_errors_keep_code_and_data() {
        let data = to_convex(
            &json!({ "code": "FEATURE_UNAVAILABLE", "message": "Pro only", "feature": "versionHistory" }),
        );
        let e = CloudError::from_convex("x".into(), data);
        assert_eq!(e.code, "FEATURE_UNAVAILABLE");
        assert!(e.friendly().contains("versionHistory"));
        assert!(!e.is_transient());
        let m = CloudError::from_message(
            "[CONVEX M(designs/designs:commit)] [Request ID: 1] Server Error\nUncaught Error: Not authenticated\n  at foo".into(),
        );
        assert_eq!(m.code, "UNAUTHENTICATED");
        assert_eq!(m.message, "Not authenticated");
        assert!(CloudError::network("down").is_transient());
    }
}
