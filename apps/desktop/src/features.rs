//! The feature modules of the desktop app, in installation order: the cloud connection and account first (the
//! rest depends on them), then fonts, sync, the inspector, the left-rail panels, the AI dock, dialogs, export,
//! collaboration, the start-screen cloud library and update notices.

use gpui::App;

use crate::auth::Account;
use crate::cloud::Cloud;
use crate::ui::app::Installer;
use crate::ui::ext::Extensions;
use crate::widgets::fonts::FontLibrary;

fn core(cx: &mut App) {
    Cloud::init(cx);
    Account::init(cx);
    FontLibrary::init(cx);
    Extensions::update(cx, |x| {
        x.on_auth_callback(Account::finish);
        x.top_bar(100, crate::auth::ui::account_item);
    });
    cx.observe_global::<Account>(crate::panels::brand::reset_on_sign_out)
        .detach();
}

/// Every feature module.
pub fn installers() -> Vec<Installer> {
    vec![
        Box::new(core),
        Box::new(crate::sync::install),
        Box::new(crate::inspector::install),
        Box::new(crate::panels::install),
        Box::new(crate::ai::install),
        Box::new(crate::dialogs::install),
        Box::new(crate::export::install),
        Box::new(crate::collab::install),
        Box::new(crate::library_ui::install),
        Box::new(crate::update::install),
    ]
}
