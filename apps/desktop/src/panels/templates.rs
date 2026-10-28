//! Design panel: the template library from the cloud (search, categories, popular), shown as thumbnails. Using a
//! template adds its pages to the current design (replacing a blank current page); templates whose images live in
//! the cloud open as a new cloud design when the current design is a local file.

use desyn_core::clipboard::{CloneOptions, clone_subtree};
use desyn_core::ids::IdGen;
use desyn_core::model::{Design, Id, Op, PathSeg, ROOT_ID, StylesOp};
use gpui::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, StatefulInteractiveElement, Styled, StyledImage, Subscription, Task,
    Window, div, img, prelude::FluentBuilder, px,
};
use serde_json::{Value, json};

use super::{body, frame};
use crate::auth::Account;
use crate::cloud::api::{self, Page, TemplateView, f};
use crate::cloud::{Cloud, CloudError, images};
use crate::ui::components::{Variant, button, icon, pill, t, tip};
use crate::ui::editor::EditorView;
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{SANS, Theme, alpha};
use crate::widgets::{empty, error_row, loading, notify, search_box, spinner};

/// Ops adding every page of `tpl` after page `after` of `target` (fresh ids), with the template's assets and
/// styles; a blank `after` page is removed. Returns the ops and the new page ids.
pub fn template_ops(
    target: &Design,
    tpl: &Design,
    after: &str,
    ids: &mut dyn IdGen,
) -> (Vec<Op>, Vec<Id>) {
    let mut ops = Vec::new();
    let missing: std::collections::BTreeMap<Id, desyn_core::model::AssetRef> = tpl
        .assets
        .iter()
        .filter(|(k, _)| !target.assets.contains_key(*k))
        .map(|(k, v)| {
            let mut a = v.clone();
            a.url = None;
            (k.clone(), a)
        })
        .collect();
    if !missing.is_empty() {
        ops.push(Op::Asset(desyn_core::model::AssetOp {
            set: Some(missing),
            remove: None,
        }));
    }
    for (k, v) in &tpl.styles.colors {
        if !target.styles.colors.contains_key(k) {
            ops.push(Op::Styles(StylesOp {
                path: vec![PathSeg::Key("colors".into()), PathSeg::Key(k.clone())],
                value: serde_json::to_value(v).unwrap_or(Value::Null),
            }));
        }
    }
    for (k, v) in &tpl.styles.text {
        if !target.styles.text.contains_key(k) {
            ops.push(Op::Styles(StylesOp {
                path: vec![PathSeg::Key("text".into()), PathSeg::Key(k.clone())],
                value: serde_json::to_value(v).unwrap_or(Value::Null),
            }));
        }
    }
    for (k, v) in &tpl.styles.variables {
        if !target.styles.variables.contains_key(k) {
            ops.push(Op::Styles(StylesOp {
                path: vec![PathSeg::Key("variables".into()), PathSeg::Key(k.clone())],
                value: serde_json::to_value(v).unwrap_or(Value::Null),
            }));
        }
    }
    let pages = target.page_ids().to_vec();
    let mut index = pages
        .iter()
        .position(|p| p == after)
        .map(|i| i as i64 + 1)
        .unwrap_or(pages.len() as i64);
    let mut new_pages = Vec::new();
    for p in tpl.page_ids() {
        if let Some(c) = clone_subtree(
            tpl,
            p,
            ids,
            &CloneOptions {
                parent: Some(ROOT_ID.to_string()),
                index: Some(index),
                ..Default::default()
            },
        ) {
            if let Some(id) = c.id_map.get(p) {
                new_pages.push(id.clone());
            }
            ops.push(c.op);
            index += 1;
        }
    }
    let blank = target.node(after).is_some_and(|n| n.child_ids().is_empty());
    if blank && !new_pages.is_empty() {
        ops.push(Op::delete(after.to_string()));
    }
    (ops, new_pages)
}

/// Whether a design has assets stored in the cloud (their bytes come from signed URLs of a cloud design).
pub fn has_cloud_assets(d: &Design) -> bool {
    d.assets.values().any(|a| {
        a.storage_key
            .as_deref()
            .is_some_and(|k| !k.starts_with("assets/"))
    })
}

/// The panel.
pub struct TemplatesPanel {
    editor: Entity<EditorView>,
    search: Entity<TextField>,
    category: Option<String>,
    categories: Vec<(String, u64)>,
    items: Vec<TemplateView>,
    cursor: Option<String>,
    done: bool,
    loading: bool,
    error: Option<String>,
    applying: Option<String>,
    /// Local previews for templates the server has no thumbnail for yet (rendered from the template design).
    previews: std::collections::HashMap<String, Preview>,
    request: u64,
    debounce: Option<Task<()>>,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl Focusable for TemplatesPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// A locally rendered template preview.
#[derive(Clone)]
enum Preview {
    Loading,
    Ready(std::sync::Arc<gpui::Image>),
    Failed,
}

/// Preview width in px (two columns of about 137 pt at 2x).
const PREVIEW_W: f64 = 300.0;

/// Renders the first page of a template design to PNG bytes for a preview tile.
fn render_preview(design: &Design) -> Option<Vec<u8>> {
    let page = design.page_ids().first()?.clone();
    let width = design.node(&page)?.base().width.max(1.0);
    let settings = crate::export::run::Settings {
        pages: vec![page],
        scale: (PREVIEW_W / width).min(1.0),
        ..Default::default()
    };
    let out =
        crate::export::run::render(design, &Default::default(), &[], "preview", &settings).ok()?;
    out.into_iter().next().map(|(_, b)| b)
}

fn label_of(cat: &str) -> String {
    let mut s = cat.replace(['-', '_'], " ");
    if let Some(c) = s.get_mut(0..1) {
        c.make_ascii_uppercase();
    }
    s
}

impl TemplatesPanel {
    /// A panel for an editor.
    pub fn new(
        editor: Entity<EditorView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> TemplatesPanel {
        let search = cx.new(|cx| {
            let mut f = TextField::new("Search templates", cx);
            f.font_size = 13.0;
            f
        });
        let subs =
            vec![
                cx.subscribe_in(&search, window, |this, _, e: &FieldEvent, _, cx| match e {
                    FieldEvent::Changed(_) => {
                        this.debounce = Some(cx.spawn(async move |this, cx| {
                            crate::cloud::runtime::sleep(std::time::Duration::from_millis(280))
                                .await;
                            let _ = this.update(cx, |this, cx| this.reload(cx));
                        }));
                    }
                    FieldEvent::Confirm => this.reload(cx),
                    _ => {}
                }),
            ];
        let mut p = TemplatesPanel {
            editor,
            search,
            category: None,
            categories: Vec::new(),
            items: Vec::new(),
            cursor: None,
            done: false,
            loading: false,
            error: None,
            applying: None,
            previews: Default::default(),
            request: 0,
            debounce: None,
            focus: cx.focus_handle(),
            _subs: subs,
        };
        p.load_categories(cx);
        p.reload(cx);
        p
    }

    fn load_categories(&mut self, cx: &mut Context<Self>) {
        let Some(cloud) = Cloud::try_get(cx) else {
            return;
        };
        let q = cloud.query(f::TEMPLATES_CATEGORIES, json!({}));
        cx.spawn(async move |this, cx| {
            if let Ok(Value::Array(a)) = q.await {
                let cats: Vec<(String, u64)> = a
                    .iter()
                    .filter_map(|c| {
                        Some((
                            c.get("category")?.as_str()?.to_string(),
                            c.get("count")?.as_u64().unwrap_or(0),
                        ))
                    })
                    .filter(|(_, n)| *n > 0)
                    .collect();
                let _ = this.update(cx, |this, cx| {
                    this.categories = cats;
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        self.items.clear();
        self.cursor = None;
        self.done = false;
        self.load_more(cx);
    }

    fn load_more(&mut self, cx: &mut Context<Self>) {
        if self.done {
            return;
        }
        let Some(cloud) = Cloud::try_get(cx) else {
            return;
        };
        self.request += 1;
        let req = self.request;
        self.loading = true;
        self.error = None;
        let q = self.search.read(cx).text().trim().to_string();
        let mut args = json!({ "paginationOpts": api::page(24, self.cursor.as_deref()) });
        if let Some(c) = &self.category {
            args["category"] = json!(c);
        }
        let call = if q.is_empty() {
            args["sort"] = json!("popular");
            cloud.query(f::TEMPLATES_LIST, args)
        } else {
            args["query"] = json!(q);
            cloud.query(f::TEMPLATES_SEARCH, args)
        };
        cx.spawn(async move |this, cx| {
            let res = call.await.and_then(api::decode::<Page<TemplateView>>);
            let _ = this.update(cx, |this, cx| {
                if this.request != req {
                    return;
                }
                this.loading = false;
                match res {
                    Ok(p) => {
                        this.items.extend(p.page);
                        this.cursor = p.continue_cursor;
                        this.done = p.is_done || this.cursor.is_none();
                    }
                    Err(e) => this.error = Some(e.friendly()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn use_template(&mut self, t: TemplateView, new_design: bool, cx: &mut Context<Self>) {
        if self.applying.is_some() {
            return;
        }
        if t.premium {
            if !Account::signed_in(cx) {
                notify(
                    cx,
                    "Premium templates are part of Desyn Pro. Sign in to use them.".into(),
                );
                Account::start_sign_in(cx);
                return;
            }
            if Account::profile(cx).is_some_and(|p| !p.can("templates.premium")) {
                let url = format!("{}/settings/billing", Cloud::get(cx).endpoints().app_url);
                notify(
                    cx,
                    "Premium templates are part of Desyn Pro. Opening plans in your browser."
                        .into(),
                );
                cx.open_url(&url);
                return;
            }
        }
        let cloud = Cloud::get(cx);
        self.applying = Some(t.id.clone());
        cx.notify();
        let q = cloud.query(f::TEMPLATES_DESIGN, json!({ "templateId": t.id }));
        cx.spawn(async move |this, cx| {
            let res: Result<Design, CloudError> = q.await.and_then(|v| {
                let s = v
                    .get("design")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CloudError::server("No design."))?;
                Design::from_json(s).map_err(|e| CloudError::server(e.to_string()))
            });
            let _ = this.update(cx, |this, cx| {
                this.applying = None;
                match res {
                    Ok(tpl) => this.apply(t, tpl, new_design, cx),
                    Err(e) => notify(cx, format!("Couldn't load “{}”: {}", t.title, e.friendly())),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn apply(&mut self, t: TemplateView, tpl: Design, new_design: bool, cx: &mut Context<Self>) {
        let linked = crate::sync::link(&self.editor, cx).is_some();
        let cloud_assets = has_cloud_assets(&tpl);
        if new_design || (cloud_assets && !linked) {
            if Account::signed_in(cx) {
                self.instantiate(t, cx);
                return;
            }
            if new_design {
                notify(cx, "Sign in to open templates as new designs.".into());
                Account::start_sign_in(cx);
                return;
            }
            notify(
                cx,
                "This template's images load once you sign in. The layout and text were added."
                    .into(),
            );
        }
        for fam in tpl
            .nodes
            .values()
            .flat_map(desyn_core::clipboard::font_families)
        {
            crate::widgets::fonts::FontLibrary::ensure(&fam, cx);
        }
        let label = format!("Template: {}", t.title);
        self.editor.update(cx, |e, cx| {
            let page = e.session.page.clone();
            let (ops, pages) = {
                let (d, ids) = e.session.doc.split();
                template_ops(d, &tpl, &page, ids)
            };
            if e.apply(ops, &label, cx)
                && let Some(p) = pages.first()
            {
                e.set_page(p, cx);
            }
        });
        if linked {
            crate::sync::download_assets(self.editor.clone(), cx);
        }
    }

    fn instantiate(&mut self, t: TemplateView, cx: &mut Context<Self>) {
        let Some(ws) = Account::workspace_id(cx) else {
            notify(
                cx,
                "Your account is still loading. Try again in a moment.".into(),
            );
            return;
        };
        let cloud = Cloud::get(cx);
        let m = cloud.mutation(
            "templates/templates:instantiate",
            json!({ "templateId": t.id, "workspaceId": ws }),
        );
        self.applying = Some(t.id.clone());
        cx.spawn(async move |this, cx| {
            let res = m.await;
            let _ = this.update(cx, |this, cx| {
                this.applying = None;
                match res.and_then(|v| {
                    v.get("designId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .ok_or_else(|| CloudError::server("No design."))
                }) {
                    Ok(id) => crate::sync::open_cloud_design(id, cx),
                    Err(e) => {
                        Account::handle_error(&e, cx);
                        notify(cx, format!("Couldn't create the design: {}", e.friendly()));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Starts rendering previews for listed templates that have no server thumbnail.
    fn ensure_previews(&mut self, cx: &mut Context<Self>) {
        let wanted: Vec<String> = self
            .items
            .iter()
            .filter(|tv| tv.thumb(320.0).is_none() && !self.previews.contains_key(&tv.id))
            .map(|tv| tv.id.clone())
            .collect();
        for id in wanted {
            self.previews.insert(id.clone(), Preview::Loading);
            let q = Cloud::get(cx).query(f::TEMPLATES_DESIGN, json!({ "templateId": id }));
            cx.spawn(async move |this, cx| {
                let design = q.await.ok().and_then(|v| {
                    v.get("design")
                        .and_then(Value::as_str)
                        .and_then(|s| Design::from_json(s).ok())
                });
                let bytes = match design {
                    Some(d) => cx.background_spawn(async move { render_preview(&d) }).await,
                    None => None,
                };
                let preview = bytes
                    .as_deref()
                    .and_then(images::from_bytes)
                    .map_or(Preview::Failed, Preview::Ready);
                let _ = this.update(cx, |this, cx| {
                    this.previews.insert(id, preview);
                    cx.notify();
                });
            })
            .detach();
        }
    }

    fn card(
        &self,
        i: usize,
        tv: &TemplateView,
        w: f32,
        th: &Theme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let aspect = (tv.height / tv.width.max(1.0)).clamp(0.4, 2.2) as f32;
        let h = w * aspect;
        let thumb = tv.thumb(320.0).map(|t| t.url.clone()).unwrap_or_default();
        let me = cx.entity().entity_id();
        let preview = self.previews.get(&tv.id).cloned();
        let image = if thumb.is_empty() {
            match &preview {
                Some(Preview::Ready(i)) => Some(i.clone()),
                _ => None,
            }
        } else {
            images::image(&thumb, me, cx)
        };
        let pending = thumb.is_empty() && matches!(preview, None | Some(Preview::Loading));
        let initial = tv
            .title
            .chars()
            .next()
            .map(|c| c.to_uppercase().to_string())
            .unwrap_or_default();
        let placeholder = thumb.is_empty() && matches!(preview, Some(Preview::Failed));
        let busy = self.applying.as_deref() == Some(tv.id.as_str());
        let t1 = tv.clone();
        let t2 = tv.clone();
        let accent = th.accent;
        div()
            .id(("tpl", i))
            .w(px(w))
            .flex()
            .flex_col()
            .gap(px(6.0))
            .cursor_pointer()
            .child(
                div()
                    .relative()
                    .w(px(w))
                    .h(px(h))
                    .rounded(px(10.0))
                    .overflow_hidden()
                    .bg(th.surface2)
                    .border_1()
                    .border_color(th.border_subtle)
                    .hover(move |s| s.border_color(accent))
                    .children(image.map(|i| img(i).size_full().object_fit(gpui::ObjectFit::Cover)))
                    .when(pending, |d| {
                        d.child(
                            div()
                                .size_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(spinner(format!("tpl-preview-{i}"), 12.0, th)),
                        )
                    })
                    .when(placeholder, |d| {
                        d.bg(gpui::linear_gradient(
                            160.0,
                            gpui::linear_color_stop(th.surface2, 0.0),
                            gpui::linear_color_stop(alpha(th.accent, 0.12), 1.0),
                        ))
                        .child(
                            div()
                                .size_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .font_family(crate::ui::theme::SERIF)
                                .text_size(px(34.0))
                                .text_color(alpha(th.accent, 0.8))
                                .child(initial.clone()),
                        )
                    })
                    .when(tv.premium, |d| {
                        d.child(
                            div()
                                .absolute()
                                .top(px(6.0))
                                .right(px(6.0))
                                .px(px(7.0))
                                .py(px(1.0))
                                .rounded(px(999.0))
                                .bg(gpui::linear_gradient(
                                    135.0,
                                    gpui::linear_color_stop(th.sun_hi, 0.0),
                                    gpui::linear_color_stop(th.sun_lo, 1.0),
                                ))
                                .font_family(SANS)
                                .text_size(px(10.5))
                                .font_weight(gpui::FontWeight(700.0))
                                .text_color(gpui::black())
                                .child("Pro"),
                        )
                    })
                    .when(busy, |d| {
                        d.child(
                            div()
                                .absolute()
                                .inset_0()
                                .flex()
                                .items_center()
                                .justify_center()
                                .bg(alpha(th.bg, 0.5))
                                .child(spinner(format!("tpl-busy-{i}"), 14.0, th)),
                        )
                    }),
            )
            .child(
                div()
                    .truncate()
                    .font_family(SANS)
                    .text_size(px(11.5))
                    .text_color(th.muted)
                    .child(tv.title.clone()),
            )
            .tooltip(tip(format!("{} · {}", tv.title, label_of(&tv.kind)), None))
            .on_click(cx.listener(move |this, _, _, cx| this.use_template(t1.clone(), false, cx)))
            .on_mouse_down(
                gpui::MouseButton::Right,
                cx.listener(move |this, e: &gpui::MouseDownEvent, window, cx| {
                    let me = cx.entity().downgrade();
                    let (a, b) = (t2.clone(), t2.clone());
                    let (m1, m2) = (me.clone(), me);
                    let entries = vec![
                        crate::ui::menu::MenuEntry::run(
                            "Add pages to this design",
                            move |_, cx| {
                                let t = a.clone();
                                let _ = m1.update(cx, |p, cx| p.use_template(t, false, cx));
                            },
                        ),
                        crate::ui::menu::MenuEntry::run("Open as a new design", move |_, cx| {
                            let t = b.clone();
                            let _ = m2.update(cx, |p, cx| p.use_template(t, true, cx));
                        }),
                    ];
                    let at = e.position;
                    this.editor
                        .update(cx, |ed, cx| ed.open_menu(entries, at, window, cx));
                }),
            )
    }
}

impl Render for TemplatesPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let w = (320.0 - 36.0 - 10.0) / 2.0;
        let mut cols = [
            div().flex().flex_col().gap(px(12.0)).w(px(w)),
            div().flex().flex_col().gap(px(12.0)).w(px(w)),
        ];
        let mut heights = [0.0f32; 2];
        self.ensure_previews(cx);
        let items = self.items.clone();
        for (i, tv) in items.iter().enumerate() {
            let k = if heights[0] <= heights[1] { 0 } else { 1 };
            heights[k] += w * (tv.height / tv.width.max(1.0)).clamp(0.4, 2.2) as f32 + 30.0;
            let card = self.card(i, tv, w, &th, cx);
            let c = std::mem::replace(&mut cols[k], div());
            cols[k] = c.child(card);
        }
        let [c0, c1] = cols;
        let chips = div().flex().flex_wrap().gap(px(6.0)).children(
            std::iter::once((None, "All".to_string()))
                .chain(
                    self.categories
                        .iter()
                        .take(14)
                        .map(|(c, _)| (Some(c.clone()), label_of(c))),
                )
                .enumerate()
                .map(|(i, (cat, label))| {
                    let active = self.category == cat;
                    let s3 = th.surface3;
                    div()
                        .id(("tpl-cat", i))
                        .px(px(10.0))
                        .h(px(26.0))
                        .flex()
                        .items_center()
                        .rounded(px(999.0))
                        .border_1()
                        .border_color(if active { th.accent } else { th.border_subtle })
                        .when(active, |d| d.bg(th.accent_soft))
                        .when(!active, move |d| d.hover(move |s| s.bg(s3)))
                        .cursor_pointer()
                        .font_family(SANS)
                        .text_size(px(11.5))
                        .text_color(if active { th.accent_text } else { th.muted })
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.category = cat.clone();
                            this.reload(cx);
                        }))
                }),
        );
        let content = div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(search_box(self.search.clone(), &th))
            .child(chips)
            .children(self.error.clone().map(|e| {
                error_row(
                    &e,
                    Some(
                        button("tpl-retry", "Try again", Variant::Secondary, &th)
                            .on_click(cx.listener(|this, _, _, cx| this.reload(cx)))
                            .into_any_element(),
                    ),
                    &th,
                )
            }))
            .child(div().flex().gap(px(10.0)).child(c0).child(c1))
            .when(
                self.items.is_empty() && !self.loading && self.error.is_none(),
                |d| {
                    d.child(empty(
                        "nothing here yet",
                        "No templates match. Try another word or category.",
                        None,
                        &th,
                    ))
                },
            )
            .when(self.loading, |d| {
                d.child(loading("tpl-loading", "Loading templates…", &th))
            })
            .when(!self.done && !self.loading && !self.items.is_empty(), |d| {
                d.child(
                    button("tpl-more", "Show more", Variant::Ghost, &th)
                        .w_full()
                        .on_click(cx.listener(|this, _, _, cx| this.load_more(cx))),
                )
            })
            .child(
                div()
                    .pt(px(6.0))
                    .flex()
                    .gap(px(6.0))
                    .items_center()
                    .child(icon("icons/info.svg", 12.0, th.faint))
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(11.0))
                            .text_color(th.faint)
                            .child("Click to add a template's pages; right-click for more."),
                    ),
            )
            .children(
                (!Account::signed_in(cx)).then(|| pill("Sign in for premium templates", &th)),
            );
        frame("start from a", Some("template"), None, &th).child(body("templates-body", content))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::model::{DesignKind, Node};

    #[test]
    fn template_pages_replace_a_blank_page() {
        let target = Design::with_page(
            "design000001",
            "Mine",
            DesignKind::Poster,
            "page00000001",
            100.0,
            100.0,
        );
        let mut tpl = Design::with_page(
            "design000002",
            "Tpl",
            DesignKind::Poster,
            "page00000009",
            100.0,
            100.0,
        );
        tpl.push_child(
            "page00000009",
            Node::rect("rect00000009", "R", 1.0, 1.0, 5.0, 5.0),
        );
        let mut ids = desyn_core::ids::SequentialIds::new("n");
        let (ops, pages) = template_ops(&target, &tpl, "page00000001", &mut ids);
        assert_eq!(pages.len(), 1);
        let mut d = target.clone();
        let r = desyn_core::apply_transaction(
            &mut d,
            &desyn_core::model::Transaction::new("t0000000001", "t", ops),
            Default::default(),
        );
        assert!(r.dropped.is_empty(), "{:?}", r.dropped);
        assert_eq!(d.page_ids().len(), 1, "the blank page was replaced");
        assert_eq!(d.node(&pages[0]).unwrap().child_ids().len(), 1);
        assert!(!has_cloud_assets(&tpl));
    }
}
