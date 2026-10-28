//! Update notifications from a JSON feed (no signing keys; downloads open in the browser from the official site).
//!
//! Feed (default `https://desyn.app/desktop/latest.json`, override with `DESYN_UPDATE_FEED` or
//! `extensions.cloud.updateFeed`):
//!
//! ```json
//! {
//!   "schema": 1,
//!   "latest": {
//!     "version": "0.2.0",
//!     "date": "2026-11-01",
//!     "notes": "Short release notes shown in the app.",
//!     "notesUrl": "https://desyn.app/changelog#0.2.0",
//!     "minimumVersion": "0.1.0",
//!     "downloads": {
//!       "linux-x86_64": { "url": "https://desyn.app/download/desyn-0.2.0-x86_64.AppImage", "sha256": "…", "size": 123456 },
//!       "macos-aarch64": { "url": "…", "sha256": "…", "size": 0 },
//!       "windows-x86_64": { "url": "…", "sha256": "…", "size": 0 }
//!     }
//!   }
//! }
//! ```
//!
//! Platform keys are `<os>-<arch>` with os `linux` | `macos` | `windows` and arch `x86_64` | `aarch64`. A version
//! below `minimumVersion` is told the update is required. The app checks 20 s after start and every 6 hours
//! (`extensions.update.check: false` turns it off; `extensions.update.skip` remembers a skipped version).

use std::time::Duration;

use gpui::{
    App, AppContext, Context, FocusHandle, Focusable, Global, IntoElement, ParentElement, Render,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::cloud::{Cloud, http, runtime};
use crate::ui::app::AppState;
use crate::ui::components::{Variant, button, icon, t};
use crate::ui::ext::{CommandSpec, Extensions};
use crate::ui::theme::{SANS, alpha};
use crate::widgets::notify;

/// One download.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Download {
    /// URL.
    pub url: String,
    /// sha256 hex of the file.
    pub sha256: String,
    /// Size in bytes.
    pub size: u64,
}

/// The newest release.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Release {
    /// Semantic version.
    pub version: String,
    /// Release date.
    pub date: String,
    /// Notes.
    pub notes: String,
    /// Full notes.
    pub notes_url: Option<String>,
    /// Oldest version that may keep running.
    pub minimum_version: Option<String>,
    /// Downloads by platform key.
    pub downloads: std::collections::BTreeMap<String, Download>,
}

/// The feed.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Feed {
    /// Format version (1).
    pub schema: u32,
    /// Latest release.
    pub latest: Release,
}

/// Parses `1.2.3` (pre-release / build suffixes ignored) into comparable parts.
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((
        it.next()??,
        it.next().flatten().unwrap_or(0),
        it.next().flatten().unwrap_or(0),
    ))
}

/// This platform's key.
pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// What the feed means for this app.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// Up to date.
    Current,
    /// A newer version exists.
    Available {
        /// Release.
        release: Box<Release>,
        /// Download for this platform.
        download: Option<Download>,
        /// This version is below the minimum.
        required: bool,
    },
}

/// Compares the feed with the running version.
pub fn evaluate(feed: &Feed, current: &str, platform: &str) -> Verdict {
    let (Some(latest), Some(cur)) = (parse_version(&feed.latest.version), parse_version(current))
    else {
        return Verdict::Current;
    };
    if latest <= cur {
        return Verdict::Current;
    }
    let required = feed
        .latest
        .minimum_version
        .as_deref()
        .and_then(parse_version)
        .is_some_and(|m| cur < m);
    Verdict::Available {
        release: Box::new(feed.latest.clone()),
        download: feed.latest.downloads.get(platform).cloned(),
        required,
    }
}

/// Update state (GPUI global).
#[derive(Default)]
pub struct Updates {
    /// The last verdict.
    pub available: Option<(Release, Option<Download>, bool)>,
    /// A check is running.
    pub checking: bool,
}

impl Global for Updates {}

fn setting(cx: &App, key: &str) -> Option<Value> {
    cx.try_global::<AppState>()?
        .settings
        .extensions
        .get("update")?
        .get(key)
        .cloned()
}

/// Checks the feed now (`manual` reports "up to date" too).
pub fn check(manual: bool, cx: &mut App) {
    if cx.global::<Updates>().checking {
        return;
    }
    let Some(cloud) = Cloud::try_get(cx) else {
        return;
    };
    let url = cloud.endpoints().update_feed.clone();
    cx.global_mut::<Updates>().checking = true;
    let f = runtime::spawn(async move { http::get_json(&url, None).await });
    cx.spawn(async move |cx| {
        let res = f
            .await
            .ok()
            .and_then(Result::ok)
            .and_then(|v| serde_json::from_value::<Feed>(v).ok());
        cx.update(|cx| {
            cx.global_mut::<Updates>().checking = false;
            let Some(feed) = res else {
                if manual {
                    notify(
                        cx,
                        "Couldn't reach the update service. Try again later.".into(),
                    );
                }
                return;
            };
            match evaluate(&feed, env!("CARGO_PKG_VERSION"), &platform()) {
                Verdict::Current => {
                    cx.global_mut::<Updates>().available = None;
                    if manual {
                        notify(
                            cx,
                            format!("Desyn {} is up to date.", env!("CARGO_PKG_VERSION")),
                        );
                    }
                }
                Verdict::Available {
                    release,
                    download,
                    required,
                } => {
                    let skipped = setting(cx, "skip").and_then(|v| v.as_str().map(str::to_string))
                        == Some(release.version.clone());
                    if !manual && skipped && !required {
                        return;
                    }
                    notify(cx, format!("Desyn {} is available.", release.version));
                    cx.global_mut::<Updates>().available = Some((*release, download, required));
                    cx.refresh_windows();
                }
            }
        });
    })
    .detach();
}

/// Installs the checker, the palette command and the start-screen notice.
pub fn install(cx: &mut App) {
    cx.set_global(Updates::default());
    Extensions::update(cx, |x| {
        x.command(CommandSpec {
            id: "app.check-updates".into(),
            title: "Check for updates".into(),
            group: "Help".into(),
            keywords: "version upgrade release".into(),
            run: std::rc::Rc::new(|_, _, cx| check(true, cx)),
        });
        x.home_section(0, |_, cx| {
            cx.new(|cx| UpdateNotice {
                focus: cx.focus_handle(),
            })
            .into()
        });
    });
    cx.spawn(async move |cx| {
        runtime::sleep(Duration::from_secs(20)).await;
        loop {
            let enabled = cx.update(|cx| {
                setting(cx, "check")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true)
            });
            if enabled {
                cx.update(|cx| check(false, cx));
            }
            runtime::sleep(Duration::from_secs(6 * 3600)).await;
        }
    })
    .detach();
}

/// Start-screen notice when an update exists.
pub struct UpdateNotice {
    focus: FocusHandle,
}

impl Focusable for UpdateNotice {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for UpdateNotice {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let Some((release, download, required)) =
            cx.try_global::<Updates>().and_then(|u| u.available.clone())
        else {
            return div();
        };
        let notes = release
            .notes_url
            .clone()
            .filter(|u| crate::widgets::is_web_url(u));
        let url = download
            .map(|d| d.url)
            .filter(|u| u.starts_with("https://"))
            .or(notes.clone())
            .unwrap_or_else(|| "https://desyn.app/download".into());
        let version = release.version.clone();
        div()
            .p(px(16.0))
            .flex()
            .items_center()
            .gap(px(14.0))
            .rounded(px(14.0))
            .bg(alpha(th.accent, 0.08))
            .border_1()
            .border_color(alpha(th.accent, 0.35))
            .child(icon("icons/download.svg", 18.0, th.accent_text))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(px(3.0))
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(14.0))
                            .text_color(th.fg)
                            .child(if required {
                                format!("Desyn {} is required", release.version)
                            } else {
                                format!("Desyn {} is available", release.version)
                            }),
                    )
                    .when(!release.notes.is_empty(), |d| {
                        d.child(
                            div()
                                .font_family(SANS)
                                .text_size(px(12.5))
                                .text_color(th.muted)
                                .child(release.notes.clone()),
                        )
                    }),
            )
            .when_some(notes, |d, n| {
                d.child(
                    button("update-notes", "What's new", Variant::Ghost, &th)
                        .on_click(move |_, _, cx| cx.open_url(&n)),
                )
            })
            .when(!required, |d| {
                d.child(
                    button("update-skip", "Skip this version", Variant::Ghost, &th).on_click(
                        move |_, _, cx| {
                            let v = version.clone();
                            AppState::update(cx, |s| {
                                let e = s
                                    .settings
                                    .extensions
                                    .entry("update".to_string())
                                    .or_insert_with(|| json!({}));
                                e["skip"] = json!(v);
                                s.save_settings();
                            });
                            cx.global_mut::<Updates>().available = None;
                            cx.refresh_windows();
                        },
                    ),
                )
            })
            .child(
                button("update-download", "Download", Variant::Primary, &th)
                    .on_click(move |_, _, cx| cx.open_url(&url)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(v: &str, min: Option<&str>) -> Feed {
        serde_json::from_value(json!({
            "schema": 1,
            "latest": {
                "version": v, "date": "2026-11-01", "notes": "Faster exports.",
                "minimumVersion": min,
                "downloads": { "linux-x86_64": { "url": "https://desyn.app/d/x.AppImage", "sha256": "ab", "size": 10 } }
            }
        }))
        .unwrap()
    }

    #[test]
    fn versions_compare() {
        assert_eq!(parse_version("v1.2.3-beta.1"), Some((1, 2, 3)));
        assert_eq!(parse_version("2"), Some((2, 0, 0)));
        assert_eq!(parse_version("x"), None);
        assert_eq!(
            evaluate(&feed("0.1.0", None), "0.1.0", "linux-x86_64"),
            Verdict::Current
        );
        match evaluate(&feed("0.3.0", Some("0.2.0")), "0.1.5", "linux-x86_64") {
            Verdict::Available {
                download, required, ..
            } => {
                assert!(required);
                assert_eq!(download.unwrap().url, "https://desyn.app/d/x.AppImage");
            }
            v => panic!("{v:?}"),
        }
        match evaluate(&feed("0.3.0", None), "0.2.9", "macos-aarch64") {
            Verdict::Available {
                download, required, ..
            } => {
                assert!(!required);
                assert!(download.is_none());
            }
            v => panic!("{v:?}"),
        }
        assert!(platform().contains('-'));
    }
}
