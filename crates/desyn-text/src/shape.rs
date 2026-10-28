//! Shaping with harfrust plus a bounded shape cache keyed by text, context, font instance and settings.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

use harfrust::{
    Buffer, BufferFlags, Direction, Feature, Language, ShapeOptions, ShapePlan, ShaperFont,
};
use skrifa::Tag;

use crate::font::{FontDb, InstanceId};

/// One shaped glyph in font units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ShapedGlyph {
    pub id: u32,
    /// Byte offset of the cluster in the shaped text.
    pub cluster: u32,
    pub advance: f32,
    pub dx: f32,
    pub dy: f32,
    pub unsafe_to_break: bool,
}

/// Glyphs of one shaped segment in visual order.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Shaped {
    pub glyphs: Vec<ShapedGlyph>,
}

/// User features as (tag, value) for the whole segment.
pub(crate) type FeatureList = Vec<(u32, u32)>;

/// Parses CSS-like feature strings (`"liga"`, `"-liga"`, `"+kern"`, `"ss01=2"`, `"tnum 1"`); invalid entries are
/// skipped.
pub(crate) fn parse_features(features: &[String], no_optional_ligatures: bool) -> FeatureList {
    let mut out: FeatureList = Vec::new();
    let mut set = |tag: Tag, value: u32| {
        let t = u32::from_be_bytes(tag.into_bytes());
        match out.iter_mut().find(|(k, _)| *k == t) {
            Some(slot) => slot.1 = value,
            None => out.push((t, value)),
        }
    };
    if no_optional_ligatures {
        for t in [b"liga", b"clig", b"dlig", b"hlig"] {
            set(Tag::new(t), 0);
        }
    }
    for f in features {
        let s = f.trim().replace(' ', "=");
        if let Ok(feat) = Feature::from_str(&s) {
            set(feat.tag, feat.value);
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    text: Box<str>,
    pre: Box<str>,
    post: Box<str>,
    instance: InstanceId,
    rtl: bool,
    script: [u8; 4],
    language: Option<Box<str>>,
    features: FeatureList,
    flags: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PlanKey {
    instance: InstanceId,
    rtl: bool,
    script: [u8; 4],
    language: Option<Box<str>>,
    features: FeatureList,
}

/// What to shape.
pub(crate) struct ShapeRequest<'a> {
    pub text: &'a str,
    pub pre_context: &'a str,
    pub post_context: &'a str,
    pub instance: InstanceId,
    pub rtl: bool,
    pub script: unicode_script::Script,
    pub language: Option<&'a str>,
    pub features: &'a FeatureList,
    pub start_of_paragraph: bool,
    pub end_of_paragraph: bool,
}

/// Shaper with caches. Entries are dropped wholesale when the cache exceeds its capacity (layouts reshape what
/// they need; this keeps memory bounded without bookkeeping on the hot path).
pub(crate) struct Shaper {
    cache: HashMap<Key, Arc<Shaped>>,
    plans: HashMap<PlanKey, ShapePlan>,
    buffer: Option<Buffer>,
    capacity: usize,
    pub hits: u64,
    pub misses: u64,
}

impl Default for Shaper {
    fn default() -> Self {
        Shaper {
            cache: HashMap::new(),
            plans: HashMap::new(),
            buffer: Some(Buffer::new()),
            capacity: 8192,
            hits: 0,
            misses: 0,
        }
    }
}

fn script_tag(script: unicode_script::Script) -> [u8; 4] {
    let name = script.short_name().as_bytes();
    let mut tag = *b"Zyyy";
    if name.len() == 4 {
        tag.copy_from_slice(name);
    }
    tag
}

impl Shaper {
    pub fn clear(&mut self) {
        self.cache.clear();
        self.plans.clear();
    }

    pub fn len(&self) -> usize {
        self.cache.len()
    }

    pub fn shape(&mut self, db: &FontDb, req: &ShapeRequest<'_>) -> Arc<Shaped> {
        let script = script_tag(req.script);
        let flags = u8::from(req.start_of_paragraph) | (u8::from(req.end_of_paragraph) << 1);
        let key = Key {
            text: req.text.into(),
            pre: req.pre_context.into(),
            post: req.post_context.into(),
            instance: req.instance,
            rtl: req.rtl,
            script,
            language: req.language.map(Into::into),
            features: req.features.clone(),
            flags,
        };
        if let Some(hit) = self.cache.get(&key) {
            self.hits += 1;
            return hit.clone();
        }
        self.misses += 1;
        let shaped = Arc::new(self.shape_uncached(db, req, script));
        if self.cache.len() >= self.capacity {
            self.cache.clear();
        }
        self.cache.insert(key, shaped.clone());
        shaped
    }

    fn shape_uncached(&mut self, db: &FontDb, req: &ShapeRequest<'_>, script: [u8; 4]) -> Shaped {
        let font = db.inst(req.instance).font();
        let shaper_font = ShaperFont::new(font);
        let direction = if req.rtl {
            Direction::RightToLeft
        } else {
            Direction::LeftToRight
        };
        let hb_script = harfrust::Script::from_iso15924_tag(Tag::new(&script));
        let language = req.language.and_then(|l| Language::from_str(l).ok());
        let mut buffer = self.buffer.take().unwrap_or_default();
        buffer.clear();
        buffer.push_str(req.text);
        buffer.set_pre_context(req.pre_context);
        buffer.set_post_context(req.post_context);
        buffer.set_direction(direction);
        buffer.set_script(hb_script);
        buffer.set_language(language.clone());
        let mut flags = BufferFlags::default();
        if req.start_of_paragraph {
            flags |= BufferFlags::BEGINNING_OF_TEXT;
        }
        if req.end_of_paragraph {
            flags |= BufferFlags::END_OF_TEXT;
        }
        buffer.set_flags(flags);
        let features: Vec<Feature> = req
            .features
            .iter()
            .map(|(t, v)| Feature::new(Tag::from_u32(*t), *v, ..))
            .collect();
        let plan_key = PlanKey {
            instance: req.instance,
            rtl: req.rtl,
            script,
            language: req.language.map(Into::into),
            features: req.features.clone(),
        };
        if !self.plans.contains_key(&plan_key) {
            if self.plans.len() >= 1024 {
                self.plans.clear();
            }
            let plan = ShapePlan::new(font, direction, hb_script, language.as_ref(), &features);
            self.plans.insert(plan_key.clone(), plan);
        }
        let plan = &self.plans[&plan_key];
        let options = ShapeOptions::new().plan(Some(plan)).features(&features);
        let result = harfrust::shape(&shaper_font, &mut buffer, options);
        let mut glyphs = Vec::with_capacity(buffer.len());
        if result.is_ok() {
            for (info, pos) in buffer.glyph_infos().iter().zip(buffer.glyph_positions()) {
                glyphs.push(ShapedGlyph {
                    id: info.glyph_id,
                    cluster: info.cluster,
                    advance: pos.x_advance as f32,
                    dx: pos.x_offset as f32,
                    dy: pos.y_offset as f32,
                    unsafe_to_break: info.unsafe_to_break(),
                });
            }
        }
        self.buffer = Some(buffer);
        Shaped { glyphs }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_parsing() {
        let f = parse_features(
            &[
                "-liga".into(),
                "ss01".into(),
                "tnum=1".into(),
                "bogus!!".into(),
            ],
            false,
        );
        let tags: Vec<String> = f
            .iter()
            .map(|(t, v)| format!("{}={v}", Tag::from_u32(*t)))
            .collect();
        assert_eq!(tags, vec!["liga=0", "ss01=1", "tnum=1"]);
        let f = parse_features(&["liga".into()], true);
        assert_eq!(f.len(), 4);
        assert_eq!(f[0].1, 1, "explicit feature wins over the tracking default");
    }
}
