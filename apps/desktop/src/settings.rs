//! User settings (`settings.json` in the config directory). Unknown keys are preserved so newer builds and
//! feature modules (panels, AI, sync) can store their own state under `extensions` without schema changes.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::paths::{AppPaths, write_atomic};

/// Theme preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePref {
    /// Follow the OS appearance.
    System,
    /// Dark (the default: Desyn is dark-first).
    #[default]
    Dark,
    /// Light.
    Light,
}

impl ThemePref {
    /// All values in menu order.
    pub const ALL: [ThemePref; 3] = [ThemePref::Dark, ThemePref::Light, ThemePref::System];

    /// Menu label.
    pub fn label(self) -> &'static str {
        match self {
            ThemePref::System => "System",
            ThemePref::Dark => "Dark",
            ThemePref::Light => "Light",
        }
    }
}

/// Snapping preferences (sources mirror `desyn_core::snap::SnapOptions`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SnapPrefs {
    /// Master switch (mod+shift+').
    pub enabled: bool,
    /// Snap to other layers.
    pub objects: bool,
    /// Snap to page edges and center.
    pub page: bool,
    /// Snap to ruler guides.
    pub guides: bool,
    /// Snap to the page layout grid.
    pub grid: bool,
    /// Equal-spacing snapping.
    pub spacing: bool,
    /// Snap distance in screen px.
    pub threshold: f64,
}

impl Default for SnapPrefs {
    fn default() -> Self {
        SnapPrefs {
            enabled: true,
            objects: true,
            page: true,
            guides: true,
            grid: true,
            spacing: true,
            threshold: 6.0,
        }
    }
}

/// Saved window placement.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPlacement {
    /// Left in screen px.
    pub x: f32,
    /// Top in screen px.
    pub y: f32,
    /// Width.
    pub width: f32,
    /// Height.
    pub height: f32,
    /// Maximized.
    pub maximized: bool,
}

/// Everything the user can change in Settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Theme.
    pub theme: ThemePref,
    /// Folder that holds the local library (`None` = `~/Documents/Desyn`).
    pub library_dir: Option<PathBuf>,
    /// Save open designs that have a file automatically (debounced after edits).
    pub autosave: bool,
    /// Idle time after the last edit before an autosave, in milliseconds.
    pub autosave_delay_ms: u64,
    /// Interval of crash-recovery snapshots while a design has unsaved changes, in seconds.
    pub recovery_interval_secs: u64,
    /// Snapping.
    pub snapping: SnapPrefs,
    /// Show rulers (shift+R).
    pub rulers: bool,
    /// Show the page layout grid (mod+').
    pub layout_grid: bool,
    /// Show the pixel grid when zoomed in beyond 800%.
    pub pixel_grid: bool,
    /// Arrow-key nudge in px.
    pub nudge: f64,
    /// Shift+arrow nudge in px.
    pub big_nudge: f64,
    /// Smart distance labels while moving.
    pub smart_distances: bool,
    /// Pages strip visible.
    pub pages_strip: bool,
    /// Reduce interface motion.
    pub reduce_motion: bool,
    /// Last window placement.
    pub window: Option<WindowPlacement>,
    /// State owned by feature modules, keyed by module id.
    pub extensions: Map<String, Value>,
    /// Unknown keys from newer versions.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: ThemePref::Dark,
            library_dir: None,
            autosave: true,
            autosave_delay_ms: 1500,
            recovery_interval_secs: 10,
            snapping: SnapPrefs::default(),
            rulers: true,
            layout_grid: true,
            pixel_grid: true,
            nudge: 1.0,
            big_nudge: 10.0,
            smart_distances: true,
            pages_strip: true,
            reduce_motion: false,
            window: None,
            extensions: Map::new(),
            extra: Map::new(),
        }
    }
}

impl Settings {
    /// Loads settings; a missing or unreadable file yields the defaults (a corrupt file is kept aside as
    /// `settings.json.bad` so the user's values are not silently lost).
    pub fn load(path: &Path) -> Settings {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Settings::default();
        };
        match serde_json::from_str::<Settings>(&text) {
            Ok(s) => s.sanitized(),
            Err(e) => {
                log::warn!(
                    "settings: {} is not valid ({e}); using defaults",
                    path.display()
                );
                let _ = std::fs::rename(path, path.with_extension("json.bad"));
                Settings::default()
            }
        }
    }

    /// Writes settings atomically.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        write_atomic(path, &json)
    }

    /// The library folder in effect.
    pub fn library(&self, paths: &AppPaths) -> PathBuf {
        self.library_dir
            .clone()
            .unwrap_or_else(|| paths.default_library.clone())
    }

    /// Clamps values a hand-edited file could break.
    pub fn sanitized(mut self) -> Settings {
        let finite_or =
            |v: f64, d: f64, lo: f64, hi: f64| if v.is_finite() { v.clamp(lo, hi) } else { d };
        self.nudge = finite_or(self.nudge, 1.0, 0.01, 1000.0);
        self.big_nudge = finite_or(self.big_nudge, 10.0, 0.01, 10_000.0);
        self.snapping.threshold = finite_or(self.snapping.threshold, 6.0, 1.0, 40.0);
        self.autosave_delay_ms = self.autosave_delay_ms.clamp(300, 60_000);
        self.recovery_interval_secs = self.recovery_interval_secs.clamp(2, 600);
        self
    }

    /// `desyn_core` snap options for the given zoom (threshold converted to design px).
    pub fn snap_options(&self, zoom: f64) -> desyn_core::snap::SnapOptions {
        let s = &self.snapping;
        desyn_core::snap::SnapOptions {
            threshold: s.threshold / zoom.max(1e-6),
            objects: s.objects,
            page: s.page,
            guides: s.guides,
            grid: s.grid && self.layout_grid,
            spacing: s.spacing,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::test_dir::TempDir;

    #[test]
    fn round_trip_keeps_unknown_keys() {
        let t = TempDir::new("settings");
        let p = t.0.join("settings.json");
        std::fs::write(
            &p,
            r#"{"theme":"light","futureKey":{"a":1},"extensions":{"ai":{"dock":true}}}"#,
        )
        .unwrap();
        let mut s = Settings::load(&p);
        assert_eq!(s.theme, ThemePref::Light);
        assert!(s.autosave, "missing keys take defaults");
        s.nudge = 2.0;
        s.save(&p).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["futureKey"]["a"], 1);
        assert_eq!(v["extensions"]["ai"]["dock"], true);
        assert_eq!(v["nudge"], 2.0);
    }

    #[test]
    fn corrupt_file_is_set_aside() {
        let t = TempDir::new("settings-bad");
        let p = t.0.join("settings.json");
        std::fs::write(&p, "{nope").unwrap();
        assert_eq!(Settings::load(&p), Settings::default());
        assert!(p.with_extension("json.bad").exists());
    }

    #[test]
    fn sanitizes_values() {
        let s = Settings {
            nudge: f64::NAN,
            big_nudge: -5.0,
            autosave_delay_ms: 1,
            ..Default::default()
        }
        .sanitized();
        assert_eq!(s.nudge, 1.0);
        assert_eq!(s.big_nudge, 0.01);
        assert_eq!(s.autosave_delay_ms, 300);
        let o = s.snap_options(2.0);
        assert_eq!(o.threshold, 3.0);
    }
}
