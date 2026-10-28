//! Settings (mod+,): appearance, canvas, editing and files. Changes apply immediately and are saved to
//! `settings.json`.

use gpui::{
    App, BoxShadow, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Window,
    div, prelude::*, px,
};

use super::app::AppState;
use super::components::{Variant, button, label, serif, t};
use super::text_field::{FieldEvent, TextField};
use super::theme::{MONO, SANS, Theme, alpha};
use crate::settings::{Settings, ThemePref};

/// The settings sheet.
pub struct SettingsView {
    focus: FocusHandle,
    nudge: Entity<TextField>,
    big_nudge: Entity<TextField>,
    threshold: Entity<TextField>,
    autosave_delay: Entity<TextField>,
    _subs: Vec<Subscription>,
}

impl Focusable for SettingsView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn number_field(value: f64, cx: &mut Context<SettingsView>) -> Entity<TextField> {
    cx.new(|cx| {
        let mut f = TextField::new("", cx);
        f.font_size = 13.0;
        f.set_text(&crate::canvas::overlay::fmt_px(value), cx);
        f
    })
}

impl SettingsView {
    /// New sheet.
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> SettingsView {
        let s = super::app::settings(Some(cx));
        let nudge = number_field(s.nudge, cx);
        let big_nudge = number_field(s.big_nudge, cx);
        let threshold = number_field(s.snapping.threshold, cx);
        let autosave_delay = number_field(s.autosave_delay_ms as f64 / 1000.0, cx);
        let bind =
            |f: &Entity<TextField>, apply: fn(&mut Settings, f64), cx: &mut Context<Self>| {
                cx.subscribe(f, move |_, field, e: &FieldEvent, cx| {
                    if matches!(e, FieldEvent::Changed(_) | FieldEvent::Confirm)
                        && let Ok(v) = field
                            .read(cx)
                            .text()
                            .trim()
                            .replace(',', ".")
                            .parse::<f64>()
                    {
                        AppState::update(cx, |s| {
                            apply(&mut s.settings, v);
                            s.settings = s.settings.clone().sanitized();
                            s.save_settings();
                        });
                    }
                })
            };
        let subs = vec![
            bind(&nudge, |s, v| s.nudge = v, cx),
            bind(&big_nudge, |s, v| s.big_nudge = v, cx),
            bind(&threshold, |s, v| s.snapping.threshold = v, cx),
            bind(
                &autosave_delay,
                |s, v| s.autosave_delay_ms = (v * 1000.0).round().max(0.0) as u64,
                cx,
            ),
        ];
        SettingsView {
            focus: cx.focus_handle(),
            nudge,
            big_nudge,
            threshold,
            autosave_delay,
            _subs: subs,
        }
    }
}

fn row(title: &str, hint: &str, control: impl IntoElement, th: &Theme) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap(px(16.0))
        .py(px(10.0))
        .border_b_1()
        .border_color(th.border_subtle)
        .child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(
                    div()
                        .font_family(SANS)
                        .text_size(px(13.5))
                        .text_color(th.fg)
                        .child(title.to_string()),
                )
                .when(!hint.is_empty(), |d| {
                    d.child(
                        div()
                            .font_family(SANS)
                            .text_size(px(12.0))
                            .text_color(th.faint)
                            .child(hint.to_string()),
                    )
                }),
        )
        .child(control)
}

fn toggle(id: &'static str, on: bool, th: &Theme, f: fn(&mut Settings)) -> impl IntoElement {
    let track = if on { th.accent_solid } else { th.surface3 };
    div()
        .id(id)
        .w(px(36.0))
        .h(px(20.0))
        .p(px(2.0))
        .rounded(px(999.0))
        .bg(track)
        .border_1()
        .border_color(if on { alpha(th.accent, 0.6) } else { th.border })
        .cursor_pointer()
        .flex()
        .when(on, |d| d.justify_end())
        .child(div().size(px(14.0)).rounded(px(999.0)).bg(if on {
            th.accent_ink
        } else {
            th.muted
        }))
        .on_click(move |_, _, cx| {
            AppState::update(cx, |s| {
                f(&mut s.settings);
                s.save_settings();
            })
        })
}

fn input(field: Entity<TextField>, suffix: &str, th: &Theme) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .child(
            div()
                .w(px(72.0))
                .h(px(30.0))
                .px(px(8.0))
                .flex()
                .items_center()
                .rounded(px(6.0))
                .bg(th.surface2)
                .border_1()
                .border_color(th.border_subtle)
                .child(field),
        )
        .child(
            div()
                .font_family(MONO)
                .text_size(px(11.0))
                .text_color(th.faint)
                .w(px(20.0))
                .child(suffix.to_string()),
        )
}

impl Render for SettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let s = super::app::settings(Some(cx));
        let lib = cx.global::<AppState>().library_dir();
        let segment = |pref: ThemePref| {
            let active = s.theme == pref;
            div()
                .id(SharedString::from(format!("theme-{}", pref.label())))
                .px(px(14.0))
                .h(px(28.0))
                .flex()
                .items_center()
                .rounded(px(7.0))
                .font_family(SANS)
                .text_size(px(12.5))
                .cursor_pointer()
                .text_color(if active { th.accent_ink } else { th.muted })
                .when(active, |d| d.bg(th.accent_solid))
                .child(pref.label())
                .on_click(move |_, _, cx| super::workspace::set_theme(pref, cx))
        };
        div()
            .id("settings")
            .track_focus(&self.focus)
            .mt(px(64.0))
            .w(px(620.0))
            .max_h(px(720.0))
            .overflow_y_scroll()
            .p(px(28.0))
            .rounded(px(18.0))
            .bg(th.surface1)
            .border_1()
            .border_color(th.border_subtle)
            .shadow(vec![
                BoxShadow::new(
                    px(0.0),
                    px(24.0),
                    alpha(gpui::black(), if th.dark { 0.6 } else { 0.2 }),
                )
                .blur_radius(px(64.0)),
            ])
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(serif("settings", 34.0, th.fg))
            .child(div().h(px(10.0)))
            .child(label("Appearance", &th))
            .child(row(
                "Theme",
                "Desyn is designed dark-first; light is fully designed too.",
                div()
                    .flex()
                    .p(px(3.0))
                    .gap(px(2.0))
                    .rounded(px(9.0))
                    .bg(th.surface2)
                    .child(segment(ThemePref::Dark))
                    .child(segment(ThemePref::Light))
                    .child(segment(ThemePref::System)),
                &th,
            ))
            .child(div().h(px(14.0)))
            .child(label("Canvas", &th))
            .child(row(
                "Rulers",
                "Drag from a ruler to add a guide.",
                toggle("s-rulers", s.rulers, &th, |s| s.rulers = !s.rulers),
                &th,
            ))
            .child(row(
                "Layout grid",
                "Columns of the page grid.",
                toggle("s-grid", s.layout_grid, &th, |s| {
                    s.layout_grid = !s.layout_grid
                }),
                &th,
            ))
            .child(row(
                "Pixel grid",
                "Shown above 800 % zoom.",
                toggle("s-pixel", s.pixel_grid, &th, |s| {
                    s.pixel_grid = !s.pixel_grid
                }),
                &th,
            ))
            .child(row(
                "Snapping",
                "Edges, centers, guides, grid and spacing.",
                toggle("s-snap", s.snapping.enabled, &th, |s| {
                    s.snapping.enabled = !s.snapping.enabled
                }),
                &th,
            ))
            .child(row(
                "Snap to spacing",
                "Match the gaps between neighbors.",
                toggle("s-spacing", s.snapping.spacing, &th, |s| {
                    s.snapping.spacing = !s.snapping.spacing
                }),
                &th,
            ))
            .child(row(
                "Snap distance",
                "In screen pixels.",
                input(self.threshold.clone(), "px", &th),
                &th,
            ))
            .child(row(
                "Smart distances",
                "Measure to neighbors while moving (hold Alt to measure any time).",
                toggle("s-dist", s.smart_distances, &th, |s| {
                    s.smart_distances = !s.smart_distances
                }),
                &th,
            ))
            .child(row(
                "Pages strip",
                "Page thumbnails under the canvas.",
                toggle("s-pages", s.pages_strip, &th, |s| {
                    s.pages_strip = !s.pages_strip
                }),
                &th,
            ))
            .child(div().h(px(14.0)))
            .child(label("Editing", &th))
            .child(row(
                "Nudge",
                "Arrow keys.",
                input(self.nudge.clone(), "px", &th),
                &th,
            ))
            .child(row(
                "Big nudge",
                "Shift + arrow keys.",
                input(self.big_nudge.clone(), "px", &th),
                &th,
            ))
            .child(row(
                "Reduce motion",
                "Fewer animations in the interface.",
                toggle("s-motion", s.reduce_motion, &th, |s| {
                    s.reduce_motion = !s.reduce_motion
                }),
                &th,
            ))
            .child(div().h(px(14.0)))
            .child(label("Files", &th))
            .child(row(
                "Save automatically",
                "Designs with a file save themselves after you stop editing.",
                toggle("s-autosave", s.autosave, &th, |s| s.autosave = !s.autosave),
                &th,
            ))
            .child(row(
                "Autosave delay",
                "Idle time before saving.",
                input(self.autosave_delay.clone(), "s", &th),
                &th,
            ))
            .child(row(
                "Library folder",
                &lib.display().to_string(),
                button("s-reveal", "Show", Variant::Secondary, &th).on_click(move |_, _, cx| {
                    let dir = super::app::library_dir(cx);
                    let _ = std::fs::create_dir_all(&dir);
                    cx.reveal_path(&dir);
                }),
                &th,
            ))
            .child(div().h(px(18.0)))
            .child(div().flex().justify_end().gap(px(8.0)).child(
                button("s-shortcuts", "Keyboard shortcuts", Variant::Ghost, &th).on_click(
                    |_, window, cx| {
                        window.dispatch_action(Box::new(super::actions::ShowShortcuts), cx)
                    },
                ),
            ))
    }
}
