//! Position tab: x / y of the selection's bounds on the page, width / height along the layers' own axes, rotation,
//! proportional resizing, flips. Groups resize through their children; text scaled uniformly scales its type.

use desyn_core::geometry::{Affine, OrientedBox, Point};
use desyn_core::hit::selection_bounds;
use desyn_core::model::Design;
use gpui::{
    AnyElement, Context, IntoElement, ParentElement, StatefulInteractiveElement, Styled, Window,
    div, px,
};
use serde_json::{Value, json};

use super::props::Sel;
use super::{Edit, Inspector, block, hint, pair};
use crate::doc::edit;
use crate::ui::theme::Theme;
use crate::widgets::number::Label;
use crate::widgets::{icon_toggle, row};

/// Numeric fields (`pos.*`).
pub(super) fn number(key: &str, v: f64, sel: &Sel, d: &mut Design) -> Edit {
    if sel.is_page || !key.starts_with("pos.") {
        return None;
    }
    let b = selection_bounds(d, &sel.ids)?;
    let lock = sel.flag(&["aspectLocked"], false).unwrap_or(false);
    let ops = match key {
        "pos.x" => edit::translate(d, &sel.ids, v - b.aabb.x, 0.0),
        "pos.y" => edit::translate(d, &sel.ids, 0.0, v - b.aabb.y),
        "pos.w" | "pos.h" => {
            let (w0, h0) = (b.obb.width.max(1e-6), b.obb.height.max(1e-6));
            let (mut w, mut h) = (w0, h0);
            if key == "pos.w" {
                w = v.max(0.01);
                if lock {
                    h = h0 * w / w0;
                }
            } else {
                h = v.max(0.01);
                if lock {
                    w = w0 * h / h0;
                }
            }
            let to = OrientedBox {
                transform: b.obb.transform,
                width: w,
                height: h,
            };
            let m = edit::box_map(&b.obb, &to, false, false);
            edit::transform_nodes(d, &sel.ids, &m)
        }
        "pos.rot" => {
            let c = b
                .obb
                .transform
                .apply(Point::new(b.obb.width / 2.0, b.obb.height / 2.0));
            let to = OrientedBox {
                transform: Affine::translate(c.x, c.y)
                    * Affine::rotate_deg(v)
                    * Affine::translate(-b.obb.width / 2.0, -b.obb.height / 2.0),
                width: b.obb.width,
                height: b.obb.height,
            };
            let m = edit::box_map(&b.obb, &to, false, false);
            edit::transform_nodes(d, &sel.ids, &m)
        }
        _ => return None,
    };
    let label = match key {
        "pos.rot" => "Rotate",
        "pos.w" | "pos.h" => "Resize",
        _ => "Move",
    };
    Some((ops, label.to_string()))
}

/// Choices (`pos.lock`).
pub(super) fn choice(key: &str, v: &Value, sel: &Sel, _d: &mut Design) -> Edit {
    match key {
        "pos.lock" => Some((
            sel.set_all("aspectLocked", v.clone()),
            "Lock proportions".to_string(),
        )),
        _ => None,
    }
}

impl Inspector {
    pub(super) fn position_tab(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let col = div().flex().flex_col().pt(px(6.0));
        if sel.is_page {
            return col
                .child(block("Position", None, hint("Select a layer to set its position, size and rotation. Page size is on the Design tab.", th), th))
                .into_any_element();
        }
        let b = {
            let e = self.editor.read(cx);
            selection_bounds(&e.session.doc.design, &sel.ids)
        };
        let (x, y, w, h, r) = match b {
            Some(b) => (
                Some(b.aabb.x),
                Some(b.aabb.y),
                Some(b.obb.width),
                Some(b.obb.height),
                Some(b.rotation),
            ),
            None => (None, None, None, None, None),
        };
        let lock = sel.flag(&["aspectLocked"], false).unwrap_or(false);
        let fx = self.num(
            "pos.x",
            Label::Text("X".into()),
            x,
            |f| f.unit("px").precision(1),
            window,
            cx,
        );
        let fy = self.num(
            "pos.y",
            Label::Text("Y".into()),
            y,
            |f| f.unit("px").precision(1),
            window,
            cx,
        );
        let fw = self.num(
            "pos.w",
            Label::Text("W".into()),
            w,
            |f| f.range(0.01, 1_000_000.0).unit("px").precision(1),
            window,
            cx,
        );
        let fh = self.num(
            "pos.h",
            Label::Text("H".into()),
            h,
            |f| f.range(0.01, 1_000_000.0).unit("px").precision(1),
            window,
            cx,
        );
        let fr = self.num(
            "pos.rot",
            Label::Icon("icons/rotate-cw.svg"),
            r,
            |f| {
                f.range(-360.0, 360.0)
                    .unit("°")
                    .precision(1)
                    .tooltip("Rotation")
            },
            window,
            cx,
        );
        let lock_btn = icon_toggle(
            "pos-lock",
            if lock {
                "icons/lock.svg"
            } else {
                "icons/lock-open.svg"
            },
            lock,
            "Keep proportions",
            th,
        )
        .on_click(cx.listener(move |this, _, _, cx| this.choose("pos.lock", json!(!lock), cx)));
        let flips = div()
            .flex()
            .gap(px(4.0))
            .child(
                icon_toggle(
                    "pos-flip-h",
                    "icons/flip-horizontal-2.svg",
                    false,
                    "Flip horizontally",
                    th,
                )
                .on_click(cx.listener(|this, _, _, cx| this.command(cx, |s| s.flip(true)))),
            )
            .child(
                icon_toggle(
                    "pos-flip-v",
                    "icons/flip-vertical-2.svg",
                    false,
                    "Flip vertically",
                    th,
                )
                .on_click(cx.listener(|this, _, _, cx| this.command(cx, |s| s.flip(false)))),
            );
        col.child(block("Position", None, pair(fx, fy), th))
            .child(block(
                "Size",
                Some(lock_btn.into_any_element()),
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(pair(fw, fh))
                    .child(hint(
                        "Along the layer's own axes. Groups scale their contents.",
                        th,
                    )),
                th,
            ))
            .child(block(
                "Rotation",
                None,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(row("Angle", fr, th))
                    .child(row("Flip", flips, th)),
                th,
            ))
            .into_any_element()
    }
}
