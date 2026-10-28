//! Compact renderings of a [`Description`] for LLM prompts.
//!
//! * [`compact_value`]: the JSON shape `compactDescription` of `@desyn/ai` sends with `read_design` (same keys,
//!   same strings), so a host can swap the TypeScript approximation for the engine output without changing
//!   prompts. Untrusted strings (names, text, alt) are passed through; hosts apply their own untrusted-content
//!   guard as `@desyn/ai` does.
//! * [`compact_text`]: a token-budgeted plain-text rendering with stable ordering: header, issues, the tree
//!   (as deep as the budget allows), groups, reading order, palette, fonts, type scale, grid, hierarchy. Every
//!   line is one line: free text (names, text, alt, labels) is JSON-quoted and control characters anywhere else
//!   are escaped, so design content cannot forge structure. Hosts still wrap the result as untrusted data.

use serde_json::{Map, Value, json};

use crate::types::{DNode, Description};

/// Rough token estimate used for budgets: one token per four bytes of UTF-8 (rounded up). Conservative for
/// English prose and JSON-like text with current tokenizers.
pub fn estimate_tokens(s: &str) -> usize {
    s.len().div_ceil(4)
}

/// Escapes control characters and Unicode line / paragraph separators, so user-authored strings (layer names,
/// roles, font families, asset ids inside messages and labels) cannot start a new line and forge structure in
/// [`compact_text`].
fn one_line(s: &str) -> String {
    if !s
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{85}'))
    {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') => {
                out.push_str(&format!("\\u{{{:04x}}}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

/// A user-authored token printed bare when it is a plain word (`hero`, `slide-title`), JSON-quoted otherwise.
fn word(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
    {
        s.to_string()
    } else {
        serde_json::to_string(s).unwrap_or_default()
    }
}

fn r1(v: f64) -> f64 {
    let r = (v * 10.0).round() / 10.0;
    if r == 0.0 { 0.0 } else { r }
}

fn compact_node(d: &DNode) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), json!(d.id));
    o.insert("type".into(), json!(d.node_type));
    o.insert("name".into(), json!(d.name));
    if let Some(r) = &d.role {
        o.insert("role".into(), json!(r));
    }
    o.insert(
        "box".into(),
        json!([r1(d.bbox.x), r1(d.bbox.y), r1(d.bbox.w), r1(d.bbox.h)]),
    );
    if d.bbox.rotation != 0.0 {
        o.insert("rot".into(), json!(d.bbox.rotation));
    }
    if let Some(t) = &d.text {
        o.insert("text".into(), json!(t));
    }
    if let Some(f) = &d.font {
        o.insert("font".into(), json!(font_string(f)));
    }
    if let Some(fill) = d.fill.as_ref().filter(|f| f.as_str() != "none") {
        o.insert("fill".into(), json!(fill));
    }
    if let Some(img) = &d.image {
        let kind = img.kind.map(image_kind_str).unwrap_or("image");
        let alt = img
            .alt
            .as_ref()
            .map(|a| format!(" alt={}", json!(a)))
            .unwrap_or_default();
        o.insert(
            "image".into(),
            json!(format!("{kind} asset {}{alt}", img.asset_id)),
        );
    }
    if let Some(s) = &d.semantic {
        o.insert("semantic".into(), json!(s));
    }
    if let Some(f) = d.flags.as_ref().filter(|f| !f.is_empty()) {
        o.insert("flags".into(), json!(f));
    }
    if !d.visible {
        o.insert("hidden".into(), json!(true));
    }
    if d.locked {
        o.insert("locked".into(), json!(true));
    }
    if d.opacity < 1.0 {
        o.insert("opacity".into(), json!(d.opacity));
    }
    if let Some(c) = d.children.as_ref().filter(|c| !c.is_empty()) {
        o.insert(
            "children".into(),
            Value::Array(c.iter().map(compact_node).collect()),
        );
    }
    Value::Object(o)
}

fn image_kind_str(k: crate::types::ImageKind) -> &'static str {
    use crate::types::ImageKind::*;
    match k {
        Photo => "photo",
        Illustration => "illustration",
        Logo => "logo",
        Icon => "icon",
        Unknown => "unknown",
    }
}

fn font_string(f: &crate::types::DFont) -> String {
    let lines = match f.lines {
        Some(n) if n > 1 => format!(" {n} lines"),
        _ => String::new(),
    };
    format!(
        "{} {} {}px {} {}{lines}",
        f.family, f.weight, f.size, f.color, f.align
    )
}

fn issue_line(i: &crate::types::Issue) -> String {
    format!(
        "[{}] {} {}: {}",
        i.severity.as_str(),
        i.code.as_str(),
        i.ids.join(","),
        i.message
    )
}

/// The `compactDescription` shape of `@desyn/ai` (`issues` limits the issue list, default 20).
pub fn compact_value(desc: &Description, issues: Option<usize>) -> Value {
    let mut grid = Map::new();
    grid.insert("margins".into(), json!(desc.grid.margins));
    if let Some(r) = desc.grid.spacing_rhythm.filter(|r| *r != 0.0) {
        grid.insert("spacingRhythm".into(), json!(r));
    }
    sorted_keys(json!({
        "page": desc.page,
        "tree": desc.tree.iter().map(compact_node).collect::<Vec<_>>(),
        "palette": desc.palette.iter().map(|p| format!("{} {}%", p.color, (p.share * 100.0).round())).collect::<Vec<_>>(),
        "fonts": desc.fonts.iter().map(|f| format!("{} ({}) ×{}", f.family, f.weights.iter().map(|w| w.to_string()).collect::<Vec<_>>().join("/"), f.used_by)).collect::<Vec<_>>(),
        "typography": desc.typography,
        "grid": grid,
        "hierarchy": desc.hierarchy.iter().take(6).map(|h| format!("{}. {} — {}", h.rank, h.id, h.reason)).collect::<Vec<_>>(),
        "issues": desc.issues.iter().take(issues.unwrap_or(20)).map(issue_line).collect::<Vec<_>>(),
    }))
}

/// Rebuilds every object with its keys in sorted order. `serde_json::Map` keeps insertion order when another crate in
/// the build enables `preserve_order` (the desktop app's Convex client does), so without this the same description
/// would serialize differently in the desktop app than in the wasm engine and the worker.
fn sorted_keys(v: Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(k, v)| (k, sorted_keys(v)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sorted_keys).collect()),
        other => other,
    }
}

/// Options of [`compact_text`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompactOptions {
    /// Token budget (estimated with [`estimate_tokens`]).
    pub max_tokens: usize,
    /// Most issues to list.
    pub max_issues: usize,
    /// Longest text excerpt per node, in characters.
    pub max_text_chars: usize,
}

impl Default for CompactOptions {
    fn default() -> Self {
        CompactOptions {
            max_tokens: 2000,
            max_issues: 30,
            max_text_chars: 120,
        }
    }
}

fn quote(s: &str, max: usize) -> String {
    let t: String = if s.chars().count() > max {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    } else {
        s.to_string()
    };
    serde_json::to_string(&t).unwrap_or_default()
}

fn node_line(d: &DNode, depth: usize, o: &CompactOptions, cut_children: usize) -> String {
    let mut s = format!(
        "{}- {} {} {}",
        "  ".repeat(depth),
        d.id,
        d.node_type,
        quote(&d.name, 60)
    );
    if let Some(r) = &d.role {
        s.push_str(&format!(" role={}", word(r)));
    }
    s.push_str(&format!(
        " [{} {} {}x{}]",
        r1(d.bbox.x),
        r1(d.bbox.y),
        r1(d.bbox.w),
        r1(d.bbox.h)
    ));
    if d.bbox.rotation != 0.0 {
        s.push_str(&format!(" rot={}", d.bbox.rotation));
    }
    if let Some(f) = &d.font {
        s.push_str(&format!(" font={}", quote(&font_string(f), 160)));
    }
    if let Some(t) = &d.text {
        s.push_str(&format!(" text={}", quote(t, o.max_text_chars)));
    }
    if let Some(f) = d.fill.as_ref().filter(|f| f.as_str() != "none") {
        s.push_str(&format!(" fill={f}"));
    }
    if let Some(i) = &d.image {
        s.push_str(&format!(
            " image={}:{}",
            i.kind.map(image_kind_str).unwrap_or("image"),
            i.asset_id
        ));
        if let Some(a) = &i.alt {
            s.push_str(&format!(" alt={}", quote(a, 80)));
        }
    }
    if let Some(sem) = &d.semantic {
        s.push_str(&format!(" semantic={}", quote(sem, 80)));
    }
    if !d.visible {
        s.push_str(" hidden");
    }
    if d.locked {
        s.push_str(" locked");
    }
    if d.opacity < 1.0 {
        s.push_str(&format!(" opacity={}", d.opacity));
    }
    if let Some(w) = d.weight {
        s.push_str(&format!(" weight={w}"));
    }
    if let Some(f) = d.flags.as_ref().filter(|f| !f.is_empty()) {
        s.push_str(&format!(" flags={}", f.join(",")));
    }
    if cut_children > 0 {
        s.push_str(&format!(" (+{cut_children} nested)"));
    }
    one_line(&s)
}

fn count(d: &DNode) -> usize {
    1 + d
        .children
        .as_ref()
        .map(|c| c.iter().map(count).sum())
        .unwrap_or(0)
}

fn tree_lines(
    nodes: &[DNode],
    max_depth: usize,
    depth: usize,
    o: &CompactOptions,
    out: &mut Vec<String>,
) {
    for d in nodes {
        let kids = d.children.as_deref().unwrap_or(&[]);
        let cut = if depth + 1 > max_depth {
            kids.iter().map(count).sum()
        } else {
            0
        };
        out.push(node_line(d, depth, o, cut));
        if depth < max_depth {
            tree_lines(kids, max_depth, depth + 1, o, out);
        }
    }
}

fn depth_of(nodes: &[DNode]) -> usize {
    nodes
        .iter()
        .map(|d| 1 + d.children.as_deref().map(depth_of).unwrap_or(0))
        .max()
        .unwrap_or(0)
}

/// Token-budgeted text rendering (stable: same description, same text).
pub fn compact_text(desc: &Description, o: &CompactOptions) -> String {
    let mut head: Vec<String> = Vec::new();
    head.push(format!(
        "design {} kind={} page {}/{} {}x{}{} bg={} dir={}",
        quote(&desc.design.name, 80),
        desc.design.kind,
        desc.page.index + 1,
        desc.design.page_count,
        r1(desc.page.width),
        r1(desc.page.height),
        if desc.page.unit == "px" {
            "px".to_string()
        } else {
            format!("px ({})", desc.page.unit)
        },
        desc.page.background,
        match desc.direction {
            crate::types::Direction::Ltr => "ltr",
            crate::types::Direction::Rtl => "rtl",
        }
    ));
    if !desc.selection.is_empty() {
        head.push(format!("selection: {}", desc.selection.join(",")));
    }
    let head: Vec<String> = head.iter().map(|l| one_line(l)).collect();
    let mut tail: Vec<String> = Vec::new();
    if !desc.palette.is_empty() {
        tail.push(format!(
            "palette: {}",
            desc.palette
                .iter()
                .map(|p| format!("{} {}%", p.color, (p.share * 100.0).round()))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !desc.fonts.is_empty() {
        tail.push(format!(
            "fonts: {}",
            desc.fonts
                .iter()
                .map(|f| format!(
                    "{} ({}) x{}",
                    f.family,
                    f.weights
                        .iter()
                        .map(|w| w.to_string())
                        .collect::<Vec<_>>()
                        .join("/"),
                    f.used_by
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let t = &desc.typography;
    if !t.scale.is_empty() {
        let mut s = format!(
            "type scale: {}",
            t.scale
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join("/")
        );
        if let Some(h) = t.headline_size {
            s.push_str(&format!(" headline={h}"));
        }
        if let Some(b) = t.body_size {
            s.push_str(&format!(" body={b}"));
        }
        if let Some(r) = t.ratio {
            s.push_str(&format!(" ratio={r}"));
        }
        tail.push(s);
    }
    let m = desc.grid.margins;
    let mut g = format!("margins: t{} r{} b{} l{}", m.t, m.r, m.b, m.l);
    if let Some(r) = desc.grid.spacing_rhythm {
        g.push_str(&format!(" rhythm={r}"));
    }
    tail.push(g);
    if !desc.hierarchy.is_empty() {
        tail.push("hierarchy:".into());
        for h in desc.hierarchy.iter().take(6) {
            tail.push(format!("{}. {} {}", h.rank, h.id, h.reason));
        }
    }

    let tail: Vec<String> = tail.iter().map(|l| one_line(l)).collect();
    let budget = o.max_tokens;
    let used = |lines: &[String]| -> usize { lines.iter().map(|l| estimate_tokens(l) + 1).sum() };
    let mut remaining = budget.saturating_sub(used(&head) + used(&tail));

    // Issues: up to 40% of what is left.
    let mut issues: Vec<String> = Vec::new();
    if !desc.issues.is_empty() {
        let cap = remaining * 2 / 5;
        let mut spent = estimate_tokens("issues:") + 1;
        for i in desc.issues.iter().take(o.max_issues) {
            let mut line = one_line(&issue_line(i));
            if i.fix.is_some() {
                line.push_str(" (fix available)");
            }
            let cost = estimate_tokens(&line) + 1;
            if spent + cost > cap {
                break;
            }
            spent += cost;
            issues.push(line);
        }
        let left = desc.issues.len() - issues.len();
        let mut block = vec![format!("issues ({}):", desc.issues.len())];
        block.extend(issues);
        if left > 0 {
            block.push(format!("… {left} more issues"));
        }
        issues = block;
        remaining = remaining.saturating_sub(used(&issues));
    }

    // Tree: the deepest level that fits; at depth 0 cut the list itself.
    let mut tree: Vec<String> = vec!["tree (id type name [x y wxh]):".into()];
    let total_depth = depth_of(&desc.tree);
    let mut chosen: Option<Vec<String>> = None;
    for d in (0..total_depth.max(1)).rev() {
        let mut lines = Vec::new();
        tree_lines(&desc.tree, d, 0, o, &mut lines);
        if used(&lines) + used(&tree) <= remaining {
            chosen = Some(lines);
            break;
        }
    }
    let lines = chosen.unwrap_or_else(|| {
        let mut lines = Vec::new();
        let mut spent = used(&tree);
        for (k, d) in desc.tree.iter().enumerate() {
            let line = node_line(d, 0, o, count(d) - 1);
            let cost = estimate_tokens(&line) + 1;
            if spent + cost + 8 > remaining {
                lines.push(format!("… {} more top-level nodes", desc.tree.len() - k));
                break;
            }
            spent += cost;
            lines.push(line);
        }
        lines
    });
    tree.extend(lines);
    if desc.omitted > 0 {
        tree.push(format!(
            "({} nodes omitted by the request limits)",
            desc.omitted
        ));
    }
    remaining = remaining.saturating_sub(used(&tree));

    // Groups and reading order when room is left.
    let mut extra: Vec<String> = Vec::new();
    if !desc.groups.is_empty() {
        let mut block = vec!["groups:".to_string()];
        for g in &desc.groups {
            block.push(one_line(&format!(
                "{} {} [{}]",
                g.id,
                g.label,
                g.ids.join(",")
            )));
        }
        if used(&block) <= remaining {
            remaining -= used(&block);
            extra.extend(block);
        }
    }
    if !desc.reading_order.is_empty() {
        let line = one_line(&format!("reading order: {}", desc.reading_order.join(",")));
        if estimate_tokens(&line) < remaining {
            extra.push(line);
        }
    }

    let mut out = head;
    out.extend(issues);
    out.extend(tree);
    out.extend(extra);
    out.extend(tail);
    out.join("\n")
}
