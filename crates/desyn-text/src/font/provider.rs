//! Lazy font loading.
//!
//! The engine records every family it needed but could not find as a [`FontRequest`]. Hosts either drain those
//! requests and feed bytes back (`TextEngine::take_font_requests` + `TextEngine::add_font`, the wasm path), or
//! install a [`FontProvider`] that the engine calls synchronously before laying out (native: a fonts directory,
//! an in-memory map, or Google Fonts with the `fetch` feature).

use std::collections::HashMap;
use std::fmt;

/// Why a family was requested.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RequestReason {
    /// The text asks for this family by name.
    Family,
    /// No registered font covers characters of a script; this is the script's fallback family.
    Fallback,
    /// No registered font covers an emoji.
    Emoji,
}

/// A family the engine needs.
#[derive(Debug, Clone, PartialEq)]
pub struct FontRequest {
    /// Family name as written in the text style (or the fallback family).
    pub family: String,
    /// Requested weight.
    pub weight: f32,
    /// Requested italic.
    pub italic: bool,
    /// Why.
    pub reason: RequestReason,
}

impl FontRequest {
    /// Dedup key: family (case-insensitive) + weight + italic.
    pub(crate) fn key(&self) -> (String, u32, bool) {
        (
            super::db::normalize_family(&self.family),
            self.weight.round() as u32,
            self.italic,
        )
    }
}

/// A provider failure (network, disk, unknown family). The engine keeps laying out with fallbacks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderError {
    /// Human-readable reason.
    pub message: String,
}

impl ProviderError {
    /// Creates an error.
    pub fn new(message: impl Into<String>) -> Self {
        ProviderError {
            message: message.into(),
        }
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProviderError {}

/// Loads font files on demand.
pub trait FontProvider: Send {
    /// Returns font files (TTF / OTF / TTC / WOFF / WOFF2 bytes) for the request; an empty list when the family is
    /// unknown. Called at most once per family / weight / italic combination for the engine's lifetime.
    fn load(&mut self, request: &FontRequest) -> Result<Vec<Vec<u8>>, ProviderError>;
}

/// Provider backed by bytes the host registered up front (families known but not yet parsed, e.g. a desktop app's
/// downloaded fonts or a design's font assets).
#[derive(Debug, Default, Clone)]
pub struct MemoryProvider {
    families: HashMap<String, Vec<Vec<u8>>>,
}

impl MemoryProvider {
    /// Empty provider.
    pub fn new() -> Self {
        Self::default()
    }

    /// Makes `bytes` available for `family` (all weights / styles inside the files are registered on first use).
    pub fn insert(&mut self, family: &str, bytes: Vec<u8>) {
        self.families
            .entry(super::db::normalize_family(family))
            .or_default()
            .push(bytes);
    }
}

impl FontProvider for MemoryProvider {
    fn load(&mut self, request: &FontRequest) -> Result<Vec<Vec<u8>>, ProviderError> {
        // Hand the files out once; the engine keeps every face of them.
        Ok(self
            .families
            .remove(&super::db::normalize_family(&request.family))
            .unwrap_or_default())
    }
}

/// Native provider that serves fonts from a directory tree (the worker's `FONTS_DIR`). Files are indexed by the
/// family names inside them on first use.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug)]
pub struct DirectoryProvider {
    root: std::path::PathBuf,
    index: Option<HashMap<String, Vec<std::path::PathBuf>>>,
}

#[cfg(not(target_arch = "wasm32"))]
impl DirectoryProvider {
    /// Serves fonts found below `root` (`.ttf`, `.otf`, `.ttc`, `.otc`, `.woff`, `.woff2`).
    pub fn new(root: impl Into<std::path::PathBuf>) -> Self {
        DirectoryProvider {
            root: root.into(),
            index: None,
        }
    }

    fn build_index(&self) -> HashMap<String, Vec<std::path::PathBuf>> {
        let mut index: HashMap<String, Vec<std::path::PathBuf>> = HashMap::new();
        for path in super::db::font_files(&self.root) {
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(data) = super::db::decode_font_bytes(bytes) else {
                continue;
            };
            for family in super::db::family_names(&data) {
                let list = index
                    .entry(super::db::normalize_family(&family))
                    .or_default();
                if !list.contains(&path) {
                    list.push(path.clone());
                }
            }
        }
        index
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl FontProvider for DirectoryProvider {
    fn load(&mut self, request: &FontRequest) -> Result<Vec<Vec<u8>>, ProviderError> {
        if self.index.is_none() {
            self.index = Some(self.build_index());
        }
        let key = super::db::normalize_family(&request.family);
        let paths = self
            .index
            .as_mut()
            .and_then(|i| i.remove(&key))
            .unwrap_or_default();
        paths
            .iter()
            .map(|p| {
                std::fs::read(p).map_err(|e| ProviderError::new(format!("{}: {e}", p.display())))
            })
            .collect()
    }
}
