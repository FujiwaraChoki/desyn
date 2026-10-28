//! Share dialog: for cloud designs, the team link and public share links (view / comment / edit, optional password
//! and expiry) to create, copy and revoke; local designs are uploaded first (they stay linked to their file).

use gpui::{
    App, AppContext, ClipboardItem, Context, Entity, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window,
    div, prelude::FluentBuilder, px,
};
use serde_json::{Value, json};

use crate::auth::Account;
use crate::cloud::api::{self, ShareLink, f};
use crate::cloud::{Cloud, CloudError};
use crate::ui::components::{Variant, button, icon, icon_button, label, t, tip};
use crate::ui::editor::EditorView;
use crate::ui::text_field::TextField;
use crate::ui::theme::{MONO, SANS, Theme, alpha};
use crate::widgets::{Seg, error_row, input_box, loading, notify, row, segmented, spinner, toggle};

/// The dialog.
pub struct ShareDialog {
    editor: Entity<EditorView>,
    links: Vec<ShareLink>,
    loading: bool,
    busy: bool,
    error: Option<String>,
    permission: String,
    use_password: bool,
    password: Entity<TextField>,
    expires_days: Option<u32>,
    loaded: bool,
    focus: FocusHandle,
}

impl Focusable for ShareDialog {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl ShareDialog {
    /// A dialog for an editor.
    pub fn new(
        editor: Entity<EditorView>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ShareDialog {
        let password = cx.new(|cx| {
            let mut f = TextField::new("Password", cx);
            f.font_size = 13.0;
            f.masked = true;
            f
        });
        let mut d = ShareDialog {
            editor,
            links: Vec::new(),
            loading: false,
            busy: false,
            error: None,
            permission: "view".into(),
            use_password: false,
            password,
            expires_days: None,
            loaded: false,
            focus: cx.focus_handle(),
        };
        d.load(cx);
        d
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(id) = crate::sync::design_id(&self.editor, cx) else {
            return;
        };
        self.loading = true;
        let q = Cloud::get(cx).query(f::LIST_SHARES, json!({ "designId": id }));
        cx.spawn(async move |this, cx| {
            let res = q.await.and_then(api::decode::<Vec<ShareLink>>);
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                this.loaded = true;
                match res {
                    Ok(l) => this.links = l.into_iter().filter(|l| !l.expired).collect(),
                    // Editors without the manage permission cannot list links; they can still copy the team link.
                    Err(e) if e.code == "FORBIDDEN" => {}
                    Err(e) => this.error = Some(e.friendly()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn upload(&mut self, cx: &mut Context<Self>) {
        self.busy = true;
        self.error = None;
        let t = crate::sync::upload_to_cloud(&self.editor, cx);
        cx.spawn(async move |this, cx| {
            let res = t.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match res {
                    Ok(_) => this.load(cx),
                    Err(e) => this.error = Some(e.friendly()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn create(&mut self, cx: &mut Context<Self>) {
        let Some(id) = crate::sync::design_id(&self.editor, cx) else {
            return;
        };
        let password = self.password.read(cx).text().to_string();
        if self.use_password && password.len() < 4 {
            self.error = Some("Use a password of at least 4 characters.".into());
            cx.notify();
            return;
        }
        let mut args = json!({ "designId": id, "permission": self.permission });
        if self.use_password {
            args["password"] = json!(password);
        }
        if let Some(d) = self.expires_days {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0);
            args["expiresAt"] = json!(now + d as f64 * 86_400_000.0);
        }
        self.busy = true;
        self.error = None;
        let m = Cloud::get(cx).mutation(f::SET_SHARE, args);
        cx.spawn(async move |this, cx| {
            let res = m.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match res.and_then(|v| {
                    v.get("url")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .ok_or_else(|| CloudError::server("No link."))
                }) {
                    Ok(url) => {
                        cx.write_to_clipboard(ClipboardItem::new_string(url));
                        notify(cx, "Link created and copied.".into());
                        this.password.update(cx, |f, cx| f.set_text("", cx));
                        this.load(cx);
                    }
                    Err(e) => {
                        Account::handle_error(&e, cx);
                        this.error = Some(match e.code.as_str() {
                            "FEATURE_UNAVAILABLE" => {
                                "Edit and comment links are part of Desyn Pro. View links are free."
                                    .into()
                            }
                            "FORBIDDEN" => {
                                "Only owners and admins can create share links for this design."
                                    .into()
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

    fn revoke(&mut self, share_id: String, cx: &mut Context<Self>) {
        let m = Cloud::get(cx).mutation(f::REVOKE_SHARE, json!({ "shareId": share_id }));
        cx.spawn(async move |this, cx| {
            let res = m.await;
            let _ = this.update(cx, |this, cx| {
                match res {
                    Ok(_) => this.load(cx),
                    Err(e) => this.error = Some(e.friendly()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn link_row(
        &self,
        i: usize,
        l: &ShareLink,
        th: &Theme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let url = l.url.clone();
        let id = l.id.clone();
        let perm = match l.permission.as_str() {
            "edit" => "Can edit",
            "comment" => "Can comment",
            _ => "Can view",
        };
        div()
            .p(px(10.0))
            .flex()
            .items_center()
            .gap(px(10.0))
            .rounded(px(10.0))
            .bg(th.surface2)
            .border_1()
            .border_color(th.border_subtle)
            .child(icon("icons/link.svg", 14.0, th.accent_text))
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .truncate()
                            .font_family(MONO)
                            .text_size(px(11.5))
                            .text_color(th.fg)
                            .child(l.url.clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(8.0))
                            .font_family(SANS)
                            .text_size(px(11.0))
                            .text_color(th.faint)
                            .child(perm)
                            .when(l.has_password, |d| d.child("· Password"))
                            .when_some(l.expires_at, |d, e| {
                                d.child(format!(
                                    "· Expires {}",
                                    crate::widgets::ago(e).replace(" ago", "")
                                ))
                            }),
                    ),
            )
            .child(
                icon_button(
                    SharedString::from(format!("copy-link-{i}")),
                    "icons/copy.svg",
                    28.0,
                    false,
                    th,
                )
                .tooltip(tip("Copy link", None))
                .on_click(move |_, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));
                    notify(cx, "Link copied.".into());
                }),
            )
            .child(
                icon_button(
                    SharedString::from(format!("revoke-link-{i}")),
                    "icons/trash-2.svg",
                    28.0,
                    false,
                    th,
                )
                .tooltip(tip("Revoke", None))
                .on_click(cx.listener(move |this, _, _, cx| this.revoke(id.clone(), cx))),
            )
    }
}

impl Render for ShareDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let signed = Account::signed_in(cx);
        let design_id = crate::sync::design_id(&self.editor, cx);
        let col = div()
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .gap(px(16.0));
        if !signed {
            return col
                .child(div().font_family(SANS).text_size(px(13.5)).line_height(px(20.0)).text_color(th.muted).child("Sharing works through your Desyn account: the design syncs to the cloud and people open it in the browser or the app."))
                .child(button("share-signin", "Sign in to share", Variant::Primary, &th).w_full().on_click(|_, _, cx| Account::start_sign_in(cx)));
        }
        let Some(design_id) = design_id else {
            return col
                .child(div().font_family(SANS).text_size(px(13.5)).line_height(px(20.0)).text_color(th.muted).child("This design is a file on this computer. Upload it to your Desyn cloud to share it; the file stays linked and keeps syncing."))
                .children(self.error.clone().map(|e| error_row(&e, None, &th)))
                .child(
                    button("share-upload", if self.busy { "Uploading…" } else { "Upload and share" }, Variant::Primary, &th)
                        .w_full()
                        .child(icon("icons/cloud-upload.svg", 14.0, th.accent_ink))
                        .when(!self.busy, |b| b.on_click(cx.listener(|this, _, _, cx| this.upload(cx)))),
                );
        };
        if !self.loaded && !self.loading {
            self.load(cx);
        }
        let team_url = Cloud::get(cx).endpoints().design_url(&design_id);
        let tu = team_url.clone();
        let me = cx.entity().downgrade();
        let me2 = cx.entity().downgrade();
        let me3 = cx.entity().downgrade();
        let perm_seg = segmented(
            "share-perm",
            vec![
                ("view".to_string(), Seg::Text("Can view".into())),
                ("comment".to_string(), Seg::Text("Can comment".into())),
                ("edit".to_string(), Seg::Text("Can edit".into())),
            ],
            Some(&self.permission),
            &th,
            move |p, _, cx| {
                let _ = me.update(cx, |this, cx| {
                    this.permission = p;
                    cx.notify();
                });
            },
        );
        let expiry = segmented(
            "share-exp",
            vec![
                (None, Seg::Text("Never".into())),
                (Some(1u32), Seg::Text("1 day".into())),
                (Some(7), Seg::Text("7 days".into())),
                (Some(30), Seg::Text("30 days".into())),
            ],
            Some(&self.expires_days),
            &th,
            move |d, _, cx| {
                let _ = me2.update(cx, |this, cx| {
                    this.expires_days = d;
                    cx.notify();
                });
            },
        );
        let links = self.links.clone();
        col.child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(label("Your team", &th))
                .child(
                    div()
                        .p(px(10.0))
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .rounded(px(10.0))
                        .bg(alpha(th.accent, 0.06))
                        .border_1()
                        .border_color(th.border_subtle)
                        .child(icon("icons/user.svg", 14.0, th.muted))
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.0))
                                .truncate()
                                .font_family(MONO)
                                .text_size(px(11.5))
                                .text_color(th.fg)
                                .child(team_url.clone()),
                        )
                        .child(
                            button("copy-team", "Copy", Variant::Secondary, &th).on_click(
                                move |_, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(tu.clone()));
                                    notify(
                                        cx,
                                        "Link copied. Members of your workspace can open it."
                                            .into(),
                                    );
                                },
                            ),
                        )
                        .child(
                            icon_button("open-web", "icons/external-link.svg", 28.0, false, &th)
                                .tooltip(tip("Open in the browser", None))
                                .on_click(move |_, _, cx| cx.open_url(&team_url)),
                        ),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(10.0))
                .child(label("New share link", &th))
                .child(perm_seg)
                .child(row("Expires", expiry, &th))
                .child(row(
                    "Password",
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .child(toggle(
                            "share-pass",
                            self.use_password,
                            &th,
                            move |v, _, cx| {
                                let _ = me3.update(cx, |this, cx| {
                                    this.use_password = v;
                                    cx.notify();
                                });
                            },
                        ))
                        .when(self.use_password, |d| {
                            d.child(div().flex_1().child(input_box(self.password.clone(), &th)))
                        }),
                    &th,
                ))
                .children(self.error.clone().map(|e| {
                    div()
                        .font_family(SANS)
                        .text_size(px(12.0))
                        .text_color(th.danger)
                        .child(e)
                }))
                .child(
                    button(
                        "share-create",
                        if self.busy {
                            "Creating…"
                        } else {
                            "Create and copy link"
                        },
                        Variant::Primary,
                        &th,
                    )
                    .w_full()
                    .child(icon("icons/link-2.svg", 14.0, th.accent_ink))
                    .when(!self.busy, |b| {
                        b.on_click(cx.listener(|this, _, _, cx| this.create(cx)))
                    }),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(label("Active links", &th))
                        .when(self.loading, |d| {
                            d.child(spinner("share-loading", 8.0, &th))
                        }),
                )
                .when(links.is_empty() && !self.loading, |d| {
                    d.child(
                        div()
                            .font_family(SANS)
                            .text_size(px(12.5))
                            .text_color(th.muted)
                            .child("No share links yet."),
                    )
                })
                .children({
                    let mut rows = Vec::new();
                    for (i, l) in links.iter().enumerate() {
                        rows.push(self.link_row(i, l, &th, cx).into_any_element());
                    }
                    rows
                }),
        )
        .when(self.loading && !self.loaded, |d| {
            d.child(loading("share-wait", "Loading links…", &th))
        })
    }
}
