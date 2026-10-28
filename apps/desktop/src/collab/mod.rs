//! Collaboration on cloud designs: the Share dialog and button, version history (mod+alt+H, save with mod+alt+S)
//! and the comments sheet (shift+C), plus palette commands to upload a local design or open it on the web.

pub mod comments;
pub mod share;
pub mod versions;

use std::rc::Rc;

use gpui::{
    App, AppContext, ClipboardItem, Entity, IntoElement, ParentElement, StatefulInteractiveElement,
    Styled, Window, px,
};

use crate::dialogs::{self, Dialog};
use crate::ui::actions;
use crate::ui::components::{Variant, button, icon, t, tip};
use crate::ui::editor::EditorView;
use crate::ui::ext::{CommandSpec, Extensions};
use crate::widgets::notify;

/// Opens the share dialog.
pub fn open_share(editor: &Entity<EditorView>, window: &mut Window, cx: &mut App) {
    let ed = editor.clone();
    dialogs::open(editor, window, cx, move |window, cx| Dialog {
        title: ("share this", Some("design")),
        width: 540.0,
        view: cx.new(|cx| share::ShareDialog::new(ed, window, cx)).into(),
    });
}

/// Opens version history (`save` focuses the name field).
pub fn open_versions(editor: &Entity<EditorView>, save: bool, window: &mut Window, cx: &mut App) {
    let ed = editor.clone();
    dialogs::open(editor, window, cx, move |window, cx| Dialog {
        title: ("version", Some("history")),
        width: 560.0,
        view: cx
            .new(|cx| versions::VersionsDialog::new(ed, save, window, cx))
            .into(),
    });
}

/// Shows / hides the comments sheet.
pub fn toggle_comments(editor: &Entity<EditorView>, cx: &mut App) {
    let ed = editor.clone();
    dialogs::toggle_sheet(editor, cx, move |cx| {
        cx.new(|cx| comments::CommentsSheet::new(ed, cx)).into()
    });
}

fn command(
    id: &str,
    title: &str,
    keywords: &str,
    run: impl Fn(&Entity<EditorView>, &mut Window, &mut App) + 'static,
) -> CommandSpec {
    let run = Rc::new(run);
    CommandSpec {
        id: id.to_string().into(),
        title: title.to_string().into(),
        group: "Cloud".into(),
        keywords: keywords.to_string().into(),
        run: Rc::new(move |editor, window, cx| {
            if let Some(e) = editor {
                run(e, window, cx);
            } else {
                notify(cx, "Open a design first.".into());
            }
        }),
    }
}

/// Registers actions, commands and the Share button.
pub fn install(cx: &mut App) {
    Extensions::update(cx, |x| {
        x.handle::<actions::Comments>(|e, _, cx| toggle_comments(e, cx));
        x.handle::<actions::VersionHistory>(|e, w, cx| open_versions(e, false, w, cx));
        x.handle::<actions::SaveVersion>(|e, w, cx| open_versions(e, true, w, cx));
        x.command(command(
            "cloud.share",
            "Share…",
            "link invite collaborate",
            open_share,
        ));
        x.command(command(
            "cloud.versions",
            "Version history",
            "restore snapshot",
            |e, w, cx| open_versions(e, false, w, cx),
        ));
        x.command(command(
            "cloud.comments",
            "Comments",
            "feedback review",
            |e, _, cx| toggle_comments(e, cx),
        ));
        x.command(command(
            "cloud.upload",
            "Upload to my Desyn cloud",
            "sync save online",
            |e, _, cx| {
                if crate::sync::link(e, cx).is_some() {
                    notify(cx, "This design already syncs with your cloud.".into());
                    return;
                }
                if !crate::auth::Account::signed_in(cx) {
                    crate::auth::Account::start_sign_in(cx);
                    return;
                }
                let t = crate::sync::upload_to_cloud(e, cx);
                cx.spawn(async move |cx| {
                    let r = t.await;
                    cx.update(|cx| match r {
                        Ok(_) => notify(
                            cx,
                            "Uploaded. This design now syncs with your Desyn cloud.".into(),
                        ),
                        Err(e) => notify(cx, format!("Couldn't upload: {}", e.friendly())),
                    });
                })
                .detach();
            },
        ));
        x.command(command(
            "cloud.open-web",
            "Open in browser",
            "web app",
            |e, _, cx| match crate::sync::design_id(e, cx) {
                Some(id) => {
                    let url = crate::cloud::Cloud::get(cx).endpoints().design_url(&id);
                    cx.open_url(&url);
                }
                None => notify(cx, "Upload the design to open it on the web.".into()),
            },
        ));
        x.command(command(
            "cloud.copy-link",
            "Copy design link",
            "url share",
            |e, _, cx| match crate::sync::design_id(e, cx) {
                Some(id) => {
                    let url = crate::cloud::Cloud::get(cx).endpoints().design_url(&id);
                    cx.write_to_clipboard(ClipboardItem::new_string(url));
                    notify(cx, "Link copied.".into());
                }
                None => notify(cx, "Upload the design to get a link.".into()),
            },
        ));
        x.top_bar(30, |editor, window, cx| {
            let th = t(window, cx);
            let ed = editor.clone();
            let ed2 = editor.clone();
            let cloud = crate::sync::link(editor, cx).is_some();
            gpui::div()
                .flex()
                .items_center()
                .gap(px(4.0))
                .child(
                    crate::ui::components::icon_button(
                        "comments-btn",
                        "icons/message-square.svg",
                        32.0,
                        false,
                        &th,
                    )
                    .tooltip(tip(
                        "Comments",
                        Some(crate::ui::actions::shortcut_label("shift-c")),
                    ))
                    .on_click(move |_, _, cx| toggle_comments(&ed2, cx)),
                )
                .child(
                    button("share-btn", "Share", Variant::Primary, &th)
                        .h(px(30.0))
                        .child(icon(
                            if cloud {
                                "icons/share-2.svg"
                            } else {
                                "icons/cloud-upload.svg"
                            },
                            13.0,
                            th.accent_ink,
                        ))
                        .tooltip(tip(
                            if cloud {
                                "Share links and team access"
                            } else {
                                "Upload to your cloud and share"
                            },
                            None,
                        ))
                        .on_click(move |_, window, cx| open_share(&ed, window, cx)),
                )
                .into_any_element()
        });
    });
}
