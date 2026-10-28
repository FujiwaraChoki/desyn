//! Canonical JSON and hashing, byte-identical to `canonicalize` in `@desyn/schema` (`packages/schema/src/canonical.ts`,
//! algorithm pinned by `spec/fixtures/README.md` and `spec/fixtures/canonical/`).
//!
//! Rules: object keys sorted by Unicode code point (= UTF-8 byte order), no whitespace, non-integer numbers rounded
//! to at most 6 decimals half away from zero (`sign(n) * Math.round(|n| * 1e6) / 1e6`), `-0` written as `0`,
//! numbers written in plain decimal (shortest round-trip digits, never exponent notation), strings escaped like
//! `JSON.stringify`. Non-finite numbers cannot occur in a `serde_json::Value`; they are written as `null`.

use core::cmp::Ordering;
use core::fmt::Write as _;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// JavaScript `Math.round`: nearest integer, ties toward +infinity.
#[inline]
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// Canonical number value: integers unchanged, other numbers rounded to at most 6 decimals half away from zero,
/// `-0` becomes `0`.
#[inline]
pub fn normalize_number(n: f64) -> f64 {
    if !n.is_finite() {
        return n;
    }
    if n.fract() == 0.0 {
        return if n == 0.0 { 0.0 } else { n };
    }
    let r = n.signum() * js_round(n.abs() * 1e6) / 1e6;
    if r == 0.0 { 0.0 } else { r }
}

/// Canonical decimal text of a number (normalized, plain decimal, no exponent).
pub fn canonical_number_string(n: f64) -> String {
    let mut s = String::new();
    write_plain_number(&mut s, normalize_number(n));
    s
}

/// Writes shortest round-trip digits in plain decimal notation (no exponent).
fn write_plain_number(out: &mut String, x: f64) {
    if !x.is_finite() {
        out.push_str("null");
        return;
    }
    if x == 0.0 {
        out.push('0');
        return;
    }
    if x < 0.0 {
        out.push('-');
    }
    let (digits, n) = shortest_digits(x.abs());
    let k = digits.len() as i32;
    if n >= k {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if n > 0 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    }
}

/// Shortest round-trip decimal digits `s` and position `n` such that `x = 0.s * 10^n` (ECMAScript Number::toString
/// terms: `s * 10^(n-k)`).
fn shortest_digits(x: f64) -> (String, i32) {
    let (digits, exp) = sci_digits(&format!("{x:e}"));
    match even_tie_alternative(x, &digits, exp) {
        Some(alt) => (alt, exp + 1),
        None => (digits, exp + 1),
    }
}

/// Splits Rust `LowerExp` output (`d.ddde±x`) into its digit string and decimal exponent.
fn sci_digits(e: &str) -> (String, i32) {
    let (mant, exp) = e.split_once('e').expect("LowerExp always has an exponent");
    let exp: i32 = exp.parse().expect("valid exponent");
    (mant.chars().filter(|c| *c != '.').collect(), exp)
}

/// ECMAScript Number::toString tie-break. When two shortest digit strings are equally close to `x` (its exact
/// value lies halfway between them), JavaScript picks the one whose last digit is even, while Rust's formatter
/// rounds the halfway case up (`1551089286804199.25` is `…199.2` in JavaScript, `…199.3` in Rust). Returns the even
/// alternative when `digits` is the odd one of such a tie and the alternative also round-trips.
fn even_tie_alternative(x: f64, digits: &str, exp: i32) -> Option<String> {
    let k = digits.len();
    if digits.as_bytes()[k - 1].is_multiple_of(2) {
        return None;
    }
    // Cheap filter: a tie needs the value rounded to k + 1 significant digits to end in 5.
    let (near, near_exp) = sci_digits(&format!("{x:.k$e}"));
    if near_exp != exp || near.as_bytes().last() != Some(&b'5') {
        return None;
    }
    // Exact decimal expansion (every double has at most 767 significant digits).
    let (exact, exact_exp) = sci_digits(&format!("{x:.800e}"));
    let tail = exact.as_bytes().get(k..)?;
    if exact_exp != exp || tail.first() != Some(&b'5') || tail[1..].iter().any(|b| *b != b'0') {
        return None;
    }
    // The two candidates are `exact[..k]` and that plus one unit in the last digit; `digits` is one of them.
    let lower = &exact[..k];
    let alt = if digits == lower {
        let mut bytes = lower.as_bytes().to_vec();
        let mut i = k;
        loop {
            if i == 0 {
                return None; // carry into a new digit: different exponent, not a tie candidate
            }
            i -= 1;
            if bytes[i] == b'9' {
                bytes[i] = b'0';
            } else {
                bytes[i] += 1;
                break;
            }
        }
        String::from_utf8(bytes).ok()?
    } else {
        lower.to_string()
    };
    let text = format!("{}.{}e{exp}", &alt[..1], &alt[1..]);
    (text.parse::<f64>().ok() == Some(x)).then_some(alt)
}

/// Formats a finite f64 exactly like JavaScript `Number.prototype.toString()` (`String(n)`).
pub fn js_number_string(x: f64) -> String {
    let mut s = String::new();
    write_js_number(&mut s, x);
    s
}

fn write_js_number(out: &mut String, x: f64) {
    if x.is_nan() {
        out.push_str("NaN");
        return;
    }
    if x == 0.0 {
        out.push('0');
        return;
    }
    if x.is_infinite() {
        out.push_str(if x > 0.0 { "Infinity" } else { "-Infinity" });
        return;
    }
    if x < 0.0 {
        out.push('-');
    }
    let (digits, n) = shortest_digits(x.abs());
    let k = digits.len() as i32;
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        let e = n - 1;
        out.push(if e >= 0 { '+' } else { '-' });
        let _ = write!(out, "{}", e.abs());
    }
}

/// Writes a JSON string literal escaped like `JSON.stringify`.
fn write_js_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Canonical key order: Unicode code point order, which equals UTF-8 byte order (Rust `str` ordering).
#[inline]
pub fn key_cmp(a: &str, b: &str) -> Ordering {
    a.cmp(b)
}

fn write_value(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            // Integers beyond 2^53 are not exactly representable as doubles; JavaScript sees the nearest double.
            const SAFE: i64 = 9_007_199_254_740_991;
            if let Some(i) = n.as_i64().filter(|i| (-SAFE..=SAFE).contains(i)) {
                let _ = write!(out, "{i}");
            } else {
                write_plain_number(out, normalize_number(n.as_f64().unwrap_or(f64::NAN)));
            }
        }
        Value::String(s) => write_js_string(out, s),
        Value::Array(a) => {
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort_by(|a, b| key_cmp(a, b));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_js_string(out, k);
                out.push(':');
                write_value(out, &m[k.as_str()]);
            }
            out.push('}');
        }
    }
}

/// Canonical JSON of a JSON value.
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::with_capacity(256);
    write_value(&mut out, v);
    out
}

/// Canonical JSON of any serializable value (e.g. a `Design`, `Node` or `Transaction`).
pub fn canonical_string<T: Serialize + ?Sized>(v: &T) -> String {
    let value = serde_json::to_value(v).expect("model types serialize to JSON");
    canonical_json(&value)
}

/// Returns a copy of `v` with all numbers normalized (6 decimals, no -0). Key order is unchanged.
pub fn normalize_value(v: &Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.is_finite() => {
                if n.is_i64() || n.is_u64() {
                    v.clone()
                } else {
                    let r = normalize_number(f);
                    if r.fract() == 0.0 && r.abs() < 9.007_199_254_740_992e15 {
                        Value::from(r as i64)
                    } else {
                        serde_json::Number::from_f64(r)
                            .map(Value::Number)
                            .unwrap_or(Value::Null)
                    }
                }
            }
            _ => Value::Null,
        },
        Value::Array(a) => Value::Array(a.iter().map(normalize_value).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| (k.clone(), normalize_value(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Lowercase hex sha256 of bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest.iter() {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// sha256 hex of the canonical JSON of a value.
pub fn canonical_hash<T: Serialize + ?Sized>(v: &T) -> String {
    sha256_hex(canonical_string(v).as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn js_number_formatting() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (100.0, "100"),
            (0.1, "0.1"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789.125, "123456789.125"),
            (1.5e-10, "1.5e-10"),
            (2.5e22, "2.5e+22"),
            (0.3333333333333333, "0.3333333333333333"),
            (5e-324, "5e-324"),
        ];
        for (x, s) in cases {
            assert_eq!(js_number_string(*x), *s, "formatting {x}");
        }
    }

    /// ECMAScript picks the even digit when two shortest decimal strings are equally close (V8 output); Rust's
    /// formatter rounds such ties up. The literals are exact doubles (ties need every digit), hence the allow.
    #[test]
    #[allow(clippy::excessive_precision)]
    fn shortest_digits_break_exact_ties_to_even_like_javascript() {
        let cases: &[(f64, &str)] = &[
            (1551089286804199.25, "1551089286804199.2"),
            (-275748312473297.125, "-275748312473297.12"),
            (25590896606445.3125, "25590896606445.312"),
            (73618457897.328125, "73618457897.32812"),
            (-2066953604251.40625, "-2066953604251.4062"),
            (1140947639942169.25, "1140947639942169.2"),
            // Not ties: unchanged.
            (0.15, "0.15"),
            (1551089286804199.5, "1551089286804199.5"),
            (123456789.125, "123456789.125"),
        ];
        for (x, want) in cases {
            assert_eq!(canonical_number_string(*x), *want, "canonical {x}");
            assert_eq!(js_number_string(*x), *want, "String({x})");
            assert_eq!(want.parse::<f64>().unwrap(), *x, "{want} round-trips");
        }
        assert_eq!(js_number_string(1.25e22), "1.25e+22");
    }

    #[test]
    fn number_normalization() {
        assert_eq!(normalize_number(0.1 + 0.2), 0.3);
        assert_eq!(normalize_number(-0.0000001), 0.0);
        assert!(normalize_number(-0.0000001).is_sign_positive());
        assert_eq!(normalize_number(1.25e-7), 0.0);
        assert_eq!(
            normalize_number(-2.0000005000001),
            -2.000001,
            "half away from zero"
        );
        assert_eq!(normalize_number(2.123456789), 2.123457);
        assert_eq!(normalize_number(-0.0), 0.0);
        assert_eq!(normalize_number(1e300), 1e300);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.5), 3.0);
    }

    #[test]
    fn plain_decimal_formatting() {
        assert_eq!(canonical_number_string(1e21), "1000000000000000000000");
        assert_eq!(canonical_number_string(2.5e22), "25000000000000000000000");
        assert_eq!(canonical_number_string(0.000001), "0.000001");
        assert_eq!(canonical_number_string(0.0000015), "0.000002");
        assert_eq!(canonical_number_string(-0.0000015), "-0.000002");
        assert_eq!(canonical_number_string(-12.5), "-12.5");
        assert_eq!(canonical_number_string(100.0), "100");
        assert_eq!(canonical_number_string(1.0 / 3.0), "0.333333");
    }

    #[test]
    fn canonical_object() {
        let v = json!({"b": 1, "a": [3.0000001, -0.0, {"z": null, "y": "x\n\"\u{1}"}], "A": true});
        assert_eq!(
            canonical_json(&v),
            r#"{"A":true,"a":[3,0,{"y":"x\n\"\u0001","z":null}],"b":1}"#
        );
    }

    #[test]
    fn code_point_key_order() {
        // U+FF5E sorts before U+1F600 by code point (UTF-16 order would put it after).
        let v = json!({"\u{1F600}": 1, "\u{FF5E}": 2});
        assert_eq!(canonical_json(&v), "{\"\u{FF5E}\":2,\"\u{1F600}\":1}");
    }

    #[test]
    fn hash_is_sha256() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
