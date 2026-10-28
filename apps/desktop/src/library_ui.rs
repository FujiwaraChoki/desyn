//! The cloud section of the start screen: signed out, a sign-in card (browser or email); signed in, the most recent
//! cloud designs of the workspace (live, with thumbnails), new cloud designs from popular sizes, and the designs
//! kept offline on this computer when the cloud cannot be reached.

use gpui::{
    App, AppContext, Context, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, StyledImage,
    Subscription, Task, Window, div, img, prelude::FluentBuilder, px,
};
use serde_json::json;

use crate::auth::ui::SignInCard;
use crate::auth::{Account, Status};
use crate::cloud::api::{self, DesignSummary, Page, f};
use crate::cloud::{Cloud, CloudError, Connection, images};
use crate::sync::cache;
use crate::ui::components::{Variant, button, icon, label, serif, sun_mark, t, tip};
use crate::ui::ext::Extensions;
use crate::ui::theme::{MONO, SANS, Theme, alpha};
use crate::widgets::{ago, notify, spinner};

/// Popular sizes for new cloud designs: (preset id, label, design kind — names the design on the server).
const NEW: &[(&str, &str, &str)] = &[
    ("instagram-post", "Instagram post", "social-post"),
    ("instagram-story", "Story", "story"),
    ("presentation-16-9", "Presentation", "presentation"),
    ("document-a4", "A4 document", "document"),
];

fn kind_of(preset: &str) -> &'static str {
    NEW.iter()
        .find(|(id, ..)| *id == preset)
        .map_or("custom", |(.., kind)| kind)
}

/// Registers the section.
pub fn install(cx: &mut App) {
    Extensions::update(cx, |x| {
        x.home_section(10, |window, cx| {
            cx.new(|cx| CloudLibrary::new(window, cx)).into()
        });
    });
}

/// The section.
pub struct CloudLibrary {
    designs: Vec<DesignSummary>,
    loaded: bool,
    error: Option<String>,
    creating: Option<String>,
    sign_in: gpui::Entity<SignInCard>,
    live: Option<Task<()>>,
    live_for: Option<String>,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl Focusable for CloudLibrary {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl CloudLibrary {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> CloudLibrary {
        let sign_in = cx.new(|cx| {
            let mut c = SignInCard::new(window, cx);
            c.compact = true;
            c
        });
        let subs = vec![
            cx.observe_global::<Account>(|this, cx| {
                this.follow(cx);
                cx.notify();
            }),
            cx.observe_global::<Cloud>(|_, cx| cx.notify()),
        ];
        let mut s = CloudLibrary {
            designs: Vec::new(),
            loaded: false,
            error: None,
            creating: None,
            sign_in,
            live: None,
            live_for: None,
            focus: cx.focus_handle(),
            _subs: subs,
        };
        s.follow(cx);
        s
    }

    /// Subscribes to the workspace's recent designs (once per workspace).
    fn follow(&mut self, cx: &mut Context<Self>) {
        let ws = Account::workspace_id(cx).filter(|_| Account::signed_in(cx));
        if ws == self.live_for {
            return;
        }
        self.live_for = ws.clone();
        self.designs.clear();
        self.loaded = false;
        let Some(ws) = ws else {
            self.live = None;
            return;
        };
        log::debug!("following cloud designs of workspace {ws}");
        let mut live = Cloud::get(cx).subscribe(
            f::DESIGNS_LIST,
            json!({ "workspaceId": ws, "filter": "recent", "paginationOpts": api::page(12, None) }),
        );
        self.live = Some(cx.spawn(async move |this, cx| {
            while let Some(r) = live.next().await {
                let res = r.and_then(api::decode::<Page<DesignSummary>>);
                if this
                    .update(cx, |this, cx| {
                        this.loaded = true;
                        match res {
                            Ok(p) => {
                                this.designs = p.page;
                                this.error = None;
                            }
                            Err(e) => {
                                log::warn!("cloud designs: {e}");
                                Account::handle_error(&e, cx);
                                this.error = Some(e.friendly());
                            }
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
    }

    fn create(&mut self, preset: &str, cx: &mut Context<Self>) {
        let Some(ws) = Account::workspace_id(cx) else {
            return;
        };
        self.creating = Some(preset.to_string());
        let m = Cloud::get(cx).mutation(
            f::DESIGNS_CREATE,
            json!({ "workspaceId": ws, "presetId": preset, "kind": kind_of(preset) }),
        );
        cx.spawn(async move |this, cx| {
            let res = m.await;
            let _ = this.update(cx, |this, cx| {
                this.creating = None;
                match res.and_then(|v| {
                    v.get("designId")
                        .and_then(|d| d.as_str())
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
        cx.notify();
    }

    fn card(
        &self,
        i: usize,
        d: &DesignSummary,
        th: &Theme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let w = 200.0f32;
        let aspect = if d.width > 0.0 {
            (d.height / d.width).clamp(0.45, 1.6) as f32
        } else {
            1.0
        };
        let h = (w * aspect).min(240.0);
        let image = d
            .thumbnail_url
            .as_deref()
            .and_then(|u| images::image(u, cx.entity().entity_id(), cx));
        let id = d.id.clone();
        let accent = th.accent;
        div()
            .id(("cloud-design", i))
            .w(px(w))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .cursor_pointer()
            .child(
                div()
                    .w(px(w))
                    .h(px(h))
                    .rounded(px(12.0))
                    .overflow_hidden()
                    .bg(th.surface2)
                    .border_1()
                    .border_color(th.border_subtle)
                    .hover(move |s| s.border_color(accent))
                    .flex()
                    .items_center()
                    .justify_center()
                    .map(|el| match image {
                        Some(im) => {
                            el.child(img(im).size_full().object_fit(gpui::ObjectFit::Cover))
                        }
                        None => el.child(icon("icons/cloud.svg", 22.0, th.faint)),
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .truncate()
                            .font_family(SANS)
                            .text_size(px(13.0))
                            .text_color(th.fg)
                            .child(if d.name.is_empty() {
                                "Untitled design".to_string()
                            } else {
                                d.name.clone()
                            }),
                    )
                    .child(
                        div()
                            .font_family(MONO)
                            .text_size(px(10.5))
                            .text_color(th.faint)
                            .child(format!("{} · {}", ago(d.updated_at), d.kind)),
                    ),
            )
            .on_click(move |_, _, cx| crate::sync::open_cloud_design(id.clone(), cx))
    }
}

impl Render for CloudLibrary {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let status = cx
            .try_global::<Account>()
            .map(|a| a.status.clone())
            .unwrap_or(Status::Loading);
        let host = Cloud::try_get(cx)
            .map(|c| c.endpoints().display_host())
            .unwrap_or_default();
        let offline = Cloud::try_get(cx).is_some_and(|c| c.connection == Connection::Connecting);
        let header = div()
            .flex()
            .items_center()
            .gap(px(12.0))
            .child(label("Your cloud", &th))
            .child(
                div()
                    .font_family(MONO)
                    .text_size(px(11.0))
                    .text_color(th.faint)
                    .child(host.clone()),
            )
            .when(offline && status == Status::SignedIn, |d| {
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(icon("icons/cloud-off.svg", 12.0, th.accent_text))
                        .child(
                            div()
                                .font_family(SANS)
                                .text_size(px(11.5))
                                .text_color(th.accent_text)
                                .child("Offline"),
                        ),
                )
            })
            .child(div().flex_1());
        let body: gpui::AnyElement = match status {
            Status::Loading => div().py(px(12.0)).child(spinner("cloud-lib-loading", 10.0, &th)).into_any_element(),
            Status::SignedOut | Status::Waiting { .. } => div()
                .p(px(24.0))
                .flex()
                .gap(px(36.0))
                .rounded(px(16.0))
                .bg(th.surface1)
                .border_1()
                .border_color(th.border_subtle)
                .child(
                    div()
                        .w(px(380.0))
                        .flex_none()
                        .flex()
                        .flex_col()
                        .gap(px(14.0))
                        .child(sun_mark(26.0, &th))
                        .child(
                            div()
                                .flex()
                                .items_baseline()
                                .gap(px(8.0))
                                .child(serif("your designs,", 34.0, th.fg))
                                .child(div().font_family(crate::ui::theme::SERIF).italic().text_size(px(34.0)).text_color(th.accent_text).child("everywhere")),
                        )
                        .child(div().font_family(SANS).text_size(px(13.5)).line_height(px(21.0)).text_color(th.muted).child(
                            "Sign in to open designs from the web and your phone, work on them together, share links and use the AI. Everything also works offline.",
                        )),
                )
                .child(div().flex_1().max_w(px(420.0)).child(self.sign_in.clone()))
                .into_any_element(),
            Status::SignedIn => {
                let who = Account::display_name(cx).unwrap_or_default();
                let cards: Vec<gpui::AnyElement> = self.designs.clone().iter().enumerate().map(|(i, d)| self.card(i, d, &th, cx).into_any_element()).collect();
                let cached: Vec<cache::CacheMeta> = if self.designs.is_empty() && (offline || self.error.is_some()) {
                    let data = cx.try_global::<crate::ui::app::AppState>().map(|s| s.paths.data_dir.clone());
                    data.map(|d| cache::list(&cache::server_dir(&d, &Cloud::get(cx).endpoints().convex_url))).unwrap_or_default()
                } else {
                    Vec::new()
                };
                let new_row = div().flex().items_center().gap(px(8.0)).child(div().font_family(SANS).text_size(px(12.5)).text_color(th.muted).child("New in the cloud:")).children(NEW.iter().map(|(id, l, _)| {
                    let busy = self.creating.as_deref() == Some(*id);
                    button(SharedString::from(format!("new-cloud-{id}")), if busy { "Creating…".to_string() } else { l.to_string() }, Variant::Secondary, &th)
                        .h(px(30.0))
                        .on_click(cx.listener(move |this, _, _, cx| this.create(id, cx)))
                }));
                div()
                    .flex()
                    .flex_col()
                    .gap(px(16.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .child(div().font_family(SANS).text_size(px(13.0)).text_color(th.muted).child(format!("Signed in as {who}")))
                            .child(div().flex_1())
                            .child(
                                button("cloud-web", "Open on the web", Variant::Ghost, &th)
                                    .tooltip(tip("All your designs, folders and team in the browser", None))
                                    .on_click(|_, _, cx| {
                                        let u = Cloud::get(cx).endpoints().app_url.clone();
                                        cx.open_url(&u)
                                    }),
                            )
                            .child(button("cloud-signout", "Sign out", Variant::Ghost, &th).on_click(|_, _, cx| Account::sign_out(cx))),
                    )
                    .child(new_row)
                    .child(if !self.loaded && cached.is_empty() {
                        div().py(px(20.0)).flex().items_center().gap(px(10.0)).child(spinner("cloud-list", 10.0, &th)).child(div().font_family(SANS).text_size(px(12.5)).text_color(th.muted).child("Loading your designs…")).into_any_element()
                    } else if !cards.is_empty() {
                        div().flex().flex_wrap().gap(px(18.0)).children(cards).into_any_element()
                    } else if !cached.is_empty() {
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(10.0))
                            .child(div().font_family(SANS).text_size(px(12.5)).text_color(th.muted).child("Available offline on this computer:"))
                            .child(div().flex().flex_wrap().gap(px(10.0)).children(cached.into_iter().enumerate().map(|(i, m)| {
                                let id = m.design_id.clone();
                                let s3 = th.surface3;
                                div()
                                    .id(("cached-design", i))
                                    .px(px(14.0))
                                    .py(px(10.0))
                                    .rounded(px(10.0))
                                    .bg(th.surface1)
                                    .border_1()
                                    .border_color(th.border_subtle)
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(s3))
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .child(icon("icons/cloud-off.svg", 13.0, th.faint))
                                    .child(div().font_family(SANS).text_size(px(13.0)).text_color(th.fg).child(if m.name.is_empty() { "Untitled design".to_string() } else { m.name.clone() }))
                                    .on_click(move |_, _, cx| crate::sync::open_cloud_design(id.clone(), cx))
                            })))
                            .into_any_element()
                    } else {
                        div()
                            .py(px(28.0))
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(8.0))
                            .rounded(px(14.0))
                            .border_1()
                            .border_dashed()
                            .border_color(th.border_subtle)
                            .bg(alpha(th.accent, 0.02))
                            .child(serif("nothing in the cloud yet", 24.0, th.fg))
                            .child(div().font_family(SANS).text_size(px(13.0)).text_color(th.muted).child(match &self.error {
                                Some(e) => e.clone(),
                                None => "Create one above, or upload a local design from its Share button.".into(),
                            }))
                            .into_any_element()
                    })
                    .into_any_element()
            }
        };
        div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(header)
            .child(body)
    }
}
