//! The left rail and its 320 px flyouts (DESIGN_SYSTEM §6): Design (templates), Elements (shapes, lines, frames,
//! icons, charts, tables, QR), Text (presets, pairings, document styles), Brand (kits), Uploads, Photos (stock),
//! AI (see [`crate::ai::panel`]), Layers (tree with drag and drop, rename, lock, hide) and Pages.

pub mod brand;
pub mod elements;
pub mod insert;
pub mod layers;
pub mod pages;
pub mod photos;
pub mod templates;
pub mod text;
pub mod uploads;

use gpui::{AnyElement, App, AppContext, Div, IntoElement, ParentElement, Styled, div, px};

use crate::ui::actions;
use crate::ui::ext::{Extensions, PanelSpec, Slot};
use crate::ui::theme::{SANS, Theme};
use crate::widgets::title;

/// Registers every left-rail panel and the panel shortcuts (alt+1/2/3).
pub fn install(cx: &mut App) {
    Extensions::update(cx, |x| {
        x.panel(
            PanelSpec::new(
                "design",
                "Design",
                "icons/layout-template.svg",
                Slot::Left,
                |e, w, cx| {
                    let e = e.clone();
                    cx.new(|cx| templates::TemplatesPanel::new(e, w, cx)).into()
                },
            )
            .order(10),
        );
        x.panel(
            PanelSpec::new(
                "elements",
                "Elements",
                "icons/shapes.svg",
                Slot::Left,
                |e, w, cx| {
                    let e = e.clone();
                    cx.new(|cx| elements::ElementsPanel::new(e, w, cx)).into()
                },
            )
            .order(20),
        );
        x.panel(
            PanelSpec::new("text", "Text", "icons/type.svg", Slot::Left, |e, w, cx| {
                let e = e.clone();
                cx.new(|cx| text::TextPanel::new(e, w, cx)).into()
            })
            .order(30),
        );
        x.panel(
            PanelSpec::new(
                "brand",
                "Brand",
                "icons/swatch-book.svg",
                Slot::Left,
                |e, w, cx| {
                    let e = e.clone();
                    cx.new(|cx| brand::BrandPanel::new(e, w, cx)).into()
                },
            )
            .order(40),
        );
        x.panel(
            PanelSpec::new(
                "uploads",
                "Uploads",
                "icons/cloud-upload.svg",
                Slot::Left,
                |e, w, cx| {
                    let e = e.clone();
                    cx.new(|cx| uploads::UploadsPanel::new(e, w, cx)).into()
                },
            )
            .order(50),
        );
        x.panel(
            PanelSpec::new(
                "photos",
                "Photos",
                "icons/images.svg",
                Slot::Left,
                |e, w, cx| {
                    let e = e.clone();
                    cx.new(|cx| photos::PhotosPanel::new(e, w, cx)).into()
                },
            )
            .order(60),
        );
        x.panel(
            PanelSpec::new(
                "layers",
                "Layers",
                "icons/layers.svg",
                Slot::Left,
                |e, w, cx| {
                    let e = e.clone();
                    cx.new(|cx| layers::LayersPanel::new(e, w, cx)).into()
                },
            )
            .order(80),
        );
        x.panel(
            PanelSpec::new(
                "pages",
                "Pages",
                "icons/files.svg",
                Slot::Left,
                |e, w, cx| {
                    let e = e.clone();
                    cx.new(|cx| pages::PagesPanel::new(e, w, cx)).into()
                },
            )
            .order(90),
        );
        x.handle::<actions::LayersPanel>(|e, _, cx| {
            e.update(cx, |e, cx| e.toggle_left_panel("layers", cx))
        });
        x.handle::<actions::ElementsPanel>(|e, _, cx| {
            e.update(cx, |e, cx| e.toggle_left_panel("elements", cx))
        });
        x.handle::<actions::BrandPanel>(|e, _, cx| {
            e.update(cx, |e, cx| e.toggle_left_panel("brand", cx))
        });
    });
}

/// The panel frame: serif title (with an italic sun word), optional subtitle, then content.
pub fn frame(t: &str, italic: Option<&str>, subtitle: Option<&str>, th: &Theme) -> Div {
    div().size_full().flex().flex_col().child(
        div()
            .flex_none()
            .px(px(18.0))
            .pt(px(18.0))
            .pb(px(10.0))
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(title(t, italic, th))
            .children(subtitle.map(|s| {
                div()
                    .font_family(SANS)
                    .text_size(px(12.5))
                    .line_height(px(18.0))
                    .text_color(th.muted)
                    .child(s.to_string())
            })),
    )
}

/// Scrollable panel body.
pub fn body(id: &'static str, content: impl IntoElement) -> AnyElement {
    use gpui::{InteractiveElement, StatefulInteractiveElement};
    div()
        .id(id)
        .flex_1()
        .min_h(px(0.0))
        .overflow_y_scroll()
        .px(px(18.0))
        .pb(px(24.0))
        .child(content)
        .into_any_element()
}
