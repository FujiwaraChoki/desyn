//! Version history of a cloud design: save a named version, list named and automatic versions (live), open a
//! version as a separate local copy to look at it, and restore one (the server saves a "Before restoring" version
//! first, and the restore arrives as ordinary synced changes).

use gpui::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Window,
    div, prelude::FluentBuilder, px,
};
use serde_json::{Value, json};

use crate::auth::Account;
use crate::cloud::api::{self, Version, f};
use crate::cloud::{Cloud, LiveQuery};
use crate::ui::components::{Variant, button, icon, label, t, tip};
use crate::ui::editor::EditorView;
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{MONO, SANS, Theme};
use crate::widgets::{ago, empty, error_row, input_box, loading, notify, spinner};

/// The dialog.
pub struct VersionsDialog {
    editor: Entity<EditorView>,
    name: Entity<TextField>,
    versions: Vec<Version>,
    loaded: bool,
    error: Option<String>,
    busy: Option<String>,
    confirm: Option<String>,
    show_auto: bool,
    focus: FocusHandle,
    _live: Option<gpui::Task<()>>,
    _subs: Vec<Subscription>,
}

impl Focusable for VersionsDialog {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl VersionsDialog {
    /// A dialog for an editor (`focus_name` focuses the version name field).
    pub fn new(
        editor: Entity<EditorView>,
        focus_name: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> VersionsDialog {
        let name = cx.new(|cx| {
            let mut f = TextField::new("Name this version", cx);
            f.font_size = 13.0;
            f
        });
        let subs = vec![cx.subscribe(&name, |this, _, e: &FieldEvent, cx| {
            if *e == FieldEvent::Confirm {
                this.save(cx);
            }
        })];
        if focus_name {
            let fh = name.focus_handle(cx);
            window.focus(&fh, cx);
        }
        let mut d = VersionsDialog {
            editor,
            name,
            versions: Vec::new(),
            loaded: false,
            error: None,
            busy: None,
            confirm: None,
            show_auto: false,
            focus: cx.focus_handle(),
            _live: None,
            _subs: subs,
        };
        d.subscribe(cx);
        d
    }

    fn subscribe(&mut self, cx: &mut Context<Self>) {
        let Some(id) = crate::sync::design_id(&self.editor, cx) else {
            return;
        };
        let live: LiveQuery = Cloud::get(cx).subscribe(f::VERSIONS_LIST, json!({ "designId": id }));
        self._live = Some(cx.spawn(async move |this, cx| {
            let mut live = live;
            while let Some(r) = live.next().await {
                let res = r.and_then(api::decode::<Vec<Version>>);
                if this
                    .update(cx, |this, cx| {
                        this.loaded = true;
                        match res {
                            Ok(v) => {
                                this.versions = v;
                                this.error = None;
                            }
                            Err(e) => {
                                this.error = Some(match e.code.as_str() {
                                    "FEATURE_UNAVAILABLE" => {
                                        "Version history is part of Desyn Pro.".into()
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

    fn save(&mut self, cx: &mut Context<Self>) {
        let Some(id) = crate::sync::design_id(&self.editor, cx) else {
            return;
        };
        let name = self.name.read(cx).text().trim().to_string();
        let name = if name.is_empty() {
            format!(
                "Version {}",
                self.versions.iter().filter(|v| !v.auto).count() + 1
            )
        } else {
            name
        };
        self.busy = Some("save".into());
        let m =
            Cloud::get(cx).mutation(f::VERSIONS_CREATE, json!({ "designId": id, "name": name }));
        cx.spawn(async move |this, cx| {
            let res = m.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = None;
                match res {
                    Ok(_) => {
                        this.name.update(cx, |f, cx| f.set_text("", cx));
                        notify(cx, "Version saved.".into());
                    }
                    Err(e) => {
                        Account::handle_error(&e, cx);
                        this.error = Some(match e.code.as_str() {
                            "FEATURE_UNAVAILABLE" => "Named versions are part of Desyn Pro.".into(),
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

    fn restore(&mut self, v: Version, cx: &mut Context<Self>) {
        self.confirm = None;
        self.busy = Some(v.id.clone());
        let a = Cloud::get(cx).action(f::VERSIONS_RESTORE, json!({ "versionId": v.id }));
        cx.spawn(async move |this, cx| {
            let res = a.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = None;
                match res {
                    Ok(_) => notify(
                        cx,
                        format!(
                            "Restored “{}”. The previous state was saved as a version.",
                            v.name
                        ),
                    ),
                    Err(e) => this.error = Some(format!("Couldn't restore: {}", e.friendly())),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn open_copy(&mut self, v: Version, cx: &mut Context<Self>) {
        self.busy = Some(v.id.clone());
        let a = Cloud::get(cx).action("designs/versions:get", json!({ "versionId": v.id }));
        let name = self.editor.read(cx).name();
        let assets = self.editor.read(cx).session.doc.assets.clone();
        cx.spawn(async move |this, cx| {
            let res = a.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = None;
                match res.and_then(|v| {
                    let s = v
                        .get("design")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    desyn_core::model::Design::from_json(&s)
                        .map_err(|e| crate::cloud::CloudError::server(e.to_string()))
                }) {
                    Ok(mut d) => {
                        // A separate local copy: new ids so it never syncs into the original.
                        d.name = format!("{name} · {}", v.name);
                        d.id = crate::sync::new_tx_id();
                        let doc = crate::doc::Document::new(d, assets);
                        crate::widgets::open_document(doc, None, cx);
                    }
                    Err(e) => {
                        this.error = Some(format!("Couldn't open the version: {}", e.friendly()))
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn version_row(
        &self,
        i: usize,
        v: &Version,
        th: &Theme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let busy = self.busy.as_deref() == Some(v.id.as_str());
        let confirming = self.confirm.as_deref() == Some(v.id.as_str());
        let (v1, v2, v3) = (v.clone(), v.clone(), v.id.clone());
        let ready = v.status == "ready";
        div()
            .id(("version", i))
            .p(px(10.0))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .rounded(px(10.0))
            .border_1()
            .border_color(if confirming { th.accent } else { th.border_subtle })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .child(icon(if v.auto { "icons/clock.svg" } else { "icons/history.svg" }, 14.0, if v.auto { th.faint } else { th.accent_text }))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.0))
                            .flex()
                            .flex_col()
                            .gap(px(2.0))
                            .child(div().truncate().font_family(SANS).text_size(px(13.0)).text_color(th.fg).child(v.name.clone()))
                            .child(
                                div()
                                    .font_family(MONO)
                                    .text_size(px(10.5))
                                    .text_color(th.faint)
                                    .child(format!(
                                        "{}{} · {} page{}",
                                        ago(v.created_at),
                                        v.created_by_name.as_ref().map(|n| format!(" · {n}")).unwrap_or_default(),
                                        v.page_count,
                                        if v.page_count == 1.0 { "" } else { "s" }
                                    )),
                            ),
                    )
                    .when(busy, |d| d.child(spinner(format!("ver-busy-{i}"), 9.0, th)))
                    .when(!ready, |d| d.child(div().font_family(SANS).text_size(px(11.0)).text_color(th.faint).child(if v.status == "failed" { "Failed" } else { "Saving…" })))
                    .when(ready && !busy && !confirming, |d| {
                        d.child(button(SharedString::from(format!("ver-open-{i}")), "Open copy", Variant::Ghost, th).tooltip(tip("Open this version in a new tab", None)).on_click(cx.listener(move |this, _, _, cx| this.open_copy(v1.clone(), cx))))
                            .child(button(SharedString::from(format!("ver-restore-{i}")), "Restore", Variant::Secondary, th).on_click(cx.listener(move |this, _, _, cx| {
                                this.confirm = Some(v3.clone());
                                cx.notify();
                            })))
                    }),
            )
            .when(confirming, |d| {
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(div().flex_1().font_family(SANS).text_size(px(12.0)).text_color(th.muted).child("Replace the design with this version for everyone? You can undo by restoring the automatic “Before restoring” version."))
                        .child(button(SharedString::from(format!("ver-no-{i}")), "Cancel", Variant::Ghost, th).on_click(cx.listener(|this, _, _, cx| {
                            this.confirm = None;
                            cx.notify();
                        })))
                        .child(button(SharedString::from(format!("ver-yes-{i}")), "Restore", Variant::Primary, th).on_click(cx.listener(move |this, _, _, cx| this.restore(v2.clone(), cx)))),
                )
            })
    }
}

impl Render for VersionsDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let col = div()
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .gap(px(16.0));
        if crate::sync::design_id(&self.editor, cx).is_none() {
            return col.child(empty(
                "history lives in the cloud",
                "Version history is kept for cloud designs. Upload this design (Share › Upload) to start saving versions.",
                None,
                &th,
            ));
        }
        let named: Vec<Version> = self
            .versions
            .iter()
            .filter(|v| self.show_auto || !v.auto)
            .cloned()
            .collect();
        let autos = self.versions.iter().filter(|v| v.auto).count();
        col.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(div().flex_1().child(input_box(self.name.clone(), &th)))
                .child(
                    button(
                        "ver-save",
                        if self.busy.as_deref() == Some("save") {
                            "Saving…"
                        } else {
                            "Save version"
                        },
                        Variant::Primary,
                        &th,
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.save(cx))),
                ),
        )
        .children(self.error.clone().map(|e| error_row(&e, None, &th)))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(label("Versions", &th))
                .when(autos > 0, |d| {
                    d.child(
                        div()
                            .id("ver-auto")
                            .font_family(SANS)
                            .text_size(px(12.0))
                            .text_color(th.accent_text)
                            .cursor_pointer()
                            .child(if self.show_auto {
                                "Hide automatic".to_string()
                            } else {
                                format!("Show {autos} automatic")
                            })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.show_auto = !this.show_auto;
                                cx.notify();
                            })),
                    )
                }),
        )
        .when(!self.loaded, |d| {
            d.child(loading("ver-loading", "Loading versions…", &th))
        })
        .when(self.loaded && named.is_empty(), |d| {
            d.child(
                div()
                    .font_family(SANS)
                    .text_size(px(12.5))
                    .text_color(th.muted)
                    .child("No named versions yet. Save one before big changes."),
            )
        })
        .children({
            let mut rows = Vec::new();
            for (i, v) in named.iter().enumerate() {
                rows.push(self.version_row(i, v, &th, cx).into_any_element());
            }
            rows
        })
    }
}
