//! Desyn desktop: a native GPUI editor over the shared Rust engine (`desyn-core`, `desyn-text`, `desyn-raster`).
//!
//! Layers (see `ARCHITECTURE.md`):
//! * [`doc`], [`file`], [`canvas`] — pure Rust: documents, history, files, the canvas interaction model, tiles.
//! * [`ui`] — GPUI views: windows, menus, tabs, the canvas element, tool dock, pages strip, palette, settings.
//! * [`ui::ext`] — the extension API feature modules (panels, inspector, AI, sync, export) build on.
//! * Feature modules ([`features::installers`]): [`cloud`] + [`auth`] (account, keychain), [`sync`] (offline-first
//!   Convex sync), [`panels`] (left rail), [`inspector`] (right column), [`ai`] (dock + panel), [`export`],
//!   [`collab`] (share, versions, comments), [`library_ui`] (start screen), [`update`], shared [`widgets`] and
//!   [`dialogs`].

pub mod ai;
pub mod auth;
pub mod canvas;
pub mod cloud;
pub mod collab;
pub mod deeplink;
pub mod dialogs;
pub mod doc;
pub mod export;
pub mod features;
pub mod file;
pub mod inspector;
pub mod ipc;
pub mod library_ui;
pub mod panels;
pub mod paths;
pub mod presets;
pub mod settings;
pub mod sync;
pub mod ui;
pub mod update;
pub mod widgets;
