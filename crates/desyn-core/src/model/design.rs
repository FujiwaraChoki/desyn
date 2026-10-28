//! `Design`, assets and reusable styles.

use std::collections::BTreeMap;

use indexmap::IndexMap;
use rustc_hash::FxBuildHasher;
use serde::{Deserialize, Serialize};

use super::num::nn;
use serde_json::{Map, Value};

use super::node::{Extra, Node};
use super::paint::Effect;
use super::primitives::{Color, Id, ROOT_ID, string_enum};
use super::text::{ParagraphStylePatch, TextStyle};

/// Flat node map with fast lookups. Iteration order is insertion order (not semantically meaningful;
/// child order lives in `children`). Use [`crate::canonical`] for deterministic output.
pub type NodeMap = IndexMap<Id, Node, FxBuildHasher>;

string_enum!(
    /// Kind of design (drives presets, describe heuristics and templates).
    DesignKind {
        SocialPost = "social-post", Story = "story", Poster = "poster", Flyer = "flyer", Thumbnail = "thumbnail",
        Banner = "banner", Ad = "ad", Presentation = "presentation", Infographic = "infographic",
        BusinessCard = "business-card", Resume = "resume", Invitation = "invitation", Menu = "menu", Logo = "logo",
        Newsletter = "newsletter", Document = "document", Whiteboard = "whiteboard", Website = "website",
        Video = "video", BookCover = "book-cover", Certificate = "certificate", Sticker = "sticker", Mockup = "mockup",
        Custom = "custom",
    }
);

string_enum!(
    /// Asset kind.
    AssetKind { Image = "image", Svg = "svg", Font = "font", Video = "video", Audio = "audio", Lottie = "lottie", Data = "data" }
);
string_enum!(
    /// Where an asset came from.
    AssetSource { Upload = "upload", Ai = "ai", Stock = "stock", Template = "template", Brand = "brand" }
);

/// Stock / third-party attribution.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attribution {
    /// Author name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub author: Option<String>,
    /// License name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub license: Option<String>,
    /// Source url.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub url: Option<String>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// AI generation provenance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProvenance {
    /// Provider id.
    pub provider: String,
    /// Model id.
    pub model: String,
    /// Prompt.
    pub prompt: String,
    /// Seed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub seed: Option<f64>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Asset reference stored in `Design.assets`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(missing_docs)]
pub struct AssetRef {
    pub id: Id,
    pub kind: AssetKind,
    /// Resolvable URL filled by clients at load time (never persisted by Convex).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub url: Option<String>,
    /// S3 object key.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub storage_key: Option<String>,
    pub mime: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub bytes: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub width: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub height: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub duration_ms: Option<f64>,
    /// sha256 hex of the bytes.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub hash: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub source: Option<AssetSource>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub attribution: Option<Attribution>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub ai: Option<AiProvenance>,
    /// Font family (fonts).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub family: Option<String>,
    /// Font weight (fonts).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub weight: Option<f64>,
    /// Font style (fonts).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub style: Option<super::text::FontStyle>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

impl AssetRef {
    /// Minimal asset reference.
    pub fn new(id: impl Into<Id>, kind: AssetKind, mime: impl Into<String>) -> Self {
        AssetRef {
            id: id.into(),
            kind,
            url: None,
            storage_key: None,
            mime: mime.into(),
            bytes: None,
            width: None,
            height: None,
            duration_ms: None,
            hash: None,
            name: None,
            source: None,
            attribution: None,
            ai: None,
            family: None,
            weight: None,
            style: None,
            extra: Default::default(),
        }
    }
}

/// Named color style.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColorStyle {
    /// Name.
    pub name: String,
    /// Value.
    pub value: Color,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Named text style.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextStyleDef {
    /// Name.
    pub name: String,
    /// Character style.
    pub style: TextStyle,
    /// Paragraph overrides.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub paragraph: Option<ParagraphStylePatch>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Named effect stack.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EffectStyle {
    /// Name.
    pub name: String,
    /// Effects.
    pub effects: Vec<Effect>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Design variable value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum VarValue {
    /// Boolean.
    Bool(bool),
    /// Number.
    Number(f64),
    /// String (colors are strings).
    String(String),
}

/// Reusable named styles and variables.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignStyles {
    /// Color styles.
    pub colors: BTreeMap<Id, ColorStyle>,
    /// Text styles.
    pub text: BTreeMap<Id, TextStyleDef>,
    /// Effect styles.
    pub effects: BTreeMap<Id, EffectStyle>,
    /// Variables, referenced as `{"$var": name}`.
    pub variables: BTreeMap<String, VarValue>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// A complete design document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Design {
    /// Schema version (always 1).
    pub schema: u32,
    /// Design id.
    pub id: Id,
    /// Name.
    pub name: String,
    /// Kind.
    pub kind: DesignKind,
    /// Flat node map; `nodes["root"]` is the root.
    pub nodes: NodeMap,
    /// Referenced assets.
    pub assets: BTreeMap<Id, AssetRef>,
    /// Reusable styles.
    pub styles: DesignStyles,
    /// Followed brand kit (informational).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub brand_kit_id: Option<String>,
    /// Free-form metadata.
    pub meta: Map<String, Value>,
    /// Unknown top-level keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

impl Design {
    /// Node by id.
    #[inline]
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    /// Node by id (mutable).
    #[inline]
    pub fn node_mut(&mut self, id: &str) -> Option<&mut Node> {
        self.nodes.get_mut(id)
    }

    /// The root node.
    pub fn root(&self) -> Option<&Node> {
        self.nodes.get(ROOT_ID)
    }

    /// Page ids in order.
    pub fn page_ids(&self) -> &[Id] {
        self.root().map(Node::child_ids).unwrap_or(&[])
    }

    /// Parses a design from JSON.
    pub fn from_json(s: &str) -> Result<Design, serde_json::Error> {
        serde_json::from_str(s)
    }

    /// Serializes to (non-canonical) JSON.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("design serialization is infallible")
    }

    /// Canonical JSON (sorted keys, normalized numbers).
    pub fn canonical_json(&self) -> String {
        crate::canonical::canonical_string(self)
    }

    /// sha256 hex of the canonical JSON.
    pub fn hash(&self) -> String {
        crate::canonical::sha256_hex(self.canonical_json().as_bytes())
    }
}

#[cfg(feature = "std-fs")]
impl Design {
    /// Reads a design from a JSON file (feature `std-fs`).
    pub fn load(path: impl AsRef<std::path::Path>) -> std::io::Result<Design> {
        let text = std::fs::read_to_string(path)?;
        serde_json::from_str(&text)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }

    /// Writes the design as canonical JSON (feature `std-fs`).
    pub fn save(&self, path: impl AsRef<std::path::Path>) -> std::io::Result<()> {
        std::fs::write(path, self.canonical_json())
    }
}

#[cfg(all(test, feature = "std-fs"))]
mod fs_tests {
    use super::*;

    #[test]
    fn save_and_load() {
        let d = Design::with_page(
            "design000001",
            "D",
            DesignKind::Poster,
            "page00000001",
            10.0,
            10.0,
        );
        let dir = std::env::temp_dir().join(format!("desyn-core-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("d.json");
        d.save(&p).unwrap();
        assert_eq!(Design::load(&p).unwrap(), d);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
