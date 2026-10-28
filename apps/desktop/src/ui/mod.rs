//! The GPUI desktop interface. See `ARCHITECTURE.md` for the module map and the extension API.

pub mod actions;
pub mod app;
pub mod assets;
pub mod canvas;
pub mod commands;
pub mod components;
pub mod dock;
pub mod editor;
pub mod ext;
pub mod home;
pub mod icon;
mod logging;
pub mod menu;
pub mod menus;
pub mod pages;
pub mod palette;
pub mod prompt;
pub mod script;
pub mod settings_view;
pub mod shortcuts;
pub mod text_field;
pub mod theme;
pub mod workspace;

pub use app::run;
