//! The canvas interaction model (pure Rust, no UI): camera, tools, gestures and selection, snapping feedback,
//! the pen and text editors, overlay geometry, rulers and the raster tile cache.

pub mod camera;
pub mod overlay;
pub mod pen;
pub mod rulers;
pub mod session;
pub mod text;
pub mod tiles;
pub mod tools;

pub use session::{
    Button, ClipboardContent, Cursor, EditorSession, Mods, Pointer, SessionEvent, ViewPrefs,
};
pub use tools::Tool;
