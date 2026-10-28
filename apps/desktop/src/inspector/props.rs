//! Pure helpers behind the inspector: read the selection as JSON, find values common to every selected layer
//! (`None` = mixed), and build the ops for an edit. Everything goes through `update` ops on whole top-level keys
//! (fills, strokes, effects, style, ...), so one inspector gesture is one transaction.

use desyn_core::arrange::top_level_selection;
use desyn_core::model::{Design, Id, NodeType, Op};
use serde_json::{Map, Value, json};

/// The selection as the inspector sees it.
#[derive(Debug, Clone, Default)]
pub struct Sel {
    /// Selected ids (top-level, pages excluded unless the page itself is the target).
    pub ids: Vec<Id>,
    /// Node JSON in the same order.
    pub nodes: Vec<Value>,
    /// Types in the same order.
    pub types: Vec<NodeType>,
    /// Current page.
    pub page: Id,
    /// No layer selected: the page is the target.
    pub is_page: bool,
}

impl Sel {
    /// Builds the selection (the page when nothing is selected).
    pub fn new(d: &Design, selection: &[Id], page: &str) -> Sel {
        let ids: Vec<Id> = top_level_selection(d, selection)
            .into_iter()
            .filter(|id| {
                d.node(id)
                    .is_some_and(|n| !matches!(n.node_type(), NodeType::Root))
            })
            .collect();
        let (ids, is_page) = if ids.is_empty() {
            (vec![page.to_string()], true)
        } else {
            (ids, false)
        };
        let nodes: Vec<Value> = ids
            .iter()
            .filter_map(|id| d.node(id).and_then(|n| serde_json::to_value(n).ok()))
            .collect();
        let types = ids
            .iter()
            .filter_map(|id| d.node(id).map(|n| n.node_type()))
            .collect();
        Sel {
            ids,
            nodes,
            types,
            page: page.to_string(),
            is_page,
        }
    }

    /// Single node selected.
    pub fn single(&self) -> Option<&Value> {
        (self.nodes.len() == 1).then(|| &self.nodes[0])
    }

    /// Every selected node has this type.
    pub fn all(&self, t: NodeType) -> bool {
        !self.types.is_empty() && self.types.iter().all(|x| *x == t)
    }

    /// Some selected node has one of these types.
    pub fn any(&self, ts: &[NodeType]) -> bool {
        self.types.iter().any(|t| ts.contains(t))
    }

    /// Value shared by every node at `path` (`None` when mixed or missing everywhere).
    pub fn common(&self, path: &[&str]) -> Option<Value> {
        let mut out: Option<Value> = None;
        for n in &self.nodes {
            let v = get(n, path)?.clone();
            match &out {
                None => out = Some(v),
                Some(o) if *o == v => {}
                Some(_) => return None,
            }
        }
        out
    }

    /// Numeric value shared by every node.
    pub fn num(&self, path: &[&str]) -> Option<f64> {
        let mut out: Option<f64> = None;
        for n in &self.nodes {
            let v = get(n, path).and_then(Value::as_f64)?;
            match out {
                None => out = Some(v),
                Some(o) if (o - v).abs() < 1e-9 => {}
                Some(_) => return None,
            }
        }
        out
    }

    /// String value shared by every node.
    pub fn str(&self, path: &[&str]) -> Option<String> {
        self.common(path)
            .and_then(|v| v.as_str().map(str::to_string))
    }

    /// Bool shared by every node (missing = `default`).
    pub fn flag(&self, path: &[&str], default: bool) -> Option<bool> {
        let mut out: Option<bool> = None;
        for n in &self.nodes {
            let v = get(n, path).and_then(Value::as_bool).unwrap_or(default);
            match out {
                None => out = Some(v),
                Some(o) if o == v => {}
                Some(_) => return None,
            }
        }
        out
    }

    /// One `update` per node setting `key` to `f(node)` (nodes where `f` returns `None` are skipped).
    pub fn set_each(&self, key: &str, mut f: impl FnMut(&Value) -> Option<Value>) -> Vec<Op> {
        self.ids
            .iter()
            .zip(&self.nodes)
            .filter_map(|(id, n)| f(n).map(|v| update(id, key, v)))
            .collect()
    }

    /// Sets `key` to the same value on every node.
    pub fn set_all(&self, key: &str, v: Value) -> Vec<Op> {
        self.set_each(key, |_| Some(v.clone()))
    }

    /// Deep-sets `path` inside a top-level key on every node, creating objects on the way.
    pub fn set_path(&self, path: &[&str], v: Value) -> Vec<Op> {
        let Some((key, rest)) = path.split_first() else {
            return Vec::new();
        };
        self.set_each(key, |n| {
            let mut top = n.get(*key).cloned().unwrap_or(Value::Null);
            set_in(&mut top, rest, v.clone());
            Some(top)
        })
    }
}

/// Reads a JSON path.
pub fn get<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for p in path {
        cur = match cur {
            Value::Object(o) => o.get(*p)?,
            Value::Array(a) => a.get(p.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

/// Sets a JSON path (objects created as needed; array indexes must exist or be the next index).
pub fn set_in(v: &mut Value, path: &[&str], new: Value) {
    let Some((head, rest)) = path.split_first() else {
        *v = new;
        return;
    };
    if let Ok(i) = head.parse::<usize>()
        && let Value::Array(a) = v
    {
        if i == a.len() {
            a.push(Value::Null);
        }
        if let Some(slot) = a.get_mut(i) {
            set_in(slot, rest, new);
        }
        return;
    }
    if !v.is_object() {
        *v = Value::Object(Map::new());
    }
    if let Value::Object(o) = v {
        set_in(o.entry(head.to_string()).or_insert(Value::Null), rest, new);
    }
}

/// `update` op setting one key.
pub fn update(id: &str, key: &str, v: Value) -> Op {
    let mut m = Map::new();
    m.insert(key.to_string(), v);
    Op::update_set(id, m)
}

/// A number rounded for the document (no `-0`, 4 decimals).
pub fn n(v: f64) -> Value {
    let r = (v * 10_000.0).round() / 10_000.0;
    json!(if r == 0.0 { 0.0 } else { r })
}

/// The fills key of a node type (`background` for pages, `fills` for shapes, `style.fills` for text).
pub fn fills_path(t: NodeType) -> Option<&'static [&'static str]> {
    match t {
        NodeType::Page => Some(&["background"]),
        NodeType::Text => Some(&["style", "fills"]),
        NodeType::Frame
        | NodeType::Rect
        | NodeType::Ellipse
        | NodeType::Polygon
        | NodeType::Star
        | NodeType::Path
        | NodeType::Boolean => Some(&["fills"]),
        _ => None,
    }
}

/// Default solid fill.
pub fn solid(color: &str) -> Value {
    json!({ "type": "solid", "color": color })
}

/// Default stroke.
pub fn stroke(color: &str, width: f64) -> Value {
    json!({ "fills": [solid(color)], "width": width, "align": "inside", "cap": "butt", "join": "miter" })
}

/// The color shown for a fill (solid color, or the first stop of a gradient).
pub fn fill_color(f: &Value) -> Option<String> {
    match f.get("type").and_then(Value::as_str)? {
        "solid" => f.get("color").and_then(Value::as_str).map(str::to_string),
        "linear" | "radial" | "conic" => f
            .get("stops")
            .and_then(Value::as_array)
            .and_then(|s| s.first())
            .and_then(|s| s.get("color"))
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

/// Converts a fill to another kind keeping its colors.
pub fn convert_fill(f: &Value, kind: &str) -> Value {
    let base = fill_color(f).unwrap_or_else(|| "#d9d9d9".into());
    let stops = f.get("stops").cloned().unwrap_or_else(
        || json!([{ "pos": 0, "color": base }, { "pos": 1, "color": lighten(&base) }]),
    );
    let mut out = match kind {
        "solid" => json!({ "type": "solid", "color": base }),
        "linear" => json!({ "type": "linear", "angle": 90, "stops": stops }),
        "radial" => {
            json!({ "type": "radial", "cx": 0.5, "cy": 0.5, "rx": 0.5, "ry": 0.5, "stops": stops })
        }
        "conic" => json!({ "type": "conic", "cx": 0.5, "cy": 0.5, "angle": 0, "stops": stops }),
        _ => f.clone(),
    };
    for k in ["opacity", "visible", "blend"] {
        if let (Some(v), Some(o)) = (f.get(k), out.as_object_mut()) {
            o.insert(k.into(), v.clone());
        }
    }
    out
}

fn lighten(c: &str) -> String {
    desyn_core::model::Color::new(c.to_string())
        .map(|col| {
            let [r, g, b, a] = col.rgba8();
            let l = |x: u8| x.saturating_add(((255 - x as u16) / 2) as u8);
            format!(
                "#{:02x}{:02x}{:02x}{}",
                l(r),
                l(g),
                l(b),
                if a == 255 {
                    String::new()
                } else {
                    format!("{a:02x}")
                }
            )
        })
        .unwrap_or_else(|_| "#ffffff".into())
}

/// Corner radii `[tl, tr, br, bl]` of a node JSON.
pub fn radii(v: &Value) -> Option<[f64; 4]> {
    match v.get("cornerRadius")? {
        Value::Number(n) => {
            let r = n.as_f64()?;
            Some([r; 4])
        }
        Value::Array(a) if a.len() == 4 => {
            let mut out = [0.0; 4];
            for (i, x) in a.iter().enumerate() {
                out[i] = x.as_f64()?;
            }
            Some(out)
        }
        _ => None,
    }
}

/// Node types with a corner radius.
pub fn has_radius(t: NodeType) -> bool {
    matches!(
        t,
        NodeType::Rect
            | NodeType::Frame
            | NodeType::Image
            | NodeType::Video
            | NodeType::Polygon
            | NodeType::Star
    )
}

/// Node types with strokes.
pub fn has_stroke(t: NodeType) -> bool {
    !matches!(
        t,
        NodeType::Root
            | NodeType::Page
            | NodeType::Group
            | NodeType::Audio
            | NodeType::Chart
            | NodeType::Table
            | NodeType::Qr
            | NodeType::Video
    )
}

/// Default effect of a kind.
pub fn effect(kind: &str) -> Value {
    match kind {
        "dropShadow" => {
            json!({ "type": "dropShadow", "x": 0, "y": 8, "blur": 24, "spread": 0, "color": "#00000040" })
        }
        "innerShadow" => {
            json!({ "type": "innerShadow", "x": 0, "y": 2, "blur": 6, "spread": 0, "color": "#00000033" })
        }
        "layerBlur" => json!({ "type": "layerBlur", "radius": 8 }),
        "backgroundBlur" => json!({ "type": "backgroundBlur", "radius": 16 }),
        "noise" => json!({ "type": "noise", "amount": 0.15, "scale": 1, "mono": true }),
        _ => json!({ "type": "glow", "radius": 24, "strength": 0.6, "color": "#ffb02e" }),
    }
}

/// Image adjustment keys with their ranges and display scale.
pub const ADJUSTMENTS: &[(&str, &str, f64, f64)] = &[
    ("brightness", "Brightness", -1.0, 1.0),
    ("contrast", "Contrast", -1.0, 1.0),
    ("saturation", "Saturation", -1.0, 1.0),
    ("exposure", "Exposure", -1.0, 1.0),
    ("temperature", "Warmth", -1.0, 1.0),
    ("tint", "Tint", -1.0, 1.0),
    ("highlights", "Highlights", -1.0, 1.0),
    ("shadows", "Shadows", -1.0, 1.0),
    ("hue", "Hue", -180.0, 180.0),
    ("vignette", "Vignette", 0.0, 1.0),
    ("grain", "Grain", 0.0, 1.0),
    ("sharpen", "Sharpen", 0.0, 1.0),
    ("grayscale", "Grayscale", 0.0, 1.0),
    ("sepia", "Sepia", 0.0, 1.0),
    ("blur", "Blur", 0.0, 100.0),
];

/// Named filter presets the renderer knows (DOCUMENT_MODEL change log, raster agent).
pub const FILTERS: &[(&str, &str)] = &[
    ("vivid", "Vivid"),
    ("warm", "Warm"),
    ("cool", "Cool"),
    ("mono", "Mono"),
    ("noir", "Noir"),
    ("vintage", "Vintage"),
    ("fade", "Fade"),
    ("dramatic", "Drama"),
    ("film", "Film"),
    ("sunset", "Sunset"),
    ("matte", "Matte"),
    ("chrome", "Chrome"),
    ("lush", "Lush"),
    ("dusk", "Dusk"),
];

/// A complete `ImageAdjust` with every key at zero (the schema requires them all).
pub fn neutral_adjust() -> Value {
    json!({
        "brightness": 0, "contrast": 0, "saturation": 0, "hue": 0, "temperature": 0, "tint": 0,
        "exposure": 0, "vignette": 0, "blur": 0, "grayscale": 0, "sepia": 0, "sharpen": 0, "grain": 0
    })
}

/// Animation presets.
pub const ANIM_PRESETS: &[(&str, &str)] = &[
    ("fade", "Fade"),
    ("rise", "Rise"),
    ("drop", "Drop"),
    ("slide-left", "Slide left"),
    ("slide-right", "Slide right"),
    ("zoom-in", "Zoom in"),
    ("zoom-out", "Zoom out"),
    ("pop", "Pop"),
    ("rotate", "Rotate"),
    ("wipe", "Wipe"),
    ("typewriter", "Typewriter"),
    ("blur-in", "Blur in"),
    ("pulse", "Pulse"),
    ("float", "Float"),
    ("shake", "Shake"),
];

/// Blend modes with labels.
pub const BLEND_MODES: &[(&str, &str)] = &[
    ("normal", "Normal"),
    ("multiply", "Multiply"),
    ("screen", "Screen"),
    ("overlay", "Overlay"),
    ("darken", "Darken"),
    ("lighten", "Lighten"),
    ("color-dodge", "Color dodge"),
    ("color-burn", "Color burn"),
    ("hard-light", "Hard light"),
    ("soft-light", "Soft light"),
    ("difference", "Difference"),
    ("exclusion", "Exclusion"),
    ("hue", "Hue"),
    ("saturation", "Saturation"),
    ("color", "Color"),
    ("luminosity", "Luminosity"),
];

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
            100.0,
            100.0,
        );
        d.push_child(
            "page00000001",
            Node::rect("rect00000001", "a", 0.0, 0.0, 10.0, 10.0),
        );
        d.push_child(
            "page00000001",
            Node::rect("rect00000002", "b", 5.0, 0.0, 10.0, 20.0),
        );
        d
    }

    #[test]
    fn common_values_and_mixed() {
        let d = design();
        let s = Sel::new(
            &d,
            &["rect00000001".into(), "rect00000002".into()],
            "page00000001",
        );
        assert!(!s.is_page);
        assert_eq!(s.num(&["width"]), Some(10.0));
        assert_eq!(s.num(&["height"]), None);
        assert_eq!(s.num(&["x"]), None);
        assert!(s.all(NodeType::Rect));
        assert_eq!(
            fill_color(&s.common(&["fills", "0"]).unwrap()).as_deref(),
            Some("#d9d9d9")
        );
        let page = Sel::new(&d, &[], "page00000001");
        assert!(page.is_page && page.all(NodeType::Page));
    }

    #[test]
    fn ops_apply() {
        let mut d = design();
        let s = Sel::new(
            &d,
            &["rect00000001".into(), "rect00000002".into()],
            "page00000001",
        );
        let mut ops = s.set_all("opacity", n(0.5));
        ops.extend(s.set_path(&["fills", "0", "color"], json!("#ff0000")));
        let tx = desyn_core::model::Transaction::new("t0000000001", "x", ops);
        let r = desyn_core::apply_transaction(&mut d, &tx, Default::default());
        assert!(r.dropped.is_empty(), "{:?}", r.dropped);
        let s2 = Sel::new(
            &d,
            &["rect00000001".into(), "rect00000002".into()],
            "page00000001",
        );
        assert_eq!(s2.num(&["opacity"]), Some(0.5));
        assert_eq!(s2.str(&["fills", "0", "color"]).as_deref(), Some("#ff0000"));
    }

    #[test]
    fn fills_convert_and_radii() {
        let g = convert_fill(&solid("#000000"), "linear");
        assert_eq!(g["type"], "linear");
        assert_eq!(g["stops"][1]["color"], "#7f7f7f");
        assert_eq!(convert_fill(&g, "solid")["color"], "#000000");
        assert_eq!(radii(&json!({ "cornerRadius": 4 })), Some([4.0; 4]));
        assert_eq!(
            radii(&json!({ "cornerRadius": [1, 2, 3, 4] })),
            Some([1.0, 2.0, 3.0, 4.0])
        );
        let mut v = json!({});
        set_in(&mut v, &["a", "b"], json!(1));
        assert_eq!(v, json!({ "a": { "b": 1 } }));
        assert_eq!(n(-0.00001), json!(0.0));
    }
}
