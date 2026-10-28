//! The font database: registration, family lookup, CSS matching, variation instances and coverage queries.

use std::collections::HashMap;
use std::fmt;
use std::hash::{Hash, Hasher};

use skrifa::raw::model::{Blob, Font as RfFont, NormalizedCoord};
use skrifa::{FontRef, Tag};

use super::face::{FaceInfo, FontId, parse_face};
use super::fallback::FallbackConfig;
use super::matching::{FaceMatch, MatchRequest, match_faces};

/// Font registration failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FontError {
    /// The bytes are not a TrueType / OpenType font, collection, WOFF or WOFF2 file.
    Unsupported,
    /// WOFF / WOFF2 decompression failed.
    Decode(String),
    /// The file parsed but contains no usable face (no names, no `head`).
    NoFaces,
}

impl fmt::Display for FontError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FontError::Unsupported => f.write_str("unsupported font format"),
            FontError::Decode(e) => write!(f, "font decode failed: {e}"),
            FontError::NoFaces => f.write_str("font file contains no usable face"),
        }
    }
}

impl std::error::Error for FontError {}

/// Handle of a font face at one location in its design space (interned per database).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize)]
#[serde(transparent)]
pub struct InstanceId(pub u32);

/// Font-wide metrics of an instance, in font units (y up; descent positive below the baseline).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InstanceMetrics {
    /// Units per em.
    pub units_per_em: f64,
    /// Ascender (positive).
    pub ascent: f64,
    /// Descender (positive, below the baseline).
    pub descent: f64,
    /// Line gap.
    pub line_gap: f64,
    /// Top of the underline stroke relative to the baseline (negative = below).
    pub underline_position: f64,
    /// Underline thickness.
    pub underline_thickness: f64,
    /// Top of the strikethrough stroke relative to the baseline.
    pub strikeout_position: f64,
    /// Strikethrough thickness.
    pub strikeout_thickness: f64,
    /// x-height.
    pub x_height: f64,
    /// Cap height.
    pub cap_height: f64,
}

/// One face at one variation location.
#[derive(Clone)]
pub struct Instance {
    face: FontId,
    variations: Vec<(String, f32)>,
    font: RfFont,
    coords: Vec<NormalizedCoord>,
    metrics: InstanceMetrics,
}

impl fmt::Debug for Instance {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Instance")
            .field("face", &self.face)
            .field("variations", &self.variations)
            .field("metrics", &self.metrics)
            .finish()
    }
}

impl Instance {
    /// Face this instance belongs to.
    pub fn face(&self) -> FontId {
        self.face
    }
    /// User-space axis values (`[("wght", 650.0)]`); empty for static fonts and default locations.
    pub fn variations(&self) -> &[(String, f32)] {
        &self.variations
    }
    /// Metrics at this location.
    pub fn metrics(&self) -> &InstanceMetrics {
        &self.metrics
    }
    /// Normalized coordinates (for skrifa outline / color drawing).
    pub fn coords(&self) -> &[NormalizedCoord] {
        &self.coords
    }
    pub(crate) fn font(&self) -> &RfFont {
        &self.font
    }
}

struct Face {
    info: FaceInfo,
    blob: Blob,
    font: RfFont,
}

/// A family as listed by [`FontDb::families`].
#[derive(Debug, Clone, PartialEq)]
pub struct FamilyInfo {
    /// Display name (as registered first).
    pub name: String,
    /// Faces in registration order.
    pub faces: Vec<FontId>,
}

/// Normalizes a family name for lookups: trims, strips CSS quotes, collapses whitespace, lowercases.
pub fn normalize_family(name: &str) -> String {
    let t = name.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    let mut out = String::with_capacity(t.len());
    let mut space = false;
    for c in t.chars() {
        if c.is_whitespace() {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.extend(c.to_lowercase());
        }
    }
    out
}

/// Splits a CSS `font-family` list (`"Inter, 'Noto Sans', sans-serif"`) into names.
pub fn split_family_list(list: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in list.chars() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), c2) if c2 == q => quote = None,
            (None, ',') => {
                let t = cur.trim().to_string();
                if !t.is_empty() {
                    out.push(t);
                }
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    let t = cur.trim().to_string();
    if !t.is_empty() {
        out.push(t);
    }
    out
}

/// Largest decoded font accepted from WOFF / WOFF2 (the WOFF2 decoder enforces the same cap).
const MAX_DECODED_FONT: u64 = 128 * 1024 * 1024;
/// zlib cannot expand data by more than about 1032:1; anything claiming more is malformed.
const MAX_ZLIB_RATIO: u64 = 1032;

/// Validates a WOFF 1 table directory before decoding. The decoder reserves each table's declared `origLength` up
/// front, so a few hundred bytes claiming 4 GB tables would abort the process (and the wasm engine) on allocation.
fn check_woff1(bytes: &[u8]) -> Result<(), FontError> {
    let bad = |why: &str| Err(FontError::Decode(format!("invalid WOFF: {why}")));
    let u16_at = |o: usize| {
        bytes
            .get(o..o + 2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]))
    };
    let u32_at = |o: usize| {
        bytes
            .get(o..o + 4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    };
    let Some(num_tables) = u16_at(12) else {
        return bad("truncated header");
    };
    let mut total: u64 = 0;
    for i in 0..usize::from(num_tables) {
        let entry = 44 + i * 20;
        let (Some(comp), Some(orig)) = (u32_at(entry + 8), u32_at(entry + 12)) else {
            return bad("truncated table directory");
        };
        let (comp, orig) = (u64::from(comp), u64::from(orig));
        if comp < orig && orig > comp.saturating_mul(MAX_ZLIB_RATIO) {
            return bad("implausible compression ratio");
        }
        total += orig;
        if total > MAX_DECODED_FONT {
            return bad("decoded font too large");
        }
    }
    Ok(())
}

/// Decodes WOFF / WOFF2 to SFNT; returns other data unchanged.
pub(crate) fn decode_font_bytes(bytes: Vec<u8>) -> Result<Vec<u8>, FontError> {
    match bytes.get(0..4) {
        Some(b"wOFF") => {
            check_woff1(&bytes)?;
            wuff::decompress_woff1(&bytes).map_err(|e| FontError::Decode(format!("{e:?}")))
        }
        Some(b"wOF2") => {
            wuff::decompress_woff2(&bytes).map_err(|e| FontError::Decode(format!("{e:?}")))
        }
        _ => Ok(bytes),
    }
}

/// Number of faces in SFNT data (1 for a font, n for a collection), `None` when not a font.
fn face_count(data: &[u8]) -> Option<u32> {
    match skrifa::raw::FileRef::new(data).ok()? {
        skrifa::raw::FileRef::Font(_) => Some(1),
        skrifa::raw::FileRef::Collection(c) => Some(c.len()),
    }
}

/// Family names (typographic or legacy) of every face in SFNT data.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn family_names(data: &[u8]) -> Vec<String> {
    use skrifa::MetadataProvider as _;
    let mut out = Vec::new();
    for index in 0..face_count(data).unwrap_or(0) {
        let Ok(font) = FontRef::from_index(data, index) else {
            continue;
        };
        for id in [
            skrifa::string::StringId::TYPOGRAPHIC_FAMILY_NAME,
            skrifa::string::StringId::FAMILY_NAME,
        ] {
            for s in font.localized_strings(id) {
                let s: String = s.chars().collect();
                if !s.trim().is_empty() && !out.contains(&s) {
                    out.push(s);
                }
            }
        }
    }
    out
}

/// Font files below `root`, sorted for deterministic registration.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn font_files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    // Symlinked directories are followed once each, so a link cycle cannot loop forever.
    let mut seen = std::collections::HashSet::new();
    while let Some(dir) = stack.pop() {
        if !seen.insert(std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone())) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .is_some_and(|e| {
                    matches!(e.as_str(), "ttf" | "otf" | "ttc" | "otc" | "woff" | "woff2")
                })
            {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

fn tag_of(s: &str) -> Option<Tag> {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 4 {
        return None;
    }
    let mut padded = [b' '; 4];
    padded[..b.len()].copy_from_slice(b);
    Tag::new_checked(&padded).ok()
}

/// The font database.
pub struct FontDb {
    faces: Vec<Face>,
    families: HashMap<String, Vec<FontId>>,
    family_order: Vec<(String, String)>,
    hashes: HashMap<u64, Vec<FontId>>,
    instances: Vec<Instance>,
    instance_ids: HashMap<(FontId, Vec<(u32, i32)>), InstanceId>,
    scan_cache: HashMap<(char, bool), Option<FontId>>,
    generation: u64,
    /// Fallback chains used by the shaper.
    pub fallback: FallbackConfig,
}

impl fmt::Debug for FontDb {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FontDb")
            .field("faces", &self.faces.len())
            .field("families", &self.family_order.len())
            .field("instances", &self.instances.len())
            .finish()
    }
}

impl Default for FontDb {
    fn default() -> Self {
        Self::new()
    }
}

impl FontDb {
    /// Empty database with the default fallback chains.
    pub fn new() -> Self {
        FontDb {
            faces: Vec::new(),
            families: HashMap::new(),
            family_order: Vec::new(),
            hashes: HashMap::new(),
            instances: Vec::new(),
            instance_ids: HashMap::new(),
            scan_cache: HashMap::new(),
            generation: 0,
            fallback: FallbackConfig::default(),
        }
    }

    /// Changes whenever faces are added; layout caches key on it.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Registers every face in `bytes` (TTF, OTF, TTC, OTC, WOFF, WOFF2). Registering the same bytes again returns
    /// the existing ids.
    pub fn add_font(&mut self, bytes: Vec<u8>) -> Result<Vec<FontId>, FontError> {
        let data = decode_font_bytes(bytes)?;
        self.add_blob(Blob::from(data), None)
    }

    /// Registers `bytes` under `family` (overriding the family name inside the file). Used for design font assets
    /// whose `AssetRef.family` names them.
    pub fn add_font_as(&mut self, bytes: Vec<u8>, family: &str) -> Result<Vec<FontId>, FontError> {
        let data = decode_font_bytes(bytes)?;
        self.add_blob(Blob::from(data), Some(family))
    }

    /// Registers static SFNT bytes without copying (bundled fonts).
    pub fn add_static_font(&mut self, bytes: &'static [u8]) -> Result<Vec<FontId>, FontError> {
        if matches!(bytes.get(0..4), Some(b"wOFF" | b"wOF2")) {
            return self.add_font(bytes.to_vec());
        }
        self.add_blob(Blob::from(bytes), None)
    }

    /// Registers every font file below `dir` (native only). Returns the number of faces added.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn load_dir(&mut self, dir: impl AsRef<std::path::Path>) -> usize {
        let mut n = 0;
        for path in font_files(dir.as_ref()) {
            if let Ok(bytes) = std::fs::read(&path)
                && let Ok(ids) = self.add_font(bytes)
            {
                n += ids.len();
            }
        }
        n
    }

    fn add_blob(&mut self, blob: Blob, family: Option<&str>) -> Result<Vec<FontId>, FontError> {
        let data: &[u8] = &blob;
        let count = face_count(data).ok_or(FontError::Unsupported)?;
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        data.hash(&mut hasher);
        family.map(normalize_family).hash(&mut hasher);
        let hash = hasher.finish();
        if let Some(existing) = self.hashes.get(&hash) {
            return Ok(existing.clone());
        }
        let mut ids = Vec::new();
        for index in 0..count {
            let Some(font) = RfFont::new(blob.clone(), index) else {
                continue;
            };
            let id = FontId(self.faces.len() as u32);
            let Some(info) = parse_face(&blob, index, id, family, &font) else {
                continue;
            };
            let mut names = vec![info.family.clone()];
            names.extend(info.aliases.iter().cloned());
            for name in names {
                let key = normalize_family(&name);
                if key.is_empty() {
                    continue;
                }
                let list = self.families.entry(key.clone()).or_default();
                if list.is_empty() {
                    self.family_order.push((key, name));
                }
                list.push(id);
            }
            self.faces.push(Face {
                info,
                blob: blob.clone(),
                font,
            });
            ids.push(id);
        }
        if ids.is_empty() {
            return Err(FontError::NoFaces);
        }
        self.hashes.insert(hash, ids.clone());
        self.scan_cache.clear();
        self.generation += 1;
        Ok(ids)
    }

    /// Number of faces.
    pub fn len(&self) -> usize {
        self.faces.len()
    }

    /// True when no face is registered.
    pub fn is_empty(&self) -> bool {
        self.faces.is_empty()
    }

    /// All faces in registration order.
    pub fn faces(&self) -> impl Iterator<Item = &FaceInfo> {
        self.faces.iter().map(|f| &f.info)
    }

    /// One face.
    pub fn face(&self, id: FontId) -> Option<&FaceInfo> {
        self.faces.get(id.0 as usize).map(|f| &f.info)
    }

    /// The SFNT bytes and collection index of a face (for embedding in PDF / SVG exports).
    pub fn font_data(&self, id: FontId) -> Option<(&[u8], u32)> {
        self.faces
            .get(id.0 as usize)
            .map(|f| (&f.blob[..], f.info.collection_index))
    }

    /// Families in registration order (by their primary display name).
    pub fn families(&self) -> Vec<FamilyInfo> {
        self.family_order
            .iter()
            .filter_map(|(key, name)| {
                let faces = self.families.get(key)?;
                // List only names that are some face's primary family.
                faces
                    .iter()
                    .any(|id| normalize_family(&self.faces[id.0 as usize].info.family) == *key)
                    .then(|| FamilyInfo {
                        name: name.clone(),
                        faces: faces.clone(),
                    })
            })
            .collect()
    }

    /// Faces registered under a family name (exact, case-insensitive; generic names are not expanded).
    pub fn family_faces(&self, family: &str) -> &[FontId] {
        self.families
            .get(&normalize_family(family))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// True when the family (or the generic family's expansion) has at least one face.
    pub fn has_family(&self, family: &str) -> bool {
        !self.resolve_family_faces(family).is_empty()
    }

    /// Faces for a family name, expanding CSS generic families through the fallback config.
    pub(crate) fn resolve_family_faces(&self, family: &str) -> Vec<FontId> {
        let key = normalize_family(family);
        if let Some(list) = self.families.get(&key) {
            return list.clone();
        }
        if let Some(generic) = self.fallback.generic_families.get(&key) {
            for name in generic {
                if let Some(list) = self.families.get(&normalize_family(name)) {
                    return list.clone();
                }
            }
        }
        Vec::new()
    }

    /// CSS font matching inside one family (generic names expand). `None` when the family has no faces.
    pub fn match_family(&self, family: &str, req: &MatchRequest) -> Option<FaceMatch> {
        let ids = self.resolve_family_faces(family);
        let faces: Vec<&FaceInfo> = ids.iter().filter_map(|id| self.face(*id)).collect();
        match_faces(&faces, req)
    }

    /// CSS font matching among the faces of a family that cover `cluster`. Web fonts are often split into
    /// `unicode-range` subsets (Google Fonts serves one file per script), each registered as a face of the same
    /// family; like a browser, a character missing from the matched face is looked up in the family's other faces
    /// before falling back to other families.
    pub fn match_family_covering(
        &self,
        family: &str,
        req: &MatchRequest,
        cluster: &str,
    ) -> Option<FaceMatch> {
        let ids = self.resolve_family_faces(family);
        let faces: Vec<&FaceInfo> = ids
            .iter()
            .filter(|id| self.covers_cluster(**id, cluster))
            .filter_map(|id| self.face(*id))
            .collect();
        match_faces(&faces, req)
    }

    /// Variation settings to render a match at: weight / width / italic / slant / optical size, then explicit
    /// `overrides` (axis tag -> value) win. Axes the face lacks are dropped.
    pub fn variations_for(
        &self,
        m: &FaceMatch,
        size: f32,
        overrides: &[(String, f32)],
    ) -> Vec<(String, f32)> {
        let Some(face) = self.face(m.face) else {
            return Vec::new();
        };
        let mut out: Vec<(String, f32)> = Vec::new();
        let has = |t: &str| face.axes.iter().any(|a| a.tag == t);
        if has("wght") {
            out.push(("wght".into(), m.weight));
        }
        if has("wdth") {
            out.push(("wdth".into(), m.stretch));
        }
        if m.use_ital_axis && has("ital") {
            out.push(("ital".into(), 1.0));
        }
        if let Some(s) = m.slnt
            && has("slnt")
        {
            out.push(("slnt".into(), s));
        }
        if let Some((lo, hi)) = face.opsz_range
            && size.is_finite()
        {
            out.push(("opsz".into(), size.clamp(lo, hi)));
        }
        for (tag, value) in overrides {
            if !value.is_finite() {
                continue;
            }
            if let Some(axis) = face.axes.iter().find(|a| a.tag == *tag) {
                let v = value.clamp(axis.min, axis.max);
                match out.iter_mut().find(|(t, _)| t == tag) {
                    Some(slot) => slot.1 = v,
                    None => out.push((tag.clone(), v)),
                }
            }
        }
        out
    }

    /// Interns the instance of `face` at `variations` (user-space axis values).
    pub fn instance(&mut self, face: FontId, variations: &[(String, f32)]) -> InstanceId {
        let mut key: Vec<(u32, i32)> = variations
            .iter()
            .filter_map(|(t, v)| {
                let tag = tag_of(t)?;
                Some((
                    u32::from_be_bytes(tag.into_bytes()),
                    (v * 100.0).round() as i32,
                ))
            })
            .collect();
        key.sort_unstable();
        key.dedup_by_key(|(t, _)| *t);
        if let Some(id) = self.instance_ids.get(&(face, key.clone())) {
            return *id;
        }
        let base = &self.faces[face.0 as usize];
        let settings: Vec<(Tag, f32)> = key
            .iter()
            .map(|(t, v)| (Tag::from_u32(*t), *v as f32 / 100.0))
            .collect();
        let font = if settings.is_empty() {
            base.font.clone()
        } else {
            base.font
                .instance_builder()
                .variations(settings.iter())
                .build()
        };
        let coords = font.normalized_coords().to_vec();
        let metrics = instance_metrics(&font, &base.info);
        let id = InstanceId(self.instances.len() as u32);
        self.instances.push(Instance {
            face,
            variations: settings.iter().map(|(t, v)| (t.to_string(), *v)).collect(),
            font,
            coords,
            metrics,
        });
        self.instance_ids.insert((face, key), id);
        id
    }

    /// An interned instance.
    pub fn instance_info(&self, id: InstanceId) -> Option<&Instance> {
        self.instances.get(id.0 as usize)
    }

    pub(crate) fn inst(&self, id: InstanceId) -> &Instance {
        &self.instances[id.0 as usize]
    }

    /// Nominal glyph for a character in a face.
    pub fn glyph_index(&self, face: FontId, c: char) -> Option<u32> {
        let f = self.faces.get(face.0 as usize)?;
        f.font
            .charmap()
            .map_unicode(c)
            .map(|g| g.to_u32())
            .filter(|g| *g != 0)
    }

    /// True when the face maps the character.
    pub fn covers(&self, face: FontId, c: char) -> bool {
        self.glyph_index(face, c).is_some()
    }

    /// True when the face covers every non-ignorable character of a cluster.
    pub fn covers_cluster(&self, face: FontId, cluster: &str) -> bool {
        let Some(f) = self.faces.get(face.0 as usize) else {
            return false;
        };
        let cmap = f.font.charmap();
        cluster
            .chars()
            .filter(|c| !super::fallback::is_ignorable(*c))
            .all(|c| cmap.map_unicode(c).is_some_and(|g| g.to_u32() != 0))
    }

    /// Last-resort fallback: the first face (emoji faces first for emoji clusters) covering `cluster`.
    pub(crate) fn scan_cover(&mut self, cluster: &str, emoji: bool) -> Option<FontId> {
        let key_char = cluster
            .chars()
            .find(|c| !super::fallback::is_ignorable(*c))?;
        let single = cluster
            .chars()
            .filter(|c| !super::fallback::is_ignorable(*c))
            .count()
            == 1;
        if single && let Some(hit) = self.scan_cache.get(&(key_char, emoji)) {
            return *hit;
        }
        let ordered = self
            .faces
            .iter()
            .map(|f| &f.info)
            .filter(|f| f.is_emoji() == emoji);
        let others = self
            .faces
            .iter()
            .map(|f| &f.info)
            .filter(|f| f.is_emoji() != emoji);
        let found = ordered
            .chain(others)
            .find(|f| self.covers_cluster(f.id, cluster))
            .map(|f| f.id);
        if single {
            self.scan_cache.insert((key_char, emoji), found);
        }
        found
    }

    /// Glyph advance in font units at an instance.
    pub fn advance(&self, instance: InstanceId, glyph: u32) -> f32 {
        self.inst(instance)
            .font
            .glyph_metrics()
            .h_advance(skrifa::GlyphId::new(glyph))
    }

    /// Glyph bounding box in font units (x_min, y_min, x_max, y_max; y up).
    pub fn glyph_bounds(&self, instance: InstanceId, glyph: u32) -> Option<(f32, f32, f32, f32)> {
        let e = self
            .inst(instance)
            .font
            .glyph_metrics()
            .extents(skrifa::GlyphId::new(glyph))?;
        Some((
            e.x_bearing,
            e.y_bearing + e.height,
            e.x_bearing + e.width,
            e.y_bearing,
        ))
    }

    /// skrifa view of a face (outlines, color glyphs, bitmaps).
    pub(crate) fn font_ref(&self, face: FontId) -> Option<FontRef<'_>> {
        let f = self.faces.get(face.0 as usize)?;
        FontRef::from_index(&f.blob, f.info.collection_index).ok()
    }
}

fn instance_metrics(font: &RfFont, info: &FaceInfo) -> InstanceMetrics {
    let m = font.metrics();
    let upem = f64::from(m.units_per_em.max(1));
    let (ascent, descent, line_gap) = match m.h_line() {
        Some(line) => (
            f64::from(line.ascender.to_f32()),
            -f64::from(line.descender.to_f32()),
            f64::from(line.line_gap.to_f32()).max(0.0),
        ),
        None => (
            f64::from(info.ascent),
            f64::from(info.descent),
            f64::from(info.line_gap),
        ),
    };
    let style = font.style_metrics();
    let x_height = m
        .x_height
        .map(|v| f64::from(v.to_f32()))
        .filter(|v| *v > 0.0)
        .unwrap_or(upem * 0.5);
    let cap_height = m
        .cap_height
        .map(|v| f64::from(v.to_f32()))
        .filter(|v| *v > 0.0)
        .unwrap_or(upem * 0.7);
    let (underline_position, underline_thickness) = match style.underline {
        Some(d) if d.thickness.to_f32() > 0.0 => (
            f64::from(d.position.to_f32()),
            f64::from(d.thickness.to_f32()),
        ),
        _ => (-upem * 0.1, upem * 0.05),
    };
    let (strikeout_position, strikeout_thickness) = match style.strikethrough {
        Some(d) if d.thickness.to_f32() > 0.0 && d.position.to_f32() > 0.0 => (
            f64::from(d.position.to_f32()),
            f64::from(d.thickness.to_f32()),
        ),
        _ => (
            x_height * 0.5 + underline_thickness * 0.5,
            underline_thickness,
        ),
    };
    InstanceMetrics {
        units_per_em: upem,
        ascent: if ascent > 0.0 { ascent } else { upem * 0.8 },
        descent: descent.max(0.0),
        line_gap,
        underline_position,
        underline_thickness,
        strikeout_position,
        strikeout_thickness,
        x_height,
        cap_height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_list_parsing() {
        assert_eq!(
            split_family_list("Inter, 'Noto Sans' , \"A, B\", sans-serif"),
            vec!["Inter", "Noto Sans", "A, B", "sans-serif"]
        );
        assert_eq!(normalize_family("  'Noto   Sans  SC' "), "noto sans sc");
    }

    #[test]
    fn rejects_garbage() {
        let mut db = FontDb::new();
        assert_eq!(
            db.add_font(vec![1, 2, 3, 4, 5]),
            Err(FontError::Unsupported)
        );
        assert!(matches!(
            db.add_font(b"wOF2garbage".to_vec()),
            Err(FontError::Decode(_))
        ));
    }

    /// A WOFF whose table claims a 4 GB decompressed size is rejected before the decoder reserves memory for it.
    #[test]
    fn rejects_woff_tables_with_absurd_sizes() {
        let mut woff = Vec::new();
        woff.extend_from_slice(b"wOFF");
        woff.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // flavor
        woff.extend_from_slice(&76u32.to_be_bytes()); // length
        woff.extend_from_slice(&1u16.to_be_bytes()); // numTables
        woff.extend_from_slice(&0u16.to_be_bytes()); // reserved
        woff.extend_from_slice(&0xFFFF_FFF0u32.to_be_bytes()); // totalSfntSize
        woff.resize(44, 0);
        woff.extend_from_slice(b"head");
        woff.extend_from_slice(&64u32.to_be_bytes()); // offset
        woff.extend_from_slice(&12u32.to_be_bytes()); // compLength
        woff.extend_from_slice(&0xFFFF_FFF0u32.to_be_bytes()); // origLength
        woff.extend_from_slice(&0u32.to_be_bytes()); // origChecksum
        woff.resize(76, 0);
        let err = db_add(woff);
        assert!(
            matches!(&err, Err(FontError::Decode(m)) if m.contains("compression ratio")),
            "{err:?}"
        );
        assert!(matches!(
            check_woff1(b"wOFF\0\0\0\0"),
            Err(FontError::Decode(_))
        ));
    }

    fn db_add(bytes: Vec<u8>) -> Result<Vec<FontId>, FontError> {
        FontDb::new().add_font(bytes)
    }
}
