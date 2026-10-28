//! Semantic grouping (deterministic heuristics, no model call).
//!
//! 1. Explicit roles win: a container whose `role` is `product-card`, `nav`, `header`, ... keeps that meaning.
//! 2. Containers (frames / groups / booleans) are classified from their children.
//! 3. Loose siblings are clustered: shapes with content on top of them (containment), then proximity (stacked or
//!    side-by-side within a distance that scales with the type size), then repetition (three or more units with
//!    the same make-up become a list, a grid of cards or a nav bar).
//!
//! Recognized patterns: product card, card, CTA button (shape + short text), logo lockup, image with caption,
//! header, footer, nav bar, list, grid of cards, stat, quote, text block, labelled icon.

use std::collections::{BTreeMap, HashMap};

use desyn_core::NodeType;
use desyn_core::geometry::Rect;
use serde::{Deserialize, Serialize};

use crate::ctx::Ctx;
use crate::types::{DBox, SemanticGroup};

/// Kind of an inferred group.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[allow(missing_docs)]
pub enum GroupKind {
    ProductCard,
    Card,
    Button,
    LogoLockup,
    ImageWithCaption,
    Header,
    Footer,
    NavBar,
    List,
    Grid,
    Stat,
    Quote,
    TextBlock,
    LabelledIcon,
    /// A container with an explicit role that maps to none of the above.
    Role,
}

impl GroupKind {
    /// Human readable noun.
    pub fn noun(self) -> &'static str {
        match self {
            GroupKind::ProductCard => "product card",
            GroupKind::Card => "card",
            GroupKind::Button => "CTA button",
            GroupKind::LogoLockup => "logo lockup",
            GroupKind::ImageWithCaption => "image with caption",
            GroupKind::Header => "header",
            GroupKind::Footer => "footer",
            GroupKind::NavBar => "nav bar",
            GroupKind::List => "list",
            GroupKind::Grid => "grid",
            GroupKind::Stat => "stat",
            GroupKind::Quote => "quote",
            GroupKind::TextBlock => "text block",
            GroupKind::LabelledIcon => "labelled icon",
            GroupKind::Role => "group",
        }
    }
}

/// Coarse class of one element, used by the pattern rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Elem {
    /// Text.
    Text {
        /// One line of at most 24 characters.
        short: bool,
        /// Looks like a price (currency + digits) or has the `price` role.
        price: bool,
        /// A number / statistic (`98%`, `2.5M`) or the `stat` role.
        stat: bool,
        /// Starts with a quotation mark or has the `quote` role.
        quote: bool,
    },
    /// Photo / raster image (or a shape with an image fill).
    Photo,
    /// Logo or brand mark.
    Logo,
    /// Small vector or image (icon).
    Icon,
    /// Filled shape.
    Shape,
    /// Divider line.
    Line,
    /// Chart, table or QR code.
    Data,
    /// Container (classified separately).
    Container,
    /// Anything else (audio, empty).
    Other,
}

impl Elem {
    fn letter(self) -> char {
        match self {
            Elem::Text { .. } => 'T',
            Elem::Photo => 'P',
            Elem::Logo => 'L',
            Elem::Icon => 'I',
            Elem::Shape => 'S',
            Elem::Line => '-',
            Elem::Data => 'D',
            Elem::Container => 'C',
            Elem::Other => '?',
        }
    }
}

/// Result of grouping: groups plus the container label lookup.
#[derive(Debug, Default)]
pub struct Grouping {
    /// Groups in discovery order (ids `g1`, `g2`, ...).
    pub groups: Vec<SemanticGroup>,
    /// Container item index -> group index.
    pub by_container: HashMap<usize, usize>,
    /// Reading units per parent (`None` = page): lists of item indices that read together, in paint order of the
    /// first member.
    pub units: HashMap<Option<usize>, Vec<Vec<usize>>>,
    /// Shapes that other content sits on (card and button surfaces).
    pub backings: std::collections::HashSet<usize>,
    /// Item -> the shape it sits on (innermost), for items placed on a card / button surface.
    pub surface: HashMap<usize, usize>,
}

const SHORT_TEXT: usize = 24;

fn is_price(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() || t.chars().count() > 16 {
        return false;
    }
    let currency = [
        '$', '€', '£', '¥', '₹', '₩', '₽', '₺', '₪', '฿', '₫', '₴', '₦',
    ];
    let has_digit = t.chars().any(|c| c.is_ascii_digit());
    let has_cur = t.chars().any(|c| currency.contains(&c))
        || [
            "usd", "eur", "gbp", "chf", "sek", "nok", "dkk", "aud", "cad", "jpy", " kr", "zł",
        ]
        .iter()
        .any(|code| t.to_lowercase().contains(code));
    has_digit && has_cur
}

fn is_stat(s: &str) -> bool {
    let t = s.trim();
    let digits = t.chars().filter(|c| c.is_ascii_digit()).count();
    !t.is_empty()
        && t.chars().count() <= 10
        && digits > 0
        && t.chars()
            .all(|c| c.is_ascii_digit() || "%+-.,:/xX×kKmMbB★ ".contains(c))
}

fn is_quote(s: &str) -> bool {
    let t = s.trim_start();
    t.starts_with(['"', '“', '”', '«', '„', '‘', '\'', '»', '「', '『'])
}

impl Ctx<'_> {
    /// Coarse element class (computed once per item when the context is built).
    pub fn elem(&self, i: usize) -> Elem {
        self.elems[i]
    }

    /// Computes the element class of an item.
    pub(crate) fn compute_elem(&self, i: usize) -> Elem {
        let it = &self.scene.items[i];
        let role = it.role().unwrap_or("");
        let b = it.node.base();
        let short_side = self.scene.page_rect.w.min(self.scene.page_rect.h);
        match it.kind() {
            NodeType::Text => {
                let f = self.text(i).expect("text facts");
                let t = f.text.trim();
                Elem::Text {
                    short: t.chars().count() <= SHORT_TEXT
                        && f.line_count() <= 1
                        && !t.contains('\n'),
                    price: role == "price" || is_price(t),
                    stat: role == "stat" || is_stat(t),
                    quote: role == "quote" || is_quote(t),
                }
            }
            _ if matches!(role, "logo" | "brand-mark") => Elem::Logo,
            _ if role == "icon" => Elem::Icon,
            NodeType::Image | NodeType::Video => {
                if b.width.max(b.height) <= (short_side * 0.08).clamp(48.0, 96.0) {
                    Elem::Icon
                } else {
                    Elem::Photo
                }
            }
            NodeType::Svg => {
                if b.width.max(b.height) <= (short_side * 0.12).clamp(64.0, 128.0) {
                    Elem::Icon
                } else if matches!(role, "illustration" | "photo" | "product" | "hero") {
                    Elem::Photo
                } else {
                    Elem::Icon
                }
            }
            NodeType::Line => Elem::Line,
            NodeType::Chart | NodeType::Table | NodeType::Qr => Elem::Data,
            NodeType::Group | NodeType::Boolean => Elem::Container,
            NodeType::Frame if !it.children.is_empty() => Elem::Container,
            NodeType::Audio | NodeType::Root | NodeType::Page => Elem::Other,
            _ => {
                if crate::paint::top_is_image(it.node.fills()) {
                    Elem::Photo
                } else if it.node.fills().iter().any(|f| f.is_visible()) {
                    Elem::Shape
                } else if it.node.strokes().iter().any(|s| s.is_visible()) {
                    Elem::Line
                } else {
                    Elem::Other
                }
            }
        }
    }

    fn text_len(&self, i: usize) -> usize {
        self.text(i)
            .map(|f| f.text.trim().chars().count())
            .unwrap_or(0)
    }

    fn text_size(&self, i: usize) -> f64 {
        self.text(i).map(|f| f.style().font_size).unwrap_or(0.0)
    }

    /// Part names of members for labels (`image + title + price + button`).
    fn parts(
        &self,
        members: &[usize],
        groups: &[SemanticGroup],
        member_groups: &HashMap<usize, usize>,
    ) -> String {
        let max_text = members
            .iter()
            .map(|m| self.text_size(*m))
            .fold(0.0, f64::max);
        let smaller_text = members
            .iter()
            .any(|m| self.text(*m).is_some() && self.text_size(*m) < max_text - 0.5);
        let mut names: Vec<(f64, f64, String)> = Vec::new();
        let mut seen_groups: Vec<usize> = Vec::new();
        for m in members {
            let r = self.bounds(*m);
            let name = if let Some(g) = member_groups.get(m) {
                if seen_groups.contains(g) {
                    continue;
                }
                seen_groups.push(*g);
                groups[*g].kind.noun().replace("CTA ", "")
            } else {
                match self.elem(*m) {
                    Elem::Text { price: true, .. } => "price".into(),
                    Elem::Text { quote: true, .. } => "quote".into(),
                    Elem::Text { .. }
                        if self.scene.items[*m].role().is_some_and(|r| {
                            matches!(
                                r,
                                "headline"
                                    | "subhead"
                                    | "body"
                                    | "caption"
                                    | "eyebrow"
                                    | "author"
                                    | "stat-label"
                                    | "date"
                                    | "location"
                                    | "contact"
                                    | "url"
                            )
                        }) =>
                    {
                        self.scene.items[*m]
                            .role()
                            .unwrap_or_default()
                            .replace('-', " ")
                    }
                    Elem::Text { .. } => {
                        let s = self.text_size(*m);
                        if members.iter().filter(|o| self.text(**o).is_some()).count() == 1 {
                            if s >= 28.0 {
                                "title".into()
                            } else {
                                "text".into()
                            }
                        } else if (s - max_text).abs() < 0.5 && smaller_text {
                            "title".into()
                        } else if s <= max_text * 0.6
                            && s <= self.min_text * 1.5
                            && self.text_len(*m) <= 60
                            && self.text(*m).is_some_and(|f| f.line_count() <= 2)
                        {
                            "caption".into()
                        } else {
                            "text".into()
                        }
                    }
                    Elem::Photo => "image".into(),
                    Elem::Logo => "logo".into(),
                    Elem::Icon => "icon".into(),
                    Elem::Shape => "shape".into(),
                    Elem::Line => "divider".into(),
                    Elem::Data => self.scene.items[*m].kind().as_str().to_string(),
                    Elem::Container => "group".into(),
                    Elem::Other => continue,
                }
            };
            names.push((r.y, r.x, name));
        }
        names.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
        // Consecutive identical parts collapse into one with a count ("text ×3").
        let mut out: Vec<(String, usize)> = Vec::new();
        for (_, _, n) in names {
            match out.last_mut() {
                Some((last, k)) if *last == n => *k += 1,
                _ => out.push((n, 1)),
            }
        }
        out.into_iter()
            .map(|(n, k)| if k > 1 { format!("{n} ×{k}") } else { n })
            .collect::<Vec<_>>()
            .join(" + ")
    }

    /// Pattern rules over a set of members. `backing` is the container or the shape the members sit on.
    fn classify(
        &self,
        members: &[usize],
        backing: Option<usize>,
        groups: &[SemanticGroup],
        member_groups: &HashMap<usize, usize>,
    ) -> Option<(GroupKind, String)> {
        let content: Vec<usize> = members
            .iter()
            .copied()
            .filter(|m| Some(*m) != backing)
            .collect();
        if content.is_empty() {
            return None;
        }
        let elems: Vec<Elem> = content.iter().map(|m| self.elem(*m)).collect();
        let sub = |m: &usize| member_groups.get(m).map(|g| groups[*g].kind);
        let texts: Vec<usize> = content
            .iter()
            .copied()
            .filter(|m| self.text(*m).is_some())
            .collect();
        let photos = elems.iter().filter(|e| **e == Elem::Photo).count();
        let logos = elems.iter().filter(|e| **e == Elem::Logo).count();
        let icons = elems.iter().filter(|e| **e == Elem::Icon).count();
        let prices = elems
            .iter()
            .filter(|e| matches!(e, Elem::Text { price: true, .. }))
            .count();
        let backing_box = backing.map(|b| self.bounds(b));
        let all_box = self.union_box(members)?;
        let page = self.scene.page_rect;
        let parts = || self.parts(&content, groups, member_groups);

        // Product card: image + text + price.
        if photos >= 1 && !texts.is_empty() && prices >= 1 {
            return Some((GroupKind::ProductCard, format!("product card: {}", parts())));
        }

        // Button: a filled backing with exactly one short text and nothing else (icons allowed).
        let backing_filled = backing.is_some_and(|b| {
            self.scene.items[b]
                .node
                .fills()
                .iter()
                .any(|f| f.is_visible())
                || self.scene.items[b]
                    .node
                    .strokes()
                    .iter()
                    .any(|s| s.is_visible())
        });
        if backing_filled
            && texts.len() == 1
            && content.len() <= 2
            && content.len() - texts.len() <= icons
        {
            let t = texts[0];
            // The label's ink (not its box) has to sit inside the shape.
            let tb = crate::lint::ink_box(self, t);
            let bb = backing_box.expect("backing");
            let inside = tb.intersection(&bb).map(|r| r.area()).unwrap_or(0.0) >= tb.area() * 0.9;
            let label = self
                .text(t)
                .map(|f| f.text.trim().to_string())
                .unwrap_or_default();
            // A button hugs its label: not much taller than the text, the label filling a good part of the width.
            if inside
                && label.chars().count() <= 32
                && self.text(t).is_some_and(|f| f.line_count() <= 2)
                && bb.h <= tb.h * 3.0 + 16.0
                && tb.w >= bb.w * 0.25
                && bb.w <= page.w * 0.9
            {
                return Some((
                    GroupKind::Button,
                    format!("CTA button: \"{}\"", truncate(&label, 32)),
                ));
            }
        }

        // Logo lockup: a mark plus a short word mark close together.
        if (logos + icons) == 1 && texts.len() == 1 && content.len() == 2 {
            let t = texts[0];
            let short_words = self
                .text(t)
                .is_some_and(|f| f.text.split_whitespace().count() <= 3 && f.line_count() <= 2);
            let small = all_box.w <= page.w * 0.6 && all_box.h <= page.h * 0.3;
            if short_words
                && small
                && (logos == 1
                    || self.scene.items[t]
                        .role()
                        .is_some_and(|r| r == "logo" || r == "brand-mark"))
            {
                return Some((GroupKind::LogoLockup, "logo lockup: mark + wordmark".into()));
            }
            if short_words && small && icons == 1 {
                return Some((
                    GroupKind::LabelledIcon,
                    "labelled icon: icon + label".into(),
                ));
            }
        }

        // Stat: a big number with a small label.
        if texts.len() == 2 && content.len() == 2 {
            let (a, b) = (texts[0], texts[1]);
            let (big, small) = if self.text_size(a) >= self.text_size(b) {
                (a, b)
            } else {
                (b, a)
            };
            if matches!(self.elem(big), Elem::Text { stat: true, .. })
                && self.text_size(big) >= self.text_size(small) * 1.5
                && self.text_len(small) <= 60
            {
                return Some((GroupKind::Stat, "stat: value + label".into()));
            }
        }

        // Quote: quoted text (+ author).
        if !texts.is_empty()
            && texts.len() <= 3
            && content.len() == texts.len() + usize::from(photos + icons > 0).min(1)
            && let Some(q) = texts
                .iter()
                .find(|t| matches!(self.elem(**t), Elem::Text { quote: true, .. }))
        {
            let author = texts.iter().any(|t| t != q && self.text_len(*t) <= 60);
            return Some((
                GroupKind::Quote,
                format!("quote: text{}", if author { " + author" } else { "" }),
            ));
        }

        // Nav bar: three or more short texts on one row.
        if let Some(n) = self.nav_row(&content) {
            return Some((GroupKind::NavBar, format!("nav bar: {n} links")));
        }

        // Repetition: list / grid of similar members.
        if let Some(r) = self.repetition(&content) {
            return Some(r);
        }

        // Header / footer: wide bands at the top / bottom of the page.
        let wide = all_box.w >= page.w * 0.6;
        let has_brand = logos > 0
            || content.iter().any(|m| {
                sub(m) == Some(GroupKind::LogoLockup) || sub(m) == Some(GroupKind::NavBar)
            });
        if wide
            && all_box.y <= page.h * 0.12
            && all_box.bottom() <= page.h * 0.3
            && (has_brand || texts.len() >= 2)
        {
            return Some((GroupKind::Header, format!("header: {}", parts())));
        }
        if wide
            && all_box.bottom() >= page.h * 0.88
            && all_box.y >= page.h * 0.7
            && !texts.is_empty()
        {
            let small = texts
                .iter()
                .all(|t| self.text_size(*t) <= self.min_text * 2.2);
            if small {
                return Some((GroupKind::Footer, format!("footer: {}", parts())));
            }
        }

        // Image with caption: one photo and short text right above / below it.
        if photos == 1 && !texts.is_empty() && texts.len() <= 2 && content.len() == texts.len() + 1
        {
            let img = content
                .iter()
                .copied()
                .find(|m| self.elem(*m) == Elem::Photo)
                .expect("photo");
            let ib = self.bounds(img);
            let caption = texts.iter().all(|t| {
                let tb = self.bounds(*t);
                let below =
                    tb.y >= ib.bottom() - 2.0 && tb.y - ib.bottom() <= (ib.h * 0.35).max(24.0);
                let above =
                    tb.bottom() <= ib.y + 2.0 && ib.y - tb.bottom() <= (ib.h * 0.35).max(24.0);
                let inside = ib.contains_rect(&tb) && tb.h <= ib.h * 0.35;
                let overlap_x = overlap(tb.x, tb.right(), ib.x, ib.right()) >= tb.w.min(ib.w) * 0.5;
                overlap_x && (below || above || inside)
            });
            if caption {
                return Some((
                    GroupKind::ImageWithCaption,
                    format!("image with caption: {}", parts()),
                ));
            }
        }

        // Card: a filled backing (or filled frame) holding at least two pieces of content.
        if backing_filled && content.len() >= 2 {
            return Some((GroupKind::Card, format!("card: {}", parts())));
        }

        // Labelled icon.
        if icons == 1 && texts.len() == 1 && content.len() == 2 {
            return Some((
                GroupKind::LabelledIcon,
                "labelled icon: icon + label".into(),
            ));
        }

        // Text block: stacked texts.
        if texts.len() >= 2 && texts.len() == content.len() {
            return Some((GroupKind::TextBlock, format!("text block: {}", parts())));
        }
        if photos == 1 && !texts.is_empty() && content.len() == texts.len() + 1 {
            return Some((
                GroupKind::ImageWithCaption,
                format!("media with text: {}", parts()),
            ));
        }
        None
    }

    /// Three or more short single-line texts sharing a row (same center line, similar size) and nothing else but
    /// a logo / icons.
    fn nav_row(&self, content: &[usize]) -> Option<usize> {
        let texts: Vec<usize> = content
            .iter()
            .copied()
            .filter(|m| matches!(self.elem(*m), Elem::Text { short: true, .. }))
            .collect();
        if texts.len() < 3 {
            return None;
        }
        let others_ok = content.iter().all(|m| {
            texts.contains(m)
                || matches!(
                    self.elem(*m),
                    Elem::Logo | Elem::Icon | Elem::Shape | Elem::Line
                )
                || self.text(*m).is_some()
        });
        if !others_ok {
            return None;
        }
        let size = self.text_size(texts[0]);
        let cy = |i: usize| {
            let b = self.bounds(i);
            b.y + b.h / 2.0
        };
        let row: Vec<usize> = texts
            .iter()
            .copied()
            .filter(|t| {
                (cy(*t) - cy(texts[0])).abs() <= size * 0.6
                    && (self.text_size(*t) - size).abs() <= size * 0.15
            })
            .collect();
        if row.len() < 3 || row.len() * 2 < texts.len() + 1 {
            return None;
        }
        Some(row.len())
    }

    /// Repetition among members: list (one row or column) or grid of similar units.
    fn repetition(&self, members: &[usize]) -> Option<(GroupKind, String)> {
        if members.len() < 3 {
            return None;
        }
        let sig = |m: usize| -> (String, f64, f64) {
            let b = self.bounds(m);
            let mut letters: Vec<char> = if self.scene.items[m].children.is_empty() {
                vec![self.elem(m).letter()]
            } else {
                self.leaves(m)
                    .iter()
                    .map(|l| self.elem(*l).letter())
                    .collect()
            };
            letters.sort_unstable();
            letters.dedup();
            (letters.into_iter().collect(), b.w, b.h)
        };
        let sigs: Vec<(String, f64, f64)> = members.iter().map(|m| sig(*m)).collect();
        let similar = |a: &(String, f64, f64), b: &(String, f64, f64)| {
            a.0 == b.0 && close(a.1, b.1, 0.15) && close(a.2, b.2, 0.25)
        };
        if !sigs.iter().all(|s| similar(s, &sigs[0]))
            || !members
                .iter()
                .all(|m| same_type_size(self, &[members[0]], &[*m]))
        {
            return None;
        }
        let boxes: Vec<Rect> = members.iter().map(|m| self.bounds(*m)).collect();
        let rows = cluster_positions(boxes.iter().map(|b| b.y + b.h / 2.0), boxes[0].h * 0.5);
        let cols = cluster_positions(boxes.iter().map(|b| b.x + b.w / 2.0), boxes[0].w * 0.5);
        let n = members.len();
        let what = item_noun(&sigs[0].0);
        if rows >= 2 && cols >= 2 && rows * cols >= n && n >= 4 {
            return Some((
                GroupKind::Grid,
                format!("grid of {n} {what}s ({rows} x {cols})"),
            ));
        }
        if rows == 1 || cols == 1 {
            let axis = if rows == 1 { "row" } else { "column" };
            return Some((GroupKind::List, format!("list of {n} {what}s ({axis})")));
        }
        None
    }
}

fn item_noun(sig: &str) -> &'static str {
    match sig {
        "T" => "text item",
        "P" => "image",
        "I" => "icon",
        "S" => "shape",
        "IT" | "LT" => "labelled icon",
        "PT" | "PST" => "card",
        "ST" => "card",
        _ if sig.contains('P') && sig.contains('T') => "card",
        _ if sig.contains('T') => "item",
        _ => "element",
    }
}

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= a.abs().max(b.abs()) * tol + 1.0
}

fn overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

/// Number of distinct positions (single-linkage within `tol`).
fn cluster_positions(values: impl Iterator<Item = f64>, tol: f64) -> usize {
    let mut v: Vec<f64> = values.collect();
    v.sort_by(f64::total_cmp);
    let mut n = 0;
    let mut last = f64::NEG_INFINITY;
    for x in v {
        if x - last > tol.max(1.0) {
            n += 1;
        }
        last = x;
    }
    n
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(n.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}

/// Uniform bucket grid over the page for "which boxes contain this point" queries.
struct Buckets {
    origin: (f64, f64),
    cell: f64,
    cols: usize,
    rows: usize,
    cells: Vec<Vec<(usize, Rect)>>,
    /// Boxes spanning many cells (checked on every query).
    big: Vec<(usize, Rect)>,
}

impl Buckets {
    const CELLS: usize = 64;

    fn new(page: Rect, boxes: impl Iterator<Item = (usize, Rect)>) -> Self {
        let cell = (page.w.max(page.h) / Self::CELLS as f64).max(1.0);
        let cols = ((page.w / cell).ceil() as usize).clamp(1, Self::CELLS);
        let rows = ((page.h / cell).ceil() as usize).clamp(1, Self::CELLS);
        let mut b = Buckets {
            origin: (page.x, page.y),
            cell,
            cols,
            rows,
            cells: vec![Vec::new(); cols * rows],
            big: Vec::new(),
        };
        for (i, r) in boxes {
            if !(r.w.is_finite() && r.h.is_finite()) {
                b.big.push((i, r));
                continue;
            }
            let (c0, r0) = b.cell_of(r.x, r.y);
            let (c1, r1) = b.cell_of(r.right(), r.bottom());
            if (c1 - c0 + 1) * (r1 - r0 + 1) > 256 {
                b.big.push((i, r));
                continue;
            }
            for row in r0..=r1 {
                for col in c0..=c1 {
                    b.cells[row * cols + col].push((i, r));
                }
            }
        }
        b
    }

    fn cell_of(&self, x: f64, y: f64) -> (usize, usize) {
        let f = |v: f64, o: f64, n: usize| {
            let k = ((v - o) / self.cell).floor();
            if k.is_finite() {
                k.clamp(0.0, (n - 1) as f64) as usize
            } else {
                0
            }
        };
        (
            f(x, self.origin.0, self.cols),
            f(y, self.origin.1, self.rows),
        )
    }

    /// Items whose box contains `p`.
    fn at(&self, p: desyn_core::geometry::Point) -> Vec<usize> {
        let (c, r) = self.cell_of(p.x, p.y);
        self.cells[r * self.cols + c]
            .iter()
            .chain(self.big.iter())
            .filter(|(_, b)| b.contains(p))
            .map(|(i, _)| *i)
            .collect()
    }
}

/// Disjoint-set forest.
struct Dsu(Vec<usize>);

impl Dsu {
    fn new(n: usize) -> Self {
        Dsu((0..n).collect())
    }
    fn find(&mut self, x: usize) -> usize {
        let mut r = x;
        while self.0[r] != r {
            r = self.0[r];
        }
        let mut c = x;
        while self.0[c] != r {
            let next = self.0[c];
            self.0[c] = r;
            c = next;
        }
        r
    }
    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            // Keep the smaller index as root so components are ordered by their first member.
            let (lo, hi) = if ra < rb { (ra, rb) } else { (rb, ra) };
            self.0[hi] = lo;
        }
    }
}

/// Above this many siblings, proximity clustering compares only nearby units (sorted sweep).
const SWEEP_LIMIT: usize = 64;

/// Builds every group of the page.
pub fn group(ctx: &Ctx<'_>) -> Grouping {
    let mut out = Grouping::default();
    // Process containers bottom-up (deepest first) so a container sees its children's groups.
    let mut containers: Vec<usize> = (0..ctx.scene.items.len())
        .filter(|i| !ctx.scene.items[*i].children.is_empty() && ctx.scene.items[*i].visible)
        .collect();
    containers.sort_by_key(|i| std::cmp::Reverse(ctx.scene.items[*i].depth));
    let mut member_groups: HashMap<usize, usize> = HashMap::new();
    for c in containers {
        let whole = cluster_level(ctx, Some(c), &mut out, &mut member_groups);
        let kids = ctx.visible_children(Some(c));
        let role = ctx.scene.items[c].role().map(str::to_string);
        // A container whose children form one cluster inherits the cluster's meaning.
        let classified = ctx
            .classify(&kids, Some(c), &out.groups, &member_groups)
            .or(whole);
        let (kind, label, source) = match (role, classified) {
            (Some(r), Some((k, l))) => {
                // The explicit role names the group; the inferred parts describe it.
                let kind = role_kind(&r).unwrap_or(GroupKind::Role);
                let label = if kind == k {
                    l
                } else {
                    format!(
                        "{}: {}",
                        r.replace('-', " "),
                        l.split_once(": ").map(|x| x.1).unwrap_or(&l)
                    )
                };
                (kind, label, "role")
            }
            (Some(r), None) => {
                let parts = ctx.parts(&kids, &out.groups, &member_groups);
                let label = if parts.is_empty() {
                    r.replace('-', " ")
                } else {
                    format!("{}: {parts}", r.replace('-', " "))
                };
                (role_kind(&r).unwrap_or(GroupKind::Role), label, "role")
            }
            (None, Some((k, l))) => (k, l, "container"),
            (None, None) => continue,
        };
        let gi = push_group(
            ctx,
            &mut out,
            kind,
            label,
            Some(c),
            &kids,
            Vec::new(),
            source,
        );
        out.by_container.insert(c, gi);
        member_groups.insert(c, gi);
    }
    cluster_level(ctx, None, &mut out, &mut member_groups);
    out
}

fn role_kind(role: &str) -> Option<GroupKind> {
    Some(match role {
        "product-card" | "product" => GroupKind::ProductCard,
        "card" => GroupKind::Card,
        "button" | "cta" => GroupKind::Button,
        "nav" => GroupKind::NavBar,
        "header" => GroupKind::Header,
        "footer" => GroupKind::Footer,
        "list" => GroupKind::List,
        "quote" => GroupKind::Quote,
        "stat" => GroupKind::Stat,
        "logo" | "brand-mark" => GroupKind::LogoLockup,
        _ => return None,
    })
}

#[allow(clippy::too_many_arguments)]
fn push_group(
    ctx: &Ctx<'_>,
    out: &mut Grouping,
    kind: GroupKind,
    label: String,
    node: Option<usize>,
    members: &[usize],
    parts: Vec<String>,
    source: &str,
) -> usize {
    let r = match node {
        Some(n) => ctx.bounds(n),
        None => ctx.union_box(members).unwrap_or_default(),
    };
    let id = format!("g{}", out.groups.len() + 1);
    out.groups.push(SemanticGroup {
        id,
        kind,
        label,
        node: node.map(|n| ctx.scene.items[n].id().to_string()),
        ids: ctx.ids(members),
        parts,
        bbox: DBox {
            x: round2(r.x),
            y: round2(r.y),
            w: round2(r.w),
            h: round2(r.h),
            rotation: 0.0,
        },
        source: source.to_string(),
    });
    out.groups.len() - 1
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Clusters the visible children of `parent` (or the page) into reading units and records recognized groups.
/// For a container, a cluster made of all its content children is not recorded (the container stands for it);
/// its classification is returned instead.
///
/// 1. Containment forest: every item belongs to the smallest filled shape it sits on (above it in paint order,
///    90% inside). Backings are classified smallest first (a button inside a card is known when the card is
///    classified); each root backing with everything on it is one unit.
/// 2. Proximity: units link when stacked or side by side within a distance that scales with their type size, or
///    when text lies on a photo. One side must be a single text (photos and cards never pull each other in).
/// 3. Repetition: three or more units with the same make-up and size form a list, grid or nav bar.
fn cluster_level(
    ctx: &Ctx<'_>,
    parent: Option<usize>,
    out: &mut Grouping,
    member_groups: &mut HashMap<usize, usize>,
) -> Option<(GroupKind, String)> {
    let kids: Vec<usize> = ctx
        .visible_children(parent)
        .into_iter()
        .filter(|k| {
            crate::scene::visible_area(&ctx.scene.items[*k]) > 0.0
                || ctx.scene.items[*k].kind() == NodeType::Line
        })
        .collect();
    // Auto-layout containers already are one structured unit; their children read in layout order.
    if parent.is_some_and(|p| ctx.scene.items[p].node.layout().is_some()) {
        let units: Vec<Vec<usize>> = kids.iter().map(|k| vec![*k]).collect();
        out.units.insert(parent, units);
        return None;
    }
    let content: Vec<usize> = kids
        .iter()
        .copied()
        .filter(|k| !ctx.scene.is_backdrop(*k))
        .collect();
    let n = content.len();
    let page_area = ctx.scene.page_area();

    // 1. Containment forest.
    let is_backing = |b: usize| {
        let area = ctx.bounds(b).area();
        ctx.elem(b) == Elem::Shape && area < page_area * 0.6 && area > 0.0
    };
    let candidates: Vec<usize> = content.iter().copied().filter(|b| is_backing(*b)).collect();
    // A shape holding 90% of an item contains the item's center, so a center lookup in a bucket grid finds every
    // candidate without comparing all pairs.
    let buckets = Buckets::new(
        ctx.scene.page_rect,
        candidates.iter().map(|c| (*c, ctx.bounds(*c))),
    );
    let mut backing_of: HashMap<usize, usize> = HashMap::new();
    for &m in &content {
        let mb = ctx.bounds(m);
        if mb.area() <= 0.0 || candidates.is_empty() {
            continue;
        }
        let best = buckets
            .at(mb.center())
            .into_iter()
            .filter(|b| *b != m && ctx.scene.items[*b].z < ctx.scene.items[m].z)
            .filter(|b| {
                let bb = ctx.bounds(*b);
                let inside = mb.intersection(&bb).map(|r| r.area()).unwrap_or(0.0);
                inside >= mb.area() * 0.9 && mb.area() < bb.area()
            })
            .min_by(|a, b| {
                ctx.bounds(*a)
                    .area()
                    .total_cmp(&ctx.bounds(*b).area())
                    .then(a.cmp(b))
            });
        if let Some(b) = best {
            backing_of.insert(m, b);
        }
    }
    let mut direct: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (m, b) in &backing_of {
        direct.entry(*b).or_default().push(*m);
    }
    for v in direct.values_mut() {
        v.sort_unstable();
    }
    let subtree = |b: usize| -> Vec<usize> {
        let mut all = vec![b];
        let mut k = 0;
        while k < all.len() {
            if let Some(ms) = direct.get(&all[k]) {
                all.extend(ms.iter().copied());
            }
            k += 1;
        }
        all.sort_unstable();
        all
    };
    out.backings.extend(direct.keys().copied());
    out.surface.extend(backing_of.iter().map(|(m, b)| (*m, *b)));
    let mut backings: Vec<usize> = direct.keys().copied().collect();
    backings.sort_by(|a, b| {
        ctx.bounds(*a)
            .area()
            .total_cmp(&ctx.bounds(*b).area())
            .then(a.cmp(b))
    });
    let mut backed_groups: HashMap<usize, usize> = HashMap::new();
    for b in &backings {
        let mut members = vec![*b];
        members.extend(direct[b].iter().copied());
        let all = subtree(*b);
        let whole_level = parent.is_some() && all.len() == n;
        if let Some((k, l)) = ctx.classify(&members, Some(*b), &out.groups, member_groups) {
            if whole_level {
                // The container itself stands for this cluster.
                return finish_level(ctx, parent, out, vec![all], Some((k, l)));
            }
            let gi = push_group(ctx, out, k, l, None, &all, Vec::new(), "containment");
            backed_groups.insert(*b, gi);
            for m in &all {
                member_groups.insert(*m, gi);
            }
        }
    }

    // Units: root backings with their subtree, and free items.
    let mut units: Vec<Vec<usize>> = Vec::new();
    for &m in &content {
        if backing_of.contains_key(&m) {
            continue;
        }
        units.push(if direct.contains_key(&m) {
            subtree(m)
        } else {
            vec![m]
        });
    }

    // 2. Proximity between units.
    let scale = |i: usize| -> f64 {
        match ctx.text(i) {
            Some(f) => f.min_size.max(4.0),
            None => {
                let r = ctx.bounds(i);
                (r.w.min(r.h) * 0.35).clamp(8.0, 64.0)
            }
        }
    };
    let unit_text = |u: &Vec<usize>| u.len() == 1 && ctx.text(u[0]).is_some();
    let boxes: Vec<Rect> = units
        .iter()
        .map(|u| ctx.union_box(u).unwrap_or_default())
        .collect();
    let uscale: Vec<f64> = units
        .iter()
        .map(|u| {
            if u.len() == 1 {
                scale(u[0])
            } else {
                u.iter()
                    .filter_map(|m| ctx.text(*m).map(|f| f.min_size))
                    .fold(16.0f64, f64::min)
            }
        })
        .collect();
    let un = units.len();
    let mut dsu = Dsu::new(un);
    let mut order: Vec<usize> = (0..un).collect();
    order.sort_by(|a, b| boxes[*a].y.total_cmp(&boxes[*b].y).then(a.cmp(b)));
    for (oi, &a) in order.iter().enumerate() {
        let window: Vec<usize> = if un > SWEEP_LIMIT {
            order[oi + 1..un.min(oi + 1 + SWEEP_LIMIT)].to_vec()
        } else {
            order.iter().copied().filter(|x| *x != a).collect()
        };
        for b in window {
            if dsu.find(a) == dsu.find(b) || !(unit_text(&units[a]) || unit_text(&units[b])) {
                continue;
            }
            // Lines and loose shapes do not pull things together.
            let structural = |u: &Vec<usize>| {
                u.len() == 1 && matches!(ctx.elem(u[0]), Elem::Shape | Elem::Line | Elem::Other)
            };
            if structural(&units[a]) || structural(&units[b]) {
                continue;
            }
            let (ra, rb) = (boxes[a], boxes[b]);
            let t = 0.9 * (uscale[a] + uscale[b]) / 2.0 + 4.0;
            let ox = overlap(ra.x, ra.right(), rb.x, rb.right());
            let oy = overlap(ra.y, ra.bottom(), rb.y, rb.bottom());
            let gap_y = (rb.y - ra.bottom()).max(ra.y - rb.bottom());
            let gap_x = (rb.x - ra.right()).max(ra.x - rb.right());
            let stacked = ox >= ra.w.min(rb.w) * 0.3 && gap_y <= t && gap_y >= -t;
            let beside = oy >= ra.h.min(rb.h) * 0.5 && gap_x <= t && gap_x >= -t;
            // Text laid over a photo reads with it (overlay captions), unless the photo is a page-sized hero.
            let overlay = ox > 0.0
                && oy > 0.0
                && ra
                    .intersection(&rb)
                    .is_some_and(|r| r.area() >= ra.area().min(rb.area()) * 0.8)
                && ra.area().max(rb.area()) < page_area * 0.5;
            if stacked || beside || overlay {
                dsu.union(a, b);
            }
        }
    }
    let mut comps: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for u in 0..un {
        comps.entry(dsu.find(u)).or_default().push(u);
    }
    let mut merged: Vec<Vec<usize>> = Vec::new();
    let mut whole = None;
    for (_, us) in comps {
        let mut all: Vec<usize> = us.iter().flat_map(|u| units[*u].iter().copied()).collect();
        all.sort_unstable();
        if us.len() >= 2 {
            // Classify with the unit roots as members (cards / buttons are known through `member_groups`).
            let roots: Vec<usize> = us
                .iter()
                .map(|u| {
                    *units[*u]
                        .iter()
                        .find(|m| !backing_of.contains_key(m))
                        .unwrap_or(&units[*u][0])
                })
                .collect();
            let classified = ctx.classify(&roots, None, &out.groups, member_groups);
            if parent.is_some() && all.len() == n {
                whole = classified;
            } else if let Some((k, l)) = classified {
                let gi = push_group(ctx, out, k, l, None, &all, Vec::new(), "proximity");
                for m in &all {
                    member_groups.insert(*m, gi);
                }
            }
        }
        merged.push(all);
    }
    merged.sort_by_key(|u| u[0]);
    finish_level(ctx, parent, out, merged, whole)
}

/// Repetition across the final units of a level, then records the units.
fn finish_level(
    ctx: &Ctx<'_>,
    parent: Option<usize>,
    out: &mut Grouping,
    units: Vec<Vec<usize>>,
    whole: Option<(GroupKind, String)>,
) -> Option<(GroupKind, String)> {
    let unit_sig = |u: &Vec<usize>| -> (String, f64, f64) {
        let r = ctx.union_box(u).unwrap_or_default();
        let mut letters: Vec<char> = u
            .iter()
            .flat_map(|m| {
                if ctx.scene.items[*m].children.is_empty() {
                    vec![ctx.elem(*m).letter()]
                } else {
                    ctx.leaves(*m)
                        .iter()
                        .map(|l| ctx.elem(*l).letter())
                        .collect()
                }
            })
            .collect();
        letters.sort_unstable();
        letters.dedup();
        (letters.into_iter().collect(), r.w, r.h)
    };
    let sigs: Vec<(String, f64, f64)> = units.iter().map(unit_sig).collect();
    // The group (if any) covering exactly one unit, for `parts`.
    // Group covering exactly one unit (loose groups by member list, containers by node), for `parts`.
    let mut by_members: HashMap<Vec<String>, String> = HashMap::new();
    let mut by_node: HashMap<String, String> = HashMap::new();
    for g in &out.groups {
        match &g.node {
            None => {
                by_members.insert(g.ids.clone(), g.id.clone());
            }
            Some(n) => {
                by_node.entry(n.clone()).or_insert_with(|| g.id.clone());
            }
        }
    }
    let unit_group = |u: &Vec<usize>| -> Option<String> {
        by_members.get(&ctx.ids(u)).cloned().or_else(|| {
            (u.len() == 1)
                .then(|| by_node.get(ctx.scene.items[u[0]].id()).cloned())
                .flatten()
        })
    };
    let mut used = vec![false; units.len()];
    let covers_all = |same: &[usize]| parent.is_some() && same.len() == units.len();
    let mut whole = whole;
    for a in 0..units.len() {
        if used[a] {
            continue;
        }
        let same: Vec<usize> = (a..units.len())
            .filter(|b| {
                !used[*b]
                    && sigs[*b].0 == sigs[a].0
                    && close(sigs[*b].1, sigs[a].1, 0.15)
                    && close(sigs[*b].2, sigs[a].2, 0.25)
                    && same_type_size(ctx, &units[a], &units[*b])
            })
            .collect();
        if same.len() < 3 {
            continue;
        }
        let boxes: Vec<Rect> = same
            .iter()
            .map(|u| ctx.union_box(&units[*u]).unwrap_or_default())
            .collect();
        let rows = cluster_positions(boxes.iter().map(|b| b.y + b.h / 2.0), boxes[0].h * 0.5);
        let cols = cluster_positions(boxes.iter().map(|b| b.x + b.w / 2.0), boxes[0].w * 0.5);
        let n = same.len();
        let what = item_noun(&sigs[a].0);
        let short_texts = same.iter().all(|u| {
            units[*u].len() == 1 && matches!(ctx.elem(units[*u][0]), Elem::Text { short: true, .. })
        });
        let (kind, label) = if sigs[a].0 == "T" && rows == 1 && short_texts {
            (GroupKind::NavBar, format!("nav bar: {n} links"))
        } else if rows >= 2 && cols >= 2 && n >= 4 {
            (
                GroupKind::Grid,
                format!("grid of {n} {what}s ({rows} x {cols})"),
            )
        } else if rows == 1 || cols == 1 {
            let axis = if rows == 1 { "row" } else { "column" };
            (GroupKind::List, format!("list of {n} {what}s ({axis})"))
        } else {
            continue;
        };
        for u in &same {
            used[*u] = true;
        }
        if covers_all(&same) {
            whole = whole.or(Some((kind, label)));
            continue;
        }
        let parts: Vec<String> = same.iter().filter_map(|u| unit_group(&units[*u])).collect();
        let mut members: Vec<usize> = same
            .iter()
            .flat_map(|u| units[*u].iter().copied())
            .collect();
        members.sort_unstable();
        push_group(ctx, out, kind, label, None, &members, parts, "repetition");
    }
    out.units.insert(parent, units);
    whole
}

/// Single-text units only repeat when they share the text size (a type scale is not a list).
fn same_type_size(ctx: &Ctx<'_>, a: &[usize], b: &[usize]) -> bool {
    match (a, b) {
        ([x], [y]) => match (ctx.text(*x), ctx.text(*y)) {
            (Some(fx), Some(fy)) => {
                let (sx, sy) = (fx.style().font_size, fy.style().font_size);
                (sx - sy).abs() <= sx.max(sy) * 0.05
            }
            _ => true,
        },
        _ => true,
    }
}
