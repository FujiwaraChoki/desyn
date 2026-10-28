//! Brand panel: the workspace's brand kits (colors, fonts, logos) from the cloud. Colors apply to the selection
//! (fill, or the page background when nothing is selected), fonts add styled text or restyle selected text, logos
//! insert as images. Kits are cached for the inspector's swatches.

use desyn_core::model::{AssetSource, NodeType};
use gpui::{
    App, BorrowAppContext, Context, Entity, FocusHandle, Focusable, Global, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window,
    div, img, prelude::FluentBuilder, px,
};
use serde_json::{Value, json};

use super::insert::{self, MediaInfo, tweak};
use super::{body, frame};
use crate::auth::{Account, Status};
use crate::cloud::api::{self, BrandKit, f};
use crate::cloud::{Cloud, images};
use crate::inspector::props;
use crate::ui::components::{Variant, button, t, tip};
use crate::ui::editor::EditorView;
use crate::ui::theme::{SANS, Theme};
use crate::widgets::{empty, error_row, hsla, loading, notify, section, select_button, swatch};

/// Brand kits of the current workspace (GPUI global cache).
#[derive(Default)]
pub struct BrandCache {
    /// Workspace the kits belong to.
    pub workspace: Option<String>,
    /// Kits.
    pub kits: Vec<BrandKit>,
}

impl Global for BrandCache {}

/// Cached kits (inspector swatches).
pub fn cached_kits(cx: &App) -> Option<&Vec<BrandKit>> {
    cx.try_global::<BrandCache>()
        .map(|c| &c.kits)
        .filter(|k| !k.is_empty())
}

/// The panel.
pub struct BrandPanel {
    editor: Entity<EditorView>,
    selected: usize,
    loading: bool,
    error: Option<String>,
    loaded_for: Option<String>,
    focus: FocusHandle,
    _subs: Vec<gpui::Subscription>,
}

impl Focusable for BrandPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl BrandPanel {
    /// A panel for an editor.
    pub fn new(
        editor: Entity<EditorView>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> BrandPanel {
        let subs = vec![cx.observe_global::<Account>(|this, cx| {
            if Account::workspace_id(cx) != this.loaded_for {
                this.load(cx);
            }
            cx.notify();
        })];
        let mut p = BrandPanel {
            editor,
            selected: 0,
            loading: false,
            error: None,
            loaded_for: None,
            focus: cx.focus_handle(),
            _subs: subs,
        };
        p.load(cx);
        p
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(ws) = Account::workspace_id(cx) else {
            return;
        };
        if self.loading {
            return;
        }
        self.loading = true;
        self.error = None;
        self.loaded_for = Some(ws.clone());
        let q = Cloud::get(cx).query(f::BRAND_LIST, json!({ "workspaceId": ws }));
        cx.spawn(async move |this, cx| {
            let res = q.await.and_then(api::decode::<Vec<BrandKit>>);
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match res {
                    Ok(mut kits) => {
                        kits.sort_by_key(|k| !k.is_default);
                        cx.set_global(BrandCache {
                            workspace: Some(ws.clone()),
                            kits,
                        });
                    }
                    Err(e) => {
                        Account::handle_error(&e, cx);
                        if e.code != "FEATURE_UNAVAILABLE" {
                            this.error = Some(e.friendly());
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn apply_color(&mut self, c: String, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| {
            let s = props::Sel::new(&e.session.doc.design, &e.session.selection, &e.session.page);
            let mut ops = Vec::new();
            for (i, id) in s.ids.iter().enumerate() {
                let t = s.types[i];
                let Some(path) = props::fills_path(t) else {
                    continue;
                };
                let fill = json!([props::solid(&c)]);
                if path.len() == 1 {
                    ops.push(props::update(id, path[0], fill));
                } else {
                    let mut style = s.nodes[i].get("style").cloned().unwrap_or(json!({}));
                    props::set_in(&mut style, &path[1..], fill);
                    ops.push(props::update(id, "style", style));
                }
            }
            if ops.is_empty() {
                cx.emit(crate::ui::editor::EditorEvent::Notice(
                    "Select a shape, text or the page to apply brand colors.".into(),
                ));
                return;
            }
            e.apply(ops, "Brand color", cx);
        });
    }

    fn use_font(&mut self, family: String, weight: f64, heading: bool, cx: &mut Context<Self>) {
        crate::widgets::fonts::FontLibrary::ensure(&family, cx);
        let restyled = self.editor.update(cx, |e, cx| {
            let s = props::Sel::new(&e.session.doc.design, &e.session.selection, &e.session.page);
            if s.is_page || !s.all(NodeType::Text) {
                return false;
            }
            let ops = s.set_each("style", |n| {
                let mut st = n.get("style").cloned().unwrap_or(json!({}));
                st["fontFamily"] = json!(family);
                st["fontWeight"] = json!(weight);
                Some(st)
            });
            e.apply(ops, "Brand font", cx)
        });
        if restyled {
            return;
        }
        let id = insert::new_id(&self.editor, cx);
        let pw = self.editor.read(cx).session.page_rect().w.max(1.0);
        let text = if heading {
            "Your headline here"
        } else {
            "Body copy in your brand font. Make it say what you mean."
        };
        let n =
            desyn_core::model::Node::text(id, text, 0.0, 0.0, Some((pw * 0.6).round().max(200.0)));
        let size = if heading {
            (pw / 12.0).clamp(32.0, 96.0).round()
        } else {
            (pw / 50.0).clamp(14.0, 28.0).round()
        };
        let mut style = serde_json::to_value(match &n {
            desyn_core::model::Node::Text(t) => &t.style,
            _ => return,
        })
        .unwrap_or(Value::Null);
        style["fontFamily"] = json!(family);
        style["fontWeight"] = json!(weight);
        style["fontSize"] = json!(size);
        if let Some(n) = tweak(
            n,
            json!({ "style": style, "role": if heading { "headline" } else { "body" } }),
        ) {
            insert::insert(
                &self.editor,
                vec![vec![n]],
                Vec::new(),
                "Add brand text",
                cx,
            );
        }
    }

    fn insert_logo(&mut self, url: String, name: String, cx: &mut Context<Self>) {
        let fetch = Cloud::get(cx).fetch_bytes(&url, crate::cloud::http::MAX_DOWNLOAD);
        let editor = self.editor.clone();
        cx.spawn(async move |_, cx| {
            let res = fetch.await;
            cx.update(|cx| match res {
                Ok((bytes, _)) => {
                    let id = insert::insert_image(
                        &editor,
                        bytes,
                        &name,
                        MediaInfo {
                            source: Some(AssetSource::Brand),
                            ..Default::default()
                        },
                        cx,
                    );
                    if id.is_none() {
                        notify(cx, "That logo file could not be read.".into());
                    }
                }
                Err(e) => notify(cx, format!("Couldn't load the logo: {}", e.friendly())),
            });
        })
        .detach();
    }

    fn kit_view(&mut self, kit: &BrandKit, th: &Theme, cx: &mut Context<Self>) -> gpui::Div {
        let mut colors = div().flex().flex_wrap().gap(px(8.0));
        for (i, c) in kit.colors.iter().enumerate() {
            let v = c.value.clone();
            let label = match &c.role {
                Some(r) => format!("{} · {} · {}", c.name, r, c.value),
                None => format!("{} · {}", c.name, c.value),
            };
            colors = colors.child(
                div()
                    .id(("brand-color", i))
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .cursor_pointer()
                    .tooltip(tip(label, None))
                    .child(swatch(hsla(&c.value), 44.0, th))
                    .child(
                        div()
                            .w(px(44.0))
                            .truncate()
                            .font_family(SANS)
                            .text_size(px(10.0))
                            .text_color(th.faint)
                            .child(c.name.clone()),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.apply_color(v.clone(), cx))),
            );
        }
        let mut fonts = div().flex().flex_col().gap(px(8.0));
        for (slot, label, heading) in [
            (&kit.fonts.heading, "Heading", true),
            (&kit.fonts.body, "Body", false),
            (&kit.fonts.accent, "Accent", true),
        ] {
            let Some(fnt) = slot else { continue };
            crate::widgets::fonts::FontLibrary::ensure(&fnt.family, cx);
            let fam: SharedString =
                if crate::widgets::fonts::FontLibrary::previewable(&fnt.family, cx) {
                    fnt.family.clone().into()
                } else {
                    SANS.into()
                };
            let family = fnt.family.clone();
            let weight = fnt.weight.unwrap_or(if heading { 700.0 } else { 400.0 });
            let s3 = th.surface3;
            fonts = fonts.child(
                div()
                    .id(SharedString::from(format!("brand-font-{label}")))
                    .px(px(12.0))
                    .py(px(10.0))
                    .rounded(px(10.0))
                    .bg(th.surface2)
                    .border_1()
                    .border_color(th.border_subtle)
                    .cursor_pointer()
                    .hover(move |s| s.bg(s3))
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(11.5))
                            .text_color(th.faint)
                            .child(label),
                    )
                    .child(
                        div()
                            .font_family(fam)
                            .font_weight(gpui::FontWeight(weight as f32))
                            .text_size(px(if heading { 22.0 } else { 15.0 }))
                            .text_color(th.fg)
                            .child(fnt.family.clone()),
                    )
                    .tooltip(tip(
                        "Add text in this font, or restyle the selected text",
                        None,
                    ))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.use_font(family.clone(), weight, heading, cx)
                    })),
            );
        }
        let me = cx.entity().entity_id();
        let mut logos = div().flex().flex_wrap().gap(px(8.0));
        for (i, l) in kit.logos.iter().enumerate() {
            let Some(url) = l.url.clone() else { continue };
            let image = images::image(&url, me, cx);
            let name = l.name.clone();
            let s3 = th.surface3;
            logos = logos.child(
                div()
                    .id(("brand-logo", i))
                    .w(px(134.0))
                    .h(px(84.0))
                    .p(px(10.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(10.0))
                    .bg(
                        if l.variant.contains("light") || l.variant.contains("white") {
                            gpui::rgb(0x2a2a2a)
                        } else {
                            gpui::rgb(0xf3efe7)
                        },
                    )
                    .border_1()
                    .border_color(th.border_subtle)
                    .cursor_pointer()
                    .hover(move |s| s.bg(s3))
                    .tooltip(tip(format!("{} · {}", l.name, l.variant), None))
                    .children(image.map(|im| img(im).max_w_full().max_h_full()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.insert_logo(url.clone(), name.clone(), cx)
                    })),
            );
        }
        div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .when(!kit.colors.is_empty(), |d| {
                d.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(section("Colors", None, th))
                        .child(colors),
                )
            })
            .when(
                kit.fonts.heading.is_some()
                    || kit.fonts.body.is_some()
                    || kit.fonts.accent.is_some(),
                |d| {
                    d.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.0))
                            .child(section("Fonts", None, th))
                            .child(fonts),
                    )
                },
            )
            .when(!kit.logos.is_empty(), |d| {
                d.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(section("Logos", None, th))
                        .child(logos),
                )
            })
    }
}

impl Render for BrandPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let status = cx
            .try_global::<Account>()
            .map(|a| a.status.clone())
            .unwrap_or(Status::Loading);
        let manage_url = Cloud::try_get(cx)
            .map(|c| format!("{}/brand", c.endpoints().app_url))
            .unwrap_or_default();
        let content: gpui::AnyElement = if status != Status::SignedIn {
            empty(
                "your brand, everywhere",
                "Sign in to use your brand kits: colors, fonts and logos from your Desyn account.",
                Some(
                    button("brand-signin", "Sign in", Variant::Primary, &th)
                        .on_click(|_, _, cx| Account::start_sign_in(cx))
                        .into_any_element(),
                ),
                &th,
            )
            .into_any_element()
        } else if Account::profile(cx).is_some_and(|p| !p.can("brandKit")) {
            let url = manage_url.replace("/brand", "/settings/billing");
            empty(
                "brand kits are pro",
                "Keep colors, fonts and logos in one place and apply them in a click with Desyn Pro.",
                Some(button("brand-upgrade", "See plans", Variant::Primary, &th).on_click(move |_, _, cx| cx.open_url(&url)).into_any_element()),
                &th,
            )
            .into_any_element()
        } else if self.loading && cached_kits(cx).is_none() {
            loading("brand-loading", "Loading brand kits…", &th).into_any_element()
        } else if let Some(e) = self.error.clone() {
            error_row(
                &e,
                Some(
                    button("brand-retry", "Try again", Variant::Secondary, &th)
                        .on_click(cx.listener(|this, _, _, cx| this.load(cx)))
                        .into_any_element(),
                ),
                &th,
            )
            .into_any_element()
        } else {
            let kits: Vec<BrandKit> = cx
                .try_global::<BrandCache>()
                .map(|c| c.kits.clone())
                .unwrap_or_default();
            if kits.is_empty() {
                let u = manage_url.clone();
                empty(
                    "no brand kit yet",
                    "Create a brand kit on the web with your colors, fonts and logos; it shows up here.",
                    Some(button("brand-create", "Create on the web", Variant::Secondary, &th).on_click(move |_, _, cx| cx.open_url(&u)).into_any_element()),
                    &th,
                )
                .into_any_element()
            } else {
                let sel = self.selected.min(kits.len() - 1);
                let kit = kits[sel].clone();
                let names: Vec<String> = kits.iter().map(|k| k.name.clone()).collect();
                let picker = select_button("brand-kit", kit.name.clone(), &th).on_click(
                    cx.listener(move |this, e: &gpui::ClickEvent, window, cx| {
                        let me = cx.entity().downgrade();
                        let entries = names
                            .iter()
                            .enumerate()
                            .map(|(i, n)| {
                                let me = me.clone();
                                crate::ui::menu::MenuEntry::run(n.clone(), move |_, cx| {
                                    let _ = me.update(cx, |this, cx| {
                                        this.selected = i;
                                        cx.notify();
                                    });
                                })
                            })
                            .collect();
                        let at = e.position();
                        this.editor
                            .update(cx, |ed, cx| ed.open_menu(entries, at, window, cx));
                    }),
                );
                let u = manage_url.clone();
                div()
                    .flex()
                    .flex_col()
                    .gap(px(14.0))
                    .when(kits.len() > 1, |d| d.child(picker))
                    .child(self.kit_view(&kit, &th, cx))
                    .child(
                        button(
                            "brand-manage",
                            "Edit brand kits on the web",
                            Variant::Ghost,
                            &th,
                        )
                        .w_full()
                        .on_click(move |_, _, cx| cx.open_url(&u)),
                    )
                    .into_any_element()
            }
        };
        frame(
            "brand",
            Some("kit"),
            Some("Click a color to apply it, a font to add text in it, a logo to place it."),
            &th,
        )
        .child(body("brand-body", content))
    }
}

/// Keeps the kit cache in sync with sign-in changes.
pub fn reset_on_sign_out(cx: &mut App) {
    if !Account::signed_in(cx) && cx.has_global::<BrandCache>() {
        cx.update_global::<BrandCache, _>(|c, _| {
            c.kits.clear();
            c.workspace = None;
        });
    }
}
