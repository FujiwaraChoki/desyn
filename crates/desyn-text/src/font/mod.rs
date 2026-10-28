//! Fonts: registration (TTF / OTF / collections / WOFF / WOFF2, variable fonts with axes and named instances), CSS
//! font matching, fallback chains, lazy loading and the bundled OFL set.

pub mod bundled;
mod db;
mod face;
pub mod fallback;
#[cfg(all(feature = "fetch", not(target_arch = "wasm32")))]
mod google;
mod matching;
mod provider;

pub use db::{
    FamilyInfo, FontDb, FontError, Instance, InstanceId, InstanceMetrics, normalize_family,
    split_family_list,
};
pub use face::{AxisInfo, ColorSupport, FaceInfo, FaceStyle, FontId, NamedInstanceInfo};
pub use fallback::FallbackConfig;
#[cfg(all(feature = "fetch", not(target_arch = "wasm32")))]
pub use google::GoogleFontsProvider;
pub use matching::{FaceMatch, MatchRequest, StyleQuery, match_faces};
#[cfg(not(target_arch = "wasm32"))]
pub use provider::DirectoryProvider;
pub use provider::{FontProvider, FontRequest, MemoryProvider, ProviderError, RequestReason};
