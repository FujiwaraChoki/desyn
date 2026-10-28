//! PKCE (RFC 7636, S256) and the authorize URL of the native sign-in flow (`convex/accounts/nativeAuth.ts`).

use base64::Engine as _;
use sha2::{Digest, Sha256};

const UNRESERVED: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/// `len` random characters from the RFC 7636 unreserved set (CSPRNG).
pub fn random_string(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    if getrandom::fill(&mut bytes).is_err() {
        // No OS randomness: refuse to produce a guessable secret.
        panic!("the operating system's random number generator is unavailable");
    }
    // 66 symbols: rejection sampling keeps the distribution uniform.
    let mut out = String::with_capacity(len);
    let mut i = 0;
    while out.len() < len {
        if i == bytes.len() {
            let _ = getrandom::fill(&mut bytes);
            i = 0;
        }
        let b = bytes[i] as usize;
        i += 1;
        if b < 66 * 3 {
            out.push(UNRESERVED[b % 66] as char);
        }
    }
    out
}

/// A PKCE pair plus the anti-forgery `state`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pkce {
    /// Secret verifier (kept in memory until the exchange).
    pub verifier: String,
    /// `base64url(sha256(verifier))`.
    pub challenge: String,
    /// Random `state` echoed back by the redirect.
    pub state: String,
}

/// The S256 challenge for a verifier.
pub fn challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

impl Pkce {
    /// A fresh pair (64-character verifier).
    pub fn new() -> Pkce {
        let verifier = random_string(64);
        Pkce {
            challenge: challenge(&verifier),
            verifier,
            state: random_string(32),
        }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Pkce::new()
    }
}

/// `${app}/native/authorize?client=desktop&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…`.
pub fn authorize_url(app_url: &str, redirect_uri: &str, pkce: &Pkce) -> String {
    let mut u = url::Url::parse(&format!("{app_url}/native/authorize")).unwrap_or_else(|_| {
        url::Url::parse("https://app.desyn.app/native/authorize").expect("url")
    });
    u.query_pairs_mut()
        .append_pair("client", "desktop")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &pkce.state);
    u.to_string()
}

/// Compares secrets without an early exit on the first differing byte.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_comparison() {
        assert!(constant_time_eq(b"state-1", b"state-1"));
        assert!(!constant_time_eq(b"state-1", b"state-2"));
        assert!(!constant_time_eq(b"state", b"state-1"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn rfc7636_vector() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn fresh_pairs_are_valid_and_distinct() {
        let a = Pkce::new();
        let b = Pkce::new();
        assert_eq!(a.verifier.len(), 64);
        assert!(a.verifier.bytes().all(|c| UNRESERVED.contains(&c)));
        assert_eq!(a.challenge.len(), 43);
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.state, b.state);
        let url = authorize_url("http://localhost:4100", "desyn://auth/callback", &a);
        assert!(url.starts_with("http://localhost:4100/native/authorize?client=desktop&redirect_uri=desyn%3A%2F%2Fauth%2Fcallback"));
        assert!(url.contains(&format!("code_challenge={}", a.challenge)));
        assert!(url.contains("code_challenge_method=S256"));
    }
}
