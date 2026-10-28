//! Comments side sheet (shift+C) for cloud designs: threads update live, new comments attach to the selected layer
//! (and its page), replies, resolve / reopen, delete your own; clicking a thread shows its layer on the canvas.

use std::collections::HashMap;

use gpui::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Task,
    Window, div, prelude::FluentBuilder, px,
};
use serde_json::json;

use crate::auth::Account;
use crate::cloud::Cloud;
use crate::cloud::api::{self, Thread, f};
use crate::ui::components::{Variant, button, icon, icon_button, t, tip};
use crate::ui::editor::EditorView;
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{MONO, SANS, SERIF, Theme, alpha};
use crate::widgets::{ago, avatar, empty, input_box, loading, notify};

/// The sheet.
pub struct CommentsSheet {
    editor: Entity<EditorView>,
    threads: Vec<Thread>,
    loaded: bool,
    error: Option<String>,
    include_resolved: bool,
    composer: Entity<TextField>,
    replies: HashMap<String, Entity<TextField>>,
    open_reply: Option<String>,
    sending: bool,
    focus: FocusHandle,
    live: Option<Task<()>>,
    _subs: Vec<Subscription>,
}

impl Focusable for CommentsSheet {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl CommentsSheet {
    /// A sheet for an editor.
    pub fn new(editor: Entity<EditorView>, cx: &mut Context<Self>) -> CommentsSheet {
        let composer = cx.new(|cx| {
            let mut f = TextField::new("Add a comment", cx);
            f.font_size = 13.0;
            f
        });
        let subs = vec![cx.subscribe(&composer, |this, _, e: &FieldEvent, cx| {
            if *e == FieldEvent::Confirm {
                this.post(cx);
            }
        })];
        let mut s = CommentsSheet {
            editor,
            threads: Vec::new(),
            loaded: false,
            error: None,
            include_resolved: false,
            composer,
            replies: HashMap::new(),
            open_reply: None,
            sending: false,
            focus: cx.focus_handle(),
            live: None,
            _subs: subs,
        };
        s.subscribe(cx);
        s
    }

    fn subscribe(&mut self, cx: &mut Context<Self>) {
        let Some(id) = crate::sync::design_id(&self.editor, cx) else {
            return;
        };
        let mut live = Cloud::get(cx).subscribe(
            f::COMMENTS_LIST,
            json!({ "designId": id, "includeResolved": self.include_resolved }),
        );
        self.live = Some(cx.spawn(async move |this, cx| {
            while let Some(r) = live.next().await {
                let res = r.and_then(api::decode::<Vec<Thread>>);
                if this
                    .update(cx, |this, cx| {
                        this.loaded = true;
                        match res {
                            Ok(t) => {
                                this.threads = t;
                                this.error = None;
                            }
                            Err(e) => {
                                this.error = Some(match e.code.as_str() {
                                    "FEATURE_UNAVAILABLE" => {
                                        "Comments are part of Desyn Pro.".into()
                                    }
                                    _ => e.friendly(),
                                })
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

    fn post(&mut self, cx: &mut Context<Self>) {
        let Some(id) = crate::sync::design_id(&self.editor, cx) else {
            return;
        };
        let body = self.composer.read(cx).text().trim().to_string();
        if body.is_empty() || self.sending {
            return;
        }
        let (node, page) = {
            let e = self.editor.read(cx);
            (e.session.selection.first().cloned(), e.session.page.clone())
        };
        let mut args = json!({ "designId": id, "body": body, "pageId": page });
        if let Some(n) = node {
            args["nodeId"] = json!(n);
        }
        self.sending = true;
        let m = Cloud::get(cx).mutation(f::COMMENTS_CREATE, args);
        cx.spawn(async move |this, cx| {
            let res = m.await;
            let _ = this.update(cx, |this, cx| {
                this.sending = false;
                match res {
                    Ok(_) => this.composer.update(cx, |f, cx| f.set_text("", cx)),
                    Err(e) => {
                        Account::handle_error(&e, cx);
                        notify(cx, format!("Couldn't post the comment: {}", e.friendly()));
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn reply(&mut self, thread: String, cx: &mut Context<Self>) {
        let Some(field) = self.replies.get(&thread).cloned() else {
            return;
        };
        let body = field.read(cx).text().trim().to_string();
        if body.is_empty() {
            return;
        }
        let m = Cloud::get(cx).mutation(
            f::COMMENTS_REPLY,
            json!({ "threadId": thread, "body": body }),
        );
        cx.spawn(async move |this, cx| {
            let res = m.await;
            let _ = this.update(cx, |this, cx| {
                match res {
                    Ok(_) => {
                        field.update(cx, |f, cx| f.set_text("", cx));
                        this.open_reply = None;
                    }
                    Err(e) => notify(cx, format!("Couldn't reply: {}", e.friendly())),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn resolve(&mut self, thread: String, resolved: bool, cx: &mut Context<Self>) {
        let m = Cloud::get(cx).mutation(
            f::COMMENTS_RESOLVE,
            json!({ "threadId": thread, "resolved": resolved }),
        );
        cx.spawn(async move |_, cx| {
            if let Err(e) = m.await {
                cx.update(|cx| notify(cx, e.friendly()));
            }
        })
        .detach();
    }

    fn delete(&mut self, comment: String, cx: &mut Context<Self>) {
        let m = Cloud::get(cx).mutation(f::COMMENTS_DELETE, json!({ "commentId": comment }));
        cx.spawn(async move |_, cx| {
            if let Err(e) = m.await {
                cx.update(|cx| notify(cx, e.friendly()));
            }
        })
        .detach();
    }

    fn reveal(&mut self, page: Option<String>, node: Option<String>, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| {
            if let Some(p) = &page {
                e.set_page(p, cx);
            }
            if let Some(n) = node.filter(|n| e.session.doc.design.node(n).is_some()) {
                e.select(vec![n], cx);
                e.session.zoom_to_selection();
                e.after(cx);
            }
        });
    }

    fn reply_field(
        &mut self,
        thread: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextField> {
        if let Some(f) = self.replies.get(thread) {
            return f.clone();
        }
        let f = cx.new(|cx| {
            let mut f = TextField::new("Reply", cx);
            f.font_size = 12.5;
            f
        });
        let tid = thread.to_string();
        let sub = cx.subscribe_in(&f, window, move |this, _, e: &FieldEvent, _, cx| {
            if *e == FieldEvent::Confirm {
                this.reply(tid.clone(), cx);
            }
        });
        self._subs.push(sub);
        self.replies.insert(thread.to_string(), f.clone());
        f
    }

    fn thread_card(
        &mut self,
        i: usize,
        th_: &Thread,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let me_id = Account::profile(cx).map(|p| p.user_id).unwrap_or_default();
        let viewer = cx.entity().entity_id();
        let open = self.open_reply.as_deref() == Some(th_.id.as_str());
        let reply_field = open.then(|| self.reply_field(&th_.id, window, cx));
        let (tid1, tid2, tid3) = (th_.id.clone(), th_.id.clone(), th_.id.clone());
        let resolved = th_.resolved;
        let (page, node) = (th_.page_id.clone(), th_.node_id.clone());
        let layer = node.as_ref().and_then(|n| {
            self.editor
                .read(cx)
                .session
                .doc
                .design
                .node(n)
                .map(|n| n.base().name.clone())
        });
        let mut comments = vec![(
            th_.id.clone(),
            th_.author.clone(),
            th_.body.clone(),
            th_.deleted,
            th_.created_at,
        )];
        comments.extend(th_.replies.iter().map(|r| {
            (
                r.id.clone(),
                r.author.clone(),
                r.body.clone(),
                r.deleted,
                r.created_at,
            )
        }));
        div()
            .id(("thread", i))
            .p(px(12.0))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .rounded(px(12.0))
            .bg(th.surface2)
            .border_1()
            .border_color(th.border_subtle)
            .when(resolved, |d| d.opacity(0.6))
            .when_some(layer, |d, l| {
                d.child(
                    div()
                        .id(("thread-layer", i))
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .cursor_pointer()
                        .child(icon("icons/scan.svg", 11.0, th.accent_text))
                        .child(
                            div()
                                .font_family(SANS)
                                .text_size(px(11.0))
                                .text_color(th.accent_text)
                                .child(l),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.reveal(page.clone(), node.clone(), cx)
                        })),
                )
            })
            .children(comments.into_iter().enumerate().map(
                |(j, (cid, author, body, deleted, at))| {
                    let initials: String = author
                        .name
                        .split_whitespace()
                        .filter_map(|w| w.chars().next())
                        .take(2)
                        .collect::<String>()
                        .to_uppercase();
                    let img = author
                        .image
                        .as_deref()
                        .and_then(|u| crate::cloud::images::image(u, viewer, cx));
                    let mine = author.id == me_id && !deleted;
                    div()
                        .flex()
                        .gap(px(10.0))
                        .child(avatar(
                            if initials.is_empty() { "?" } else { &initials },
                            th.accent_solid,
                            img,
                            24.0,
                            th,
                        ))
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.0))
                                .flex()
                                .flex_col()
                                .gap(px(2.0))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(8.0))
                                        .child(
                                            div()
                                                .font_family(SANS)
                                                .text_size(px(12.5))
                                                .font_weight(gpui::FontWeight(600.0))
                                                .text_color(th.fg)
                                                .child(author.name.clone()),
                                        )
                                        .child(
                                            div()
                                                .font_family(MONO)
                                                .text_size(px(10.5))
                                                .text_color(th.faint)
                                                .child(ago(at)),
                                        )
                                        .child(div().flex_1())
                                        .when(mine, |d| {
                                            d.child(
                                                icon_button(
                                                    SharedString::from(format!("c-del-{i}-{j}")),
                                                    "icons/trash-2.svg",
                                                    22.0,
                                                    false,
                                                    th,
                                                )
                                                .tooltip(tip("Delete", None))
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.delete(cid.clone(), cx)
                                                })),
                                            )
                                        }),
                                )
                                .child(
                                    div()
                                        .font_family(SANS)
                                        .text_size(px(13.0))
                                        .line_height(px(19.0))
                                        .text_color(if deleted { th.faint } else { th.fg })
                                        .child(if deleted {
                                            "Comment deleted".to_string()
                                        } else {
                                            body
                                        }),
                                ),
                        )
                },
            ))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(
                        div()
                            .id(("c-reply", i))
                            .font_family(SANS)
                            .text_size(px(12.0))
                            .text_color(th.accent_text)
                            .cursor_pointer()
                            .child("Reply")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_reply =
                                    if this.open_reply.as_deref() == Some(tid1.as_str()) {
                                        None
                                    } else {
                                        Some(tid1.clone())
                                    };
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id(("c-resolve", i))
                            .font_family(SANS)
                            .text_size(px(12.0))
                            .text_color(th.muted)
                            .cursor_pointer()
                            .child(if resolved { "Reopen" } else { "Resolve" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.resolve(tid2.clone(), !resolved, cx)
                            })),
                    ),
            )
            .children(reply_field.map(|f| {
                div()
                    .flex()
                    .gap(px(6.0))
                    .child(div().flex_1().child(input_box(f, th)))
                    .child(
                        button(
                            SharedString::from(format!("c-send-{i}")),
                            "Send",
                            Variant::Secondary,
                            th,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| this.reply(tid3.clone(), cx))),
                    )
            }))
    }
}

impl Render for CommentsSheet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let ed = self.editor.clone();
        let header = div()
            .flex_none()
            .px(px(18.0))
            .pt(px(16.0))
            .pb(px(10.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .font_family(SERIF)
                    .text_size(px(26.0))
                    .text_color(th.fg)
                    .child("comments"),
            )
            .child(div().flex_1())
            .child(
                div()
                    .id("c-filter")
                    .font_family(SANS)
                    .text_size(px(12.0))
                    .text_color(th.accent_text)
                    .cursor_pointer()
                    .child(if self.include_resolved {
                        "Hide resolved"
                    } else {
                        "Show resolved"
                    })
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.include_resolved = !this.include_resolved;
                        this.subscribe(cx);
                        cx.notify();
                    })),
            )
            .child(
                icon_button("c-close", "icons/x.svg", 28.0, false, &th)
                    .on_click(move |_, _, cx| crate::dialogs::close_sheet(&ed, cx)),
            );
        let body: gpui::AnyElement = if !Account::signed_in(cx) {
            empty(
                "talk it through",
                "Sign in to read and write comments on cloud designs.",
                Some(
                    button("c-signin", "Sign in", Variant::Primary, &th)
                        .on_click(|_, _, cx| Account::start_sign_in(cx))
                        .into_any_element(),
                ),
                &th,
            )
            .into_any_element()
        } else if crate::sync::design_id(&self.editor, cx).is_none() {
            empty(
                "comments live in the cloud",
                "Upload this design (Share › Upload) so your team can comment on it.",
                None,
                &th,
            )
            .into_any_element()
        } else {
            let selected = self
                .editor
                .read(cx)
                .session
                .selection
                .first()
                .and_then(|id| {
                    self.editor
                        .read(cx)
                        .session
                        .doc
                        .design
                        .node(id)
                        .map(|n| n.base().name.clone())
                });
            let threads = self.threads.clone();
            let cards: Vec<gpui::AnyElement> = threads
                .iter()
                .enumerate()
                .map(|(i, t)| self.thread_card(i, t, &th, window, cx).into_any_element())
                .collect();
            div()
                .flex()
                .flex_col()
                .gap(px(12.0))
                .child(
                    div()
                        .p(px(10.0))
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .rounded(px(12.0))
                        .bg(alpha(th.accent, 0.05))
                        .border_1()
                        .border_color(th.border_subtle)
                        .child(input_box(self.composer.clone(), &th))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .flex_1()
                                        .font_family(SANS)
                                        .text_size(px(11.0))
                                        .text_color(th.faint)
                                        .child(match &selected {
                                            Some(n) => format!("On “{n}”"),
                                            None => "On this page".to_string(),
                                        }),
                                )
                                .child(
                                    button(
                                        "c-post",
                                        if self.sending {
                                            "Posting…"
                                        } else {
                                            "Comment"
                                        },
                                        Variant::Primary,
                                        &th,
                                    )
                                    .on_click(cx.listener(|this, _, _, cx| this.post(cx))),
                                ),
                        ),
                )
                .children(self.error.clone().map(|e| {
                    div()
                        .font_family(SANS)
                        .text_size(px(12.0))
                        .text_color(th.danger)
                        .child(e)
                }))
                .when(!self.loaded, |d| {
                    d.child(loading("c-loading", "Loading comments…", &th))
                })
                .when(self.loaded && self.threads.is_empty(), |d| {
                    d.child(
                        div()
                            .pt(px(8.0))
                            .font_family(SANS)
                            .text_size(px(12.5))
                            .text_color(th.muted)
                            .child("No comments yet."),
                    )
                })
                .children(cards)
                .into_any_element()
        };
        div()
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .child(header)
            .child(
                div()
                    .id("comments-body")
                    .flex_1()
                    .min_h(px(0.0))
                    .overflow_y_scroll()
                    .px(px(14.0))
                    .pb(px(16.0))
                    .child(body),
            )
    }
}
