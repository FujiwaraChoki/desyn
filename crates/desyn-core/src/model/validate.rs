//! Invariant checks (DOCUMENT_MODEL section 4).

use rustc_hash::FxHashSet;
use serde::Serialize;

use super::design::{AssetRef, Design, DesignStyles};
use super::node::{Container, CornerRadius, Node, NodeType, Shaped};
use super::paint::{Effect, Fill, Stroke};
use super::primitives::{ColorRef, ColorValue, Id, ROOT_ID};
use super::text::{TextStyle, TextStylePatch};

/// One invariant violation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Violation {
    /// Offending node (if node-specific).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    /// Stable machine code.
    pub code: &'static str,
    /// Human-readable detail.
    pub message: String,
}

fn v(id: Option<&str>, code: &'static str, message: impl Into<String>) -> Violation {
    Violation {
        id: id.map(str::to_string),
        code,
        message: message.into(),
    }
}

/// True for a generated id: exactly 12 chars `[a-z0-9]` (the `IdSchema` pattern of `@desyn/schema`).
pub fn is_id(s: &str) -> bool {
    s.len() == 12
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// True for an id that may name a node: a generated id or `"root"`.
pub fn is_node_id(s: &str) -> bool {
    s == ROOT_ID || is_id(s)
}

type Check = Result<(), String>;

fn non_neg(name: &str, v: f64) -> Check {
    if v.is_finite() && v >= 0.0 {
        Ok(())
    } else {
        Err(format!("{name} must be >= 0 (got {v})"))
    }
}

fn unit01(name: &str, v: f64) -> Check {
    if v.is_finite() && (0.0..=1.0).contains(&v) {
        Ok(())
    } else {
        Err(format!("{name} must be in 0..1 (got {v})"))
    }
}

fn finite(name: &str, v: f64) -> Check {
    if v.is_finite() {
        Ok(())
    } else {
        Err(format!("{name} must be finite"))
    }
}

fn id_field(name: &str, v: &str) -> Check {
    if is_id(v) {
        Ok(())
    } else {
        Err(format!("{name} {v:?} is not a 12-char [a-z0-9] id"))
    }
}

fn check_color_value(c: &ColorValue) -> Check {
    match c {
        ColorValue::Ref(ColorRef::Style { style, .. }) => id_field("$style", style),
        _ => Ok(()),
    }
}

/// Value-range rules of one fill (mirrors `FillSchema`).
pub fn check_fill(f: &Fill) -> Result<(), String> {
    if let Some(o) = f.flags().opacity {
        unit01("fill opacity", o)?;
    }
    if let Some(stops) = f.stops() {
        for s in stops {
            unit01("stop pos", s.pos)?;
            check_color_value(&s.color)?;
        }
    }
    match f {
        Fill::Solid(s) => check_color_value(&s.color),
        Fill::Image(i) => id_field("assetId", &i.asset_id),
        _ => Ok(()),
    }
}

fn check_fills(fills: &[Fill]) -> Check {
    fills.iter().try_for_each(check_fill)
}

fn check_strokes(strokes: &[Stroke]) -> Check {
    for s in strokes {
        check_fills(&s.fills)?;
        non_neg("stroke width", s.width)?;
        if let Some(d) = &s.dash {
            for v in d {
                non_neg("dash", *v)?;
            }
        }
    }
    Ok(())
}

fn check_effects(effects: &[Effect]) -> Check {
    for e in effects {
        match e {
            Effect::DropShadow(s) | Effect::InnerShadow(s) => non_neg("shadow blur", s.blur)?,
            Effect::LayerBlur(b) | Effect::BackgroundBlur(b) => non_neg("blur radius", b.radius)?,
            Effect::Glow(g) => non_neg("glow radius", g.radius)?,
            Effect::Noise(_) => {}
        }
    }
    Ok(())
}

fn check_text_style(s: &TextStyle) -> Check {
    non_neg("fontSize", s.font_size)?;
    check_fills(&s.fills)
}

fn check_text_patch(s: &TextStylePatch) -> Check {
    if let Some(v) = s.font_size {
        non_neg("fontSize", v)?;
    }
    if let Some(f) = &s.fills {
        check_fills(f)?;
    }
    Ok(())
}

fn check_corner_radius(c: &CornerRadius) -> Check {
    c.corners()
        .iter()
        .try_for_each(|r| non_neg("cornerRadius", *r))
}

fn check_shaped(s: &Shaped) -> Check {
    check_fills(&s.fills)?;
    check_strokes(&s.strokes)?;
    check_corner_radius(&s.corner_radius)?;
    if let Some(v) = s.corner_smoothing {
        unit01("cornerSmoothing", v)?;
    }
    Ok(())
}

fn check_container(c: &Container) -> Check {
    for ch in &c.children {
        id_field("child", ch)?;
    }
    if let Some(l) = &c.layout {
        if l.columns == Some(0) {
            return Err("layout.columns must be >= 1".into());
        }
        finite("layout.gap", l.gap)?;
    }
    Ok(())
}

/// Schema rules of a node that serde types cannot express (mirrors the zod node schemas of `@desyn/schema`):
/// id patterns, `parent` rules, non-negative / 0..1 ranges, integer minimums, svg `assetId | markup`.
pub fn check_node_schema(node: &Node) -> Result<(), String> {
    let b = node.base();
    match node {
        Node::Root(_) => {
            if b.id != ROOT_ID {
                return Err("root node id must be \"root\"".into());
            }
            if b.parent.is_some() {
                return Err("root parent must be null".into());
            }
        }
        _ => {
            id_field("id", &b.id)?;
            match &b.parent {
                None => return Err("non-root node must have a parent".into()),
                Some(p) if !is_node_id(p) => return Err(format!("parent {p:?} is not a node id")),
                Some(p) if matches!(node, Node::Page(_)) && p != ROOT_ID => {
                    return Err("page parent must be \"root\"".into());
                }
                _ => {}
            }
        }
    }
    finite("x", b.x)?;
    finite("y", b.y)?;
    finite("rotation", b.rotation)?;
    non_neg("width", b.width)?;
    non_neg("height", b.height)?;
    unit01("opacity", b.opacity)?;
    check_effects(&b.effects)?;
    if let Some(anims) = &b.anim {
        for a in anims {
            id_field("animation id", &a.id)?;
            non_neg("animation durationMs", a.duration_ms)?;
        }
    }
    if let Some(c) = node.container() {
        check_container(c)?;
    }
    if let Some(s) = node.shaped() {
        check_shaped(s)?;
    }
    match node {
        Node::Root(r) => r.children.iter().try_for_each(|c| id_field("child", c))?,
        Node::Page(p) => {
            check_fills(&p.background)?;
            non_neg("bleed", p.bleed)?;
            if let Some(d) = p.duration_ms {
                non_neg("durationMs", d)?;
            }
            if let Some(t) = &p.transition {
                non_neg("transition durationMs", t.duration_ms)?;
            }
            if let Some(g) = &p.grid
                && g.columns < 1
            {
                return Err("grid.columns must be >= 1".into());
            }
        }
        Node::Ellipse(e) => {
            if let Some(a) = &e.arc {
                unit01("arc.inner", a.inner)?;
            }
        }
        Node::Polygon(p) if p.sides < 3 => return Err("sides must be >= 3".into()),
        Node::Star(s) => {
            if s.points < 3 {
                return Err("points must be >= 3".into());
            }
            unit01("innerRatio", s.inner_ratio)?;
        }
        Node::Line(l) => check_strokes(&l.strokes)?,
        Node::Text(t) => {
            check_text_style(&t.style)?;
            for r in &t.runs {
                if let Some(s) = &r.style {
                    check_text_patch(s)?;
                }
            }
            if t.max_lines == Some(0) {
                return Err("maxLines must be >= 1".into());
            }
            if let Some(s) = &t.strokes {
                check_strokes(s)?;
            }
            if let Some(r) = &t.style_ref {
                id_field("styleRef", r)?;
            }
        }
        Node::Image(i) => {
            id_field("assetId", &i.asset_id)?;
            check_corner_radius(&i.corner_radius)?;
            check_strokes(&i.strokes)?;
            if let Some(m) = &i.mask_asset_id {
                id_field("maskAssetId", m)?;
            }
        }
        Node::Svg(s) => {
            if s.asset_id.is_none() && s.markup.is_none() {
                return Err("svg node requires assetId or markup".into());
            }
            if let Some(a) = &s.asset_id {
                id_field("assetId", a)?;
            }
            if let Some(st) = &s.strokes {
                check_strokes(st)?;
            }
        }
        Node::Video(v) => {
            id_field("assetId", &v.asset_id)?;
            non_neg("trimStartMs", v.trim_start_ms)?;
            if let Some(t) = v.trim_end_ms {
                non_neg("trimEndMs", t)?;
            }
            if let Some(p) = &v.poster_asset_id {
                id_field("posterAssetId", p)?;
            }
            non_neg("cornerRadius", v.corner_radius)?;
        }
        Node::Audio(a) => {
            id_field("assetId", &a.asset_id)?;
            non_neg("trimStartMs", a.trim_start_ms)?;
            for (n, v) in [
                ("trimEndMs", a.trim_end_ms),
                ("fadeInMs", a.fade_in_ms),
                ("fadeOutMs", a.fade_out_ms),
            ] {
                if let Some(v) = v {
                    non_neg(n, v)?;
                }
            }
        }
        Node::Chart(c) => non_neg("options.fontSize", c.options.font_size)?,
        Node::Table(t) => {
            for w in t.col_widths.iter().chain(t.row_heights.iter()) {
                non_neg("table track size", *w)?;
            }
            non_neg("borderWidth", t.border_width)?;
            non_neg("cellPadding", t.cell_padding)?;
            check_text_style(&t.default_style)?;
            for c in &t.cells {
                if c.colspan == Some(0) || c.rowspan == Some(0) {
                    return Err("colspan/rowspan must be >= 1".into());
                }
                if let Some(s) = &c.style {
                    check_text_patch(s)?;
                }
                if let Some(f) = &c.fill {
                    check_fill(f)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Schema rules of an asset reference (mirrors `AssetRefSchema`).
pub fn check_asset_schema(a: &AssetRef) -> Result<(), String> {
    id_field("asset id", &a.id)?;
    for (n, v) in [
        ("bytes", a.bytes),
        ("width", a.width),
        ("height", a.height),
        ("durationMs", a.duration_ms),
    ] {
        if let Some(v) = v {
            non_neg(n, v)?;
        }
    }
    Ok(())
}

/// Schema rules of `Design.styles` (mirrors `DesignStylesSchema`).
pub fn check_styles_schema(s: &DesignStyles) -> Result<(), String> {
    for k in s.colors.keys().chain(s.text.keys()).chain(s.effects.keys()) {
        id_field("style id", k)?;
    }
    for t in s.text.values() {
        check_text_style(&t.style)?;
    }
    for e in s.effects.values() {
        check_effects(&e.effects)?;
    }
    Ok(())
}

/// Node-level invariants and schema rules (used by the transaction applier after every node mutation).
pub fn validate_node(node: &Node) -> Result<(), Violation> {
    let id = Some(node.id());
    if !node.is_container() && node.extra().contains_key("children") {
        return Err(v(
            id,
            "leaf-children",
            "non-container nodes have no children",
        ));
    }
    check_node_schema(node).map_err(|m| v(id, "schema", m))
}

/// Checks every invariant of a design; returns all violations (empty = valid).
pub fn validate_design(d: &Design) -> Vec<Violation> {
    let mut out = Vec::new();
    if d.schema != 1 {
        out.push(v(
            None,
            "schema",
            format!("unsupported schema {}", d.schema),
        ));
    }
    if !is_id(&d.id) {
        out.push(v(
            None,
            "schema",
            format!("design id {:?} is not a 12-char [a-z0-9] id", d.id),
        ));
    }
    for (k, a) in &d.assets {
        if k != &a.id {
            out.push(v(
                Some(k),
                "asset-key-mismatch",
                format!("asset key {k:?} differs from asset id {:?}", a.id),
            ));
        }
        if let Err(m) = check_asset_schema(a) {
            out.push(v(Some(k), "schema", m));
        }
    }
    if let Err(m) = check_styles_schema(&d.styles) {
        out.push(v(None, "schema", m));
    }
    let Some(root) = d.node(ROOT_ID) else {
        out.push(v(None, "missing-root", "nodes[\"root\"] is missing"));
        return out;
    };
    if root.node_type() != NodeType::Root || root.parent().is_some() {
        out.push(v(
            Some(ROOT_ID),
            "bad-root",
            "root must have type \"root\" and parent null",
        ));
    }
    for (key, node) in &d.nodes {
        if key != node.id() {
            out.push(v(
                Some(key),
                "key-mismatch",
                format!("map key {key:?} differs from node id {:?}", node.id()),
            ));
        }
        if let Err(e) = validate_node(node) {
            out.push(e);
        }
        if key != ROOT_ID {
            if node.node_type() == NodeType::Root {
                out.push(v(
                    Some(key),
                    "extra-root",
                    "only nodes[\"root\"] may have type root",
                ));
            }
            match node.parent() {
                None => out.push(v(Some(key), "orphan", "non-root node without parent")),
                Some(p) => match d.node(p) {
                    None => out.push(v(
                        Some(key),
                        "missing-parent",
                        format!("parent {p:?} does not exist"),
                    )),
                    Some(pn) => {
                        let count = pn.child_ids().iter().filter(|c| *c == key).count();
                        if count != 1 {
                            out.push(v(
                                Some(key),
                                "not-in-parent",
                                format!("appears {count} times in parent's children"),
                            ));
                        }
                        let is_page = node.node_type() == NodeType::Page;
                        let parent_is_root = pn.node_type() == NodeType::Root;
                        if is_page != parent_is_root {
                            out.push(v(
                                Some(key),
                                "placement",
                                "pages must be children of root and only pages may be",
                            ));
                        }
                    }
                },
            }
        }
        if let Some(children) = node.children() {
            let mut seen = FxHashSet::default();
            for c in children {
                if !seen.insert(c.as_str()) {
                    out.push(v(
                        Some(key),
                        "duplicate-child",
                        format!("child {c:?} listed twice"),
                    ));
                }
                match d.node(c) {
                    None => out.push(v(
                        Some(key),
                        "missing-child",
                        format!("child {c:?} does not exist"),
                    )),
                    Some(cn) => {
                        if cn.parent() != Some(key.as_str()) {
                            out.push(v(
                                Some(c),
                                "parent-mismatch",
                                format!("listed under {key:?} but parent is {:?}", cn.parent()),
                            ));
                        }
                    }
                }
            }
        }
    }
    // Reachability (also catches cycles not attached to root).
    let reachable = d.subtree_ids(ROOT_ID);
    if reachable.len() != d.nodes.len() {
        let set: FxHashSet<&str> = reachable.iter().map(String::as_str).collect();
        for key in d.nodes.keys() {
            if !set.contains(key.as_str()) {
                out.push(v(
                    Some(key),
                    "unreachable",
                    "node is not reachable from root (cycle or detached)",
                ));
            }
        }
    }
    out
}
