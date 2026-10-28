//! [`TextEngine`]: the font database plus shaping / measurement caches, lazy font loading and the
//! `desyn_core::layout::TextMeasurer` implementation.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};

use desyn_core::layout::{TextMeasureRequest, TextMeasurer, TextMetrics};
use desyn_core::model::{AutoResize, DesignStyles, TextNode};

use crate::content::{LineHeightSpec, ParagraphFormat, SpanStyle, TextContent};
use crate::font::{FontDb, FontError, FontId, FontProvider, FontRequest};
use crate::layout::{Hyphenator, LayoutCtx, LayoutOptions, layout};
use crate::outline::OutlineCache;
use crate::shape::Shaper;
use crate::types::LaidOutText;

/// Cache statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CacheStats {
    /// Shaped segments kept.
    pub shape_entries: usize,
    /// Shape cache hits since creation.
    pub shape_hits: u64,
    /// Shape cache misses since creation.
    pub shape_misses: u64,
    /// Measured text boxes kept.
    pub measure_entries: usize,
    /// Glyph outlines kept.
    pub outline_entries: usize,
}

/// The text engine every client shares: fonts, shaping, layout, measurement, caret geometry and outlines.
pub struct TextEngine {
    pub(crate) db: FontDb,
    pub(crate) shaper: Shaper,
    pub(crate) outlines: OutlineCache,
    measure_cache: HashMap<u64, TextMetrics>,
    provider: Option<Box<dyn FontProvider>>,
    attempted: HashSet<(String, u32, bool)>,
    requested: HashSet<(String, u32, bool)>,
    pending: Vec<FontRequest>,
    hyphenator: Option<Box<dyn Hyphenator>>,
    provider_errors: Vec<String>,
    /// The last layout left provider requests unattempted (load budget): its result must not be cached.
    deferred: bool,
}

impl std::fmt::Debug for TextEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TextEngine")
            .field("db", &self.db)
            .field("stats", &self.cache_stats())
            .field("provider", &self.provider.is_some())
            .field("pending", &self.pending)
            .finish()
    }
}

impl Default for TextEngine {
    fn default() -> Self {
        Self::new()
    }
}

const MEASURE_CACHE_CAPACITY: usize = 4096;
/// Provider loads attempted per layout call. Providers may block on the network; a document naming thousands of
/// unknown families must not stall one layout for minutes. Later calls pick up the remaining requests.
const PROVIDER_LOADS_PER_CALL: usize = 8;

impl TextEngine {
    /// Engine with an empty font database (hosts register fonts; layout falls back to approximate metrics until
    /// then).
    pub fn new() -> Self {
        Self::with_db(FontDb::new())
    }

    /// Engine over an existing database.
    pub fn with_db(db: FontDb) -> Self {
        TextEngine {
            db,
            shaper: Shaper::default(),
            outlines: OutlineCache::default(),
            measure_cache: HashMap::new(),
            provider: None,
            attempted: HashSet::new(),
            requested: HashSet::new(),
            pending: Vec::new(),
            hyphenator: None,
            provider_errors: Vec::new(),
            deferred: false,
        }
    }

    /// Engine with every font compiled in through the `bundled*` features registered.
    pub fn with_bundled_fonts() -> Self {
        let mut e = Self::new();
        // Bundled files are known-good; a failure would be a build problem caught by the tests.
        let _ = crate::font::bundled::register(&mut e.db);
        e
    }

    /// The font database.
    pub fn db(&self) -> &FontDb {
        &self.db
    }

    /// Mutable font database (fallback configuration, registration). Shape and outline caches stay valid (they key
    /// on interned instances); measurements are dropped because fallback chains may change which faces text uses.
    pub fn db_mut(&mut self) -> &mut FontDb {
        self.measure_cache.clear();
        &mut self.db
    }

    /// Registers font bytes (TTF / OTF / TTC / WOFF / WOFF2).
    pub fn add_font(&mut self, bytes: Vec<u8>) -> Result<Vec<FontId>, FontError> {
        self.db.add_font(bytes)
    }

    /// Registers font bytes under a family name (design font assets).
    pub fn add_font_as(&mut self, bytes: Vec<u8>, family: &str) -> Result<Vec<FontId>, FontError> {
        self.db.add_font_as(bytes, family)
    }

    /// Installs (or removes) the synchronous font provider used for missing families.
    pub fn set_provider(&mut self, provider: Option<Box<dyn FontProvider>>) {
        self.provider = provider;
    }

    /// Installs (or removes) the hyphenator used when `LayoutOptions::hyphenate` is set.
    pub fn set_hyphenator(&mut self, hyphenator: Option<Box<dyn Hyphenator>>) {
        self.hyphenator = hyphenator;
        // Line breaks (and so measurements) depend on it.
        self.measure_cache.clear();
    }

    /// Families the engine needed but could not find and no provider served, oldest first. Hosts without a
    /// provider (wasm) fetch them, call [`TextEngine::add_font`] and lay out again.
    pub fn take_font_requests(&mut self) -> Vec<FontRequest> {
        std::mem::take(&mut self.pending)
    }

    /// Pending requests without draining them.
    pub fn font_requests(&self) -> &[FontRequest] {
        &self.pending
    }

    /// Provider failures since the last call (network / disk errors); layout continued with fallbacks.
    pub fn take_provider_errors(&mut self) -> Vec<String> {
        std::mem::take(&mut self.provider_errors)
    }

    /// Drops shaping, measurement and outline caches.
    pub fn clear_caches(&mut self) {
        self.shaper.clear();
        self.measure_cache.clear();
        self.outlines.clear();
    }

    /// Cache statistics.
    pub fn cache_stats(&self) -> CacheStats {
        CacheStats {
            shape_entries: self.shaper.len(),
            shape_hits: self.shaper.hits,
            shape_misses: self.shaper.misses,
            measure_entries: self.measure_cache.len(),
            outline_entries: self.outlines.len(),
        }
    }

    fn run(
        &mut self,
        content: &TextContent,
        opts: &LayoutOptions,
        measure_only: bool,
    ) -> LaidOutText {
        let mut loads = 0usize;
        loop {
            let mut requests = Vec::new();
            let laid = {
                let mut ctx = LayoutCtx {
                    db: &mut self.db,
                    shaper: &mut self.shaper,
                    hyphenator: self.hyphenator.as_deref(),
                    requests: &mut requests,
                };
                layout(&mut ctx, content, opts, measure_only)
            };
            if requests.is_empty() {
                self.deferred = false;
                return laid;
            }
            let generation = self.db.generation();
            if let Some(provider) = self.provider.as_mut() {
                for req in &requests {
                    if self.attempted.contains(&req.key()) {
                        continue;
                    }
                    if loads >= PROVIDER_LOADS_PER_CALL {
                        break;
                    }
                    loads += 1;
                    self.attempted.insert(req.key());
                    match provider.load(req) {
                        Ok(files) => {
                            for bytes in files {
                                if let Err(e) = self.db.add_font(bytes) {
                                    self.provider_errors.push(format!("{}: {e}", req.family));
                                }
                            }
                        }
                        Err(e) => self.provider_errors.push(format!("{}: {e}", req.family)),
                    }
                }
            }
            // Lay out again with the new fonts, so the result (and the measurement cached for the new generation)
            // reflects the database. Terminates: every load spends budget and is never attempted twice.
            if self.db.generation() != generation {
                continue;
            }
            self.deferred = self.provider.is_some()
                && requests.iter().any(|r| !self.attempted.contains(&r.key()));
            for req in requests {
                if self.attempted.contains(&req.key()) && self.provider.is_some() {
                    continue;
                }
                if self.requested.insert(req.key()) {
                    self.pending.push(req);
                }
            }
            return laid;
        }
    }

    /// Lays out attributed text.
    pub fn layout(&mut self, content: &TextContent, opts: &LayoutOptions) -> LaidOutText {
        self.run(content, opts, false)
    }

    /// Lays out a text node in its box (`styles` resolves color references; pass the design's styles).
    pub fn layout_node(&mut self, node: &TextNode, styles: Option<&DesignStyles>) -> LaidOutText {
        let content = TextContent::from_node(node, styles);
        self.layout(&content, &LayoutOptions::for_node(node))
    }

    /// Measures attributed text (cached by content, options and font database generation).
    pub fn measure_content(&mut self, content: &TextContent, opts: &LayoutOptions) -> TextMetrics {
        let key = measure_key(content, opts, self.db.generation());
        if let Some(m) = self.measure_cache.get(&key) {
            return *m;
        }
        let laid = self.run(content, opts, true);
        let metrics = TextMetrics {
            width: laid.content_width,
            height: laid.content_height,
            lines: laid.lines.len() as u32,
            baseline: laid.first_baseline - laid.content_top,
        };
        if self.deferred {
            // The provider still owes fonts for this text; measure again next time.
            return metrics;
        }
        if self.measure_cache.len() >= MEASURE_CACHE_CAPACITY {
            self.measure_cache.clear();
        }
        // The generation may have moved when a provider loaded fonts during this call.
        let key = measure_key(content, opts, self.db.generation());
        self.measure_cache.insert(key, metrics);
        metrics
    }
}

impl TextMeasurer for TextEngine {
    fn measure(&mut self, req: &TextMeasureRequest<'_>) -> TextMetrics {
        let content = TextContent::from_runs(req.runs, req.style, req.paragraph, None);
        let opts = LayoutOptions {
            width: req.max_width,
            height: None,
            auto_resize: if req.max_width.is_some() {
                AutoResize::Height
            } else {
                AutoResize::Width
            },
            max_lines: req.max_lines,
            ..Default::default()
        };
        self.measure_content(&content, &opts)
    }
}

fn hash_f64(h: &mut impl Hasher, v: f64) {
    v.to_bits().hash(h);
}

fn hash_style(h: &mut impl Hasher, s: &SpanStyle) {
    s.families.hash(h);
    s.weight.to_bits().hash(h);
    s.italic.hash(h);
    s.stretch.to_bits().hash(h);
    hash_f64(h, s.size);
    hash_f64(h, s.letter_spacing);
    hash_f64(h, s.word_spacing);
    (s.case as u8).hash(h);
    hash_f64(h, s.baseline_shift);
    s.features.hash(h);
    for (t, v) in &s.variations {
        t.hash(h);
        v.to_bits().hash(h);
    }
    s.language.hash(h);
}

fn hash_paragraph(h: &mut impl Hasher, p: &ParagraphFormat) {
    (p.align as u8).hash(h);
    (p.direction as u8).hash(h);
    match p.line_height {
        LineHeightSpec::Auto => 0u8.hash(h),
        LineHeightSpec::Px(v) => {
            1u8.hash(h);
            hash_f64(h, v);
        }
        LineHeightSpec::Percent(v) => {
            2u8.hash(h);
            hash_f64(h, v);
        }
    }
    hash_f64(h, p.space_before);
    hash_f64(h, p.space_after);
    hash_f64(h, p.indent);
    (p.list as u8).hash(h);
    p.list_level.hash(h);
    p.list_start.hash(h);
}

/// Hash of everything that influences measurement.
fn measure_key(content: &TextContent, opts: &LayoutOptions, generation: u64) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    generation.hash(&mut h);
    content.text.hash(&mut h);
    for s in &content.spans {
        s.range.hash(&mut h);
        hash_style(&mut h, &s.style);
    }
    hash_style(&mut h, &content.default_style);
    hash_paragraph(&mut h, &content.paragraph);
    for (i, p) in &content.paragraph_overrides {
        i.hash(&mut h);
        hash_paragraph(&mut h, p);
    }
    opts.width.map(f64::to_bits).hash(&mut h);
    opts.height.map(f64::to_bits).hash(&mut h);
    (opts.auto_resize as u8).hash(&mut h);
    opts.max_lines.hash(&mut h);
    (opts.vertical_align as u8).hash(&mut h);
    opts.hyphenate.hash(&mut h);
    h.finish()
}
