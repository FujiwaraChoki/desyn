//! Text styling types.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::node::Extra;
use super::num::nn;

use super::paint::Fill;
use super::primitives::{Color, string_enum};

string_enum!(
    /// Font style.
    FontStyle { Normal = "normal", Italic = "italic" }
);
string_enum!(
    /// Case transform applied at render time.
    TextCase { None = "none", Upper = "upper", Lower = "lower", Title = "title" }
);
string_enum!(
    /// Text decoration.
    TextDecoration { None = "none", Underline = "underline", Strikethrough = "strikethrough" }
);
string_enum!(
    /// Paragraph alignment.
    TextAlign { Left = "left", Center = "center", Right = "right", Justify = "justify" }
);
string_enum!(
    /// Paragraph base direction.
    TextDirection { Ltr = "ltr", Rtl = "rtl", Auto = "auto" }
);
string_enum!(
    /// Line height unit.
    LineHeightUnit { Auto = "auto", Px = "px", Percent = "percent" }
);
string_enum!(
    /// Paragraph list style.
    ListStyle { None = "none", Bullet = "bullet", Number = "number" }
);

/// Character style.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    /// Font family name.
    pub font_family: String,
    /// Weight 1..1000.
    pub font_weight: f64,
    /// Normal / italic.
    pub font_style: FontStyle,
    /// Size in px.
    pub font_size: f64,
    /// Glyph paints.
    pub fills: Vec<Fill>,
    /// Tracking in em.
    pub letter_spacing: f64,
    /// Case transform.
    pub text_case: TextCase,
    /// Decoration.
    pub decoration: TextDecoration,
    /// Hyperlink.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub link: Option<String>,
    /// Highlight (background) color.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub highlight: Option<Color>,
    /// OpenType features, e.g. `"liga"`, `"ss01"`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub features: Option<Vec<String>>,
    /// Variable font axis values, e.g. `{"wght": 550}`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub variations: Option<BTreeMap<String, f64>>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `Partial<TextStyle>` (run overrides, table cells).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(missing_docs)]
pub struct TextStylePatch {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub font_family: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub font_weight: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub font_style: Option<FontStyle>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub font_size: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub fills: Option<Vec<Fill>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub letter_spacing: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub text_case: Option<TextCase>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub decoration: Option<TextDecoration>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub link: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub highlight: Option<Color>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub features: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub variations: Option<BTreeMap<String, f64>>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

impl TextStyle {
    /// Returns this style with the `Some` fields of `patch` applied.
    pub fn merged(&self, patch: &TextStylePatch) -> TextStyle {
        let mut s = self.clone();
        if let Some(v) = &patch.font_family {
            s.font_family = v.clone();
        }
        if let Some(v) = patch.font_weight {
            s.font_weight = v;
        }
        if let Some(v) = patch.font_style {
            s.font_style = v;
        }
        if let Some(v) = patch.font_size {
            s.font_size = v;
        }
        if let Some(v) = &patch.fills {
            s.fills = v.clone();
        }
        if let Some(v) = patch.letter_spacing {
            s.letter_spacing = v;
        }
        if let Some(v) = patch.text_case {
            s.text_case = v;
        }
        if let Some(v) = patch.decoration {
            s.decoration = v;
        }
        if patch.link.is_some() {
            s.link = patch.link.clone();
        }
        if patch.highlight.is_some() {
            s.highlight = patch.highlight.clone();
        }
        if patch.features.is_some() {
            s.features = patch.features.clone();
        }
        if patch.variations.is_some() {
            s.variations = patch.variations.clone();
        }
        s
    }
}

/// Line height.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineHeight {
    /// Unit.
    pub unit: LineHeightUnit,
    /// Value (ignored for `auto`, px for `px`, percent of font size for `percent`).
    pub value: f64,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

impl LineHeight {
    /// Resolves to px for a given font size; `auto` uses `auto_factor` (font ascent+descent+gap ratio).
    pub fn resolve(&self, font_size: f64, auto_factor: f64) -> f64 {
        match self.unit {
            LineHeightUnit::Auto => font_size * auto_factor,
            LineHeightUnit::Px => self.value,
            LineHeightUnit::Percent => font_size * self.value / 100.0,
        }
    }
}

/// Paragraph style.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphStyle {
    /// Alignment.
    pub align: TextAlign,
    /// Base direction.
    pub direction: TextDirection,
    /// Line height.
    pub line_height: LineHeight,
    /// Extra space after each paragraph in px.
    pub spacing: f64,
    /// First-line indent in px.
    pub indent: f64,
    /// List style.
    pub list: ListStyle,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `Partial<ParagraphStyle>`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(missing_docs)]
pub struct ParagraphStylePatch {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub align: Option<TextAlign>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub direction: Option<TextDirection>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub line_height: Option<LineHeight>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub spacing: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub indent: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub list: Option<ListStyle>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

impl ParagraphStyle {
    /// Returns this style with the `Some` fields of `patch` applied.
    pub fn merged(&self, patch: &ParagraphStylePatch) -> ParagraphStyle {
        ParagraphStyle {
            align: patch.align.unwrap_or(self.align),
            direction: patch.direction.unwrap_or(self.direction),
            line_height: patch
                .line_height
                .clone()
                .unwrap_or_else(|| self.line_height.clone()),
            spacing: patch.spacing.unwrap_or(self.spacing),
            indent: patch.indent.unwrap_or(self.indent),
            list: patch.list.unwrap_or(self.list),
            extra: self.extra.clone(),
        }
    }
}

/// A run of text sharing one style override.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRun {
    /// Text; `"\n"` starts a new paragraph.
    pub text: String,
    /// Overrides on top of the node's default style.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub style: Option<TextStylePatch>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

impl TextRun {
    /// Plain run without overrides.
    pub fn plain(text: impl Into<String>) -> Self {
        TextRun {
            text: text.into(),
            style: None,
            extra: Default::default(),
        }
    }
}

/// Concatenated plain text of runs.
pub fn runs_text(runs: &[TextRun]) -> String {
    runs.iter().map(|r| r.text.as_str()).collect()
}
