//! Fonts: the bundled OFL set (compiled in), font directories indexed once at start (`FONTS_DIR`,
//! `SYSTEM_FONTS_DIR`), Google Fonts on demand with a disk cache (`FONT_CACHE_DIR`), and per-request design font
//! assets.
//!
//! Every request gets a fresh [`TextEngine`]: custom fonts uploaded by one workspace must never shape another
//! workspace's text, so nothing font-related is shared between requests except read-only file indexes and the
//! Google Fonts disk cache.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use desyn_core::model::{AssetKind, AssetRef, Id};
use desyn_text::TextEngine;
use desyn_text::font::{
    FontDb, FontProvider, FontRequest, GoogleFontsProvider, ProviderError, normalize_family,
};

use crate::config::{FontConfig, GoogleFontsMode};
use crate::metrics::{Counter, Metrics};

/// How long "Google Fonts has no such family" is remembered.
const NEGATIVE_TTL: Duration = Duration::from_secs(30 * 60);
/// How long a failed download is remembered (network trouble should not stall every request).
const ERROR_TTL: Duration = Duration::from_secs(60);

/// Font files below the configured directories, indexed by family name.
#[derive(Debug, Default)]
pub struct FontLibrary {
    families: HashMap<String, Vec<PathBuf>>,
    files: usize,
    faces: usize,
}

impl FontLibrary {
    /// Scans `dirs` (recursively; unreadable or invalid files are skipped).
    pub fn scan(dirs: &[PathBuf]) -> FontLibrary {
        let mut lib = FontLibrary::default();
        let mut seen = HashSet::new();
        for dir in dirs {
            for path in font_files(dir) {
                let key = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
                if !seen.insert(key) {
                    continue;
                }
                let Ok(bytes) = std::fs::read(&path) else {
                    continue;
                };
                // A throwaway database per file keeps the scan's memory at one file.
                let mut db = FontDb::new();
                let Ok(ids) = db.add_font(bytes) else {
                    continue;
                };
                lib.files += 1;
                for id in ids {
                    let Some(face) = db.face(id) else { continue };
                    lib.faces += 1;
                    for name in std::iter::once(&face.family).chain(face.aliases.iter()) {
                        let key = normalize_family(name);
                        if key.is_empty() {
                            continue;
                        }
                        let list = lib.families.entry(key).or_default();
                        if !list.contains(&path) {
                            list.push(path.clone());
                        }
                    }
                }
            }
        }
        lib
    }

    /// Number of font files.
    pub fn files(&self) -> usize {
        self.files
    }

    /// Number of faces.
    pub fn faces(&self) -> usize {
        self.faces
    }

    /// Number of families.
    pub fn families(&self) -> usize {
        self.families.len()
    }

    /// Files of a family. The fallback chains ask for Google's per-language CJK families ("Noto Sans JP"); system
    /// packages ship them as the pan-CJK collections ("Noto Sans CJK JP"), which are used when present.
    pub fn lookup(&self, family: &str) -> Option<&[PathBuf]> {
        let key = normalize_family(family);
        if let Some(v) = self.families.get(&key) {
            return Some(v);
        }
        for style in ["sans", "serif"] {
            let prefix = format!("noto {style} ");
            if let Some(lang) = key.strip_prefix(&prefix)
                && matches!(lang, "jp" | "sc" | "tc" | "kr" | "hk")
                && let Some(v) = self.families.get(&format!("noto {style} cjk {lang}"))
            {
                return Some(v);
            }
        }
        None
    }
}

fn font_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut dirs_seen = HashSet::new();
    while let Some(dir) = stack.pop() {
        // Symlinked directories are followed once each so a link cycle cannot loop.
        if !dirs_seen.insert(std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone())) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                matches!(
                    e.to_ascii_lowercase().as_str(),
                    "ttf" | "otf" | "ttc" | "otc" | "woff" | "woff2"
                )
            }) {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

type FontKey = (String, u32, bool);

/// Google Fonts downloads shared by all requests: one download per family / weight / style at a time, and
/// remembered misses.
pub struct GoogleFonts {
    provider: GoogleFontsProvider,
    misses: Mutex<HashMap<FontKey, Instant>>,
    locks: Mutex<HashMap<FontKey, Arc<Mutex<()>>>>,
    metrics: Arc<Metrics>,
}

impl GoogleFonts {
    fn new(cfg: &FontConfig, metrics: Arc<Metrics>) -> Option<GoogleFonts> {
        let provider = match cfg.google {
            GoogleFontsMode::Off => return None,
            GoogleFontsMode::On => {
                GoogleFontsProvider::with_endpoint(&cfg.google_endpoint, &cfg.cache_dir)
            }
            GoogleFontsMode::CacheOnly => {
                GoogleFontsProvider::with_endpoint(&cfg.google_endpoint, &cfg.cache_dir)
                    .offline(true)
            }
        };
        Some(GoogleFonts {
            provider,
            misses: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
            metrics,
        })
    }

    fn load(&self, req: &FontRequest) -> Result<Vec<Vec<u8>>, ProviderError> {
        let key: FontKey = (
            normalize_family(&req.family),
            req.weight.round() as u32,
            req.italic,
        );
        if let Some(until) = self.misses.lock().expect("font lock").get(&key)
            && Instant::now() < *until
        {
            return Ok(Vec::new());
        }
        let lock = {
            let mut locks = self.locks.lock().expect("font lock");
            if locks.len() > 4096 {
                locks.retain(|_, l| Arc::strong_count(l) > 1);
            }
            locks.entry(key.clone()).or_default().clone()
        };
        let _one_at_a_time = lock.lock().expect("font lock");
        // Another request may have recorded a miss while this one waited.
        if let Some(until) = self.misses.lock().expect("font lock").get(&key)
            && Instant::now() < *until
        {
            return Ok(Vec::new());
        }
        let started = Instant::now();
        let result = self.provider.clone().load(req);
        let miss_ttl = match &result {
            Ok(files) if !files.is_empty() => {
                self.metrics.inc(Counter::FontLoads, "google");
                tracing::debug!(family = %req.family, weight = req.weight, italic = req.italic,
                    ms = started.elapsed().as_millis() as u64, "google font loaded");
                None
            }
            Ok(_) => {
                self.metrics.inc(Counter::FontLoads, "google_missing");
                Some(NEGATIVE_TTL)
            }
            Err(e) => {
                self.metrics.inc(Counter::FontLoads, "google_error");
                tracing::warn!(family = %req.family, error = %e, "google font download failed");
                Some(ERROR_TTL)
            }
        };
        if let Some(ttl) = miss_ttl {
            let mut misses = self.misses.lock().expect("font lock");
            if misses.len() > 65_536 {
                let now = Instant::now();
                misses.retain(|_, until| *until > now);
            }
            misses.insert(key, Instant::now() + ttl);
        }
        result
    }
}

/// Fonts for every request.
pub struct FontService {
    library: Arc<FontLibrary>,
    google: Option<Arc<GoogleFonts>>,
    max_fetches_per_request: usize,
    metrics: Arc<Metrics>,
}

impl FontService {
    /// Scans the font directories (blocking; call once at start).
    pub fn new(cfg: &FontConfig, metrics: Arc<Metrics>) -> FontService {
        let started = Instant::now();
        let library = FontLibrary::scan(&cfg.dirs);
        tracing::info!(
            dirs = ?cfg.dirs,
            files = library.files(),
            faces = library.faces(),
            families = library.families(),
            ms = started.elapsed().as_millis() as u64,
            google = ?cfg.google,
            "font library indexed"
        );
        FontService {
            library: Arc::new(library),
            google: GoogleFonts::new(cfg, metrics.clone()).map(Arc::new),
            max_fetches_per_request: cfg.max_fetches_per_request,
            metrics,
        }
    }

    /// The directory index.
    pub fn library(&self) -> &FontLibrary {
        &self.library
    }

    /// A fresh engine: bundled fonts registered, the library and Google Fonts behind its provider. Downloads stop
    /// at the per-request budget and at `deadline`.
    pub fn engine(&self, deadline: Instant) -> TextEngine {
        let mut engine = TextEngine::with_bundled_fonts();
        engine.set_provider(Some(Box::new(WorkerProvider {
            library: self.library.clone(),
            google: self.google.clone(),
            downloads_left: self.max_fetches_per_request,
            deadline,
            metrics: self.metrics.clone(),
        })));
        engine
    }
}

struct WorkerProvider {
    library: Arc<FontLibrary>,
    google: Option<Arc<GoogleFonts>>,
    downloads_left: usize,
    deadline: Instant,
    metrics: Arc<Metrics>,
}

impl FontProvider for WorkerProvider {
    fn load(&mut self, request: &FontRequest) -> Result<Vec<Vec<u8>>, ProviderError> {
        if let Some(paths) = self.library.lookup(&request.family) {
            let files: Vec<Vec<u8>> = paths.iter().filter_map(|p| std::fs::read(p).ok()).collect();
            if !files.is_empty() {
                self.metrics.inc(Counter::FontLoads, "library");
                return Ok(files);
            }
        }
        let Some(google) = &self.google else {
            return Ok(Vec::new());
        };
        if self.downloads_left == 0 || Instant::now() >= self.deadline {
            self.metrics.inc(Counter::FontLoads, "budget");
            return Err(ProviderError::new(format!(
                "font download budget of this request is exhausted ({})",
                request.family
            )));
        }
        self.downloads_left -= 1;
        google.load(request)
    }
}

/// Registers design font assets (`AssetRef.kind == "font"`) whose bytes were fetched. Returns the ids that could
/// not be registered.
pub fn register_font_assets(
    engine: &mut TextEngine,
    assets: &BTreeMap<Id, AssetRef>,
    bytes: &HashMap<String, Arc<[u8]>>,
) -> Vec<Id> {
    let mut failed = Vec::new();
    for (id, asset) in assets {
        if asset.kind != AssetKind::Font {
            continue;
        }
        let Some(b) = bytes.get(id) else { continue };
        let r = match asset
            .family
            .as_deref()
            .map(str::trim)
            .filter(|f| !f.is_empty())
        {
            Some(family) => engine.add_font_as(b.to_vec(), family),
            None => engine.add_font(b.to_vec()),
        };
        if r.is_err() {
            failed.push(id.clone());
        }
    }
    failed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_fonts_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../desyn-text/fonts")
    }

    #[test]
    fn library_indexes_families_and_cjk_aliases() {
        let lib = FontLibrary::scan(&[text_fonts_dir(), PathBuf::from("/nonexistent/dir")]);
        assert!(lib.files() > 0, "the desyn-text font directory has fonts");
        assert!(lib.lookup("Instrument Serif").is_some());
        assert!(lib.lookup("instrument   serif").is_some());
        assert!(lib.lookup("No Such Family").is_none());
        let mut fake = FontLibrary::default();
        fake.families
            .insert("noto sans cjk jp".into(), vec![PathBuf::from("/x.ttc")]);
        assert!(fake.lookup("Noto Sans JP").is_some());
        assert!(fake.lookup("Noto Sans Thai").is_none());
    }
}
