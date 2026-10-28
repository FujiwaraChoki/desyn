//! Photos panel: free stock photos (Unsplash, Pexels) searched through the Desyn backend (the API keys stay on the
//! server), inserted with their attribution recorded on the asset; Unsplash downloads are reported as its API
//! guidelines require.

use desyn_core::model::{AssetSource, Attribution};
use gpui::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, StyledImage,
    Subscription, Task, Window, div, img, prelude::FluentBuilder, px,
};
use serde_json::{Value, json};

use super::insert::{self, MediaInfo};
use super::{body, frame};
use crate::auth::Account;
use crate::cloud::api::{self, StockPhoto, f};
use crate::cloud::{Cloud, images, runtime};
use crate::ui::components::{Variant, button, t, tip};
use crate::ui::editor::EditorView;
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{SANS, Theme, alpha};
use crate::widgets::{Seg, empty, error_row, loading, notify, search_box, segmented, spinner};

const SUGGESTIONS: &[&str] = &[
    "sunset",
    "coffee",
    "mountains",
    "office",
    "texture",
    "flowers",
    "city night",
    "ocean",
];

/// The panel.
pub struct PhotosPanel {
    editor: Entity<EditorView>,
    search: Entity<TextField>,
    orientation: Option<String>,
    photos: Vec<StockPhoto>,
    page: u32,
    loading: bool,
    error: Option<String>,
    inserting: Option<String>,
    request: u64,
    debounce: Option<Task<()>>,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl Focusable for PhotosPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl PhotosPanel {
    /// A panel for an editor.
    pub fn new(
        editor: Entity<EditorView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> PhotosPanel {
        let search = cx.new(|cx| {
            let mut f = TextField::new("Search free photos", cx);
            f.font_size = 13.0;
            f
        });
        let subs = vec![
            cx.subscribe_in(&search, window, |this, _, e: &FieldEvent, _, cx| match e {
                FieldEvent::Changed(_) => {
                    this.debounce = Some(cx.spawn(async move |this, cx| {
                        runtime::sleep(std::time::Duration::from_millis(400)).await;
                        let _ = this.update(cx, |this, cx| this.run(true, cx));
                    }));
                }
                FieldEvent::Confirm => this.run(true, cx),
                _ => {}
            }),
            cx.observe_global::<Account>(|_, cx| cx.notify()),
        ];
        PhotosPanel {
            editor,
            search,
            orientation: None,
            photos: Vec::new(),
            page: 1,
            loading: false,
            error: None,
            inserting: None,
            request: 0,
            debounce: None,
            focus: cx.focus_handle(),
            _subs: subs,
        }
    }

    fn run(&mut self, fresh: bool, cx: &mut Context<Self>) {
        let q = self.search.read(cx).text().trim().to_string();
        if q.is_empty() || !Account::signed_in(cx) {
            if fresh {
                self.photos.clear();
                cx.notify();
            }
            return;
        }
        if fresh {
            self.photos.clear();
            self.page = 1;
        }
        self.request += 1;
        let req = self.request;
        self.loading = true;
        self.error = None;
        let mut args = json!({ "query": q, "page": self.page, "count": 24 });
        if let Some(o) = &self.orientation {
            args["orientation"] = json!(o);
        }
        let call = Cloud::get(cx).action(f::STOCK_SEARCH, args);
        cx.spawn(async move |this, cx| {
            let res = call.await;
            let _ = this.update(cx, |this, cx| {
                if this.request != req {
                    return;
                }
                this.loading = false;
                match res.and_then(|v| {
                    api::decode::<Vec<StockPhoto>>(v.get("photos").cloned().unwrap_or(Value::Null))
                }) {
                    Ok(p) => {
                        this.photos.extend(p);
                        this.page += 1;
                    }
                    Err(e) => {
                        Account::handle_error(&e, cx);
                        this.error = Some(match e.code.as_str() {
                            "NOT_CONFIGURED" => {
                                "Stock photos are not set up on this server.".into()
                            }
                            _ => e.friendly(),
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn insert(&mut self, p: StockPhoto, cx: &mut Context<Self>) {
        if self.inserting.is_some() {
            return;
        }
        self.inserting = Some(p.id.clone());
        cx.notify();
        let cloud = Cloud::get(cx);
        if p.download_location.is_some() {
            let track = cloud.action(
                f::STOCK_TRACK,
                json!({ "id": p.id, "downloadLocation": p.download_location }),
            );
            cx.background_spawn(async move {
                let _ = track.await;
            })
            .detach();
        }
        let fetch = cloud.fetch_bytes(&p.url, crate::cloud::http::MAX_DOWNLOAD);
        let editor = self.editor.clone();
        cx.spawn(async move |this, cx| {
            let res = fetch.await;
            let _ = this.update(cx, |this, cx| {
                this.inserting = None;
                match res {
                    Ok((bytes, _)) => {
                        let provider = if p.provider == "pexels" {
                            "Pexels"
                        } else {
                            "Unsplash"
                        };
                        let info = MediaInfo {
                            source: Some(AssetSource::Stock),
                            attribution: Some(Attribution {
                                author: Some(p.author.clone()),
                                license: Some(p.license.clone()),
                                url: Some(p.source_url.clone()),
                                ..Default::default()
                            }),
                            alt: Some(p.description.clone()).filter(|d| !d.is_empty()),
                        };
                        let name = format!("Photo by {} on {provider}", p.author);
                        if insert::insert_image(&editor, bytes, &name, info, cx).is_none() {
                            notify(cx, "That photo could not be read.".into());
                        }
                    }
                    Err(e) => notify(cx, format!("Couldn't download the photo: {}", e.friendly())),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn photo(
        &self,
        i: usize,
        p: &StockPhoto,
        w: f32,
        th: &Theme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let h = (w as f64 * p.height / p.width.max(1.0)).clamp(60.0, 420.0) as f32;
        let image = images::image(&p.thumb_url, cx.entity().entity_id(), cx);
        let busy = self.inserting.as_deref() == Some(p.id.as_str());
        let color = p
            .color
            .as_deref()
            .map(crate::widgets::hsla)
            .unwrap_or(th.surface2);
        let p2 = p.clone();
        let provider = if p.provider == "pexels" {
            "Pexels"
        } else {
            "Unsplash"
        };
        let author_url = p.author_url.clone();
        div()
            .id(("photo", i))
            .relative()
            .w(px(w))
            .h(px(h))
            .rounded(px(9.0))
            .overflow_hidden()
            .bg(color)
            .cursor_pointer()
            .group("photo")
            .tooltip(tip(
                format!(
                    "{} · {} on {provider}",
                    if p.description.is_empty() {
                        "Photo"
                    } else {
                        &p.description
                    },
                    p.author
                ),
                None,
            ))
            .children(image.map(|im| img(im).size_full().object_fit(gpui::ObjectFit::Cover)))
            .child(
                div()
                    .id(("photo-credit", i))
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .px(px(7.0))
                    .py(px(4.0))
                    .bg(alpha(gpui::black(), 0.55))
                    .invisible()
                    .group_hover("photo", |s| s.visible())
                    .truncate()
                    .font_family(SANS)
                    .text_size(px(10.0))
                    .text_color(gpui::white())
                    .child(p.author.clone())
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        crate::widgets::open_web_url(&author_url, cx)
                    }),
            )
            .when(busy, |d| {
                d.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(alpha(gpui::black(), 0.35))
                        .child(spinner(format!("photo-busy-{i}"), 14.0, th)),
                )
            })
            .on_click(cx.listener(move |this, _, _, cx| this.insert(p2.clone(), cx)))
    }
}

impl Render for PhotosPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        if !Account::signed_in(cx) {
            let content = empty(
                "millions of photos",
                "Sign in to search free Unsplash and Pexels photos. The search runs through your Desyn account.",
                Some(
                    button("photos-signin", "Sign in", Variant::Primary, &th)
                        .on_click(|_, _, cx| Account::start_sign_in(cx))
                        .into_any_element(),
                ),
                &th,
            );
            return frame("free", Some("photos"), None, &th).child(body("photos-body", content));
        }
        let w = (320.0 - 36.0 - 8.0) / 2.0;
        let mut cols = [
            div().flex().flex_col().gap(px(8.0)).w(px(w)),
            div().flex().flex_col().gap(px(8.0)).w(px(w)),
        ];
        let mut heights = [0.0f32; 2];
        for (i, p) in self.photos.clone().iter().enumerate() {
            let k = if heights[0] <= heights[1] { 0 } else { 1 };
            heights[k] += (w as f64 * p.height / p.width.max(1.0)).clamp(60.0, 420.0) as f32 + 8.0;
            let el = self.photo(i, p, w, &th, cx);
            let c = std::mem::replace(&mut cols[k], div());
            cols[k] = c.child(el);
        }
        let [c0, c1] = cols;
        let me = cx.entity().downgrade();
        let orient = segmented(
            "photo-orient",
            vec![
                (None, Seg::Text("Any".into())),
                (Some("landscape".to_string()), Seg::Text("Wide".into())),
                (Some("portrait".to_string()), Seg::Text("Tall".into())),
                (Some("square".to_string()), Seg::Text("Square".into())),
            ],
            Some(&self.orientation),
            &th,
            move |o, _, cx| {
                let _ = me.update(cx, |this, cx| {
                    this.orientation = o;
                    this.run(true, cx);
                });
            },
        );
        let query_empty = self.search.read(cx).text().trim().is_empty();
        let suggestions =
            div()
                .flex()
                .flex_wrap()
                .gap(px(6.0))
                .children(SUGGESTIONS.iter().enumerate().map(|(i, s)| {
                    let s3 = th.surface3;
                    div()
                        .id(("photo-suggest", i))
                        .px(px(10.0))
                        .h(px(26.0))
                        .flex()
                        .items_center()
                        .rounded(px(999.0))
                        .border_1()
                        .border_color(th.border_subtle)
                        .cursor_pointer()
                        .hover(move |st| st.bg(s3))
                        .font_family(SANS)
                        .text_size(px(11.5))
                        .text_color(th.muted)
                        .child(SharedString::from(*s))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.search.update(cx, |f, cx| f.set_text(s, cx));
                            this.run(true, cx);
                        }))
                }));
        let content = div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(search_box(self.search.clone(), &th))
            .child(orient)
            .when(query_empty, |d| d.child(suggestions))
            .children(self.error.clone().map(|e| {
                error_row(
                    &e,
                    Some(
                        button("photos-retry", "Try again", Variant::Secondary, &th)
                            .on_click(cx.listener(|this, _, _, cx| this.run(true, cx)))
                            .into_any_element(),
                    ),
                    &th,
                )
            }))
            .child(div().flex().gap(px(8.0)).child(c0).child(c1))
            .when(self.loading, |d| {
                d.child(loading("photos-loading", "Finding photos…", &th))
            })
            .when(!self.loading && !self.photos.is_empty(), |d| {
                d.child(
                    button("photos-more", "More photos", Variant::Ghost, &th)
                        .w_full()
                        .on_click(cx.listener(|this, _, _, cx| this.run(false, cx))),
                )
            })
            .when(
                !query_empty && !self.loading && self.photos.is_empty() && self.error.is_none(),
                |d| d.child(empty("no photos found", "Try a broader word.", None, &th)),
            )
            .child(
                div()
                    .font_family(SANS)
                    .text_size(px(10.5))
                    .text_color(th.faint)
                    .child("Photos from Unsplash and Pexels. Credit is saved with each image."),
            );
        frame("free", Some("photos"), None, &th).child(body("photos-body", content))
    }
}
