//! Lenient numeric deserializers: JSON has a single number type, so counts written as `3.0` by a float-only
//! producer must still load as integers. Non-integral or negative values are rejected.

use serde::{Deserialize, Deserializer};

/// Largest integer JavaScript represents exactly (`Number.MAX_SAFE_INTEGER`). zod's `z.int()` accepts exactly the
/// safe integers, so counts beyond this are rejected here too (and accepted up to it, unlike a `u32`).
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn to_count<E: serde::de::Error>(v: f64) -> Result<u64, E> {
    if v.is_finite() && v >= 0.0 && v.fract() == 0.0 && v <= MAX_SAFE_INTEGER as f64 {
        Ok(v as u64)
    } else {
        Err(E::custom(format!(
            "expected a non-negative safe integer, got {v}"
        )))
    }
}

/// Deserializes a non-negative count from any integral JSON number up to [`MAX_SAFE_INTEGER`].
pub fn u64_lenient<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let v = f64::deserialize(d)?;
    to_count(v)
}

/// Deserializes an `Option<u64>` count (absent via `#[serde(default)]`) like [`u64_lenient`]; `null` is rejected.
pub fn opt_u64_lenient<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    let v = f64::deserialize(d)?;
    to_count(v).map(Some)
}

/// `Option<T>` field that may be absent but never `null` (zod `.optional()` rejects `null`). Use with
/// `#[serde(default)]`: absent -> `None`, value -> `Some`, `null` -> error.
pub fn nn<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// Any finite integral double is an integer for JavaScript (`Number.isInteger(1e21)` is true). Values outside the
/// `i64` range saturate, which keeps their meaning everywhere they are used: indices clamp to the children range
/// and path indices that large never resolve.
fn to_i64<E: serde::de::Error>(v: f64) -> Result<i64, E> {
    if v.is_finite() && v.fract() == 0.0 {
        Ok(v as i64)
    } else {
        Err(E::custom(format!("expected an integer, got {v}")))
    }
}

/// Deserializes an optional integer from any integral JSON number (JavaScript `Number.isInteger` semantics);
/// `null` is rejected.
pub fn opt_i64_lenient<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    let v = f64::deserialize(d)?;
    to_i64(v).map(Some)
}

/// Deserializes an integer from any integral JSON number.
pub fn i64_lenient<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    let v = f64::deserialize(d)?;
    to_i64(v)
}
