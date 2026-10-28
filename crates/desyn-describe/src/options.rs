//! Request options and the optional brand kit.

use desyn_core::{Color, Id};
use serde::{Deserialize, Serialize};

/// How much detail `describe` puts into the tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Detail {
    /// Compact: text longer than [`SUMMARY_TEXT_CHARS`] is shortened, default depth 4.
    Summary,
    /// Everything: full text, design tokens, default depth 8.
    #[default]
    Full,
}

/// Characters of text kept per node in summary detail.
pub const SUMMARY_TEXT_CHARS: usize = 160;

/// Options of [`crate::describe`]. Deserializes from the worker / wasm JSON request (`camelCase`; the contract
/// names `pageId`, `selection`, `maxDepth`, `includeStyles` plus the extensions below).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DescribeOptions {
    /// Page to describe. Default: the page of the first selected node, else the first page.
    #[serde(alias = "page", skip_serializing_if = "Option::is_none")]
    pub page_id: Option<Id>,
    /// Selected node ids (echoed; selected nodes get the `"selected"` flag).
    pub selection: Vec<Id>,
    /// Tree depth below the page (1 = only top-level nodes). Default 8 (`full`) / 4 (`summary`).
    #[serde(alias = "depth", skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<usize>,
    /// Keep hidden nodes (`visible: false`, or under a hidden ancestor) in the tree. Default `true`
    /// (they are always excluded from lints, palette and hierarchy).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_hidden: Option<bool>,
    /// Add design tokens (`Description.tokens`). Default: `true` for `detail: "full"`, `false` for `"summary"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_styles: Option<bool>,
    /// Tree detail.
    pub detail: Detail,
    /// Maximum number of nodes in the tree (pre-order, back-to-front); the rest is counted in `omitted`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_nodes: Option<usize>,
    /// Run lints (default `true`; `false` leaves `issues` empty, flags only structural).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lint: Option<bool>,
    /// Brand kit to check colors and fonts against.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand: Option<BrandKit>,
}

impl DescribeOptions {
    /// Effective tree depth.
    pub fn depth(&self) -> usize {
        self.max_depth
            .unwrap_or(match self.detail {
                Detail::Summary => 4,
                Detail::Full => 8,
            })
            .max(1)
    }

    /// Effective `includeHidden`.
    pub fn include_hidden(&self) -> bool {
        self.include_hidden.unwrap_or(true)
    }

    /// Effective `includeStyles`.
    pub fn include_styles(&self) -> bool {
        self.include_styles.unwrap_or(self.detail == Detail::Full)
    }

    /// Effective `lint`.
    pub fn lint(&self) -> bool {
        self.lint.unwrap_or(true)
    }
}

/// Brand kit as the AI and the Convex `brandKits` table describe it (only the fields the checks need; unknown keys
/// are ignored).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BrandKit {
    /// Kit name.
    pub name: String,
    /// Brand colors.
    pub colors: Vec<BrandColor>,
    /// Brand fonts.
    pub fonts: Vec<BrandFont>,
}

/// A brand color.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandColor {
    /// Value.
    pub value: Color,
    /// Display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `primary | secondary | accent | background | surface | text | neutral`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// A brand font.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandFont {
    /// Family name.
    pub family: String,
    /// `heading | body | accent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Preferred weight.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
}
