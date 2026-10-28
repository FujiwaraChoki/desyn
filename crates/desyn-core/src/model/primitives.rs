//! Primitive value types shared by the whole model (`Id`, `Color`, `ColorRef`, `BlendMode`, `Unit`).

use core::fmt;
use core::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Node / asset / style identifier. 12 chars `[a-z0-9]` when generated, `"root"` is reserved for the root node.
pub type Id = String;

/// Id of the root node of every design.
pub const ROOT_ID: &str = "root";

/// Error returned when a string is not a valid [`Color`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColorParseError(pub String);

impl fmt::Display for ColorParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid color {:?}: expected \"#rrggbb\" or \"#rrggbbaa\" (lowercase hex)",
            self.0
        )
    }
}

impl std::error::Error for ColorParseError {}

/// A validated color string: `"#rrggbb"` or `"#rrggbbaa"`, lowercase hex.
///
/// The string form is kept verbatim so documents round-trip byte-for-byte.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Color(String);

impl Color {
    /// Validates and wraps a color string. Uppercase hex, short forms and CSS names are rejected
    /// (use [`crate::color::parse_css_color`] to convert arbitrary CSS colors).
    pub fn new(s: impl Into<String>) -> Result<Self, ColorParseError> {
        let s = s.into();
        if Self::is_valid(&s) {
            Ok(Self(s))
        } else {
            Err(ColorParseError(s))
        }
    }

    /// Returns true when `s` is a valid contract color.
    pub fn is_valid(s: &str) -> bool {
        let b = s.as_bytes();
        (b.len() == 7 || b.len() == 9)
            && b[0] == b'#'
            && b[1..]
                .iter()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
    }

    /// Builds a color from 8-bit channels. Alpha 255 produces the 6-digit form.
    pub fn from_rgba8(r: u8, g: u8, b: u8, a: u8) -> Self {
        if a == 255 {
            Self(format!("#{r:02x}{g:02x}{b:02x}"))
        } else {
            Self(format!("#{r:02x}{g:02x}{b:02x}{a:02x}"))
        }
    }

    /// The color string, e.g. `"#ffb02e"`.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 8-bit channels `[r, g, b, a]`; alpha is 255 for the 6-digit form.
    pub fn rgba8(&self) -> [u8; 4] {
        let h = |i: usize| u8::from_str_radix(&self.0[i..i + 2], 16).unwrap_or(0);
        let a = if self.0.len() == 9 { h(7) } else { 255 };
        [h(1), h(3), h(5), a]
    }

    /// Channels as floats in 0..1 `[r, g, b, a]` (not premultiplied).
    pub fn rgba_f64(&self) -> [f64; 4] {
        let c = self.rgba8();
        [
            c[0] as f64 / 255.0,
            c[1] as f64 / 255.0,
            c[2] as f64 / 255.0,
            c[3] as f64 / 255.0,
        ]
    }
}

impl fmt::Debug for Color {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Color({})", self.0)
    }
}

impl fmt::Display for Color {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for Color {
    type Err = ColorParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::new(s)
    }
}

impl TryFrom<&str> for Color {
    type Error = ColorParseError;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        Self::new(s)
    }
}

impl Serialize for Color {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Color::new(s).map_err(serde::de::Error::custom)
    }
}

/// Reference to a design variable or a named color style, resolved by the engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ColorRef {
    /// `{ "$var": "brand.primary" }` -> `Design.styles.variables["brand.primary"]`.
    Var {
        /// Variable name.
        #[serde(rename = "$var")]
        var: String,
        /// Unknown keys preserved for forward compatibility.
        #[serde(flatten)]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// `{ "$style": "<styleId>" }` -> `Design.styles.colors[styleId].value`.
    Style {
        /// Color style id.
        #[serde(rename = "$style")]
        style: Id,
        /// Unknown keys preserved for forward compatibility.
        #[serde(flatten)]
        extra: serde_json::Map<String, serde_json::Value>,
    },
}

impl ColorRef {
    /// `{"$var": name}`.
    pub fn var(name: impl Into<String>) -> Self {
        ColorRef::Var {
            var: name.into(),
            extra: Default::default(),
        }
    }

    /// `{"$style": id}`.
    pub fn style(id: impl Into<Id>) -> Self {
        ColorRef::Style {
            style: id.into(),
            extra: Default::default(),
        }
    }
}

/// `Color | ColorRef`, accepted where the contract allows references (fills, gradient stops).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ColorValue {
    /// Literal color.
    Color(Color),
    /// Variable / style reference.
    Ref(ColorRef),
}

impl From<Color> for ColorValue {
    fn from(c: Color) -> Self {
        ColorValue::Color(c)
    }
}

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $s:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
        pub enum $name {
            $($(#[$vmeta])* #[doc = concat!("`\"", $s, "\"`")] #[serde(rename = $s)] $variant),+
        }

        impl $name {
            /// All values in declaration order.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// The JSON string of this value.
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $s),+ }
            }
        }

        impl core::str::FromStr for $name {
            type Err = String;
            fn from_str(s: &str) -> Result<Self, String> {
                match s {
                    $($s => Ok($name::$variant),)+
                    other => Err(format!("unknown {} {:?}", stringify!($name), other)),
                }
            }
        }

        impl core::fmt::Display for $name {
            fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}
pub(crate) use string_enum;

string_enum!(
    /// Print / display unit of a page. Geometry is always in design pixels.
    Unit { Px = "px", Mm = "mm", In = "in", Pt = "pt" }
);

impl Unit {
    /// Design pixels per one unit (1 px = 1/96 in).
    pub fn px_per_unit(self) -> f64 {
        match self {
            Unit::Px => 1.0,
            Unit::In => 96.0,
            Unit::Mm => 96.0 / 25.4,
            Unit::Pt => 96.0 / 72.0,
        }
    }
}

string_enum!(
    /// Layer / paint blend modes (W3C Compositing and Blending Level 1).
    BlendMode {
        Normal = "normal",
        Multiply = "multiply",
        Screen = "screen",
        Overlay = "overlay",
        Darken = "darken",
        Lighten = "lighten",
        ColorDodge = "color-dodge",
        ColorBurn = "color-burn",
        HardLight = "hard-light",
        SoftLight = "soft-light",
        Difference = "difference",
        Exclusion = "exclusion",
        Hue = "hue",
        Saturation = "saturation",
        Color = "color",
        Luminosity = "luminosity",
    }
);

#[allow(clippy::derivable_impls)]
impl Default for BlendMode {
    fn default() -> Self {
        BlendMode::Normal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_validation() {
        assert!(Color::new("#ffb02e").is_ok());
        assert!(Color::new("#ffb02e80").is_ok());
        assert!(Color::new("#FFB02E").is_err());
        assert!(Color::new("#fff").is_err());
        assert!(Color::new("red").is_err());
        assert!(Color::new("#ffb02g").is_err());
        assert_eq!(Color::new("#ff000080").unwrap().rgba8(), [255, 0, 0, 128]);
        assert_eq!(Color::from_rgba8(1, 2, 3, 255).as_str(), "#010203");
        assert_eq!(Color::from_rgba8(1, 2, 3, 4).as_str(), "#01020304");
    }

    #[test]
    fn color_value_untagged() {
        let v: ColorValue = serde_json::from_str("\"#000000\"").unwrap();
        assert!(matches!(v, ColorValue::Color(_)));
        let v: ColorValue = serde_json::from_str(r#"{"$var":"brand.primary"}"#).unwrap();
        assert_eq!(v, ColorValue::Ref(ColorRef::var("brand.primary")));
        let v: ColorValue = serde_json::from_str(r#"{"$style":"abc"}"#).unwrap();
        assert_eq!(serde_json::to_string(&v).unwrap(), r#"{"$style":"abc"}"#);
        assert!(serde_json::from_str::<ColorValue>("\"#XYZ\"").is_err());
    }

    #[test]
    fn blend_strings() {
        assert_eq!(
            serde_json::to_string(&BlendMode::ColorDodge).unwrap(),
            "\"color-dodge\""
        );
        assert_eq!(BlendMode::ALL.len(), 16);
        assert_eq!(
            "soft-light".parse::<BlendMode>().unwrap(),
            BlendMode::SoftLight
        );
    }
}
