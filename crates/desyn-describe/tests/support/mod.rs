//! Test helpers: a small builder for fixture designs, the fixture file format, a synthetic image sampler and the
//! expectation checker.

#![allow(dead_code, clippy::too_many_arguments)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use desyn_core::layout::normalize_all;
use desyn_core::{
    AssetKind, AssetRef, AutoResize, Color, ColorValue, Design, DesignKind, Fill, Node, PageNode,
    Stop, TextAlign, TextRun, Unit,
};
use desyn_describe::{DescribeOptions, Description, Issue, PixelSampler, describe};
use desyn_text::TextEngine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PAGE: &str = "page00000001";

/// 12-character id from a readable name (`"headline"` -> `"headline0000"`).
pub fn nid(name: &str) -> String {
    let mut s: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .take(12)
        .collect();
    while s.len() < 12 {
        s.push('0');
    }
    s
}

pub fn color(s: &str) -> Color {
    Color::new(s).expect("color")
}

pub fn solid(s: &str) -> Vec<Fill> {
    vec![Fill::solid(color(s))]
}

pub fn linear(angle: f64, a: &str, b: &str) -> Vec<Fill> {
    let stop = |pos: f64, c: &str| Stop {
        pos,
        color: ColorValue::Color(color(c)),
        extra: Default::default(),
    };
    let v = serde_json::json!({ "type": "linear", "angle": angle, "stops": [stop(0.0, a), stop(1.0, b)] });
    vec![serde_json::from_value(v).expect("fill")]
}

/// Fixture design builder. Every method takes the readable name; ids are derived with [`nid`].
pub struct B {
    pub d: Design,
}

impl B {
    pub fn new(kind: DesignKind, w: f64, h: f64) -> B {
        let mut d = Design::with_page("design000001", "Fixture", kind, PAGE, w, h);
        if let Some(Node::Page(p)) = d.node_mut(PAGE) {
            p.background = solid("#ffffff");
        }
        B { d }
    }

    pub fn design_meta(&mut self, key: &str, value: &str) {
        self.d.meta.insert(key.into(), Value::String(value.into()));
    }

    pub fn page(&mut self) -> &mut PageNode {
        match self.d.node_mut(PAGE) {
            Some(Node::Page(p)) => p,
            _ => unreachable!("page exists"),
        }
    }

    pub fn print(mut self, unit: Unit, bleed: f64) -> B {
        let p = self.page();
        p.unit = unit;
        p.bleed = bleed;
        self
    }

    fn add(&mut self, parent: &str, node: Node) -> String {
        let id = node.id().to_string();
        let parent = if parent.is_empty() {
            PAGE.to_string()
        } else {
            nid(parent)
        };
        assert!(
            self.d.push_child(&parent, node),
            "parent {parent} must exist and id {id} be new"
        );
        id
    }

    pub fn rect(
        &mut self,
        parent: &str,
        name: &str,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: &str,
    ) -> String {
        let mut n = Node::rect(nid(name), name, x, y, w, h);
        n.shaped_mut().expect("shaped").fills = if fill.is_empty() { vec![] } else { solid(fill) };
        self.add(parent, n)
    }

    pub fn ellipse(
        &mut self,
        parent: &str,
        name: &str,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: &str,
    ) -> String {
        let mut n = Node::ellipse(nid(name), name, x, y, w, h);
        n.shaped_mut().expect("shaped").fills = solid(fill);
        self.add(parent, n)
    }

    pub fn frame(
        &mut self,
        parent: &str,
        name: &str,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: &str,
    ) -> String {
        let mut n = Node::frame(nid(name), name, x, y, w, h);
        n.shaped_mut().expect("shaped").fills = if fill.is_empty() { vec![] } else { solid(fill) };
        if let Some(c) = n.container_mut() {
            c.clip = false;
        }
        self.add(parent, n)
    }

    pub fn group(&mut self, parent: &str, name: &str, x: f64, y: f64, w: f64, h: f64) -> String {
        let n = Node::group(nid(name), name, x, y, w, h);
        self.add(parent, n)
    }

    /// Text with a fixed width (auto-resize height), size, weight and color.
    #[allow(clippy::too_many_arguments)]
    pub fn text(
        &mut self,
        parent: &str,
        name: &str,
        text: &str,
        x: f64,
        y: f64,
        w: f64,
        size: f64,
        weight: f64,
        fill: &str,
    ) -> String {
        let mut n = Node::text(nid(name), text, x, y, Some(w));
        n.base_mut().name = name.to_string();
        if let Node::Text(t) = &mut n {
            t.style.font_size = size;
            t.style.font_weight = weight;
            t.style.fills = solid(fill);
            t.base.height = (size * 1.2).round();
        }
        self.add(parent, n)
    }

    pub fn image(
        &mut self,
        parent: &str,
        name: &str,
        asset: &str,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> String {
        let n = Node::image(nid(name), name, nid(asset), x, y, w, h);
        self.add(parent, n)
    }

    pub fn svg(
        &mut self,
        parent: &str,
        name: &str,
        asset: &str,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> String {
        let n = Node::svg(nid(name), name, nid(asset), x, y, w, h);
        self.add(parent, n)
    }

    pub fn qr(
        &mut self,
        parent: &str,
        name: &str,
        x: f64,
        y: f64,
        size: f64,
        fg: &str,
        bg: &str,
    ) -> String {
        let mut n = Node::qr(nid(name), "https://desyn.app", x, y, size);
        n.base_mut().name = name.to_string();
        if let Node::Qr(q) = &mut n {
            q.fg = color(fg);
            q.bg = color(bg);
        }
        self.add(parent, n)
    }

    pub fn line(&mut self, parent: &str, name: &str, x: f64, y: f64, len: f64) -> String {
        let n = Node::line(nid(name), name, x, y, len);
        self.add(parent, n)
    }

    pub fn asset(&mut self, name: &str, kind: AssetKind, w: f64, h: f64) {
        let mime = if kind == AssetKind::Svg {
            "image/svg+xml"
        } else {
            "image/jpeg"
        };
        let mut a = AssetRef::new(nid(name), kind, mime);
        a.width = Some(w);
        a.height = Some(h);
        self.d.assets.insert(nid(name), a);
    }

    pub fn node(&mut self, name: &str) -> &mut Node {
        self.d
            .node_mut(&nid(name))
            .unwrap_or_else(|| panic!("node {name}"))
    }

    pub fn role(&mut self, name: &str, role: &str) -> &mut Self {
        self.node(name).base_mut().role = Some(role.to_string());
        self
    }

    pub fn alt(&mut self, name: &str, alt: &str) -> &mut Self {
        self.node(name).base_mut().alt = Some(alt.to_string());
        self
    }

    pub fn text_mut(&mut self, name: &str) -> &mut desyn_core::TextNode {
        match self.node(name) {
            Node::Text(t) => t,
            _ => panic!("{name} is not text"),
        }
    }

    pub fn align(&mut self, name: &str, a: TextAlign) -> &mut Self {
        self.text_mut(name).paragraph.align = a;
        self
    }

    pub fn fixed(&mut self, name: &str, h: f64) -> &mut Self {
        let t = self.text_mut(name);
        t.auto_resize = AutoResize::None;
        t.base.height = h;
        self
    }

    pub fn family(&mut self, name: &str, family: &str) -> &mut Self {
        self.text_mut(name).style.font_family = family.to_string();
        self
    }

    pub fn runs(&mut self, name: &str, runs: Vec<TextRun>) -> &mut Self {
        self.text_mut(name).runs = runs;
        self
    }

    /// Normalizes derived geometry with real fonts (text heights, group bounds).
    pub fn finish(mut self) -> Design {
        let mut engine = fixture_engine();
        normalize_all(&mut self.d, &mut engine);
        self.d
    }
}

/// Synthetic image for the sampler.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SynthImage {
    pub width: usize,
    pub height: usize,
    /// `"solid:#rrggbb"` or `"split:#left,#right"` (left / right halves).
    pub pattern: String,
}

impl SynthImage {
    pub fn pixels(&self) -> Vec<u8> {
        let parse = |s: &str| color(s).rgba8();
        let mut out = Vec::with_capacity(self.width * self.height * 4);
        let (kind, arg) = self.pattern.split_once(':').expect("pattern");
        for _y in 0..self.height {
            for x in 0..self.width {
                let c = match kind {
                    "solid" => parse(arg),
                    "split" => {
                        let (a, b) = arg.split_once(',').expect("two colors");
                        if x < self.width / 2 {
                            parse(a)
                        } else {
                            parse(b)
                        }
                    }
                    "stripes" => {
                        let (a, b) = arg.split_once(',').expect("two colors");
                        if (x / 4) % 2 == 0 { parse(a) } else { parse(b) }
                    }
                    other => panic!("unknown pattern {other}"),
                };
                out.extend_from_slice(&c);
            }
        }
        out
    }
}

/// Expected issue (`ids` must all be among the issue's ids; ids are readable names).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExpectIssue {
    pub rule: String,
    pub code: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    /// The issue must carry a fix.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub fix: bool,
}

/// Expected group: kind plus member ids (all must be among the group ids) or the container node.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExpectGroup {
    pub kind: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    /// Minimum number of such groups.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Expect {
    pub issues: Vec<ExpectIssue>,
    /// Rules that must not be reported.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub absent: Vec<String>,
    /// When set, the exact set of rules allowed (anything else fails).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub only_rules: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<ExpectGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reading_order: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    /// Flags that a node must carry.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub flags: BTreeMap<String, Vec<String>>,
    /// Substring of `DNode.semantic` per container node.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub semantic: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fixture {
    pub description: String,
    pub design: Design,
    #[serde(default)]
    pub options: Value,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub images: BTreeMap<String, SynthImage>,
    pub expect: Expect,
}

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Text engine with exactly the core bundled families (Inter, Instrument, JetBrains Mono). Fixtures must not depend
/// on which optional `bundled-*` features other crates enable in a workspace build (Noto Arabic changes RTL metrics).
pub fn fixture_engine() -> TextEngine {
    const CORE: [&str; 4] = [
        "Inter",
        "Instrument Sans",
        "Instrument Serif",
        "JetBrains Mono",
    ];
    let mut engine = TextEngine::new();
    for f in desyn_text::font::bundled::fonts().filter(|f| CORE.contains(&f.family)) {
        engine
            .db_mut()
            .add_static_font(f.bytes)
            .expect("bundled font");
    }
    engine
}

pub fn run_fixture(f: &Fixture) -> Description {
    let opts: DescribeOptions = if f.options.is_null() {
        DescribeOptions::default()
    } else {
        serde_json::from_value(f.options.clone()).expect("options")
    };
    let mut engine = fixture_engine();
    let mut sampler = PixelSampler::new();
    for (id, img) in &f.images {
        assert!(sampler.insert(id.clone(), img.width, img.height, img.pixels()));
    }
    describe(&f.design, &opts, &mut engine, Some(&mut sampler)).expect("describe")
}

fn issue_matches(e: &ExpectIssue, i: &Issue) -> bool {
    i.rule == e.rule
        && i.code.as_str() == e.code
        && e.ids.iter().all(|id| i.ids.contains(&nid(id)))
        && e.severity
            .as_deref()
            .is_none_or(|s| s == i.severity.as_str())
        && (!e.fix || i.fix.as_ref().is_some_and(|f| !f.is_empty()))
}

fn all_nodes(d: &[desyn_describe::DNode], out: &mut Vec<desyn_describe::DNode>) {
    for n in d {
        out.push(n.clone());
        if let Some(c) = &n.children {
            all_nodes(c, out);
        }
    }
}

/// Checks a description against the expectations; returns the list of failures.
pub fn check(name: &str, desc: &Description, e: &Expect) -> Vec<String> {
    let mut fails = Vec::new();
    let dump = || {
        desc.issues
            .iter()
            .map(|i| {
                format!(
                    "  [{}] {} / {} {:?}: {}",
                    i.severity.as_str(),
                    i.code.as_str(),
                    i.rule,
                    i.ids,
                    i.message
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    for ei in &e.issues {
        if !desc.issues.iter().any(|i| issue_matches(ei, i)) {
            fails.push(format!(
                "{name}: expected issue {ei:?}\n actual:\n{}",
                dump()
            ));
        }
    }
    for r in &e.absent {
        if let Some(i) = desc.issues.iter().find(|i| &i.rule == r) {
            fails.push(format!(
                "{name}: rule {r} must not fire, got {:?} {}",
                i.ids, i.message
            ));
        }
    }
    if let Some(only) = &e.only_rules {
        for i in &desc.issues {
            if !only.contains(&i.rule) {
                fails.push(format!(
                    "{name}: unexpected rule {} {:?}: {}",
                    i.rule, i.ids, i.message
                ));
            }
        }
    }
    for g in &e.groups {
        let found = desc
            .groups
            .iter()
            .filter(|x| {
                serde_json::to_value(x.kind)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .as_deref()
                    == Some(g.kind.as_str())
                    && g.ids.iter().all(|id| x.ids.contains(&nid(id)))
                    && g.node
                        .as_ref()
                        .is_none_or(|n| x.node.as_deref() == Some(nid(n).as_str()))
            })
            .count();
        if found < g.count.unwrap_or(1) {
            let have: Vec<String> = desc
                .groups
                .iter()
                .map(|x| format!("  {} {:?} {:?} node={:?}", x.label, x.kind, x.ids, x.node))
                .collect();
            fails.push(format!(
                "{name}: expected group {g:?} (found {found})\n groups:\n{}",
                have.join("\n")
            ));
        }
    }
    if let Some(order) = &e.reading_order {
        let want: Vec<String> = order.iter().map(|s| nid(s)).collect();
        if desc.reading_order != want {
            fails.push(format!(
                "{name}: reading order {:?} != expected {:?}",
                desc.reading_order, want
            ));
        }
    }
    if let Some(d) = &e.direction {
        let got = serde_json::to_value(desc.direction).expect("dir");
        if got.as_str() != Some(d.as_str()) {
            fails.push(format!("{name}: direction {got} != {d}"));
        }
    }
    let mut nodes = Vec::new();
    all_nodes(&desc.tree, &mut nodes);
    for (n, flags) in &e.flags {
        let id = nid(n);
        let got = nodes
            .iter()
            .find(|d| d.id == id)
            .and_then(|d| d.flags.clone())
            .unwrap_or_default();
        for f in flags {
            if !got
                .iter()
                .any(|g| g == f || g.starts_with(&format!("{f}:")))
            {
                fails.push(format!("{name}: node {n} lacks flag {f} (has {got:?})"));
            }
        }
    }
    for (n, s) in &e.semantic {
        let id = nid(n);
        let got = nodes
            .iter()
            .find(|d| d.id == id)
            .and_then(|d| d.semantic.clone())
            .unwrap_or_default();
        if !got.contains(s.as_str()) {
            fails.push(format!("{name}: node {n} semantic {got:?} lacks {s:?}"));
        }
    }
    fails
}

pub fn issue(rule: &str, code: &str, ids: &[&str]) -> ExpectIssue {
    ExpectIssue {
        rule: rule.into(),
        code: code.into(),
        ids: ids.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}

pub fn group(kind: &str, ids: &[&str]) -> ExpectGroup {
    ExpectGroup {
        kind: kind.into(),
        ids: ids.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}

pub fn run(text: &str) -> TextRun {
    TextRun::plain(text)
}

pub fn unit_of(s: &str) -> Unit {
    s.parse().expect("unit")
}
