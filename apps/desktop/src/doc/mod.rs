//! The document layer: an open design with its assets, undo history, live previews and editing commands. Pure
//! Rust (no UI), unit-tested.

pub mod clipboard;
mod document;
pub mod edit;
pub mod history;
pub mod import;

pub use document::{
    AssetBytes, Change, ChangeKind, Document, asset_entry_name, ext_for_mime, random_ids,
};
