//! Uploads panel: add images / SVGs from disk (they become assets of the design and, for cloud designs, upload to
//! the workspace), reuse images already in this design, and browse the workspace's uploads in the cloud.

use desyn_core::model::{AssetKind, Id, Node};
use gpui::{
    App, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, ParentElement,
    Render, StatefulInteractiveElement, Styled, StyledImage, Window, div, img,
    prelude::FluentBuilder, px,
};
use serde_json::json;

use super::insert::{self, MediaInfo};
use super::{body, frame};
use crate::auth::Account;
use crate::cloud::api::{self, AssetView, Page, f};
use crate::cloud::{Cloud, images};
use crate::ui::components::{Variant, button, icon, t, tip};
use crate::ui::editor::{EditorEvent, EditorView};
use crate::ui::theme::{SANS, Theme};
use crate::widgets::{empty, error_row, loading, notify, section};

/// The panel.
pub struct UploadsPanel {
    editor: Entity<EditorView>,
    cloud: Vec<AssetView>,
    cursor: Option<String>,
    done: bool,
    loading: bool,
    error: Option<String>,
    focus: FocusHandle,
    _subs: Vec<gpui::Subscription>,
}

impl Focusable for UploadsPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl UploadsPanel {
    /// A panel for an editor.
    pub fn new(
        editor: Entity<EditorView>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> UploadsPanel {
        let subs = vec![
            cx.subscribe(&editor, |_, _, e: &EditorEvent, cx| {
                if matches!(e, EditorEvent::Changed(_)) {
                    cx.notify();
                }
            }),
            cx.observe_global::<Account>(|this, cx| {
                if Account::signed_in(cx) && this.cloud.is_empty() && !this.loading {
                    this.reload(cx);
                }
                cx.notify();
            }),
        ];
        let mut p = UploadsPanel {
            editor,
            cloud: Vec::new(),
            cursor: None,
            done: false,
            loading: false,
            error: None,
            focus: cx.focus_handle(),
            _subs: subs,
        };
        p.reload(cx);
        p
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        self.cloud.clear();
        self.cursor = None;
        self.done = false;
        self.more(cx);
    }

    fn more(&mut self, cx: &mut Context<Self>) {
        let Some(ws) = Account::workspace_id(cx) else {
            return;
        };
        if self.done || self.loading {
            return;
        }
        self.loading = true;
        self.error = None;
        let q = Cloud::get(cx).query(f::ASSET_LIST, json!({ "workspaceId": ws, "kind": "image", "paginationOpts": api::page(30, self.cursor.as_deref()) }));
        cx.spawn(async move |this, cx| {
            let res = q.await.and_then(api::decode::<Page<AssetView>>);
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match res {
                    Ok(p) => {
                        this.cloud
                            .extend(p.page.into_iter().filter(|a| a.status == "ready"));
                        this.cursor = p.continue_cursor;
                        this.done = p.is_done || this.cursor.is_none();
                    }
                    Err(e) => {
                        Account::handle_error(&e, cx);
                        this.error = Some(e.friendly());
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn pick_files(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Upload".into()),
        });
        let editor = self.editor.clone();
        cx.spawn(async move |_, cx| {
            let Ok(Ok(Some(paths))) = rx.await else {
                return;
            };
            cx.update(|cx| {
                editor.update(cx, |e, cx| {
                    let at = {
                        let c = super::insert::view_center(e);
                        e.session.camera.to_screen(c)
                    };
                    e.import_paths(paths, Some(at), cx);
                });
            });
        })
        .detach();
    }

    fn reuse(&mut self, asset: Id, cx: &mut Context<Self>) {
        let (node, ok) = self.editor.update(cx, |e, _| {
            let Some(a) = e.session.doc.design.assets.get(&asset).cloned() else {
                return (None, false);
            };
            let (w, h) = (a.width.unwrap_or(400.0), a.height.unwrap_or(300.0));
            let (fw, fh) = super::insert::fit(e, w, h, 0.6);
            let id = e.session.doc.new_id();
            let name = a.name.clone().unwrap_or_else(|| "Image".into());
            let n = if a.kind == AssetKind::Svg {
                Node::svg(id, name, asset.clone(), 0.0, 0.0, fw, fh)
            } else {
                Node::image(id, name, asset.clone(), 0.0, 0.0, fw, fh)
            };
            (Some(n), true)
        });
        if let (Some(n), true) = (node, ok) {
            insert::insert(&self.editor, vec![vec![n]], Vec::new(), "Add image", cx);
        }
    }

    fn insert_cloud(&mut self, a: AssetView, cx: &mut Context<Self>) {
        let Some(url) = a.url.clone() else { return };
        let fetch = Cloud::get(cx).fetch_bytes(&url, crate::cloud::http::MAX_DOWNLOAD);
        let editor = self.editor.clone();
        cx.spawn(async move |_, cx| {
            let res = fetch.await;
            cx.update(|cx| match res {
                Ok((bytes, _)) => {
                    if insert::insert_image(&editor, bytes, &a.name, MediaInfo::default(), cx)
                        .is_none()
                    {
                        notify(cx, "That file could not be read as an image.".into());
                    }
                }
                Err(e) => notify(
                    cx,
                    format!("Couldn't download “{}”: {}", a.name, e.friendly()),
                ),
            });
        })
        .detach();
    }
}

fn thumb_box(id: impl Into<gpui::ElementId>, th: &Theme) -> gpui::Stateful<gpui::Div> {
    let b = th.accent;
    div()
        .id(id)
        .w(px(87.0))
        .h(px(87.0))
        .rounded(px(9.0))
        .overflow_hidden()
        .bg(th.surface2)
        .border_1()
        .border_color(th.border_subtle)
        .cursor_pointer()
        .hover(move |s| s.border_color(b))
        .flex()
        .items_center()
        .justify_center()
}

impl Render for UploadsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let upload = button("upload-files", "Upload files", Variant::Primary, &th)
            .w_full()
            .h(px(38.0))
            .child(icon("icons/upload.svg", 14.0, th.accent_ink))
            .on_click(cx.listener(|this, _, _, cx| this.pick_files(cx)));
        let local: Vec<(Id, std::sync::Arc<[u8]>, String)> = {
            let e = self.editor.read(cx);
            e.session
                .doc
                .design
                .assets
                .iter()
                .filter(|(_, a)| matches!(a.kind, AssetKind::Image | AssetKind::Svg))
                .filter_map(|(id, a)| {
                    e.session
                        .doc
                        .assets
                        .get(id)
                        .map(|b| (id.clone(), b.clone(), a.name.clone().unwrap_or_default()))
                })
                .collect()
        };
        let mut local_grid = div().flex().flex_wrap().gap(px(8.0));
        for (i, (id, bytes, name)) in local.iter().enumerate() {
            let preview = images::from_bytes(bytes);
            let id2 = id.clone();
            local_grid = local_grid.child(
                thumb_box(("local-asset", i), &th)
                    .tooltip(tip(
                        if name.is_empty() {
                            "Image".to_string()
                        } else {
                            name.clone()
                        },
                        None,
                    ))
                    .children(
                        preview.map(|p| img(p).size_full().object_fit(gpui::ObjectFit::Cover)),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.reuse(id2.clone(), cx))),
            );
        }
        let me = cx.entity().entity_id();
        let mut cloud_grid = div().flex().flex_wrap().gap(px(8.0));
        for (i, a) in self.cloud.clone().into_iter().enumerate() {
            let image = a.url.as_deref().and_then(|u| images::image(u, me, cx));
            let name = a.name.clone();
            cloud_grid = cloud_grid.child(
                thumb_box(("cloud-asset", i), &th)
                    .tooltip(tip(name, None))
                    .children(image.map(|p| img(p).size_full().object_fit(gpui::ObjectFit::Cover)))
                    .on_click(cx.listener(move |this, _, _, cx| this.insert_cloud(a.clone(), cx))),
            );
        }
        let signed = Account::signed_in(cx);
        let content = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(upload)
            .child(
                div()
                    .font_family(SANS)
                    .text_size(px(11.5))
                    .text_color(th.faint)
                    .child("PNG, JPEG, WebP, GIF or SVG. You can also drop files on the canvas."),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(section("In this design", None, &th))
                    .child(if local.is_empty() {
                        div()
                            .font_family(SANS)
                            .text_size(px(12.0))
                            .text_color(th.muted)
                            .child("No images yet.")
                            .into_any_element()
                    } else {
                        local_grid.into_any_element()
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(section("Your uploads", None, &th))
                    .child(if !signed {
                        empty(
                            "in your cloud",
                            "Sign in to reuse images you uploaded to Desyn on any device.",
                            Some(
                                button("uploads-signin", "Sign in", Variant::Secondary, &th)
                                    .on_click(|_, _, cx| Account::start_sign_in(cx))
                                    .into_any_element(),
                            ),
                            &th,
                        )
                        .into_any_element()
                    } else if let Some(e) = self.error.clone() {
                        error_row(
                            &e,
                            Some(
                                button("uploads-retry", "Try again", Variant::Secondary, &th)
                                    .on_click(cx.listener(|this, _, _, cx| this.reload(cx)))
                                    .into_any_element(),
                            ),
                            &th,
                        )
                        .into_any_element()
                    } else if self.cloud.is_empty() && !self.loading {
                        div()
                            .font_family(SANS)
                            .text_size(px(12.0))
                            .text_color(th.muted)
                            .child("Nothing uploaded to the cloud yet.")
                            .into_any_element()
                    } else {
                        cloud_grid.into_any_element()
                    }),
            )
            .when(self.loading, |d| {
                d.child(loading("uploads-loading", "Loading uploads…", &th))
            })
            .when(
                signed && !self.done && !self.loading && !self.cloud.is_empty(),
                |d| {
                    d.child(
                        button("uploads-more", "Show more", Variant::Ghost, &th)
                            .w_full()
                            .on_click(cx.listener(|this, _, _, cx| this.more(cx))),
                    )
                },
            );
        frame("your", Some("uploads"), None, &th).child(body("uploads-body", content))
    }
}
