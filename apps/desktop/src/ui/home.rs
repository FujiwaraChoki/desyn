//! The start screen: create a design from a size, recover work after a crash, recent files and the local library.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;

use gpui::{
    AnyElement, App, BoxShadow, Context, Entity, EventEmitter, FocusHandle, Focusable, Image,
    ImageFormat, InteractiveElement, IntoElement, MouseButton, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Window, div, img, prelude::*, px, relative,
};

use super::app::AppState;
use super::components::{Variant, button, icon, label, serif, t, tip};
use super::text_field::{FieldEvent, TextField};
use super::theme::{MONO, SANS, SERIF, Theme, alpha};
use crate::deeplink::{LaunchRequest, NewDesign};
use crate::file::library::LibraryItem;
use crate::file::recovery::{Orphan, remove_orphan};
use crate::presets::{self, Preset, format_size};

/// What the start screen asks the workspace to do.
#[derive(Debug, Clone)]
pub enum HomeEvent {
    /// Open / create something.
    Request(LaunchRequest),
    /// Toast.
    Notice(String),
    /// Reopen designs rescued after a crash.
    Recover(Vec<Orphan>),
}

/// Start screen state.
pub struct HomeView {
    focus: FocusHandle,
    all_sizes: bool,
    width: Entity<TextField>,
    height: Entity<TextField>,
    covers: HashMap<PathBuf, (SystemTime, Arc<Image>)>,
    /// Sections added by feature modules (built on first render).
    sections: Option<Vec<gpui::AnyView>>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<HomeEvent> for HomeView {}

impl Focusable for HomeView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl HomeView {
    /// New start screen.
    pub fn new(cx: &mut Context<Self>) -> HomeView {
        let width = cx.new(|cx| {
            let mut f = TextField::new("Width", cx);
            f.font_size = 13.0;
            f.set_text("1080", cx);
            f
        });
        let height = cx.new(|cx| {
            let mut f = TextField::new("Height", cx);
            f.font_size = 13.0;
            f.set_text("1080", cx);
            f
        });
        let subs = vec![
            cx.subscribe(&width, |this, _, e: &FieldEvent, cx| {
                if *e == FieldEvent::Confirm {
                    this.create_custom(cx);
                }
            }),
            cx.subscribe(&height, |this, _, e: &FieldEvent, cx| {
                if *e == FieldEvent::Confirm {
                    this.create_custom(cx);
                }
            }),
        ];
        HomeView {
            focus: cx.focus_handle(),
            all_sizes: false,
            width,
            height,
            covers: HashMap::new(),
            sections: None,
            _subs: subs,
        }
    }

    /// Rescans the library (when the screen is shown).
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        AppState::update(cx, |s| s.rescan());
        cx.notify();
    }

    /// Focuses the custom-size field (mod+N).
    pub fn focus_create(&mut self, cx: &mut Context<Self>) {
        self.all_sizes = false;
        cx.notify();
    }

    fn create_custom(&mut self, cx: &mut Context<Self>) {
        let parse = |s: &str| {
            s.trim()
                .replace(',', ".")
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite() && *v >= 1.0 && *v <= 100_000.0)
        };
        let (w, h) = (
            parse(self.width.read(cx).text()),
            parse(self.height.read(cx).text()),
        );
        match (w, h) {
            (Some(w), Some(h)) => cx.emit(HomeEvent::Request(LaunchRequest::New(NewDesign {
                width: Some(w.round()),
                height: Some(h.round()),
                name: Some("Untitled design".into()),
                ..Default::default()
            }))),
            _ => cx.emit(HomeEvent::Notice(
                "Enter a width and height between 1 and 100,000 px.".into(),
            )),
        }
    }

    fn cover(&mut self, item: &LibraryItem) -> Option<Arc<Image>> {
        let bytes = item.cover.as_ref()?;
        if let Some((m, img)) = self.covers.get(&item.path)
            && *m == item.modified
        {
            return Some(img.clone());
        }
        let img = Arc::new(Image::from_bytes(ImageFormat::Png, bytes.as_ref().clone()));
        self.covers
            .insert(item.path.clone(), (item.modified, img.clone()));
        Some(img)
    }

    fn preset_card(&self, p: &'static Preset, th: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let box_h = 76.0f32;
        let ratio = (p.width / p.height) as f32;
        let (bw, bh) = if ratio >= 1.0 {
            (box_h * ratio.min(1.9), box_h)
        } else {
            (box_h * ratio.max(0.45), box_h)
        };
        let accent = th.accent;
        let id = p.id.clone();
        div()
            .id(SharedString::from(format!("preset-{}", p.id)))
            .w(px(156.0))
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .p(px(12.0))
            .rounded(px(14.0))
            .bg(th.surface1)
            .border_1()
            .border_color(th.border_subtle)
            .cursor_pointer()
            .hover(move |s| {
                s.border_color(alpha(accent, 0.6)).shadow(vec![
                    BoxShadow::new(px(0.0), px(16.0), alpha(accent, 0.18)).blur_radius(px(40.0)),
                ])
            })
            .child(
                div()
                    .h(px(box_h + 8.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        // A miniature layout sketch: headline, body lines and a sun dot.
                        div()
                            .w(px(bw.min(130.0)))
                            .h(px(bh))
                            .rounded(px(6.0))
                            .bg(gpui::linear_gradient(
                                160.0,
                                gpui::linear_color_stop(th.surface3, 0.0),
                                gpui::linear_color_stop(th.surface2, 1.0),
                            ))
                            .border_1()
                            .border_color(th.border_subtle)
                            .p(px((bh * 0.12).clamp(5.0, 9.0)))
                            .flex()
                            .flex_col()
                            .gap(px(3.0))
                            .child(
                                div()
                                    .w(px(9.0))
                                    .h(px(9.0))
                                    .rounded(px(9.0))
                                    .bg(alpha(th.accent, 0.85))
                                    .mb(px(2.0)),
                            )
                            .child(
                                div()
                                    .w(relative(0.72))
                                    .h(px(5.0))
                                    .rounded(px(3.0))
                                    .bg(alpha(th.fg, 0.28)),
                            )
                            .child(
                                div()
                                    .w(relative(0.5))
                                    .h(px(3.0))
                                    .rounded(px(2.0))
                                    .bg(alpha(th.fg, 0.12)),
                            )
                            .child(
                                div()
                                    .w(relative(0.6))
                                    .h(px(3.0))
                                    .rounded(px(2.0))
                                    .bg(alpha(th.fg, 0.12)),
                            ),
                    ),
            )
            .child(
                div()
                    .font_family(SANS)
                    .text_size(px(13.0))
                    .text_color(th.fg)
                    .truncate()
                    .child(short_label(&p.label)),
            )
            .child(
                div()
                    .font_family(MONO)
                    .text_size(px(11.0))
                    .text_color(th.faint)
                    .child(p.size_label()),
            )
            .on_click(cx.listener(move |_, _, _, cx| {
                cx.emit(HomeEvent::Request(LaunchRequest::New(NewDesign {
                    preset: Some(id.clone()),
                    ..Default::default()
                })))
            }))
            .into_any_element()
    }

    fn file_card(&mut self, item: &LibraryItem, th: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let cover = self.cover(item);
        let path = item.path.clone();
        let path2 = item.path.clone();
        let accent = th.accent;
        let meta = match item.size {
            Some((w, h)) => format!(
                "{}{} · {}",
                format_size(w, h, "px"),
                if item.pages > 1 {
                    format!(" · {} pages", item.pages)
                } else {
                    String::new()
                },
                ago(item.modified)
            ),
            None => ago(item.modified),
        };
        div()
            .id(SharedString::from(format!("file-{}", item.path.display())))
            .w(px(220.0))
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .cursor_pointer()
            .child(
                div()
                    .h(px(150.0))
                    .rounded(px(14.0))
                    .overflow_hidden()
                    .bg(th.surface1)
                    .border_1()
                    .border_color(th.border_subtle)
                    .hover(move |s| s.border_color(alpha(accent, 0.6)))
                    .flex()
                    .items_center()
                    .justify_center()
                    .p(px(14.0))
                    .child(match cover {
                        Some(c) => img(c)
                            .max_w_full()
                            .max_h_full()
                            .rounded(px(4.0))
                            .into_any_element(),
                        None => icon(
                            if item.error.is_some() {
                                "icons/triangle-alert.svg"
                            } else {
                                "icons/file.svg"
                            },
                            28.0,
                            th.faint,
                        )
                        .into_any_element(),
                    }),
            )
            .child(
                div()
                    .px(px(2.0))
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(13.0))
                            .text_color(th.fg)
                            .truncate()
                            .child(item.name.clone()),
                    )
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(11.5))
                            .text_color(if item.error.is_some() {
                                th.danger
                            } else {
                                th.faint
                            })
                            .truncate()
                            .child(item.error.clone().unwrap_or(meta)),
                    ),
            )
            .tooltip(tip(path.display().to_string(), None))
            .on_click(cx.listener(move |_, _, _, cx| {
                cx.emit(HomeEvent::Request(LaunchRequest::Open(path.clone())))
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |_, _, _, cx| cx.reveal_path(&path2)),
            )
            .into_any_element()
    }

    fn recovery_banner(
        &mut self,
        orphans: &[Orphan],
        th: &Theme,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if orphans.is_empty() {
            return None;
        }
        let n = orphans.len();
        let list = orphans.to_vec();
        let list2 = orphans.to_vec();
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(16.0))
                .p(px(18.0))
                .rounded(px(14.0))
                .bg(alpha(th.accent, 0.08))
                .border_1()
                .border_color(alpha(th.accent, 0.35))
                .child(icon("icons/life-buoy.svg", 22.0, th.accent_text))
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.0))
                        .flex()
                        .flex_col()
                        .gap(px(3.0))
                        .child(serif(if n == 1 { "one design was rescued".to_string() } else { format!("{n} designs were rescued") }, 22.0, th.fg))
                        .child(
                            div()
                                .font_family(SANS)
                                .text_size(px(13.0))
                                .text_color(th.muted)
                                .child("Desyn closed before these changes were saved. Recover them to keep working where you left off."),
                        ),
                )
                .child(button("recover-dismiss", "Discard", Variant::Ghost, th).on_click(cx.listener(move |_, _, _, cx| {
                    for o in &list2 {
                        remove_orphan(o);
                    }
                    AppState::update(cx, |s| s.orphans.clear());
                    cx.notify();
                })))
                .child(button("recover", "Recover", Variant::Primary, th).on_click(cx.listener(move |_, _, _, cx| {
                    cx.emit(HomeEvent::Recover(list.clone()));
                    AppState::update(cx, |s| s.orphans.clear());
                    cx.notify();
                })))
                .into_any_element(),
        )
    }
}

fn short_label(l: &str) -> String {
    l.replace(" (square)", "").replace("Presentation", "Slides")
}

fn ago(t: SystemTime) -> String {
    let secs = SystemTime::now()
        .duration_since(t)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    match secs {
        0..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", secs / 60),
        3600..=86_399 => format!("{} h ago", secs / 3600),
        86_400..=604_799 => format!("{} days ago", secs / 86_400),
        _ => format!("{} weeks ago", secs / 604_800),
    }
}

impl Render for HomeView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let (items, recent, orphans, lib_dir) = {
            let s = cx.global::<AppState>();
            (
                s.library_items.clone(),
                s.recent.existing(),
                s.orphans.clone(),
                s.library_dir(),
            )
        };
        let featured = presets::featured();
        let preset_cards: Vec<AnyElement> = featured
            .iter()
            .map(|p| self.preset_card(p, &th, cx))
            .collect();
        let recent_items: Vec<LibraryItem> = recent
            .iter()
            .take(8)
            .filter_map(|r| {
                items
                    .iter()
                    .find(|i| i.path == r.path)
                    .cloned()
                    .or_else(|| {
                        crate::file::format::peek(&r.path)
                            .ok()
                            .map(|(m, cover)| LibraryItem {
                                path: r.path.clone(),
                                name: m.name.clone(),
                                kind: m.kind.clone(),
                                pages: m.pages.len(),
                                size: m.pages.first().map(|p| (p.width, p.height)),
                                modified: std::fs::metadata(&r.path)
                                    .and_then(|m| m.modified())
                                    .unwrap_or(SystemTime::UNIX_EPOCH),
                                cover: cover.map(Arc::new),
                                error: None,
                            })
                    })
            })
            .collect();
        let recent_cards: Vec<AnyElement> = recent_items
            .iter()
            .map(|i| self.file_card(i, &th, cx))
            .collect();
        let library_cards: Vec<AnyElement> =
            items.iter().map(|i| self.file_card(i, &th, cx)).collect();
        let banner = self.recovery_banner(&orphans, &th, cx);
        if self.sections.is_none() {
            let builders = super::ext::Extensions::get(cx).home_sections();
            self.sections = Some(builders.iter().map(|b| b(window, cx)).collect());
        }
        let sections = self.sections.clone().unwrap_or_default();
        let all_sizes =
            self.all_sizes.then(|| {
                let mut groups: Vec<(&str, Vec<&'static Preset>)> = Vec::new();
                for p in presets::all() {
                    match groups.iter_mut().find(|(c, _)| *c == p.category) {
                        Some(g) => g.1.push(p),
                        None => groups.push((p.category.as_str(), vec![p])),
                    }
                }
                div()
                    .flex()
                    .flex_col()
                    .gap(px(18.0))
                    .children(groups.into_iter().map(|(cat, ps)| {
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.0))
                            .child(label(cat, &th))
                            .child(div().flex().flex_wrap().gap(px(8.0)).children(
                                ps.into_iter().map(|p| {
                                    let id = p.id.clone();
                                    let s3 = th.surface3;
                                    div()
                                        .id(SharedString::from(format!("size-{}", p.id)))
                                        .px(px(12.0))
                                        .py(px(7.0))
                                        .rounded(px(999.0))
                                        .bg(th.surface1)
                                        .border_1()
                                        .border_color(th.border_subtle)
                                        .cursor_pointer()
                                        .hover(move |s| s.bg(s3))
                                        .flex()
                                        .gap(px(8.0))
                                        .child(
                                            div()
                                                .font_family(SANS)
                                                .text_size(px(12.5))
                                                .text_color(th.fg)
                                                .child(p.label.clone()),
                                        )
                                        .child(
                                            div()
                                                .font_family(MONO)
                                                .text_size(px(11.0))
                                                .text_color(th.faint)
                                                .child(p.size_label()),
                                        )
                                        .on_click(cx.listener(move |_, _, _, cx| {
                                            cx.emit(HomeEvent::Request(LaunchRequest::New(
                                                NewDesign {
                                                    preset: Some(id.clone()),
                                                    ..Default::default()
                                                },
                                            )))
                                        }))
                                }),
                            ))
                    }))
            });
        let custom = div()
            .w(px(220.0))
            .flex_none()
            .flex()
            .flex_col()
            .justify_between()
            .gap(px(10.0))
            .p(px(14.0))
            .rounded(px(14.0))
            .bg(th.surface1)
            .border_1()
            .border_dashed()
            .border_color(th.border)
            .child(
                div()
                    .font_family(SANS)
                    .text_size(px(13.0))
                    .text_color(th.fg)
                    .child("Custom size"),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(field_box(self.width.clone(), &th))
                    .child(div().text_color(th.faint).child("×"))
                    .child(field_box(self.height.clone(), &th))
                    .child(
                        div()
                            .font_family(MONO)
                            .text_size(px(11.0))
                            .text_color(th.faint)
                            .child("px"),
                    ),
            )
            .child(
                button("create-custom", "Create", Variant::Primary, &th)
                    .on_click(cx.listener(|this, _, _, cx| this.create_custom(cx))),
            );
        // A soft sun glow: a tiny disc with a very wide Gaussian shadow (GPUI blurs shadows, not fills).
        let orb = |x: f32, y: f32, a: f32| {
            div()
                .absolute()
                .left(px(x))
                .top(px(y))
                .size(px(24.0))
                .rounded(px(24.0))
                .shadow(vec![
                    BoxShadow::new(px(0.0), px(0.0), alpha(th.accent, a))
                        .blur_radius(px(260.0))
                        .spread_radius(px(150.0)),
                ])
        };
        div()
            .id("home")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .overflow_y_scroll()
            .bg(th.bg)
            .child(orb(980.0, -60.0, if th.dark { 0.26 } else { 0.24 }))
            .child(
                div()
                    .relative()
                    .max_w(px(1240.0))
                    .mx_auto()
                    .px(px(56.0))
                    .pt(px(56.0))
                    .pb(px(80.0))
                    .flex()
                    .flex_col()
                    .gap(px(40.0))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.0))
                            .child(
                                div()
                                    .flex()
                                    .items_baseline()
                                    .font_family(SERIF)
                                    .text_size(px(60.0))
                                    .line_height(px(64.0))
                                    .text_color(th.fg)
                                    .child("make something\u{00a0}")
                                    .child(div().italic().text_color(th.accent_text).child("beautiful"))
                                    .child("."),
                            )
                            .child(
                                div()
                                    .font_family(SANS)
                                    .text_size(px(15.0))
                                    .text_color(th.muted)
                                    .child("Start from a size, open a file, or pick up where you left off."),
                            ),
                    )
                    .children(banner)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(14.0))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .child(label("Create", &th))
                                    .child(
                                        button("all-sizes", if self.all_sizes { "Fewer sizes" } else { "All sizes" }, Variant::Ghost, &th)
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.all_sizes = !this.all_sizes;
                                                cx.notify();
                                            })),
                                    ),
                            )
                            .child(div().flex().flex_wrap().gap(px(14.0)).children(preset_cards).child(custom))
                            .children(all_sizes),
                    )
                    .when(!recent_cards.is_empty(), |d| {
                        d.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(14.0))
                                .child(label("Recent", &th))
                                .child(div().flex().flex_wrap().gap(px(18.0)).children(recent_cards)),
                        )
                    })
                    .children(sections)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(14.0))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(12.0))
                                    .child(label("Library", &th))
                                    .child(div().font_family(MONO).text_size(px(11.0)).text_color(th.faint).truncate().child(lib_dir.display().to_string()))
                                    .child(div().flex_1())
                                    .child(button("open-folder", "Open folder", Variant::Ghost, &th).on_click(cx.listener(move |_, _, _, cx| {
                                        let dir = super::app::library_dir(cx);
                                        let _ = std::fs::create_dir_all(&dir);
                                        cx.reveal_path(&dir);
                                    })))
                                    .child(button("change-folder", "Change…", Variant::Ghost, &th).on_click(cx.listener(|_, _, _, cx| {
                                        let rx = cx.prompt_for_paths(gpui::PathPromptOptions {
                                            files: false,
                                            directories: true,
                                            multiple: false,
                                            prompt: Some("Use as library".into()),
                                        });
                                        cx.spawn(async move |this, cx| {
                                            let Ok(Ok(Some(paths))) = rx.await else { return };
                                            let Some(dir) = paths.into_iter().next() else { return };
                                            let _ = this.update(cx, |this, cx| {
                                                AppState::update(cx, |s| {
                                                    s.settings.library_dir = Some(dir);
                                                    s.save_settings();
                                                    s.rescan();
                                                });
                                                this.covers.clear();
                                                cx.notify();
                                            });
                                        })
                                        .detach();
                                    })))
                                    .child(button("open-file", "Open…", Variant::Secondary, &th).on_click(|_, window, cx| {
                                        window.dispatch_action(Box::new(super::actions::Open), cx)
                                    })),
                            )
                            .child(if library_cards.is_empty() {
                                div()
                                    .py(px(48.0))
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .gap(px(10.0))
                                    .rounded(px(14.0))
                                    .border_1()
                                    .border_dashed()
                                    .border_color(th.border_subtle)
                                    .child(serif("your library is empty", 28.0, th.fg))
                                    .child(
                                        div()
                                            .font_family(SANS)
                                            .text_size(px(13.0))
                                            .text_color(th.muted)
                                            .child("Designs you create are saved here automatically."),
                                    )
                                    .into_any_element()
                            } else {
                                div().flex().flex_wrap().gap(px(18.0)).children(library_cards).into_any_element()
                            }),
                    ),
            )
    }
}

fn field_box(field: Entity<TextField>, th: &Theme) -> impl IntoElement {
    div()
        .w(px(64.0))
        .h(px(30.0))
        .px(px(8.0))
        .flex()
        .items_center()
        .rounded(px(6.0))
        .bg(th.surface2)
        .border_1()
        .border_color(th.border_subtle)
        .child(field)
}
