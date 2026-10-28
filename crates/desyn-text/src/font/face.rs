//! Parsing of one font face: names, CSS attributes, variation axes, named instances and metrics.

use skrifa::attribute::Style;
use skrifa::raw::TableProvider;
use skrifa::string::StringId;
use skrifa::{FontRef, MetadataProvider, Tag};

/// Handle of a registered face (index into the [`FontDb`](super::FontDb)).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize)]
#[serde(transparent)]
pub struct FontId(pub u32);

/// Static style of a face (for variable fonts: the default instance).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FaceStyle {
    /// Upright.
    Normal,
    /// Italic (cursive forms).
    Italic,
    /// Slanted, with the angle in degrees when the font states one (positive = leaning right).
    Oblique(f32),
}

/// A variation axis of a variable font.
#[derive(Debug, Clone, PartialEq)]
pub struct AxisInfo {
    /// Four-letter tag, e.g. `"wght"`.
    pub tag: String,
    /// Display name from the `name` table.
    pub name: Option<String>,
    /// Minimum user-space value.
    pub min: f32,
    /// Default user-space value.
    pub default: f32,
    /// Maximum user-space value.
    pub max: f32,
    /// The font asks UIs not to expose this axis.
    pub hidden: bool,
}

/// A named instance ("Bold Condensed") of a variable font.
#[derive(Debug, Clone, PartialEq)]
pub struct NamedInstanceInfo {
    /// Subfamily name, e.g. `"SemiBold Italic"`.
    pub name: String,
    /// PostScript name when the font gives one.
    pub postscript_name: Option<String>,
    /// User-space coordinates per axis tag.
    pub coords: Vec<(String, f32)>,
}

/// Color glyph technologies present in a face.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ColorSupport {
    /// `COLR` table (v0 layers or v1 paint graphs).
    pub colr: bool,
    /// `CBDT` color bitmaps.
    pub cbdt: bool,
    /// `sbix` bitmaps (Apple).
    pub sbix: bool,
    /// `SVG ` table (not rendered by the engine; outlines are used instead).
    pub svg: bool,
}

impl ColorSupport {
    /// True when any color technology is present.
    pub fn any(&self) -> bool {
        self.colr || self.cbdt || self.sbix || self.svg
    }
}

/// Everything the engine knows about one face.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceInfo {
    /// Handle.
    pub id: FontId,
    /// Family used for matching (typographic family, or the override given at registration).
    pub family: String,
    /// Other family names this face answers to (legacy / WWS / localized names), without `family`.
    pub aliases: Vec<String>,
    /// Subfamily ("Regular", "Bold Italic").
    pub subfamily: String,
    /// Full name.
    pub full_name: String,
    /// PostScript name.
    pub postscript_name: Option<String>,
    /// Weight of the default instance (1..1000).
    pub weight: f32,
    /// Weight range the face covers (`wght` axis), `(weight, weight)` for static faces.
    pub weight_range: (f32, f32),
    /// Width of the default instance in percent (100 = normal).
    pub stretch: f32,
    /// Width range in percent (`wdth` axis).
    pub stretch_range: (f32, f32),
    /// Style of the default instance.
    pub style: FaceStyle,
    /// `ital` axis range when present.
    pub ital_range: Option<(f32, f32)>,
    /// `slnt` axis range when present (degrees, negative = leaning right).
    pub slnt_range: Option<(f32, f32)>,
    /// `opsz` axis range when present.
    pub opsz_range: Option<(f32, f32)>,
    /// Variation axes (empty for static fonts).
    pub axes: Vec<AxisInfo>,
    /// Named instances.
    pub named_instances: Vec<NamedInstanceInfo>,
    /// Design units per em.
    pub units_per_em: u16,
    /// Ascender in font units (positive, above the baseline), default instance.
    pub ascent: f32,
    /// Descender in font units (positive, below the baseline).
    pub descent: f32,
    /// Line gap in font units.
    pub line_gap: f32,
    /// x-height in font units.
    pub x_height: Option<f32>,
    /// Cap height in font units.
    pub cap_height: Option<f32>,
    /// Fixed pitch.
    pub monospace: bool,
    /// Color technologies.
    pub color: ColorSupport,
    /// Number of glyphs.
    pub glyph_count: u32,
    /// Index inside a collection file (`.ttc`), 0 otherwise.
    pub collection_index: u32,
}

impl FaceInfo {
    /// True when the face is meant for emoji (color tables, or "emoji" in its family name).
    pub fn is_emoji(&self) -> bool {
        self.color.any() || self.family.to_ascii_lowercase().contains("emoji")
    }

    /// True when the face can render upright text (static normal face or a style axis reaching 0).
    pub fn can_be_normal(&self) -> bool {
        matches!(self.style, FaceStyle::Normal)
            || self.ital_range.is_some_and(|(lo, _)| lo <= 0.0)
            || self
                .slnt_range
                .is_some_and(|(lo, hi)| lo <= 0.0 && hi >= 0.0)
    }

    /// True when the face can render italic text without synthesis.
    pub fn can_be_italic(&self) -> bool {
        matches!(self.style, FaceStyle::Italic) || self.ital_range.is_some_and(|(_, hi)| hi >= 1.0)
    }

    /// True when the face can render oblique text without synthesis.
    pub fn can_be_oblique(&self) -> bool {
        matches!(self.style, FaceStyle::Oblique(_))
            || self.slnt_range.is_some_and(|(lo, hi)| lo < 0.0 || hi > 0.0)
    }
}

fn string(font: &FontRef<'_>, id: StringId) -> Option<String> {
    font.localized_strings(id)
        .english_or_first()
        .map(|s| s.chars().collect::<String>())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn all_strings(font: &FontRef<'_>, id: StringId, out: &mut Vec<String>) {
    for s in font.localized_strings(id) {
        let s: String = s.chars().collect();
        let s = s.trim().to_string();
        if !s.is_empty() && !out.iter().any(|o| o.eq_ignore_ascii_case(&s)) {
            out.push(s);
        }
    }
}

fn has_table(font: &FontRef<'_>, tag: &[u8; 4]) -> bool {
    font.table_data(Tag::new(tag)).is_some()
}

/// Parses face `index` of `data` (an SFNT font or collection).
pub(crate) fn parse_face(
    data: &[u8],
    index: u32,
    id: FontId,
    family_override: Option<&str>,
    rf: &skrifa::raw::model::Font,
) -> Option<FaceInfo> {
    let font = FontRef::from_index(data, index).ok()?;
    // A font without cmap / head cannot be used for text.
    font.head().ok()?;
    let typographic = string(&font, StringId::TYPOGRAPHIC_FAMILY_NAME);
    let legacy = string(&font, StringId::FAMILY_NAME);
    let parsed_family = typographic.clone().or_else(|| legacy.clone())?;
    let family = family_override
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| parsed_family.clone());

    let mut names = Vec::new();
    all_strings(&font, StringId::TYPOGRAPHIC_FAMILY_NAME, &mut names);
    all_strings(&font, StringId::FAMILY_NAME, &mut names);
    all_strings(&font, StringId::WWS_FAMILY_NAME, &mut names);
    if !names.iter().any(|n| n.eq_ignore_ascii_case(&parsed_family)) {
        names.push(parsed_family);
    }
    names.retain(|n| !n.eq_ignore_ascii_case(&family));

    let subfamily = string(&font, StringId::TYPOGRAPHIC_SUBFAMILY_NAME)
        .or_else(|| string(&font, StringId::SUBFAMILY_NAME))
        .unwrap_or_else(|| "Regular".into());
    let full_name =
        string(&font, StringId::FULL_NAME).unwrap_or_else(|| format!("{family} {subfamily}"));
    let postscript_name = string(&font, StringId::POSTSCRIPT_NAME);

    let attrs = font.attributes();
    let mut axes = Vec::new();
    let (mut weight_range, mut stretch_range) = (None, None);
    let (mut ital_range, mut slnt_range, mut opsz_range) = (None, None, None);
    for axis in font.axes().iter() {
        let tag = axis.tag();
        let range = (axis.min_value(), axis.max_value());
        match &tag.into_bytes() {
            b"wght" => weight_range = Some(range),
            b"wdth" => stretch_range = Some(range),
            b"ital" => ital_range = Some(range),
            b"slnt" => slnt_range = Some(range),
            b"opsz" => opsz_range = Some(range),
            _ => {}
        }
        axes.push(AxisInfo {
            tag: tag.to_string(),
            name: string(&font, axis.name_id()),
            min: axis.min_value(),
            default: axis.default_value(),
            max: axis.max_value(),
            hidden: axis.is_hidden(),
        });
    }
    let axis_tags: Vec<String> = axes.iter().map(|a| a.tag.clone()).collect();
    let named_instances = font
        .named_instances()
        .iter()
        .map(|inst| NamedInstanceInfo {
            name: string(&font, inst.subfamily_name_id()).unwrap_or_default(),
            postscript_name: inst.postscript_name_id().and_then(|id| string(&font, id)),
            coords: axis_tags.iter().cloned().zip(inst.user_coords()).collect(),
        })
        .collect();

    let weight = attrs.weight.value();
    let stretch = attrs.stretch.percentage();
    let style = match attrs.style {
        Style::Normal => FaceStyle::Normal,
        Style::Italic => FaceStyle::Italic,
        Style::Oblique(angle) => FaceStyle::Oblique(angle.unwrap_or(14.0)),
    };

    let m = rf.metrics();
    let upem = f32::from(m.units_per_em.max(1));
    let (ascent, descent, line_gap) = match m.h_line() {
        Some(line) => (
            line.ascender.to_f32(),
            -line.descender.to_f32(),
            line.line_gap.to_f32().max(0.0),
        ),
        None => (upem * 0.8, upem * 0.2, 0.0),
    };
    let x_height = m.x_height.map(|v| v.to_f32());
    let cap_height = m.cap_height.map(|v| v.to_f32());
    let monospace = font
        .post()
        .map(|p| p.is_fixed_pitch() != 0)
        .unwrap_or(false);
    let color = ColorSupport {
        colr: has_table(&font, b"COLR"),
        cbdt: has_table(&font, b"CBDT"),
        sbix: has_table(&font, b"sbix"),
        svg: has_table(&font, b"SVG "),
    };
    let units_per_em = font.head().map(|h| h.units_per_em()).unwrap_or(1000);
    let glyph_count = font.maxp().map(|m| u32::from(m.num_glyphs())).unwrap_or(0);

    Some(FaceInfo {
        id,
        family,
        aliases: names,
        subfamily,
        full_name,
        postscript_name,
        weight,
        weight_range: weight_range.unwrap_or((weight, weight)),
        stretch,
        stretch_range: stretch_range.unwrap_or((stretch, stretch)),
        style,
        ital_range,
        slnt_range,
        opsz_range,
        axes,
        named_instances,
        units_per_em,
        ascent,
        descent,
        line_gap,
        x_height,
        cap_height,
        monospace,
        color,
        glyph_count,
        collection_index: index,
    })
}
