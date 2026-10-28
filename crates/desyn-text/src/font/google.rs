//! Google Fonts provider (native, feature `fetch`): resolves a family / weight / style through the CSS2 API,
//! downloads the font files and keeps both the CSS answers and the files in a disk cache so later runs work
//! offline.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::provider::{FontProvider, FontRequest, ProviderError};

/// Default CSS2 endpoint.
pub const GOOGLE_FONTS_CSS2: &str = "https://fonts.googleapis.com/css2";

/// Downloads families from Google Fonts (or any server speaking the same CSS2 protocol).
#[derive(Debug, Clone)]
pub struct GoogleFontsProvider {
    endpoint: String,
    cache_dir: PathBuf,
    agent: ureq::Agent,
    offline: bool,
}

/// Default cache directory: `$DESYN_FONT_CACHE`, else `$XDG_CACHE_HOME/desyn/fonts`, else `~/.cache/desyn/fonts`,
/// else a directory under the system temp dir.
pub fn default_cache_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("DESYN_FONT_CACHE") {
        return PathBuf::from(dir);
    }
    if let Some(dir) = std::env::var_os("XDG_CACHE_HOME") {
        return PathBuf::from(dir).join("desyn").join("fonts");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join(".cache")
            .join("desyn")
            .join("fonts");
    }
    std::env::temp_dir().join("desyn-fonts")
}

fn encode_family(family: &str) -> String {
    let mut out = String::new();
    for b in family.trim().bytes() {
        match b {
            b' ' => out.push('+'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// FNV-1a 64: a stable hash (unlike `DefaultHasher`, it never changes between Rust releases, so cache names
/// survive toolchain upgrades).
fn fnv1a(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// Cache file name: a readable, length-capped form of `label` plus a hash of the full `key`, so distinct keys never
/// share a file even when sanitizing maps them to the same characters, and long family names stay under file
/// system name limits.
fn cache_name(label: &str, key: &str, ext: &str) -> String {
    let readable: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    format!("{readable}-{:016x}{ext}", fnv1a(key))
}

/// Extracts `url(...)` sources from `@font-face` CSS, in order, without duplicates.
pub(crate) fn css_font_urls(css: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = css;
    while let Some(pos) = rest.find("url(") {
        rest = &rest[pos + 4..];
        let Some(end) = rest.find(')') else {
            break;
        };
        let url = rest[..end]
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .to_string();
        rest = &rest[end..];
        if (url.starts_with("http://") || url.starts_with("https://")) && !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

impl GoogleFontsProvider {
    /// Provider for fonts.googleapis.com with the default cache directory.
    pub fn new() -> Self {
        Self::with_endpoint(GOOGLE_FONTS_CSS2, default_cache_dir())
    }

    /// Provider for a CSS2-compatible endpoint (self-hosted mirrors, tests) caching into `cache_dir`.
    pub fn with_endpoint(endpoint: impl Into<String>, cache_dir: impl Into<PathBuf>) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .user_agent("desyn-text/0.1")
            .build();
        GoogleFontsProvider {
            endpoint: endpoint.into(),
            cache_dir: cache_dir.into(),
            agent: config.into(),
            offline: false,
        }
    }

    /// Serve only from the disk cache (no network).
    pub fn offline(mut self, offline: bool) -> Self {
        self.offline = offline;
        self
    }

    /// The cache directory.
    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    fn get(&self, url: &str, cache: &Path) -> Result<Option<Vec<u8>>, ProviderError> {
        if let Ok(bytes) = std::fs::read(cache) {
            return Ok(Some(bytes));
        }
        if self.offline {
            return Ok(None);
        }
        let mut resp = match self.agent.get(url).call() {
            Ok(r) => r,
            // The CSS API answers 400 for a weight / style the family does not have.
            Err(ureq::Error::StatusCode(400 | 404)) => return Ok(None),
            Err(e) => return Err(ProviderError::new(format!("{url}: {e}"))),
        };
        let bytes = resp
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_vec()
            .map_err(|e| ProviderError::new(format!("{url}: {e}")))?;
        if let Some(parent) = cache.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ProviderError::new(format!("{}: {e}", parent.display())))?;
        }
        // Write atomically so a concurrent reader never sees a partial file.
        let tmp = cache.with_extension(format!("tmp{}", std::process::id()));
        std::fs::write(&tmp, &bytes)
            .and_then(|_| std::fs::rename(&tmp, cache))
            .map_err(|e| ProviderError::new(format!("{}: {e}", cache.display())))?;
        Ok(Some(bytes))
    }

    fn queries(request: &FontRequest) -> Vec<String> {
        let fam = encode_family(&request.family);
        let w = (request.weight.round() as i32).clamp(1, 1000);
        let i = u8::from(request.italic);
        let mut q = vec![format!("{fam}:ital,wght@{i},{w}")];
        if w != 400 {
            q.push(format!("{fam}:ital,wght@{i},400"));
        }
        if request.italic || w != 400 {
            q.push(format!("{fam}:wght@{w}"));
        }
        q.push(fam);
        q.dedup();
        q
    }
}

impl Default for GoogleFontsProvider {
    fn default() -> Self {
        Self::new()
    }
}

/// Longest family name sent to the endpoint. Family names come from documents (untrusted); real families are far
/// shorter, and this keeps a hostile name from producing huge URLs or cache names.
const MAX_FAMILY_LEN: usize = 100;

impl FontProvider for GoogleFontsProvider {
    fn load(&mut self, request: &FontRequest) -> Result<Vec<Vec<u8>>, ProviderError> {
        let family = request.family.trim();
        if family.is_empty()
            || family.len() > MAX_FAMILY_LEN
            || family.chars().any(char::is_control)
        {
            return Ok(Vec::new());
        }
        // Never downgrade: an https endpoint only hands out https font files.
        let https_only = self.endpoint.starts_with("https://");
        for query in Self::queries(request) {
            let url = format!("{}?family={query}", self.endpoint);
            let css_path = self
                .cache_dir
                .join("css")
                .join(cache_name(&query, &url, ".css"));
            let Some(css) = self.get(&url, &css_path)? else {
                continue;
            };
            let css = String::from_utf8_lossy(&css);
            let mut files = Vec::new();
            for font_url in css_font_urls(&css) {
                if https_only && !font_url.starts_with("https://") {
                    continue;
                }
                let tail = font_url.rsplit('/').next().unwrap_or("font");
                let file = self
                    .cache_dir
                    .join("files")
                    .join(cache_name(tail, &font_url, ""));
                if let Some(bytes) = self.get(&font_url, &file)? {
                    files.push(bytes);
                }
            }
            if !files.is_empty() {
                return Ok(files);
            }
        }
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_css_and_builds_queries() {
        let css = "@font-face { src: url(https://x.test/a.ttf) format('truetype'); }\n\
                   @font-face { src: url('https://x.test/b.woff2') format('woff2'); }";
        let a = cache_name(
            "Inter:wght@400",
            "https://x/css2?family=Inter:wght@400",
            ".css",
        );
        let b = cache_name(
            "Inter_wght_400",
            "https://x/css2?family=Inter_wght_400",
            ".css",
        );
        assert_ne!(a, b, "sanitized labels collide, hashes keep them apart");
        assert!(a.starts_with("Inter_wght_400-") && a.ends_with(".css"));
        assert!(cache_name(&"x".repeat(5000), "k", "").len() < 120);
        assert_eq!(
            css_font_urls(css),
            vec!["https://x.test/a.ttf", "https://x.test/b.woff2"]
        );
        let q = GoogleFontsProvider::queries(&FontRequest {
            family: "Noto Sans SC".into(),
            weight: 700.0,
            italic: true,
            reason: super::super::provider::RequestReason::Family,
        });
        assert_eq!(
            q,
            vec![
                "Noto+Sans+SC:ital,wght@1,700",
                "Noto+Sans+SC:ital,wght@1,400",
                "Noto+Sans+SC:wght@700",
                "Noto+Sans+SC"
            ]
        );
    }
}
