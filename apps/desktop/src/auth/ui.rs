//! Account UI: the account chip in the editor's top bar (sign in, waiting for the browser, avatar with the account
//! menu) and the sign-in card (browser flow first, email + password as a fallback) used on the start screen and
//! in the sign-in dialog.

use gpui::{
    AnyElement, App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled,
    Subscription, Window, div, prelude::FluentBuilder, px,
};

use super::{Account, Status};
use crate::cloud::Cloud;
use crate::ui::components::{Variant, button, divider, icon, serif, t, tip};
use crate::ui::editor::EditorView;
use crate::ui::menu::MenuEntry;
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{SANS, Theme, alpha};
use crate::widgets::{avatar, input_box, spinner};

/// The account chip for an editor's top bar.
pub fn account_item(editor: &Entity<EditorView>, window: &mut Window, cx: &mut App) -> AnyElement {
    let th = t(window, cx);
    let Some(acc) = cx.try_global::<Account>() else {
        return div().into_any_element();
    };
    let ed = editor.clone();
    match &acc.status {
        Status::Loading => div().w(px(28.0)).into_any_element(),
        Status::SignedOut => button("sign-in", "Sign in", Variant::Ghost, &th)
            .h(px(30.0))
            .child(icon("icons/log-in.svg", 14.0, th.muted))
            .tooltip(tip("Sign in to sync designs, use AI and share", None))
            .on_click(|_, _, cx| Account::start_sign_in(cx))
            .into_any_element(),
        Status::Waiting { url, .. } => {
            let url = url.clone();
            div()
                .id("sign-in-waiting")
                .h(px(30.0))
                .px(px(10.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .rounded(px(8.0))
                .cursor_pointer()
                .hover({
                    let s3 = th.surface3;
                    move |s| s.bg(s3)
                })
                .child(spinner("waiting", 9.0, &th))
                .child(
                    div()
                        .font_family(SANS)
                        .text_size(px(12.5))
                        .text_color(th.muted)
                        .child("Finish in your browser…"),
                )
                .on_click(move |e, window, cx| {
                    let u1 = url.clone();
                    let u2 = url.clone();
                    let entries = vec![
                        MenuEntry::run("Open the sign-in page again", move |_, cx| {
                            cx.open_url(&u1)
                        }),
                        MenuEntry::run("Copy sign-in link", move |_, cx| {
                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(u2.clone()))
                        }),
                        MenuEntry::Separator,
                        MenuEntry::run("Cancel sign-in", |_, cx| Account::cancel_sign_in(cx)),
                    ];
                    let at = e.position();
                    ed.update(cx, |ed, cx| {
                        ed.open_menu(
                            entries,
                            gpui::point(at.x - px(180.0), at.y + px(18.0)),
                            window,
                            cx,
                        )
                    });
                })
                .into_any_element()
        }
        Status::SignedIn => {
            let profile = acc.profile.clone();
            let session = acc.session.clone();
            let name = Account::display_name(cx).unwrap_or_default();
            let email = session
                .as_ref()
                .map(|s| s.email.clone())
                .unwrap_or_default();
            let initials = profile.as_ref().map(|p| p.initials()).unwrap_or_else(|| {
                name.chars()
                    .next()
                    .map(|c| c.to_uppercase().to_string())
                    .unwrap_or("?".into())
            });
            let image = profile
                .as_ref()
                .and_then(|p| p.image.clone())
                .and_then(|u| crate::cloud::images::image(&u, editor.entity_id(), cx));
            let plan = profile
                .as_ref()
                .map(|p| p.plan_name.clone())
                .unwrap_or_default();
            let app_url = Cloud::get(cx).endpoints().app_url.clone();
            div()
                .id("account")
                .cursor_pointer()
                .tooltip(tip(format!("{name} · {email}"), None))
                .child(avatar(&initials, th.accent_solid, image, 28.0, &th))
                .on_click(move |e, window, cx| {
                    let a1 = app_url.clone();
                    let a2 = format!("{app_url}/settings/profile");
                    let mut entries = vec![MenuEntry::Header(format!("{name} · {email}").into())];
                    if !plan.is_empty() {
                        entries.push(MenuEntry::Header(format!("Plan: {plan}").into()));
                    }
                    entries.extend([
                        MenuEntry::Separator,
                        MenuEntry::run("Open Desyn on the web", move |_, cx| cx.open_url(&a1)),
                        MenuEntry::run("Account settings", move |_, cx| cx.open_url(&a2)),
                        MenuEntry::Separator,
                        MenuEntry::run("Sign out", |_, cx| Account::sign_out(cx)),
                    ]);
                    let at = e.position();
                    ed.update(cx, |ed, cx| {
                        ed.open_menu(
                            entries,
                            gpui::point(at.x - px(220.0), at.y + px(18.0)),
                            window,
                            cx,
                        )
                    });
                })
                .into_any_element()
        }
    }
}

/// The sign-in card (start screen, sign-in dialog).
pub struct SignInCard {
    email: Entity<TextField>,
    password: Entity<TextField>,
    show_password_form: bool,
    error: Option<String>,
    busy: bool,
    /// Hide the introduction (the start screen explains it next to the card).
    pub compact: bool,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl Focusable for SignInCard {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl SignInCard {
    /// A card.
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> SignInCard {
        let email = cx.new(|cx| {
            let mut f = TextField::new("you@studio.com", cx);
            f.font_size = 13.0;
            f
        });
        let password = cx.new(|cx| {
            let mut f = TextField::new("Password", cx);
            f.font_size = 13.0;
            f.masked = true;
            f
        });
        let subs = vec![
            cx.subscribe_in(&email, window, |this, _, e: &FieldEvent, window, cx| {
                if *e == FieldEvent::Confirm {
                    let f = this.password.focus_handle(cx);
                    window.focus(&f, cx);
                }
            }),
            cx.subscribe_in(&password, window, |this, _, e: &FieldEvent, _, cx| {
                if *e == FieldEvent::Confirm {
                    this.submit(cx);
                }
            }),
            cx.observe_global::<Account>(|_, cx| cx.notify()),
        ];
        SignInCard {
            email,
            password,
            show_password_form: false,
            error: None,
            busy: false,
            compact: false,
            focus: cx.focus_handle(),
            _subs: subs,
        }
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        let email = self.email.read(cx).text().trim().to_string();
        let password = self.password.read(cx).text().to_string();
        if !email.contains('@') || password.is_empty() {
            self.error = Some("Enter your email and password.".into());
            cx.notify();
            return;
        }
        self.busy = true;
        self.error = None;
        let task = Account::sign_in_with_password(email, password, cx);
        cx.spawn(async move |this, cx| {
            let res = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match res {
                    Ok(()) => {
                        this.password.update(cx, |f, cx| f.set_text("", cx));
                    }
                    Err(e) => this.error = Some(e),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

fn field(label: &str, f: Entity<TextField>, th: &Theme) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            div()
                .font_family(SANS)
                .text_size(px(12.0))
                .text_color(th.muted)
                .child(label.to_string()),
        )
        .child(input_box(f, th))
}

impl Render for SignInCard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let status = cx
            .try_global::<Account>()
            .map(|a| a.status.clone())
            .unwrap_or(Status::Loading);
        let host = Cloud::try_get(cx)
            .map(|c| c.endpoints().display_host())
            .unwrap_or_default();
        let waiting = matches!(status, Status::Waiting { .. });
        let url = match &status {
            Status::Waiting { url, .. } => Some(url.clone()),
            _ => None,
        };
        let keychain = cx
            .try_global::<Account>()
            .and_then(|a| a.keychain_error.clone());
        div()
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .gap(px(14.0))
            .when(!self.compact, |d| d.child(
                div()
                    .font_family(SANS)
                    .text_size(px(13.5))
                    .line_height(px(20.0))
                    .text_color(th.muted)
                    .child(format!(
                        "Sign in to {host} to sync designs across devices, run the AI, share links and see version history. Local files keep working without an account."
                    )),
            ))
            .child(if waiting {
                div()
                    .p(px(14.0))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .rounded(px(10.0))
                    .bg(th.accent_soft)
                    .border_1()
                    .border_color(alpha(th.accent, 0.3))
                    .child(spinner("signin-wait", 12.0, &th))
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(2.0))
                            .child(div().font_family(SANS).text_size(px(13.0)).text_color(th.fg).child("Continue in your browser"))
                            .child(
                                div()
                                    .font_family(SANS)
                                    .text_size(px(12.0))
                                    .text_color(th.muted)
                                    .child("Approve the sign-in there. Desyn picks it up automatically."),
                            ),
                    )
                    .child(
                        button("signin-reopen", "Reopen", Variant::Ghost, &th).on_click(move |_, _, cx| {
                            if let Some(u) = &url {
                                cx.open_url(u)
                            }
                        }),
                    )
                    .child(button("signin-cancel", "Cancel", Variant::Ghost, &th).on_click(|_, _, cx| Account::cancel_sign_in(cx)))
                    .into_any_element()
            } else {
                button("signin-browser", "Continue in browser", Variant::Primary, &th)
                    .h(px(38.0))
                    .w_full()
                    .child(icon("icons/external-link.svg", 14.0, th.accent_ink))
                    .on_click(|_, _, cx| Account::start_sign_in(cx))
                    .into_any_element()
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .child(divider(&th, false).flex_1())
                    .child(div().font_family(SANS).text_size(px(11.5)).text_color(th.faint).child("or"))
                    .child(divider(&th, false).flex_1()),
            )
            .child(if self.show_password_form {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(10.0))
                    .child(field("Email", self.email.clone(), &th))
                    .child(field("Password", self.password.clone(), &th))
                    .children(self.error.clone().map(|e| {
                        div().font_family(SANS).text_size(px(12.0)).text_color(th.danger).child(e)
                    }))
                    .child(
                        button("signin-password", if self.busy { "Signing in…" } else { "Sign in" }, Variant::Secondary, &th)
                            .w_full()
                            .when(!self.busy, |b| b.on_click(cx.listener(|this, _, _, cx| this.submit(cx)))),
                    )
                    .into_any_element()
            } else {
                button("signin-email", "Sign in with email and password", Variant::Ghost, &th)
                    .w_full()
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.show_password_form = true;
                        let f = this.email.focus_handle(cx);
                        window.focus(&f, cx);
                        cx.notify();
                    }))
                    .into_any_element()
            })
            .children(keychain.map(|k| {
                div().font_family(SANS).text_size(px(11.5)).text_color(th.faint).child(k)
            }))
            .child(
                div()
                    .flex()
                    .gap(px(4.0))
                    .font_family(SANS)
                    .text_size(px(12.0))
                    .text_color(th.faint)
                    .child("New to Desyn?")
                    .child(
                        div()
                            .id("signup")
                            .text_color(th.accent_text)
                            .cursor_pointer()
                            .child("Create an account")
                            .on_click(|_, _, cx| {
                                let u = format!("{}/signup", Cloud::get(cx).endpoints().app_url);
                                cx.open_url(&u)
                            }),
                    ),
            )
    }
}

/// Serif heading used by sign-in surfaces.
pub fn heading(th: &Theme) -> impl IntoElement {
    div()
        .flex()
        .items_baseline()
        .gap(px(7.0))
        .child(serif("sign in to", 28.0, th.fg))
        .child(
            div()
                .font_family(crate::ui::theme::SERIF)
                .italic()
                .text_size(px(28.0))
                .text_color(th.accent_text)
                .child("desyn"),
        )
}

/// Short status for menus ("Signed in as Ada").
pub fn status_line(cx: &App) -> Option<SharedString> {
    Account::display_name(cx).map(|n| SharedString::from(format!("Signed in as {n}")))
}
