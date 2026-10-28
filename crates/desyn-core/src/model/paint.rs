//! Paint types: fills, gradient stops, strokes, effects, image adjustments and animations.

use serde::{Deserialize, Serialize};

use super::node::Extra;
use super::num::nn;

use super::primitives::{BlendMode, Color, ColorValue, Id, string_enum};

/// Gradient stop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stop {
    /// Position 0..1 along the gradient.
    pub pos: f64,
    /// Stop color (literal or reference).
    pub color: ColorValue,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Common optional paint flags shared by every fill kind.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaintFlags {
    /// Paint opacity 0..1 (default 1).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub opacity: Option<f64>,
    /// Visibility (default true).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub visible: Option<bool>,
    /// Blend mode of this paint over the paints below it (default normal).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub blend: Option<BlendMode>,
}

/// Solid color fill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidFill {
    /// Fill color.
    pub color: ColorValue,
    /// Opacity / visibility / blend.
    #[serde(flatten)]
    pub flags: PaintFlags,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Linear gradient fill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearFill {
    /// Angle in degrees (CSS convention: 0 = to top, 90 = to right).
    pub angle: f64,
    /// Stops.
    pub stops: Vec<Stop>,
    /// Opacity / visibility / blend.
    #[serde(flatten)]
    pub flags: PaintFlags,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Radial gradient fill (normalized 0..1 of the box).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RadialFill {
    /// Center x (0..1).
    pub cx: f64,
    /// Center y (0..1).
    pub cy: f64,
    /// Radius x (fraction of width).
    pub rx: f64,
    /// Radius y (fraction of height).
    pub ry: f64,
    /// Stops.
    pub stops: Vec<Stop>,
    /// Opacity / visibility / blend.
    #[serde(flatten)]
    pub flags: PaintFlags,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Conic (sweep) gradient fill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConicFill {
    /// Center x (0..1).
    pub cx: f64,
    /// Center y (0..1).
    pub cy: f64,
    /// Start angle in degrees, clockwise from 12 o'clock (CSS conic-gradient convention).
    pub angle: f64,
    /// Stops.
    pub stops: Vec<Stop>,
    /// Opacity / visibility / blend.
    #[serde(flatten)]
    pub flags: PaintFlags,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum!(
    /// How an image fill maps onto the box.
    ImageFillMode { Fill = "fill", Fit = "fit", Tile = "tile", Stretch = "stretch" }
);

/// Image fill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFill {
    /// Image asset id.
    pub asset_id: Id,
    /// Mapping mode.
    pub mode: ImageFillMode,
    /// Scale (tile mode).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub scale: Option<f64>,
    /// Horizontal offset.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub offset_x: Option<f64>,
    /// Vertical offset.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub offset_y: Option<f64>,
    /// Rotation in degrees.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub rotation: Option<f64>,
    /// Opacity / visibility / blend.
    #[serde(flatten)]
    pub flags: PaintFlags,
    /// Partial image adjustments.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub adjust: Option<Box<ImageAdjustPatch>>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// A paint layer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Fill {
    /// Solid color.
    Solid(SolidFill),
    /// Linear gradient.
    Linear(LinearFill),
    /// Radial gradient.
    Radial(RadialFill),
    /// Conic gradient.
    Conic(ConicFill),
    /// Image.
    Image(ImageFill),
}

/// Derived deserializer for [`Fill`]; the public impl first checks that the tag is a string (serde would
/// otherwise accept a variant index such as `"type": 1`).
#[derive(Deserialize)]
#[serde(remote = "Fill", tag = "type", rename_all = "camelCase")]
enum FillDef {
    Solid(SolidFill),
    Linear(LinearFill),
    Radial(RadialFill),
    Conic(ConicFill),
    Image(ImageFill),
}

impl<'de> Deserialize<'de> for Fill {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        if !matches!(v.get("type"), Some(serde_json::Value::String(_))) {
            return Err(serde::de::Error::custom("`type` must be a string"));
        }
        FillDef::deserialize(v).map_err(serde::de::Error::custom)
    }
}

impl Fill {
    /// Solid fill with a literal color and default flags.
    pub fn solid(color: Color) -> Self {
        Fill::Solid(SolidFill {
            color: ColorValue::Color(color),
            flags: PaintFlags::default(),
            extra: Default::default(),
        })
    }

    /// Shared flags of this fill.
    pub fn flags(&self) -> &PaintFlags {
        match self {
            Fill::Solid(f) => &f.flags,
            Fill::Linear(f) => &f.flags,
            Fill::Radial(f) => &f.flags,
            Fill::Conic(f) => &f.flags,
            Fill::Image(f) => &f.flags,
        }
    }

    /// Whether this paint contributes anything (visible and opacity > 0).
    pub fn is_visible(&self) -> bool {
        let f = self.flags();
        f.visible.unwrap_or(true) && f.opacity.unwrap_or(1.0) > 0.0
    }

    /// Gradient stops, if this is a gradient.
    pub fn stops(&self) -> Option<&[Stop]> {
        match self {
            Fill::Linear(f) => Some(&f.stops),
            Fill::Radial(f) => Some(&f.stops),
            Fill::Conic(f) => Some(&f.stops),
            _ => None,
        }
    }
}

string_enum!(
    /// Stroke alignment relative to the shape outline.
    StrokeAlign { Inside = "inside", Center = "center", Outside = "outside" }
);
string_enum!(
    /// Stroke end cap.
    StrokeCap { Butt = "butt", Round = "round", Square = "square" }
);
string_enum!(
    /// Stroke corner join.
    StrokeJoin { Miter = "miter", Round = "round", Bevel = "bevel" }
);

/// Stroke.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    /// Paints of the stroke, bottom to top.
    pub fills: Vec<Fill>,
    /// Width in px.
    pub width: f64,
    /// Alignment.
    pub align: StrokeAlign,
    /// Dash pattern in px.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub dash: Option<Vec<f64>>,
    /// Cap.
    pub cap: StrokeCap,
    /// Join.
    pub join: StrokeJoin,
    /// Miter limit (default 4).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub miter_limit: Option<f64>,
    /// Visibility (default true).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub visible: Option<bool>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

impl Stroke {
    /// Default stroke: one solid paint, centered, butt cap, miter join.
    pub fn solid(color: Color, width: f64) -> Self {
        Stroke {
            fills: vec![Fill::solid(color)],
            width,
            align: StrokeAlign::Center,
            dash: None,
            cap: StrokeCap::Butt,
            join: StrokeJoin::Miter,
            miter_limit: None,
            visible: None,
            extra: Default::default(),
        }
    }

    /// Whether this stroke paints anything.
    pub fn is_visible(&self) -> bool {
        self.visible.unwrap_or(true) && self.width > 0.0 && self.fills.iter().any(Fill::is_visible)
    }

    /// How far the painted stroke extends outside the shape outline.
    pub fn outset(&self) -> f64 {
        match self.align {
            StrokeAlign::Inside => 0.0,
            StrokeAlign::Center => self.width / 2.0,
            StrokeAlign::Outside => self.width,
        }
    }
}

/// Shadow parameters (drop / inner).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shadow {
    /// Offset x.
    pub x: f64,
    /// Offset y.
    pub y: f64,
    /// Blur radius.
    pub blur: f64,
    /// Spread.
    pub spread: f64,
    /// Color.
    pub color: Color,
    /// Visibility (default true).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub visible: Option<bool>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Blur parameters (layer / background).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blur {
    /// Radius in px.
    pub radius: f64,
    /// Visibility (default true).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub visible: Option<bool>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Noise parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Noise {
    /// Amount 0..1.
    pub amount: f64,
    /// Grain scale.
    pub scale: f64,
    /// Monochrome noise.
    pub mono: bool,
    /// Visibility (default true).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub visible: Option<bool>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Glow parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Glow {
    /// Radius in px.
    pub radius: f64,
    /// Strength 0..1.
    pub strength: f64,
    /// Color.
    pub color: Color,
    /// Visibility (default true).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub visible: Option<bool>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Layer effect.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Effect {
    /// Drop shadow.
    DropShadow(Shadow),
    /// Inner shadow.
    InnerShadow(Shadow),
    /// Gaussian blur of the layer.
    LayerBlur(Blur),
    /// Blur of what is behind the layer.
    BackgroundBlur(Blur),
    /// Noise / grain overlay.
    Noise(Noise),
    /// Outer glow.
    Glow(Glow),
}

/// Derived deserializer for [`Effect`]; the public impl first checks that the tag is a string (serde would
/// otherwise accept a variant index such as `"type": 1`).
#[derive(Deserialize)]
#[serde(remote = "Effect", tag = "type", rename_all = "camelCase")]
enum EffectDef {
    DropShadow(Shadow),
    InnerShadow(Shadow),
    LayerBlur(Blur),
    BackgroundBlur(Blur),
    Noise(Noise),
    Glow(Glow),
}

impl<'de> Deserialize<'de> for Effect {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        if !matches!(v.get("type"), Some(serde_json::Value::String(_))) {
            return Err(serde::de::Error::custom("`type` must be a string"));
        }
        EffectDef::deserialize(v).map_err(serde::de::Error::custom)
    }
}

impl Effect {
    /// Whether the effect is enabled.
    pub fn is_visible(&self) -> bool {
        match self {
            Effect::DropShadow(s) | Effect::InnerShadow(s) => s.visible.unwrap_or(true),
            Effect::LayerBlur(b) | Effect::BackgroundBlur(b) => b.visible.unwrap_or(true),
            Effect::Noise(n) => n.visible.unwrap_or(true),
            Effect::Glow(g) => g.visible.unwrap_or(true),
        }
    }

    /// Extra paint extent outside the layer bounds `[left, top, right, bottom]` caused by this effect
    /// (used for damage rectangles and render bounds). Blur extends by ~3 sigma ≈ radius.
    pub fn outsets(&self) -> [f64; 4] {
        if !self.is_visible() {
            return [0.0; 4];
        }
        match self {
            Effect::DropShadow(s) => {
                let r = s.blur.max(0.0) + s.spread.max(0.0);
                [
                    (r - s.x).max(0.0),
                    (r - s.y).max(0.0),
                    (r + s.x).max(0.0),
                    (r + s.y).max(0.0),
                ]
            }
            Effect::LayerBlur(b) => [b.radius.max(0.0); 4],
            Effect::Glow(g) => [g.radius.max(0.0); 4],
            Effect::InnerShadow(_) | Effect::BackgroundBlur(_) | Effect::Noise(_) => [0.0; 4],
        }
    }
}

/// Image adjustments (each -1..1 unless noted).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAdjust {
    /// Brightness.
    pub brightness: f64,
    /// Contrast.
    pub contrast: f64,
    /// Saturation.
    pub saturation: f64,
    /// Hue rotation in degrees (-180..180).
    pub hue: f64,
    /// Temperature.
    pub temperature: f64,
    /// Tint.
    pub tint: f64,
    /// Exposure.
    pub exposure: f64,
    /// Vignette.
    pub vignette: f64,
    /// Blur in px.
    pub blur: f64,
    /// Grayscale amount.
    pub grayscale: f64,
    /// Sepia amount.
    pub sepia: f64,
    /// Sharpen amount.
    pub sharpen: f64,
    /// Grain amount.
    pub grain: f64,
    /// Duotone shadows/highlights colors.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub duotone: Option<[Color; 2]>,
    /// Named filter preset id.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub filter: Option<String>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `Partial<ImageAdjust>`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(missing_docs)]
pub struct ImageAdjustPatch {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub brightness: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub contrast: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub saturation: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub hue: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub temperature: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub tint: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub exposure: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub vignette: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub blur: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub grayscale: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub sepia: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub sharpen: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub grain: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub duotone: Option<[Color; 2]>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub filter: Option<String>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum!(
    /// Animation preset.
    AnimationPreset {
        Fade = "fade", Rise = "rise", Drop = "drop", SlideLeft = "slide-left", SlideRight = "slide-right",
        ZoomIn = "zoom-in", ZoomOut = "zoom-out", Pop = "pop", Rotate = "rotate", Wipe = "wipe",
        Typewriter = "typewriter", Pulse = "pulse", Float = "float", Shake = "shake", BlurIn = "blur-in", None = "none",
    }
);
string_enum!(
    /// Animation phase.
    AnimationPhase { In = "in", Out = "out", Loop = "loop" }
);
string_enum!(
    /// Animation easing.
    Easing {
        Linear = "linear", Ease = "ease", EaseIn = "ease-in", EaseOut = "ease-out", EaseInOut = "ease-in-out", Spring = "spring",
    }
);

/// Entrance / exit / emphasis animation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Animation {
    /// Animation id.
    pub id: Id,
    /// Preset.
    pub preset: AnimationPreset,
    /// Phase.
    pub phase: AnimationPhase,
    /// Start time in ms.
    pub start_ms: f64,
    /// Duration in ms.
    pub duration_ms: f64,
    /// Easing.
    pub easing: Easing,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_roundtrip() {
        let j = r##"{"type":"solid","color":"#ff0000","opacity":0.5}"##;
        let f: Fill = serde_json::from_str(j).unwrap();
        assert_eq!(serde_json::to_string(&f).unwrap(), j);
        let j = r##"{"type":"linear","angle":90,"stops":[{"pos":0,"color":{"$var":"a"}},{"pos":1,"color":"#000000"}]}"##;
        let f: Fill = serde_json::from_str(j).unwrap();
        assert!(matches!(f, Fill::Linear(_)));
        let j = r##"{"type":"image","assetId":"a1","mode":"fill","adjust":{"brightness":0.2}}"##;
        let f: Fill = serde_json::from_str(j).unwrap();
        assert_eq!(serde_json::to_string(&f).unwrap(), j);
    }

    #[test]
    fn effect_tags() {
        let j = r##"{"type":"dropShadow","x":0,"y":4,"blur":8,"spread":0,"color":"#00000040"}"##;
        let e: Effect = serde_json::from_str(j).unwrap();
        assert!(matches!(e, Effect::DropShadow(_)));
        assert_eq!(e.outsets(), [8.0, 4.0, 8.0, 12.0]);
        let j = r#"{"type":"backgroundBlur","radius":4}"#;
        assert!(matches!(
            serde_json::from_str::<Effect>(j).unwrap(),
            Effect::BackgroundBlur(_)
        ));
    }
}
