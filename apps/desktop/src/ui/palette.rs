//! The command palette (mod+K): commands with their shortcuts, new-design sizes, recent files and commands
//! registered by feature modules, fuzzy-matched as you type.

use std::rc::Rc;

use gpui::{
    Action, App, BoxShadow, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Window, div, prelude::*, px,
};

use super::actions::shortcut_label;
use super::app::AppState;
use super::commands::{self, Scope, score};
use super::components::{icon, kbd, t};
use super::editor::EditorView;
use super::ext::Extensions;
use super::menu::MenuRun;
use super::text_field::{FieldEvent, TextField};
use super::theme::{SANS, alpha};
use crate::deeplink::{LaunchRequest, NewDesign};

/// What the palette chose.
pub enum PaletteEvent {
    /// Closed without choosing.
    Dismissed,
    /// Dispatch an action.
    Action(Box<dyn Action>),
    /// Run a closure (extension command).
    Run(MenuRun),
    /// Open / create.
    Request(LaunchRequest),
}

enum Target {
    Action(Box<dyn Action>),
    Run(MenuRun),
    Request(LaunchRequest),
}

struct Item {
    title: SharedString,
    group: SharedString,
    keywords: String,
    keys: Option<String>,
    icon: &'static str,
    target: Target,
}

/// Palette state.
pub struct Palette {
    field: Entity<TextField>,
    items: Vec<Item>,
    matches: Vec<usize>,
    selected: usize,
    _sub: Subscription,
}

impl EventEmitter<PaletteEvent> for Palette {}

impl Focusable for Palette {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.field.focus_handle(cx)
    }
}

impl Palette {
    /// Builds the palette for the active editor (`None` on the start screen).
    pub fn new(
        editor: Option<Entity<EditorView>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Palette {
        let field = cx.new(|cx| {
            let mut f = TextField::new("Search commands, sizes and files…", cx);
            f.font_size = 15.0;
            f
        });
        let sub = cx.subscribe_in(
            &field,
            window,
            |this, _, e: &FieldEvent, window, cx| match e {
                FieldEvent::Changed(q) => {
                    let q = q.clone();
                    this.filter(&q);
                    cx.notify();
                }
                FieldEvent::Up => {
                    this.selected = this.selected.saturating_sub(1);
                    cx.notify();
                }
                FieldEvent::Down => {
                    if this.selected + 1 < this.matches.len() {
                        this.selected += 1;
                    }
                    cx.notify();
                }
                FieldEvent::Confirm => this.choose(this.selected, window, cx),
                FieldEvent::Cancel => cx.emit(PaletteEvent::Dismissed),
            },
        );
        let ext = Extensions::get(cx);
        let mut items = Vec::new();
        for c in commands::all() {
            let action = (c.action)();
            let available = match c.scope {
                Scope::App => true,
                Scope::Editor => editor.is_some(),
                Scope::Extension => editor.is_some() && ext.handles(action.as_ref()),
            };
            if !available {
                continue;
            }
            let keys = window
                .highest_precedence_binding_for_action(action.as_ref())
                .map(|b| {
                    shortcut_label(
                        &b.keystrokes()
                            .iter()
                            .map(|k| k.to_string())
                            .collect::<Vec<_>>()
                            .join(" "),
                    )
                });
            items.push(Item {
                title: c.title.into(),
                group: c.group.into(),
                keywords: c.keywords.to_string(),
                keys,
                icon: "icons/command.svg",
                target: Target::Action(action),
            });
        }
        for c in ext.commands() {
            let run = c.run.clone();
            let ed = editor.clone();
            items.push(Item {
                title: c.title.clone(),
                group: c.group.clone(),
                keywords: c.keywords.to_string(),
                keys: None,
                icon: "icons/message-square-text.svg",
                target: Target::Run(Rc::new(move |window, cx| run(ed.as_ref(), window, cx))),
            });
        }
        for p in crate::presets::all() {
            items.push(Item {
                title: format!("New {}", p.label).into(),
                group: "New design".into(),
                keywords: format!(
                    "{} {} {}",
                    p.size_label(),
                    p.category,
                    p.platform.clone().unwrap_or_default()
                ),
                keys: None,
                icon: "icons/file-plus.svg",
                target: Target::Request(LaunchRequest::New(NewDesign {
                    preset: Some(p.id.clone()),
                    ..Default::default()
                })),
            });
        }
        for r in cx.global::<AppState>().recent.existing() {
            items.push(Item {
                title: format!("Open {}", r.name).into(),
                group: "Recent".into(),
                keywords: r.path.display().to_string(),
                keys: None,
                icon: "icons/file-clock.svg",
                target: Target::Request(LaunchRequest::Open(r.path.clone())),
            });
        }
        let mut p = Palette {
            field,
            items,
            matches: Vec::new(),
            selected: 0,
            _sub: sub,
        };
        p.filter("");
        p
    }

    fn filter(&mut self, q: &str) {
        let mut scored: Vec<(i32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter_map(|(i, it)| {
                if q.trim().is_empty() {
                    // Empty query: commands and recent files, not the 130 sizes.
                    return (it.group.as_ref() != "New design").then_some((0, i));
                }
                let kw = it.keywords.to_lowercase();
                let words: Vec<&str> = q.split_whitespace().collect();
                let s = score(q, &it.title).or_else(|| {
                    // Keywords only count when every query word starts a keyword.
                    words
                        .iter()
                        .all(|w| {
                            kw.split_whitespace()
                                .any(|k| k.starts_with(&w.to_lowercase()))
                        })
                        .then_some(-20)
                })?;
                Some((s, i))
            })
            .collect();
        if !q.trim().is_empty() {
            scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        }
        self.matches = scored.into_iter().map(|(_, i)| i).take(80).collect();
        self.selected = 0;
    }

    fn choose(&mut self, i: usize, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(&idx) = self.matches.get(i) else {
            return;
        };
        let ev = match &self.items[idx].target {
            Target::Action(a) => PaletteEvent::Action(a.boxed_clone()),
            Target::Run(f) => PaletteEvent::Run(f.clone()),
            Target::Request(r) => PaletteEvent::Request(r.clone()),
        };
        cx.emit(ev);
    }
}

impl Render for Palette {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let rows = self.matches.iter().enumerate().map(|(row, &idx)| {
            let it = &self.items[idx];
            let selected = row == self.selected;
            div()
                .id(("palette-row", row))
                .h(px(38.0))
                .mx(px(6.0))
                .px(px(10.0))
                .flex()
                .items_center()
                .gap(px(10.0))
                .rounded(px(9.0))
                .cursor_pointer()
                .when(selected, |d| d.bg(th.accent_soft))
                .child(icon(
                    it.icon,
                    15.0,
                    if selected { th.accent_text } else { th.faint },
                ))
                .child(
                    div()
                        .flex_1()
                        .truncate()
                        .font_family(SANS)
                        .text_size(px(13.5))
                        .text_color(th.fg)
                        .child(it.title.clone()),
                )
                .child(
                    div()
                        .font_family(SANS)
                        .text_size(px(11.5))
                        .text_color(th.faint)
                        .child(it.group.clone()),
                )
                .children(it.keys.clone().map(|k| kbd(k, &th)))
                .on_click(cx.listener(move |this, _, window, cx| this.choose(row, window, cx)))
                .on_mouse_move(cx.listener(move |this, _, _, cx| {
                    if this.selected != row {
                        this.selected = row;
                        cx.notify();
                    }
                }))
        });
        div()
            .mt(px(96.0))
            .w(px(640.0))
            .max_h(px(520.0))
            .flex()
            .flex_col()
            .rounded(px(16.0))
            .bg(th.glass)
            .border_1()
            .border_color(th.border_subtle)
            .shadow(vec![
                BoxShadow::new(
                    px(0.0),
                    px(24.0),
                    alpha(gpui::black(), if th.dark { 0.6 } else { 0.2 }),
                )
                .blur_radius(px(64.0)),
                BoxShadow::new(px(0.0), px(0.0), alpha(th.accent, 0.08)).blur_radius(px(80.0)),
            ])
            .overflow_hidden()
            .child(
                div()
                    .h(px(56.0))
                    .flex_none()
                    .px(px(18.0))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .border_b_1()
                    .border_color(th.border_subtle)
                    .child(icon("icons/search.svg", 17.0, th.muted))
                    .child(div().flex_1().child(self.field.clone())),
            )
            .child(
                div()
                    .id("palette-list")
                    .flex_1()
                    .min_h(px(0.0))
                    .overflow_y_scroll()
                    .py(px(6.0))
                    .children(rows)
                    .when(self.matches.is_empty(), |d| {
                        d.child(
                            div()
                                .py(px(28.0))
                                .flex()
                                .justify_center()
                                .font_family(SANS)
                                .text_size(px(13.0))
                                .text_color(th.faint)
                                .child("Nothing matches. Try another word."),
                        )
                    }),
            )
    }
}
