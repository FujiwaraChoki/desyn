//! Serde mirror of `docs/DOCUMENT_MODEL.md` (the frozen contract).

mod design;
mod factories;
mod node;
mod num;
mod ops;
mod paint;
mod primitives;
mod text;
mod tree;
mod validate;

pub use design::*;
pub use factories::{DEFAULT_FONT_FAMILY, DEFAULT_SHAPE_FILL, DEFAULT_TEXT_COLOR};
pub use node::*;
pub use num::MAX_SAFE_INTEGER;
pub use ops::*;
pub use paint::*;
pub use primitives::{BlendMode, Color, ColorParseError, ColorRef, ColorValue, Id, ROOT_ID, Unit};
pub use text::*;
pub use validate::*;
