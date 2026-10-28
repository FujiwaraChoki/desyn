//! Layers panel: the page's layer tree front-to-back (top of the list = in front), with disclosure for frames and
//! groups, selection (click, shift range, mod toggle) mirrored with the canvas, hover highlighting on the canvas,
//! inline rename (double-click), show / hide and lock / unlock, drag and drop to reorder or move layers into and out
//! of containers (keeping their place on the page), and the canvas context menu on right-click.

use std::collections::HashSet;

use desyn_core::builder::TxBuilder;
use desyn_core::geometry::reparent_placement;
use desyn_core::model::{Design, Id, NodeType, Op};
use gpui::{
    App, AppContext, Context, DragMoveEvent, Entity, FocusHandle, Focusable, InteractiveElement,
    IntoElement, MouseButton, MouseDownEvent, ParentElement, Render, StatefulInteractiveElement,
    Styled, Subscription, UniformListScrollHandle, Window, div, prelude::FluentBuilder, px,
    uniform_list,
};
use serde_json::{Map, json};

use super::frame;
use crate::doc::edit::num;
use crate::ui::components::{icon, t};
use crate::ui::editor::{EditorEvent, EditorView};
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{MONO, SANS, alpha};
use crate::widgets::{empty, node_icon, node_kind_label};

/// Where a drop lands relative to the hovered row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    /// In front of the row's layer.
    Above,
    /// Inside the row's container (on top).
    Inside,
    /// Behind the row's layer.
    Below,
}

/// One visible row.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    /// Layer id.
    pub id: Id,
    /// Nesting depth (0 = page child).
    pub depth: usize,
    /// Name.
    pub name: String,
    /// Type.
    pub kind: NodeType,
    /// Visible.
    pub visible: bool,
    /// Locked.
    pub locked: bool,
    /// Has children.
    pub container: bool,
    /// Expanded.
    pub expanded: bool,
    /// A mask.
    pub mask: bool,
    /// Hidden or locked through an ancestor.
    pub inherited: bool,
}

/// Rows of the page's tree, front to back, skipping children of collapsed containers.
pub fn rows(d: &Design, page: &str, collapsed: &HashSet<Id>) -> Vec<Row> {
    fn walk(
        d: &Design,
        id: &str,
        depth: usize,
        inherited: bool,
        collapsed: &HashSet<Id>,
        out: &mut Vec<Row>,
    ) {
        let Some(n) = d.node(id) else { return };
        let b = n.base();
        let container = n.is_container() && !n.child_ids().is_empty();
        let expanded = container && !collapsed.contains(id);
        out.push(Row {
            id: id.to_string(),
            depth,
            name: if b.name.trim().is_empty() {
                node_kind_label(n.node_type()).to_string()
            } else {
                b.name.clone()
            },
            kind: n.node_type(),
            visible: b.visible,
            locked: b.locked,
            container,
            expanded,
            mask: b.is_mask(),
            inherited,
        });
        if expanded {
            let hidden = inherited || !b.visible || b.locked;
            for c in n.child_ids().iter().rev() {
                walk(d, c, depth + 1, hidden, collapsed, out);
            }
        }
    }
    let mut out = Vec::new();
    if let Some(p) = d.node(page) {
        for c in p.child_ids().iter().rev() {
            walk(d, c, 0, false, collapsed, &mut out);
        }
    }
    out
}

/// Ops moving `ids` next to / into `target` while keeping their place on the page.
pub fn drop_ops(d: &mut Design, ids: &[Id], target: &str, zone: Zone) -> Vec<Op> {
    let Some(t) = d.node(target) else {
        return Vec::new();
    };
    let parent = match zone {
        Zone::Inside if t.is_container() => target.to_string(),
        _ => match t.parent() {
            Some(p) => p.to_string(),
            None => return Vec::new(),
        },
    };
    // Never into itself or a descendant, never pages.
    let ids: Vec<Id> = ids
        .iter()
        .filter(|id| {
            id.as_str() != target
                && !d.is_ancestor_or_self(id, &parent)
                && d.node(id)
                    .is_some_and(|n| !matches!(n.node_type(), NodeType::Page | NodeType::Root))
        })
        .cloned()
        .collect();
    if ids.is_empty() {
        return Vec::new();
    }
    let old_parents: Vec<Id> = ids
        .iter()
        .filter_map(|id| d.node(id).and_then(|n| n.parent()).map(str::to_string))
        .collect();
    let mut b = TxBuilder::new(d);
    // Back-to-front order keeps the dragged layers' relative stacking.
    let mut ordered = ids.clone();
    ordered.sort_by_key(|id| b.design.index_in_parent(id).unwrap_or(0));
    // The first layer goes above / below the target; every later one directly above the layer placed before it,
    // so a multi-layer drop keeps its stacking order on either side of the target.
    let mut anchor = target.to_string();
    let mut place_above = zone == Zone::Above;
    for id in &ordered {
        let Some(p) = reparent_placement(b.design, id, &parent) else {
            continue;
        };
        let index = match zone {
            Zone::Inside if parent == target => None,
            _ => {
                let same = b.design.node(id).and_then(|n| n.parent()) == Some(parent.as_str());
                let mut ti = b.design.index_in_parent(&anchor).unwrap_or(0) as i64;
                if same
                    && b.design
                        .index_in_parent(id)
                        .is_some_and(|i| (i as i64) < ti)
                {
                    ti -= 1;
                }
                Some(if place_above { ti + 1 } else { ti })
            }
        };
        if b.push(Op::move_to(id.clone(), parent.clone(), index))
            .is_err()
        {
            continue;
        }
        anchor = id.clone();
        place_above = true;
        let mut s = Map::new();
        s.insert("x".into(), num(p.x));
        s.insert("y".into(), num(p.y));
        s.insert("rotation".into(), num(p.rotation));
        let mut unset = Vec::new();
        if p.flip_x {
            s.insert("flipX".into(), json!(true));
        } else {
            unset.push("flipX");
        }
        unset.push("flipY");
        let _ = b.update(id, s, &unset);
    }
    let mut refit: Vec<&Id> = old_parents.iter().collect();
    refit.push(&parent);
    let _ = b.refit_groups(refit);
    b.finish()
}

/// A layer being dragged.
#[derive(Clone)]
pub struct DraggedLayers {
    ids: Vec<Id>,
    label: String,
}

impl Render for DraggedLayers {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        div()
            .px(px(10.0))
            .py(px(5.0))
            .rounded(px(8.0))
            .bg(th.accent_solid)
            .text_color(th.accent_ink)
            .font_family(SANS)
            .text_size(px(12.0))
            .child(self.label.clone())
    }
}

/// The panel.
pub struct LayersPanel {
    editor: Entity<EditorView>,
    collapsed: HashSet<Id>,
    renaming: Option<(Id, Entity<TextField>, Subscription)>,
    drop: Option<(Id, Zone)>,
    anchor: Option<Id>,
    scroll: UniformListScrollHandle,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl Focusable for LayersPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

const ROW_H: f32 = 30.0;

impl LayersPanel {
    /// A panel for an editor.
    pub fn new(
        editor: Entity<EditorView>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> LayersPanel {
        let subs = vec![
            cx.subscribe(&editor, |this, _, e: &EditorEvent, cx| match e {
                EditorEvent::Selection(sel) => {
                    // Reveal selected layers: expand their ancestors and scroll to the first.
                    let ancestors: Vec<Id> = {
                        let d = &this.editor.read(cx).session.doc.design;
                        sel.iter().flat_map(|id| d.ancestors(id)).collect()
                    };
                    for a in ancestors {
                        this.collapsed.remove(&a);
                    }
                    if let Some(first) = sel.first() {
                        let (d, page) = {
                            let e = this.editor.read(cx);
                            (e.session.doc.design.clone(), e.session.page.clone())
                        };
                        if let Some(i) = rows(&d, &page, &this.collapsed)
                            .iter()
                            .position(|r| &r.id == first)
                        {
                            this.scroll.scroll_to_item(i, gpui::ScrollStrategy::Nearest);
                        }
                    }
                    cx.notify();
                }
                EditorEvent::Changed(_) | EditorEvent::Page(_) => cx.notify(),
                _ => {}
            }),
        ];
        LayersPanel {
            editor,
            collapsed: HashSet::new(),
            renaming: None,
            drop: None,
            anchor: None,
            scroll: UniformListScrollHandle::new(),
            focus: cx.focus_handle(),
            _subs: subs,
        }
    }

    fn click(&mut self, id: Id, shift: bool, toggle: bool, cx: &mut Context<Self>) {
        let (d, page, sel) = {
            let e = self.editor.read(cx);
            (
                e.session.doc.design.clone(),
                e.session.page.clone(),
                e.session.selection.clone(),
            )
        };
        let new_sel = if toggle {
            let mut s = sel.clone();
            if let Some(i) = s.iter().position(|x| *x == id) {
                s.remove(i);
            } else {
                s.push(id.clone());
            }
            s
        } else if shift && let Some(a) = self.anchor.clone() {
            let rs = rows(&d, &page, &self.collapsed);
            let (i, j) = (
                rs.iter().position(|r| r.id == a),
                rs.iter().position(|r| r.id == id),
            );
            match (i, j) {
                (Some(i), Some(j)) => {
                    let (lo, hi) = (i.min(j), i.max(j));
                    let depth = rs[j].depth;
                    rs[lo..=hi]
                        .iter()
                        .filter(|r| r.depth == depth)
                        .map(|r| r.id.clone())
                        .collect()
                }
                _ => vec![id.clone()],
            }
        } else {
            vec![id.clone()]
        };
        if !shift {
            self.anchor = Some(id);
        }
        self.editor.update(cx, |e, cx| {
            e.session.scope = None;
            e.select(new_sel, cx);
        });
    }

    fn start_rename(
        &mut self,
        id: Id,
        current: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let field = cx.new(|cx| {
            let mut f = TextField::new("Layer name", cx);
            f.font_size = 12.5;
            f.set_text(&current, cx);
            f
        });
        let rid = id.clone();
        let sub = cx.subscribe_in(
            &field,
            window,
            move |this, f, e: &FieldEvent, window, cx| match e {
                FieldEvent::Confirm => {
                    let name = f.read(cx).text().trim().to_string();
                    if !name.is_empty() {
                        let id = rid.clone();
                        this.editor.update(cx, |ed, cx| {
                            ed.session.rename(&id, &name);
                            ed.after(cx);
                        });
                    }
                    this.renaming = None;
                    let fh = this.editor.read(cx).focus.clone();
                    window.focus(&fh, cx);
                    cx.notify();
                }
                FieldEvent::Cancel => {
                    this.renaming = None;
                    cx.notify();
                }
                _ => {}
            },
        );
        let fh = field.focus_handle(cx);
        window.focus(&fh, cx);
        self.renaming = Some((id, field, sub));
        cx.notify();
    }

    fn set_flag(&mut self, id: Id, key: &str, value: bool, cx: &mut Context<Self>) {
        let mut m = Map::new();
        m.insert(key.into(), json!(value));
        let label = match (key, value) {
            ("visible", true) => "Show layer",
            ("visible", false) => "Hide layer",
            (_, true) => "Lock layer",
            _ => "Unlock layer",
        };
        self.editor.update(cx, |e, cx| {
            e.apply(vec![Op::update_set(id, m)], label, cx);
        });
    }

    fn do_drop(&mut self, dragged: &DraggedLayers, cx: &mut Context<Self>) {
        let Some((target, zone)) = self.drop.take() else {
            return;
        };
        let ids = dragged.ids.clone();
        if zone == Zone::Inside {
            self.collapsed.remove(&target);
        }
        self.editor.update(cx, |e, cx| {
            let ops = drop_ops(&mut e.session.doc.design, &ids, &target, zone);
            if !ops.is_empty() {
                let n = ids.len();
                e.session.commit(
                    ops,
                    if n == 1 { "Move layer" } else { "Move layers" },
                    Some(ids),
                );
                e.after(cx);
            }
        });
        cx.notify();
    }
}

impl Render for LayersPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let (rs, selection, hover, page_name, count) = {
            let e = self.editor.read(cx);
            let d = &e.session.doc.design;
            let rs = rows(d, &e.session.page, &self.collapsed);
            let page_name = d
                .node(&e.session.page)
                .map(|n| n.base().name.clone())
                .unwrap_or_default();
            let pages = d.page_ids().to_vec();
            let idx = pages.iter().position(|p| *p == e.session.page).unwrap_or(0) + 1;
            let count = d
                .node(&e.session.page)
                .map(|n| n.child_ids().len())
                .unwrap_or(0);
            (
                rs,
                e.session.selection.iter().cloned().collect::<HashSet<_>>(),
                e.session.hover.clone(),
                if page_name.is_empty() {
                    format!("Page {idx}")
                } else {
                    page_name
                },
                count,
            )
        };
        let view = cx.entity();
        let renaming = self
            .renaming
            .as_ref()
            .map(|(id, f, _)| (id.clone(), f.clone()));
        let drop = self.drop.clone();
        let n = rs.len();
        let list = uniform_list("layer-rows", n, move |range, window, cx| {
            let th = t(window, cx);
            range
                .map(|i| {
                    let r = rs[i].clone();
                    let selected = selection.contains(&r.id);
                    let hovered = hover.as_deref() == Some(r.id.as_str());
                    let v = view.clone();
                    let id = r.id.clone();
                    let drop_here = drop.as_ref().filter(|(t, _)| *t == r.id).map(|(_, z)| *z);
                    let fg = if r.inherited || !r.visible {
                        th.faint
                    } else {
                        th.fg
                    };
                    let name_el: gpui::AnyElement = match &renaming {
                        Some((rid, f)) if *rid == r.id => div()
                            .flex_1()
                            .min_w(px(0.0))
                            .child(f.clone())
                            .into_any_element(),
                        _ => div()
                            .flex_1()
                            .min_w(px(0.0))
                            .truncate()
                            .font_family(SANS)
                            .text_size(px(12.5))
                            .text_color(fg)
                            .when(r.container, |d| d.font_weight(gpui::FontWeight(550.0)))
                            .child(r.name.clone())
                            .into_any_element(),
                    };
                    let (v1, v2, v3, v4, v5, v6, v7) = (
                        v.clone(),
                        v.clone(),
                        v.clone(),
                        v.clone(),
                        v.clone(),
                        v.clone(),
                        v.clone(),
                    );
                    let (i1, i2, i3, i4, i5, i6, i7) = (
                        id.clone(),
                        id.clone(),
                        id.clone(),
                        id.clone(),
                        id.clone(),
                        id.clone(),
                        id.clone(),
                    );
                    let name2 = r.name.clone();
                    let vis = r.visible;
                    let lock = r.locked;
                    let container = r.container;
                    let expanded = r.expanded;
                    let accent = th.accent;
                    let s3 = th.surface3;
                    div()
                        .id(("layer", i))
                        .group("layer-row")
                        .relative()
                        .w_full()
                        .h(px(ROW_H))
                        .pr(px(6.0))
                        .pl(px(8.0 + r.depth as f32 * 14.0))
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .rounded(px(7.0))
                        .when(selected, |d| d.bg(th.accent_soft))
                        .when(!selected && hovered, |d| d.bg(s3))
                        .when(!selected, move |d| d.hover(move |s| s.bg(s3)))
                        .when(drop_here == Some(Zone::Inside), |d| {
                            d.border_1().border_color(accent)
                        })
                        .child(
                            div()
                                .id(("layer-disclose", i))
                                .size(px(14.0))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .when(container, |d| {
                                    d.cursor_pointer().child(icon(
                                        if expanded {
                                            "icons/chevron-down.svg"
                                        } else {
                                            "icons/chevron-right.svg"
                                        },
                                        11.0,
                                        th.faint,
                                    ))
                                })
                                .on_click(move |_, _, cx| {
                                    cx.stop_propagation();
                                    v1.update(cx, |this, cx| {
                                        if !this.collapsed.remove(&i1) {
                                            this.collapsed.insert(i1.clone());
                                        }
                                        cx.notify();
                                    });
                                }),
                        )
                        .child(icon(
                            if r.mask {
                                "icons/scan.svg"
                            } else {
                                node_icon(r.kind)
                            },
                            13.0,
                            if selected { th.accent_text } else { th.muted },
                        ))
                        .child(name_el)
                        .child(
                            div()
                                .id(("layer-lock", i))
                                .size(px(22.0))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(5.0))
                                .cursor_pointer()
                                .when(!lock, |d| {
                                    d.invisible().group_hover("layer-row", |s| s.visible())
                                })
                                .child(icon(
                                    if lock {
                                        "icons/lock.svg"
                                    } else {
                                        "icons/lock-open.svg"
                                    },
                                    12.0,
                                    if lock { th.accent_text } else { th.faint },
                                ))
                                .on_click(move |_, _, cx| {
                                    cx.stop_propagation();
                                    v2.update(cx, |this, cx| {
                                        this.set_flag(i2.clone(), "locked", !lock, cx)
                                    });
                                }),
                        )
                        .child(
                            div()
                                .id(("layer-eye", i))
                                .size(px(22.0))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(5.0))
                                .cursor_pointer()
                                .when(vis, |d| {
                                    d.invisible().group_hover("layer-row", |s| s.visible())
                                })
                                .child(icon(
                                    if vis {
                                        "icons/eye.svg"
                                    } else {
                                        "icons/eye-off.svg"
                                    },
                                    12.0,
                                    if vis { th.faint } else { th.accent_text },
                                ))
                                .on_click(move |_, _, cx| {
                                    cx.stop_propagation();
                                    v3.update(cx, |this, cx| {
                                        this.set_flag(i3.clone(), "visible", !vis, cx)
                                    });
                                }),
                        )
                        .children(match drop_here {
                            Some(Zone::Above) => Some(
                                div()
                                    .absolute()
                                    .top_0()
                                    .left(px(8.0 + r.depth as f32 * 14.0))
                                    .right(px(6.0))
                                    .h(px(2.0))
                                    .rounded(px(1.0))
                                    .bg(accent),
                            ),
                            Some(Zone::Below) => Some(
                                div()
                                    .absolute()
                                    .bottom_0()
                                    .left(px(8.0 + r.depth as f32 * 14.0))
                                    .right(px(6.0))
                                    .h(px(2.0))
                                    .rounded(px(1.0))
                                    .bg(accent),
                            ),
                            _ => None,
                        })
                        .on_hover(move |on, _, cx| {
                            let id = i4.clone();
                            let on = *on;
                            v4.update(cx, |this, cx| {
                                this.editor.update(cx, |e, cx| {
                                    let want = on.then_some(id);
                                    if e.session.hover != want {
                                        e.session.hover = want;
                                        cx.notify();
                                    }
                                });
                            });
                        })
                        .on_mouse_down(MouseButton::Left, {
                            let v = v5.clone();
                            let id = i5.clone();
                            let name = name2.clone();
                            move |e: &MouseDownEvent, window, cx| {
                                if e.click_count == 2 {
                                    let (id, name) = (id.clone(), name.clone());
                                    v.update(cx, |this, cx| {
                                        this.start_rename(id, name, window, cx)
                                    });
                                    return;
                                }
                                let shift = e.modifiers.shift;
                                let toggle = e.modifiers.secondary();
                                let id = id.clone();
                                v.update(cx, |this, cx| this.click(id, shift, toggle, cx));
                            }
                        })
                        .on_mouse_down(MouseButton::Right, move |e: &MouseDownEvent, window, cx| {
                            let id = i6.clone();
                            let at = e.position;
                            v6.update(cx, |this, cx| {
                                let sel = this.editor.read(cx).session.selection.clone();
                                if !sel.contains(&id) {
                                    this.click(id, false, false, cx);
                                }
                                this.editor
                                    .update(cx, |ed, cx| ed.show_context_menu(at, window, cx));
                            });
                        })
                        .on_drag(
                            {
                                let sel: Vec<Id> = if selection.contains(&r.id) {
                                    selection.iter().cloned().collect()
                                } else {
                                    vec![r.id.clone()]
                                };
                                let label = if sel.len() > 1 {
                                    format!("{} layers", sel.len())
                                } else {
                                    r.name.clone()
                                };
                                DraggedLayers { ids: sel, label }
                            },
                            |d, _, _, cx| cx.new(|_| d.clone()),
                        )
                        .on_drag_move::<DraggedLayers>({
                            let v = v7.clone();
                            let id = i7.clone();
                            move |e: &DragMoveEvent<DraggedLayers>, _, cx| {
                                let b = e.bounds;
                                if !b.contains(&e.event.position) {
                                    return;
                                }
                                let y = f32::from(e.event.position.y - b.top())
                                    / f32::from(b.size.height).max(1.0);
                                let zone = if container {
                                    if y < 0.28 {
                                        Zone::Above
                                    } else if y > 0.72 {
                                        Zone::Below
                                    } else {
                                        Zone::Inside
                                    }
                                } else if y < 0.5 {
                                    Zone::Above
                                } else {
                                    Zone::Below
                                };
                                let target = (id.clone(), zone);
                                v.update(cx, |this, cx| {
                                    if this.drop.as_ref() != Some(&target) {
                                        this.drop = Some(target);
                                        cx.notify();
                                    }
                                });
                            }
                        })
                        .on_drop({
                            let v = v.clone();
                            move |d: &DraggedLayers, _, cx| {
                                v.update(cx, |this, cx| this.do_drop(d, cx))
                            }
                        })
                })
                .collect::<Vec<_>>()
        })
        .track_scroll(&self.scroll)
        .flex_1();
        let header = gpui::div()
            .px(px(18.0))
            .pb(px(6.0))
            .flex()
            .items_center()
            .justify_between()
            .child(
                div()
                    .font_family(SANS)
                    .text_size(px(12.0))
                    .text_color(th.muted)
                    .child(page_name),
            )
            .child(
                div()
                    .font_family(MONO)
                    .text_size(px(11.0))
                    .text_color(th.faint)
                    .child(format!("{count} top-level")),
            );
        let content: gpui::AnyElement = if n == 0 {
            div()
                .px(px(18.0))
                .child(empty(
                    "an empty page",
                    "Layers appear here as you add shapes, text and images.",
                    None,
                    &th,
                ))
                .into_any_element()
        } else {
            div()
                .flex_1()
                .min_h(px(0.0))
                .px(px(10.0))
                .pb(px(12.0))
                .flex()
                .flex_col()
                .child(list)
                .on_drag_move::<DraggedLayers>(cx.listener(
                    |this, e: &DragMoveEvent<DraggedLayers>, _, cx| {
                        if !e.bounds.contains(&e.event.position) && this.drop.is_some() {
                            this.drop = None;
                            cx.notify();
                        }
                    },
                ))
                .into_any_element()
        };
        let _ = alpha;
        frame("layers", None, None, &th)
            .child(header)
            .child(content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::model::{DesignKind, Node};

    fn design() -> Design {
        let mut d = Design::with_page(
            "design000001",
            "x",
            DesignKind::Poster,
            "page00000001",
            500.0,
            500.0,
        );
        d.push_child(
            "page00000001",
            Node::frame("frame0000001", "Card", 100.0, 100.0, 200.0, 200.0),
        );
        d.push_child(
            "page00000001",
            Node::rect("rect00000001", "A", 10.0, 10.0, 20.0, 20.0),
        );
        d.push_child(
            "page00000001",
            Node::rect("rect00000002", "B", 50.0, 50.0, 20.0, 20.0),
        );
        d.push_child(
            "frame0000001",
            Node::rect("rect00000003", "C", 5.0, 5.0, 20.0, 20.0),
        );
        d
    }

    fn apply(d: &mut Design, ops: Vec<Op>) {
        let r = desyn_core::apply_transaction(
            d,
            &desyn_core::model::Transaction::new("t0000000001", "t", ops),
            Default::default(),
        );
        assert!(r.dropped.is_empty(), "{:?}", r.dropped);
    }

    #[test]
    fn rows_are_front_to_back_and_collapse() {
        let d = design();
        let r = rows(&d, "page00000001", &HashSet::new());
        let ids: Vec<&str> = r.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "rect00000002",
                "rect00000001",
                "frame0000001",
                "rect00000003"
            ]
        );
        assert_eq!(r[3].depth, 1);
        let mut c = HashSet::new();
        c.insert("frame0000001".to_string());
        assert_eq!(rows(&d, "page00000001", &c).len(), 3);
    }

    #[test]
    fn drop_into_a_frame_keeps_page_position() {
        let mut d = design();
        let ops = drop_ops(
            &mut d,
            &["rect00000001".into()],
            "frame0000001",
            Zone::Inside,
        );
        apply(&mut d, ops);
        let n = d.node("rect00000001").unwrap();
        assert_eq!(n.parent(), Some("frame0000001"));
        assert_eq!((n.base().x, n.base().y), (-90.0, -90.0));
        assert_eq!(
            d.node("frame0000001")
                .unwrap()
                .child_ids()
                .last()
                .map(String::as_str),
            Some("rect00000001")
        );
    }

    #[test]
    fn drop_above_and_below_reorders() {
        let mut d = design();
        // Put B (front) behind the frame (back).
        let ops = drop_ops(
            &mut d,
            &["rect00000002".into()],
            "frame0000001",
            Zone::Below,
        );
        apply(&mut d, ops);
        assert_eq!(
            d.node("page00000001").unwrap().child_ids(),
            &["rect00000002", "frame0000001", "rect00000001"]
        );
        // Move C out of the frame, in front of A.
        let ops = drop_ops(
            &mut d,
            &["rect00000003".into()],
            "rect00000001",
            Zone::Above,
        );
        apply(&mut d, ops);
        assert_eq!(
            d.node("page00000001").unwrap().child_ids(),
            &[
                "rect00000002",
                "frame0000001",
                "rect00000001",
                "rect00000003"
            ]
        );
        assert_eq!(d.node("rect00000003").unwrap().base().x, 105.0);
        // Never into itself.
        assert!(
            drop_ops(
                &mut d,
                &["frame0000001".into()],
                "frame0000001",
                Zone::Inside
            )
            .is_empty()
        );
    }

    #[test]
    fn dropping_several_layers_keeps_their_stacking_on_both_sides() {
        // Page (back to front): frame, A, B; the frame holds C. Drag A and B (B in front) next to C.
        let mut d = design();
        let both: Vec<Id> = vec!["rect00000002".into(), "rect00000001".into()];
        let ops = drop_ops(&mut d, &both, "rect00000003", Zone::Above);
        apply(&mut d, ops);
        assert_eq!(
            d.node("frame0000001").unwrap().child_ids(),
            &["rect00000003", "rect00000001", "rect00000002"]
        );
        let mut d = design();
        let ops = drop_ops(&mut d, &both, "rect00000003", Zone::Below);
        apply(&mut d, ops);
        assert_eq!(
            d.node("frame0000001").unwrap().child_ids(),
            &["rect00000001", "rect00000002", "rect00000003"]
        );
        // Within the same parent: both behind the frame.
        let mut d = design();
        let ops = drop_ops(&mut d, &both, "frame0000001", Zone::Below);
        apply(&mut d, ops);
        assert_eq!(
            d.node("page00000001").unwrap().child_ids(),
            &["rect00000001", "rect00000002", "frame0000001"]
        );
    }

    #[test]
    fn never_into_itself() {
        let mut d = design();
        assert!(
            drop_ops(
                &mut d,
                &["frame0000001".into()],
                "frame0000001",
                Zone::Inside
            )
            .is_empty()
        );
    }
}
