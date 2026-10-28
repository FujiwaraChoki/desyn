//! Fonts for the editor: the families the engine has (bundled OFL set), a curated Google Fonts catalog loaded on
//! demand through the CSS2 API (files cached under the data folder so they work offline afterwards), a watcher that
//! fetches families open designs ask for (templates, pasted layers), and the font picker (virtualized list with
//! every loaded family previewed in its own face).

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gpui::{
    App, AppContext, Context, Entity, EventEmitter, FocusHandle, Focusable, Global,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, UniformListScrollHandle, Window, div,
    prelude::FluentBuilder, px, uniform_list,
};

use super::{Seg, all_editors, search_box, segmented};
use crate::cloud::{CloudError, http, runtime};
use crate::ui::components::{icon, t};
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{SANS, alpha};

/// Font category (picker filter).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Category {
    /// Sans serif.
    Sans,
    /// Serif.
    Serif,
    /// Display.
    Display,
    /// Handwriting / script.
    Script,
    /// Monospace.
    Mono,
}

/// Popular Google Fonts families (OFL / Apache), by category.
pub const CATALOG: &[(&str, Category)] = &[
    ("Inter", Category::Sans),
    ("Instrument Sans", Category::Sans),
    ("Roboto", Category::Sans),
    ("Open Sans", Category::Sans),
    ("Montserrat", Category::Sans),
    ("Poppins", Category::Sans),
    ("Lato", Category::Sans),
    ("Work Sans", Category::Sans),
    ("DM Sans", Category::Sans),
    ("Manrope", Category::Sans),
    ("Plus Jakarta Sans", Category::Sans),
    ("Outfit", Category::Sans),
    ("Space Grotesk", Category::Sans),
    ("Sora", Category::Sans),
    ("Figtree", Category::Sans),
    ("Rubik", Category::Sans),
    ("Nunito", Category::Sans),
    ("Raleway", Category::Sans),
    ("Archivo", Category::Sans),
    ("Barlow", Category::Sans),
    ("Karla", Category::Sans),
    ("IBM Plex Sans", Category::Sans),
    ("Source Sans 3", Category::Sans),
    ("Noto Sans", Category::Sans),
    ("Mulish", Category::Sans),
    ("Urbanist", Category::Sans),
    ("Lexend", Category::Sans),
    ("Albert Sans", Category::Sans),
    ("Public Sans", Category::Sans),
    ("Hanken Grotesk", Category::Sans),
    ("Instrument Serif", Category::Serif),
    ("Playfair Display", Category::Serif),
    ("Lora", Category::Serif),
    ("Merriweather", Category::Serif),
    ("Cormorant Garamond", Category::Serif),
    ("EB Garamond", Category::Serif),
    ("Libre Baskerville", Category::Serif),
    ("DM Serif Display", Category::Serif),
    ("Fraunces", Category::Serif),
    ("Crimson Pro", Category::Serif),
    ("Source Serif 4", Category::Serif),
    ("Noto Serif", Category::Serif),
    ("Bodoni Moda", Category::Serif),
    ("Prata", Category::Serif),
    ("Spectral", Category::Serif),
    ("Newsreader", Category::Serif),
    ("Young Serif", Category::Serif),
    ("Gloock", Category::Serif),
    ("Bebas Neue", Category::Display),
    ("Anton", Category::Display),
    ("Oswald", Category::Display),
    ("Abril Fatface", Category::Display),
    ("Archivo Black", Category::Display),
    ("Syne", Category::Display),
    ("Unbounded", Category::Display),
    ("Righteous", Category::Display),
    ("Bricolage Grotesque", Category::Display),
    ("Big Shoulders Display", Category::Display),
    ("Alfa Slab One", Category::Display),
    ("Bungee", Category::Display),
    ("Shrikhand", Category::Display),
    ("Monoton", Category::Display),
    ("Pacifico", Category::Script),
    ("Dancing Script", Category::Script),
    ("Caveat", Category::Script),
    ("Great Vibes", Category::Script),
    ("Satisfy", Category::Script),
    ("Lobster", Category::Script),
    ("Sacramento", Category::Script),
    ("Kalam", Category::Script),
    ("Shadows Into Light", Category::Script),
    ("Permanent Marker", Category::Script),
    ("Allura", Category::Script),
    ("Homemade Apple", Category::Script),
    ("JetBrains Mono", Category::Mono),
    ("IBM Plex Mono", Category::Mono),
    ("Space Mono", Category::Mono),
    ("Fira Code", Category::Mono),
    ("Roboto Mono", Category::Mono),
    ("DM Mono", Category::Mono),
    ("Source Code Pro", Category::Mono),
];

/// Family name lookup key.
pub fn key(family: &str) -> String {
    desyn_text::font::normalize_family(family)
}

/// A family name safe to send to the font service (documents are untrusted).
pub fn valid_family(f: &str) -> bool {
    let f = f.trim();
    !f.is_empty()
        && f.len() <= 100
        && !f
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | '?' | '&' | '#'))
}

fn encode(family: &str) -> String {
    family
        .trim()
        .bytes()
        .map(|b| match b {
            b' ' => "+".to_string(),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// CSS2 queries tried in order (every weight and italics, then fewer styles for static families).
pub fn queries(family: &str) -> Vec<String> {
    let f = encode(family);
    vec![
        format!("{f}:ital,wght@0,100..900;1,100..900"),
        format!("{f}:wght@100..900"),
        format!("{f}:ital,wght@0,400;0,700;1,400;1,700"),
        format!("{f}:wght@400;700"),
        f,
    ]
}

/// `url(...)` sources of `@font-face` CSS (https only, deduplicated).
pub fn css_urls(css: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = css;
    while let Some(i) = rest.find("url(") {
        rest = &rest[i + 4..];
        let Some(end) = rest.find(')') else { break };
        let u = rest[..end]
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .to_string();
        rest = &rest[end..];
        if u.starts_with("https://") && !out.contains(&u) {
            out.push(u);
        }
    }
    out
}

fn cache_dir() -> PathBuf {
    crate::paths::AppPaths::detect().cache_dir().join("fonts")
}

fn file_name(url: &str) -> String {
    let h = desyn_core::canonical::sha256_hex(url.as_bytes());
    format!("{}.font", &h[..24])
}

/// Downloads a family (cached on disk). Must run on the network runtime.
pub async fn fetch_family(family: String) -> Result<Vec<Vec<u8>>, CloudError> {
    let dir = cache_dir();
    let index = dir.join(format!(
        "{}.json",
        &desyn_core::canonical::sha256_hex(key(&family).as_bytes())[..24]
    ));
    if let Ok(b) = std::fs::read(&index)
        && let Ok(files) = serde_json::from_slice::<Vec<String>>(&b)
    {
        let bytes: Vec<Vec<u8>> = files
            .iter()
            .filter_map(|f| std::fs::read(dir.join(f)).ok())
            .collect();
        if !bytes.is_empty() && bytes.len() == files.len() {
            return Ok(bytes);
        }
    }
    for q in queries(&family) {
        let url = format!("https://fonts.googleapis.com/css2?family={q}");
        let css = match http::get_bytes(&url, 512 * 1024).await {
            Ok((b, _)) => String::from_utf8_lossy(&b).to_string(),
            Err(e) if e.code == "NETWORK" => return Err(e),
            Err(_) => continue,
        };
        let urls = css_urls(&css);
        if urls.is_empty() {
            continue;
        }
        let mut names = Vec::new();
        let mut out = Vec::new();
        for u in urls.iter().take(24) {
            let (bytes, _) = http::get_bytes(u, 24 * 1024 * 1024).await?;
            let name = file_name(u);
            let _ = std::fs::create_dir_all(&dir);
            let _ = crate::paths::write_atomic(&dir.join(&name), &bytes);
            names.push(name);
            out.push(bytes);
        }
        let _ = crate::paths::write_atomic(&index, &serde_json::to_vec(&names).unwrap_or_default());
        return Ok(out);
    }
    Err(CloudError {
        code: "NOT_FOUND".into(),
        message: format!("“{family}” is not available from Google Fonts."),
        data: serde_json::Value::Null,
    })
}

/// Font files of one family.
pub type FontFiles = Vec<Arc<Vec<u8>>>;

/// Loaded fonts and the fetch queue (GPUI global).
#[derive(Default)]
pub struct FontLibrary {
    /// Families fetched this session: key -> (display name, font files).
    pub loaded: HashMap<String, (String, FontFiles)>,
    loading: HashSet<String>,
    failed: HashSet<String>,
    /// Families GPUI can draw (bundled UI fonts + fetched ones), by key.
    gpui: HashSet<String>,
    /// Families registered per editor engine (entity id -> keys).
    registered: HashMap<gpui::EntityId, HashSet<String>>,
}

impl Global for FontLibrary {}

impl FontLibrary {
    /// Installs the library and the watcher that fetches families open designs need.
    pub fn init(cx: &mut App) {
        let mut lib = FontLibrary::default();
        for f in ["Instrument Sans", "Instrument Serif", "JetBrains Mono"] {
            lib.gpui.insert(key(f));
        }
        cx.set_global(lib);
        cx.spawn(async move |cx| {
            loop {
                runtime::sleep(Duration::from_millis(1200)).await;
                cx.update(FontLibrary::tick);
            }
        })
        .detach();
    }

    fn tick(cx: &mut App) {
        let editors = all_editors(cx);
        let mut wanted: Vec<String> = Vec::new();
        for e in &editors {
            let id = e.entity_id();
            let missing: Vec<String> = {
                let lib = cx.global::<FontLibrary>();
                let have = lib.registered.get(&id);
                lib.loaded
                    .keys()
                    .filter(|k| have.is_none_or(|h| !h.contains(*k)))
                    .cloned()
                    .collect()
            };
            if !missing.is_empty() {
                let files: Vec<(String, Vec<Arc<Vec<u8>>>)> = {
                    let lib = cx.global::<FontLibrary>();
                    missing
                        .iter()
                        .filter_map(|k| lib.loaded.get(k).map(|(_, f)| (k.clone(), f.clone())))
                        .collect()
                };
                e.update(cx, |ed, cx| {
                    for (_, fs) in &files {
                        for f in fs {
                            let _ = ed.session.renderer.text_mut().add_font(f.as_ref().clone());
                        }
                    }
                    ed.after(cx);
                });
                cx.global_mut::<FontLibrary>()
                    .registered
                    .entry(id)
                    .or_default()
                    .extend(files.into_iter().map(|(k, _)| k));
            }
            let reqs = e.update(cx, |ed, _| {
                ed.session.renderer.text_mut().take_font_requests()
            });
            for r in reqs {
                if !wanted.contains(&r.family) {
                    wanted.push(r.family);
                }
            }
        }
        let alive: HashSet<gpui::EntityId> = editors.iter().map(|e| e.entity_id()).collect();
        cx.global_mut::<FontLibrary>()
            .registered
            .retain(|k, _| alive.contains(k));
        for f in wanted {
            FontLibrary::ensure(&f, cx);
        }
    }

    /// Whether the engine of `editor` can use `family` now.
    pub fn available(
        editor: &Entity<crate::ui::editor::EditorView>,
        family: &str,
        cx: &App,
    ) -> bool {
        editor
            .read(cx)
            .session
            .renderer
            .text()
            .db()
            .has_family(family)
    }

    /// Whether GPUI can draw the family (picker previews).
    pub fn previewable(family: &str, cx: &App) -> bool {
        cx.try_global::<FontLibrary>()
            .is_some_and(|l| l.gpui.contains(&key(family)))
    }

    /// Whether a family is being fetched.
    pub fn is_loading(family: &str, cx: &App) -> bool {
        cx.try_global::<FontLibrary>()
            .is_some_and(|l| l.loading.contains(&key(family)))
    }

    /// Fetches a family unless it is bundled, loaded, loading or known to be missing.
    pub fn ensure(family: &str, cx: &mut App) {
        if !valid_family(family) || !cx.has_global::<FontLibrary>() {
            return;
        }
        let k = key(family);
        let bundled = desyn_text::font::bundled::fonts().any(|b| key(b.family) == k);
        {
            let lib = cx.global::<FontLibrary>();
            if bundled
                || lib.loaded.contains_key(&k)
                || lib.loading.contains(&k)
                || lib.failed.contains(&k)
            {
                return;
            }
        }
        cx.global_mut::<FontLibrary>().loading.insert(k.clone());
        let fam = family.trim().to_string();
        let f = runtime::spawn(fetch_family(fam.clone()));
        cx.spawn(async move |cx| {
            let res = f
                .await
                .unwrap_or_else(|_| Err(CloudError::network("cancelled")));
            cx.update(|cx| {
                let lib = cx.global_mut::<FontLibrary>();
                lib.loading.remove(&k);
                match res {
                    Ok(files) => {
                        let files: Vec<Arc<Vec<u8>>> = files.into_iter().map(Arc::new).collect();
                        let gpui_fonts: Vec<Cow<'static, [u8]>> = files
                            .iter()
                            .map(|f| Cow::Owned(f.as_ref().clone()))
                            .collect();
                        lib.loaded.insert(k.clone(), (fam.clone(), files));
                        if cx.text_system().add_fonts(gpui_fonts).is_ok() {
                            cx.global_mut::<FontLibrary>().gpui.insert(k);
                        }
                        // The watcher registers the files with every open editor on its next tick.
                        FontLibrary::tick(cx);
                        cx.refresh_windows();
                    }
                    Err(e) => {
                        if e.code != "NETWORK" {
                            lib.failed.insert(k);
                        }
                        log::info!("font {fam}: {e}");
                    }
                }
            });
        })
        .detach();
    }
}

/// One row of the picker.
#[derive(Debug, Clone, PartialEq)]
pub struct FamilyRow {
    /// Display name.
    pub name: String,
    /// Category when known.
    pub category: Option<Category>,
}

/// Families for the picker: the engine's families plus the catalog, filtered by a query and category.
pub fn families(
    engine_families: &[String],
    query: &str,
    category: Option<Category>,
) -> Vec<FamilyRow> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let q = query.trim().to_lowercase();
    let cat_of = |n: &str| {
        CATALOG
            .iter()
            .find(|(c, _)| key(c) == key(n))
            .map(|(_, c)| *c)
    };
    for n in engine_families
        .iter()
        .map(String::as_str)
        .chain(CATALOG.iter().map(|(n, _)| *n))
    {
        let k = key(n);
        if n.starts_with("Noto") && !CATALOG.iter().any(|(c, _)| key(c) == k) {
            // Script fallbacks (Arabic, Hebrew, Emoji) are not offered as design fonts.
            continue;
        }
        if !seen.insert(k) {
            continue;
        }
        let c = cat_of(n);
        if category.is_some() && c != category {
            continue;
        }
        if !q.is_empty() && !n.to_lowercase().contains(&q) {
            continue;
        }
        out.push(FamilyRow {
            name: n.to_string(),
            category: c,
        });
    }
    // Names starting with the query first, then word starts, then the rest; alphabetical within each.
    let rank = |n: &str| -> u8 {
        let l = n.to_lowercase();
        if q.is_empty() || l.starts_with(&q) {
            0
        } else if l.split_whitespace().any(|w| w.starts_with(&q)) {
            1
        } else {
            2
        }
    };
    out.sort_by(|a, b| {
        rank(&a.name)
            .cmp(&rank(&b.name))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

/// Emitted by the picker.
#[derive(Debug, Clone, PartialEq)]
pub enum FontEvent {
    /// A family was chosen.
    Pick(String),
}

/// The font picker popover.
pub struct FontPicker {
    search: Entity<TextField>,
    category: Option<Category>,
    current: String,
    engine: Vec<String>,
    rows: Vec<FamilyRow>,
    scroll: UniformListScrollHandle,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl EventEmitter<FontEvent> for FontPicker {}

impl Focusable for FontPicker {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl FontPicker {
    /// A picker for an editor's engine with `current` selected.
    pub fn new(
        current: &str,
        engine: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> FontPicker {
        let search = cx.new(|cx| {
            let mut f = TextField::new("Search fonts", cx);
            f.font_size = 13.0;
            f
        });
        let subs =
            vec![
                cx.subscribe_in(&search, window, |this, _, e: &FieldEvent, _, cx| match e {
                    FieldEvent::Changed(_) => this.refilter(cx),
                    FieldEvent::Confirm => {
                        if let Some(r) = this.rows.first().cloned() {
                            this.choose(r.name, cx);
                        }
                    }
                    _ => {}
                }),
            ];
        let fh = search.focus_handle(cx);
        window.focus(&fh, cx);
        let mut p = FontPicker {
            search,
            category: None,
            current: current.to_string(),
            engine,
            rows: Vec::new(),
            scroll: UniformListScrollHandle::new(),
            focus: cx.focus_handle(),
            _subs: subs,
        };
        p.refilter(cx);
        if let Some(i) = p.rows.iter().position(|r| key(&r.name) == key(current)) {
            p.scroll.scroll_to_item(i, gpui::ScrollStrategy::Center);
        }
        p
    }

    fn refilter(&mut self, cx: &mut Context<Self>) {
        let q = self.search.read(cx).text().to_string();
        self.rows = families(&self.engine, &q, self.category);
        cx.notify();
    }

    fn choose(&mut self, name: String, cx: &mut Context<Self>) {
        FontLibrary::ensure(&name, cx);
        self.current = name.clone();
        cx.emit(FontEvent::Pick(name));
        cx.notify();
    }
}

impl Render for FontPicker {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let rows = self.rows.clone();
        let current = key(&self.current);
        let view = cx.entity();
        let cats = vec![
            (None, Seg::Text("All".into())),
            (Some(Category::Sans), Seg::Text("Sans".into())),
            (Some(Category::Serif), Seg::Text("Serif".into())),
            (Some(Category::Display), Seg::Text("Display".into())),
            (Some(Category::Script), Seg::Text("Script".into())),
            (Some(Category::Mono), Seg::Text("Mono".into())),
        ];
        let v2 = view.clone();
        let accent = th.accent_text;
        let list = uniform_list("font-rows", rows.len(), move |range, window, cx| {
            let th = t(window, cx);
            range
                .map(|i| {
                    let r = rows[i].clone();
                    let selected = key(&r.name) == current;
                    let preview = FontLibrary::previewable(&r.name, cx);
                    let loading = FontLibrary::is_loading(&r.name, cx);
                    let name = r.name.clone();
                    let v = v2.clone();
                    let s3 = th.surface3;
                    div()
                        .id(("font", i))
                        .h(px(34.0))
                        .px(px(10.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .rounded(px(7.0))
                        .cursor_pointer()
                        .when(selected, |d| d.bg(th.accent_soft))
                        .hover(move |s| s.bg(s3))
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.0))
                                .truncate()
                                .font_family(if preview {
                                    SharedString::from(r.name.clone())
                                } else {
                                    SANS.into()
                                })
                                .text_size(px(15.0))
                                .text_color(if selected { accent } else { th.fg })
                                .child(r.name.clone()),
                        )
                        .when(loading, |d| {
                            d.child(super::spinner(format!("font-load-{i}"), 8.0, &th))
                        })
                        .when(!preview && !loading, |d| {
                            d.child(icon("icons/download.svg", 12.0, th.faint))
                        })
                        .when(selected, |d| d.child(icon("icons/check.svg", 14.0, accent)))
                        .on_click(move |_, _, cx| {
                            let n = name.clone();
                            v.update(cx, |p, cx| p.choose(n, cx));
                        })
                })
                .collect::<Vec<_>>()
        })
        .track_scroll(&self.scroll)
        .h(px(300.0));
        div()
            .id("font-picker")
            .track_focus(&self.focus)
            .w(px(280.0))
            .p(px(10.0))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(search_box(self.search.clone(), &th))
            .child(segmented("font-cat", cats, Some(&self.category), &th, {
                let view = view.clone();
                move |c, _, cx| {
                    view.update(cx, |p, cx| {
                        p.category = c;
                        p.refilter(cx);
                    })
                }
            }))
            .child(if self.rows.is_empty() {
                div()
                    .h(px(300.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .font_family(SANS)
                    .text_size(px(12.5))
                    .text_color(th.muted)
                    .child("No fonts match.")
                    .into_any_element()
            } else {
                list.into_any_element()
            })
            .child(
                div()
                    .font_family(SANS)
                    .text_size(px(11.0))
                    .text_color(alpha(th.fg, 0.45))
                    .child("Fonts download from Google Fonts on first use and work offline after that."),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_list_merges_engine_and_catalog() {
        let engine = vec![
            "Inter".to_string(),
            "Noto Sans Arabic".to_string(),
            "My Brand Font".to_string(),
        ];
        let all = families(&engine, "", None);
        assert!(all.iter().any(|r| r.name == "My Brand Font"));
        assert!(!all.iter().any(|r| r.name == "Noto Sans Arabic"));
        assert_eq!(all.iter().filter(|r| r.name == "Inter").count(), 1);
        let serif = families(&engine, "", Some(Category::Serif));
        assert!(serif.iter().all(|r| r.category == Some(Category::Serif)));
        let q = families(&engine, "play", None);
        assert_eq!(q[0].name, "Playfair Display");
    }

    #[test]
    fn queries_and_css() {
        assert_eq!(
            queries("Playfair Display")[0],
            "Playfair+Display:ital,wght@0,100..900;1,100..900"
        );
        assert!(!valid_family("a/b"));
        assert!(!valid_family(""));
        assert!(valid_family("Space Grotesk"));
        let css = "@font-face{src:url(https://fonts.gstatic.com/s/a.ttf) format('truetype')}@font-face{src:url(http://x/b.ttf)}";
        assert_eq!(css_urls(css), vec!["https://fonts.gstatic.com/s/a.ttf"]);
    }
}
