//! The pages strip (bottom of the editor): live page thumbnails rendered by desyn-raster, the active page in sun,
//! click to switch, drag to reorder, right-click for page actions, and "add page".

use std::sync::Arc;
use std::time::{Duration, Instant};

use desyn_core::model::Id;
use desyn_raster::PageRenderOptions;
use gpui::{
    App, Context, InteractiveElement, IntoElement, ParentElement, Render,
    StatefulInteractiveElement, Styled, Window, div, img, prelude::*, px,
};

use super::components::{icon, tip};
use super::editor::EditorView;
use super::menu::MenuEntry;
use super::theme::{MONO, SANS, Theme, alpha};

/// Thumbnail height in logical px.
pub const THUMB_H: f32 = 64.0;

/// A page being dragged in the strip.
#[derive(Clone)]
pub struct DraggedPage {
    id: Id,
    label: String,
}

impl Render for DraggedPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = super::components::t(window, cx);
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

/// Re-renders at most one stale thumbnail per frame (the active page only when idle for a moment).
pub fn refresh_thumbnails(v: &mut EditorView, window: &mut Window) {
    let rev = v.session.doc.revision();
    if v.session.has_gesture() || v.session.text.is_some() {
        return;
    }
    let pages: Vec<Id> = v.session.doc.design.page_ids().to_vec();
    v.thumbs.retain(|k, _| pages.contains(k));
    let scale_factor = window.scale_factor() as f64;
    v.thumb_dirty.retain(|k| pages.contains(k));
    let stale = pages
        .iter()
        .find(|p| !v.thumbs.contains_key(*p) || v.thumb_dirty.contains(*p))
        .cloned();
    let Some(page) = stale else { return };
    // Wait for a pause in editing (the editor schedules a re-render after it).
    let idle =
        v.last_change.elapsed() > Duration::from_millis(300) || !v.thumbs.contains_key(&page);
    if !idle {
        return;
    }
    let Some(n) = v.session.doc.design.node(&page) else {
        return;
    };
    let h = n.base().height.max(1.0);
    let scale = (THUMB_H as f64 * scale_factor / h).min(4.0);
    let started = Instant::now();
    v.thumb_dirty.remove(&page);
    if let Ok(r) = v.session.renderer.render_page(
        &v.session.doc.design,
        &PageRenderOptions {
            page: Some(page.clone()),
            scale,
            ..Default::default()
        },
    ) && let Some(img) = super::canvas::to_bgra(&r.pixmap)
        && let Some((_, old)) = v.thumbs.insert(page, (rev, img))
    {
        v.retired_images.push(old);
    }
    log::trace!("thumbnail in {:?}", started.elapsed());
    window.request_animation_frame();
}

/// The strip.
pub fn pages_strip(
    v: &mut EditorView,
    th: &Theme,
    window: &mut Window,
    cx: &mut Context<EditorView>,
) -> gpui::AnyElement {
    refresh_thumbnails(v, window);
    let pages: Vec<Id> = v.session.doc.design.page_ids().to_vec();
    let active = v.session.page.clone();
    let n = pages.len();
    let cards = pages.iter().enumerate().map(|(i, id)| {
        let node = v.session.doc.design.node(id);
        let (w, h) = node
            .map(|n| (n.base().width, n.base().height))
            .unwrap_or((1.0, 1.0));
        let tw = (THUMB_H as f64 * w / h.max(1.0)).clamp(24.0, 160.0) as f32;
        let is_active = *id == active;
        let thumb: Option<Arc<gpui::RenderImage>> = v.thumbs.get(id).map(|(_, i)| i.clone());
        let name = node.map(|n| n.base().name.clone()).unwrap_or_default();
        let pid = id.clone();
        let pid2 = id.clone();
        let pid3 = id.clone();
        let accent = th.accent;
        let border = th.border_subtle;
        let hover_border = th.border_strong;
        div()
            .id(gpui::SharedString::from(format!("page-{id}")))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(5.0))
            .cursor_pointer()
            .child(
                div()
                    .w(px(tw + 6.0))
                    .h(px(THUMB_H + 6.0))
                    .p(px(2.0))
                    .rounded(px(9.0))
                    .border_1()
                    .border_color(if is_active { accent } else { border })
                    .when(is_active, |d| d.bg(alpha(accent, 0.12)))
                    .when(!is_active, move |d| {
                        d.hover(move |s| s.border_color(hover_border))
                    })
                    .child(
                        div()
                            .size_full()
                            .rounded(px(6.0))
                            .overflow_hidden()
                            .bg(alpha(th.fg, 0.06))
                            .children(thumb.map(|t| img(t).size_full())),
                    ),
            )
            .child(
                div()
                    .font_family(MONO)
                    .text_size(px(10.5))
                    .text_color(if is_active { th.accent_text } else { th.faint })
                    .child(format!("{}", i + 1)),
            )
            .tooltip(tip(
                if name.is_empty() {
                    format!("Page {}", i + 1)
                } else {
                    name.clone()
                },
                None,
            ))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.set_page(&pid, cx);
            }))
            .on_mouse_down(
                gpui::MouseButton::Right,
                cx.listener(move |this, e: &gpui::MouseDownEvent, window, cx| {
                    let page = pid2.clone();
                    let entries = page_menu(&page, i, n);
                    this.set_page(&page, cx);
                    this.open_menu(
                        entries,
                        e.position - gpui::point(px(0.0), px(230.0)),
                        window,
                        cx,
                    );
                }),
            )
            .on_drag(
                DraggedPage {
                    id: id.clone(),
                    label: format!("Page {}", i + 1),
                },
                |p, _, _, cx| cx.new(|_| p.clone()),
            )
            .drag_over::<DraggedPage>(move |s, _, _, _| s.opacity(0.6))
            .on_drop(cx.listener(move |this, dragged: &DraggedPage, _, cx| {
                let _ = &pid3;
                this.session.move_page(&dragged.id, i);
                this.after(cx);
            }))
    });
    let add = div()
        .id("add-page")
        .w(px(44.0))
        .h(px(THUMB_H + 6.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(9.0))
        .border_1()
        .border_dashed()
        .border_color(th.border)
        .cursor_pointer()
        .hover({
            let a = th.accent;
            move |s| s.border_color(a)
        })
        .tooltip(tip(
            "Add page",
            Some(super::actions::shortcut_label("secondary-enter")),
        ))
        .child(icon("icons/plus.svg", 16.0, th.muted))
        .on_click(cx.listener(|this, _, _, cx| {
            this.session.add_page();
            this.after(cx);
        }));
    div()
        .id("pages-strip")
        .h(px(THUMB_H + 44.0))
        .flex_none()
        .flex()
        .items_center()
        .gap(px(12.0))
        .px(px(20.0))
        .bg(th.surface1)
        .border_t_1()
        .border_color(th.border_subtle)
        .overflow_x_scroll()
        .child(
            div()
                .flex_none()
                .mr(px(4.0))
                .font_family(SANS)
                .text_size(px(11.0))
                .text_color(th.faint)
                .child(format!("{} {}", n, if n == 1 { "page" } else { "pages" })),
        )
        .children(cards)
        .child(add)
        .into_any_element()
}

fn page_menu(page: &str, index: usize, count: usize) -> Vec<MenuEntry> {
    let p1 = page.to_string();
    let p2 = page.to_string();
    let mut v = vec![
        MenuEntry::action("Add page", super::actions::AddPage),
        MenuEntry::action("Duplicate page", super::actions::DuplicatePage),
        MenuEntry::action("Delete page", super::actions::DeletePage).enabled(count > 1),
        MenuEntry::Separator,
    ];
    if index > 0 {
        v.push(MenuEntry::run("Move left", move |window, cx| {
            move_page(window, cx, &p1, index - 1)
        }));
    }
    if index + 1 < count {
        v.push(MenuEntry::run("Move right", move |window, cx| {
            move_page(window, cx, &p2, index + 1)
        }));
    }
    v
}

fn move_page(window: &mut Window, cx: &mut App, page: &str, to: usize) {
    let page = page.to_string();
    if let Some(ws) = window.root::<super::workspace::Workspace>().flatten() {
        ws.update(cx, |ws, cx| {
            if let Some(ed) = ws.active_editor() {
                ed.update(cx, |e, cx| {
                    e.session.move_page(&page, to);
                    e.after(cx);
                });
            }
        });
    }
}
