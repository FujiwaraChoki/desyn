//! The floating tool dock (bottom center over the canvas, glass, DESIGN_SYSTEM §6): select, hand, frame, shapes,
//! pen, text, image. Shapes share one button whose menu picks the shape.

use gpui::{
    BoxShadow, Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
    Styled, div, prelude::*, px,
};

use super::actions::shortcut_label;
use super::components::{divider, icon, tip};
use super::editor::EditorView;
use super::menu::MenuEntry;
use super::theme::{Theme, alpha};
use crate::canvas::Tool;

fn key_for(tool: Tool) -> Option<&'static str> {
    Some(match tool {
        Tool::Select => "v",
        Tool::Hand => "h",
        Tool::Frame => "f",
        Tool::Rect => "r",
        Tool::Ellipse => "o",
        Tool::Line => "l",
        Tool::Arrow => "shift-l",
        Tool::Pen => "p",
        Tool::Text => "t",
        Tool::Image => "secondary-shift-k",
        Tool::Polygon | Tool::Star => return None,
    })
}

/// The dock element.
pub fn tool_dock(v: &mut EditorView, th: &Theme, cx: &mut Context<EditorView>) -> gpui::AnyElement {
    let current = v.session.tool;
    let shape_tool = if current.is_shape() {
        current
    } else {
        v.last_shape_tool()
    };
    let button = |tool: Tool, th: &Theme, cx: &mut Context<EditorView>| {
        let active = current == tool;
        let fg = if active { th.accent_ink } else { th.muted };
        let hover_bg = th.surface3;
        div()
            .id(gpui::SharedString::from(format!("tool-{}", tool.id())))
            .size(px(36.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(10.0))
            .cursor_pointer()
            .when(active, |d| {
                d.bg(th.accent_solid).shadow(vec![
                    BoxShadow::new(px(0.0), px(0.0), th.accent_glow).blur_radius(px(14.0)),
                ])
            })
            .when(!active, move |d| d.hover(move |s| s.bg(hover_bg)))
            .tooltip(tip(tool.label(), key_for(tool).map(shortcut_label)))
            .child(icon(tool.icon(), 18.0, fg))
            .on_click(cx.listener(move |this, _, window, cx| {
                if tool == Tool::Image {
                    window.dispatch_action(Box::new(super::actions::PlaceImage), cx);
                    return;
                }
                this.session.set_tool(tool);
                this.after(cx);
            }))
    };
    let shapes_active = current.is_shape();
    let s3 = th.surface3;
    div()
        .id("tool-dock")
        .flex()
        .items_center()
        .gap(px(2.0))
        .p(px(5.0))
        .rounded(px(16.0))
        .bg(th.glass)
        .border_1()
        .border_color(th.border_subtle)
        .shadow(vec![
            BoxShadow::new(
                px(0.0),
                px(8.0),
                alpha(gpui::black(), if th.dark { 0.45 } else { 0.12 }),
            )
            .blur_radius(px(24.0)),
        ])
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(button(Tool::Select, th, cx))
        .child(button(Tool::Hand, th, cx))
        .child(div().px(px(3.0)).child(divider(th, true)))
        .child(button(Tool::Frame, th, cx))
        .child(
            div()
                .flex()
                .items_center()
                .child(button(shape_tool, th, cx))
                .child(
                    div()
                        .id("shapes-menu")
                        .h(px(36.0))
                        .w(px(16.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.0))
                        .cursor_pointer()
                        .hover(move |s| s.bg(s3))
                        .tooltip(tip("Shapes", None))
                        .child(icon(
                            "icons/chevron-up.svg",
                            12.0,
                            if shapes_active {
                                th.accent_text
                            } else {
                                th.faint
                            },
                        ))
                        .on_click(cx.listener(|this, e: &gpui::ClickEvent, window, cx| {
                            let entries = Tool::SHAPES
                                .iter()
                                .map(|t| {
                                    let tool = *t;
                                    let entry = MenuEntry::run(tool.label(), move |window, cx| {
                                        let a: Box<dyn gpui::Action> = match tool {
                                            Tool::Rect => Box::new(super::actions::ToolRect),
                                            Tool::Ellipse => Box::new(super::actions::ToolEllipse),
                                            Tool::Polygon => Box::new(super::actions::ToolPolygon),
                                            Tool::Star => Box::new(super::actions::ToolStar),
                                            Tool::Line => Box::new(super::actions::ToolLine),
                                            _ => Box::new(super::actions::ToolArrow),
                                        };
                                        window.dispatch_action(a, cx);
                                    });
                                    match (entry, key_for(tool)) {
                                        (MenuEntry::Run { label, run, .. }, k) => MenuEntry::Run {
                                            label,
                                            run,
                                            hint: k.map(|k| shortcut_label(k).into()),
                                        },
                                        (e, _) => e,
                                    }
                                })
                                .collect();
                            let p = e.position();
                            this.open_menu(
                                entries,
                                gpui::point(p.x - px(40.0), p.y - px(250.0)),
                                window,
                                cx,
                            );
                        })),
                ),
        )
        .child(button(Tool::Pen, th, cx))
        .child(button(Tool::Text, th, cx))
        .child(button(Tool::Image, th, cx))
        .into_any_element()
}
