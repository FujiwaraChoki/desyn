//! Pages panel: every page as a large live thumbnail with its number, name and size; click to show it, double-click
//! the name to rename, drag to reorder, right-click for duplicate / delete / move, and add a page.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use desyn_core::model::Id;
use desyn_raster::PageRenderOptions;
use gpui::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    MouseButton, MouseDownEvent, ParentElement, Render, RenderImage, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Window, div, img, prelude::FluentBuilder, px,
};

use super::{body, frame};
use crate::presets::format_size;
use crate::ui::components::{Variant, button, icon, t};
use crate::ui::editor::{EditorEvent, EditorView};
use crate::ui::menu::MenuEntry;
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{MONO, SANS};

const THUMB_W: f32 = 252.0;

/// A page being dragged in the panel.
#[derive(Clone)]
pub struct DraggedPageCard {
    id: Id,
    label: String,
}

impl Render for DraggedPageCard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        div()
            .px(px(10.0))
            .py(px(6.0))
            .rounded(px(8.0))
            .bg(th.accent_solid)
            .text_color(th.accent_ink)
            .font_family(SANS)
            .text_size(px(12.0))
            .child(self.label.clone())
    }
}

/// The panel.
pub struct PagesPanel {
    editor: Entity<EditorView>,
    thumbs: HashMap<Id, (u64, Arc<RenderImage>)>,
    retired: Vec<Arc<RenderImage>>,
    renaming: Option<(Id, Entity<TextField>, Subscription)>,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl Focusable for PagesPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl PagesPanel {
    /// A panel for an editor.
    pub fn new(
        editor: Entity<EditorView>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> PagesPanel {
        let subs = vec![cx.subscribe(&editor, |this, _, e: &EditorEvent, cx| {
            if matches!(e, EditorEvent::Changed(_) | EditorEvent::Page(_)) {
                // Re-render thumbnails after editing pauses.
                cx.spawn(async move |this, cx| {
                    crate::cloud::runtime::sleep(Duration::from_millis(400)).await;
                    let _ = this.update(cx, |_, cx| cx.notify());
                })
                .detach();
                let _ = this;
                cx.notify();
            }
        })];
        PagesPanel {
            editor,
            thumbs: HashMap::new(),
            retired: Vec::new(),
            renaming: None,
            focus: cx.focus_handle(),
            _subs: subs,
        }
    }

    /// Renders at most one stale thumbnail per frame (never mid-gesture).
    fn refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for old in self.retired.drain(..) {
            window.drop_image(old).ok();
        }
        let scale_factor = window.scale_factor() as f64;
        let stale = self.editor.update(cx, |e, _| {
            let rev = e.session.doc.revision();
            if e.session.has_gesture()
                || e.session.text.is_some()
                || e.last_change.elapsed() < Duration::from_millis(300)
            {
                return None;
            }
            let pages: Vec<Id> = e.session.doc.design.page_ids().to_vec();
            let page = pages
                .iter()
                .find(|p| self.thumbs.get(*p).is_none_or(|(r, _)| *r != rev))?
                .clone();
            let n = e.session.doc.design.node(&page)?;
            let w = n.base().width.max(1.0);
            let scale = (THUMB_W as f64 * scale_factor / w).min(2.0);
            let r = e
                .session
                .renderer
                .render_page(
                    &e.session.doc.design,
                    &PageRenderOptions {
                        page: Some(page.clone()),
                        scale,
                        ..Default::default()
                    },
                )
                .ok()?;
            let image = crate::ui::canvas::to_bgra(&r.pixmap)?;
            Some((page, rev, image))
        });
        if let Some((page, rev, image)) = stale {
            if let Some((_, old)) = self.thumbs.insert(page, (rev, image)) {
                self.retired.push(old);
            }
            window.request_animation_frame();
        }
        let alive: Vec<Id> = self.editor.read(cx).session.doc.design.page_ids().to_vec();
        self.thumbs.retain(|k, _| alive.contains(k));
    }

    fn rename(&mut self, id: Id, current: String, window: &mut Window, cx: &mut Context<Self>) {
        let field = cx.new(|cx| {
            let mut f = TextField::new("Page name", cx);
            f.font_size = 12.5;
            f.set_text(&current, cx);
            f
        });
        let pid = id.clone();
        let sub = cx.subscribe_in(
            &field,
            window,
            move |this, f, e: &FieldEvent, window, cx| match e {
                FieldEvent::Confirm => {
                    let name = f.read(cx).text().trim().to_string();
                    let id = pid.clone();
                    this.editor.update(cx, |ed, cx| {
                        ed.session.rename(&id, &name);
                        ed.after(cx);
                    });
                    this.renaming = None;
                    let fh = this.editor.read(cx).focus.clone();
                    window.focus(&fh, cx);
                    cx.notify();
                }
                FieldEvent::Cancel => {
                    this.renaming = None;
                    cx.notify();
                }
                _ => {}
            },
        );
        let fh = field.focus_handle(cx);
        window.focus(&fh, cx);
        self.renaming = Some((id, field, sub));
        cx.notify();
    }

    fn menu(
        &mut self,
        page: Id,
        index: usize,
        count: usize,
        at: gpui::Point<gpui::Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let ed = self.editor.downgrade();
        let mk = |label: &str, f: Box<dyn Fn(&mut crate::canvas::EditorSession)>| {
            let ed = ed.clone();
            let f: std::rc::Rc<dyn Fn(&mut crate::canvas::EditorSession)> = std::rc::Rc::from(f);
            MenuEntry::run(label.to_string(), move |_, cx| {
                let f = f.clone();
                let _ = ed.update(cx, |e, cx| {
                    f(&mut e.session);
                    e.after(cx);
                });
            })
        };
        let (p1, p2, p3, p4) = (page.clone(), page.clone(), page.clone(), page.clone());
        let mut entries = vec![
            mk("Duplicate page", Box::new(move |s| s.duplicate_page(&p1))),
            mk("Add page after", Box::new(|s| s.add_page())),
        ];
        if index > 0 {
            entries.push(mk(
                "Move up",
                Box::new(move |s| s.move_page(&p2, index - 1)),
            ));
        }
        if index + 1 < count {
            entries.push(mk(
                "Move down",
                Box::new(move |s| s.move_page(&p3, index + 1)),
            ));
        }
        if count > 1 {
            entries.push(MenuEntry::Separator);
            entries.push(mk("Delete page", Box::new(move |s| s.delete_page(&p4))));
        }
        self.editor
            .update(cx, |e, cx| e.open_menu(entries, at, window, cx));
    }
}

impl Render for PagesPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        self.refresh(window, cx);
        let (pages, active) = {
            let e = self.editor.read(cx);
            let d = &e.session.doc.design;
            let pages: Vec<(Id, String, f64, f64, String)> = d
                .page_ids()
                .iter()
                .filter_map(|p| {
                    let n = d.node(p)?;
                    let unit = serde_json::to_value(n)
                        .ok()
                        .and_then(|v| v.get("unit").and_then(|u| u.as_str()).map(str::to_string))
                        .unwrap_or_else(|| "px".into());
                    Some((
                        p.clone(),
                        n.base().name.clone(),
                        n.base().width,
                        n.base().height,
                        unit,
                    ))
                })
                .collect();
            (pages, e.session.page.clone())
        };
        let count = pages.len();
        let mut list = div().flex().flex_col().gap(px(14.0));
        for (i, (id, name, w, h, unit)) in pages.into_iter().enumerate() {
            let is_active = id == active;
            let thumb = self.thumbs.get(&id).map(|(_, im)| im.clone());
            let th_h = (THUMB_W as f64 * h / w.max(1.0)).clamp(40.0, 420.0) as f32;
            let label = if name.trim().is_empty() {
                format!("Page {}", i + 1)
            } else {
                name.clone()
            };
            let renaming = self
                .renaming
                .as_ref()
                .filter(|(r, _, _)| *r == id)
                .map(|(_, f, _)| f.clone());
            let (id1, id2, id3, id4) = (id.clone(), id.clone(), id.clone(), id.clone());
            let label2 = label.clone();
            let accent = th.accent;
            let border = th.border_strong;
            list = list.child(
                div()
                    .id(SharedString::from(format!("page-card-{id}")))
                    .flex()
                    .flex_col()
                    .gap(px(7.0))
                    .cursor_pointer()
                    .child(
                        div()
                            .w(px(THUMB_W + 8.0))
                            .h(px(th_h + 8.0))
                            .p(px(3.0))
                            .rounded(px(12.0))
                            .border_1()
                            .border_color(if is_active { accent } else { th.border_subtle })
                            .when(is_active, |d| d.bg(th.accent_soft))
                            .when(!is_active, move |d| {
                                d.hover(move |s| s.border_color(border))
                            })
                            .child(
                                div()
                                    .size_full()
                                    .rounded(px(9.0))
                                    .overflow_hidden()
                                    .bg(th.surface2)
                                    .children(thumb.map(|im| img(im).size_full())),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .font_family(MONO)
                                    .text_size(px(11.0))
                                    .text_color(if is_active { th.accent_text } else { th.faint })
                                    .child(format!("{}", i + 1)),
                            )
                            .child(match renaming {
                                Some(f) => div().flex_1().child(f).into_any_element(),
                                None => div()
                                    .id(SharedString::from(format!("page-name-{id}")))
                                    .flex_1()
                                    .truncate()
                                    .font_family(SANS)
                                    .text_size(px(12.5))
                                    .text_color(th.fg)
                                    .child(label.clone())
                                    .on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(move |this, e: &MouseDownEvent, window, cx| {
                                            if e.click_count == 2 {
                                                this.rename(
                                                    id1.clone(),
                                                    label2.clone(),
                                                    window,
                                                    cx,
                                                );
                                            }
                                        }),
                                    )
                                    .into_any_element(),
                            })
                            .child(
                                div()
                                    .font_family(MONO)
                                    .text_size(px(10.5))
                                    .text_color(th.faint)
                                    .child(format_size(w, h, &unit)),
                            ),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let p = id2.clone();
                        this.editor.update(cx, |e, cx| e.set_page(&p, cx));
                    }))
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(move |this, e: &MouseDownEvent, window, cx| {
                            this.menu(id3.clone(), i, count, e.position, window, cx);
                        }),
                    )
                    .on_drag(
                        DraggedPageCard {
                            id: id.clone(),
                            label: label.clone(),
                        },
                        |p, _, _, cx| cx.new(|_| p.clone()),
                    )
                    .drag_over::<DraggedPageCard>(|s, _, _, _| s.opacity(0.6))
                    .on_drop(cx.listener(move |this, d: &DraggedPageCard, _, cx| {
                        let _ = &id4;
                        let page = d.id.clone();
                        this.editor.update(cx, |e, cx| {
                            e.session.move_page(&page, i);
                            e.after(cx);
                        });
                    })),
            );
        }
        let add = button("pages-add", "Add page", Variant::Secondary, &th)
            .w_full()
            .child(icon("icons/plus.svg", 13.0, th.fg))
            .on_click(cx.listener(|this, _, _, cx| {
                this.editor.update(cx, |e, cx| {
                    e.session.add_page();
                    e.after(cx);
                })
            }));
        let content = div().flex().flex_col().gap(px(14.0)).child(list).child(add);
        frame(
            "pages",
            None,
            Some("Drag to reorder. Double-click a name to rename it."),
            &th,
        )
        .child(body("pages-body", content))
    }
}
