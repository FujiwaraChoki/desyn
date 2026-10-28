//! Shared request checks and asset planning: which assets a job needs, where to fetch them, and the limits every
//! design must respect.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use desyn_core::clipboard::{font_families, node_asset_refs};
use desyn_core::model::{AssetKind, Design, Id, Node, ROOT_ID, validate_design};
use desyn_text::font::{normalize_family, split_family_list};
use serde_json::json;

use crate::config::{AssetConfig, Limits};
use crate::error::{ApiError, ApiResult};
use crate::net::{FetchItem, FetchReport};

/// Most validation violations echoed in an error.
const MAX_VIOLATIONS: usize = 25;

/// Rejects designs above the node limit, and checks the document invariants (DOCUMENT_MODEL section 4).
///
/// With `strict` (layout, apply: they return a design callers store) a violation is a 422. Otherwise (render,
/// thumbnail, describe: read-only outputs; the engine never panics on invalid input) violations are reported as a
/// warning so a minor inconsistency never blocks a user's export.
pub fn check_design(design: &Design, limits: &Limits, strict: bool) -> ApiResult<Vec<String>> {
    if design.nodes.len() > limits.max_nodes {
        return Err(ApiError::too_large(
            "too_many_nodes",
            format!(
                "the design has {} nodes (limit {})",
                design.nodes.len(),
                limits.max_nodes
            ),
        ));
    }
    if let Err((id, message)) = check_child_graph(design) {
        return Err(ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_design",
            format!("the design's child lists do not form a tree: {message}"),
        )
        .with_details(json!({ "violations": [{ "id": id, "code": "child-graph", "message": message }], "total": 1 })));
    }
    let violations = validate_design(design);
    if violations.is_empty() {
        return Ok(Vec::new());
    }
    let total = violations.len();
    let message = format!(
        "the design violates {total} document rule(s); first: {} ({})",
        violations[0].message,
        violations[0].id.as_deref().unwrap_or("design")
    );
    if strict {
        let shown: Vec<_> = violations.into_iter().take(MAX_VIOLATIONS).collect();
        return Err(ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_design",
            message,
        )
        .with_details(json!({ "violations": shown, "total": total })));
    }
    tracing::warn!(total, first = %violations[0].message, "design violates document invariants");
    Ok(vec![message])
}

/// Checks that the `children` lists form a forest: no node is listed twice (in one list or in two), root is never
/// listed, and there is no cycle. This is the part of invariants 1 and 2 that every tree walk depends on: a node
/// listed twice per level makes a walk visit it 2^depth times, and a cycle walks until the depth guard. A design
/// that breaks it is refused even where other violations only warn. Mismatched `parent` fields do not matter here
/// (walks follow child lists). Linear in the number of nodes.
pub fn check_child_graph(design: &Design) -> Result<(), (Id, String)> {
    let mut listed_in: HashMap<&str, &str> = HashMap::with_capacity(design.nodes.len());
    for (key, node) in &design.nodes {
        for child in node.child_ids() {
            if !design.nodes.contains_key(child) {
                // Dangling ids are skipped by every walk (and reported by the validator).
                continue;
            }
            if child == ROOT_ID {
                return Err((key.clone(), "root is listed as a child".into()));
            }
            if let Some(first) = listed_in.insert(child.as_str(), key.as_str()) {
                let message = if first == key {
                    format!("{child:?} is listed twice in the children of {key:?}")
                } else {
                    format!("{child:?} is listed in the children of both {first:?} and {key:?}")
                };
                return Err((child.clone(), message));
            }
        }
    }
    // Every node now has at most one lister; walking down from the unlisted nodes reaches each node at most once,
    // and whatever stays unreached sits on (or under) a cycle.
    let mut reached: HashSet<&str> = HashSet::with_capacity(design.nodes.len());
    let mut stack: Vec<&str> = design
        .nodes
        .keys()
        .map(String::as_str)
        .filter(|k| !listed_in.contains_key(k))
        .collect();
    while let Some(id) = stack.pop() {
        reached.insert(id);
        if let Some(n) = design.nodes.get(id) {
            stack.extend(
                n.child_ids()
                    .iter()
                    .map(String::as_str)
                    .filter(|c| design.nodes.contains_key(*c)),
            );
        }
    }
    if let Some(start) = design
        .nodes
        .keys()
        .map(String::as_str)
        .find(|k| !reached.contains(k))
    {
        // Unreached nodes all have a lister; following listers upwards for `n` steps ends on the cycle.
        let mut cur = start;
        for _ in 0..design.nodes.len() {
            match listed_in.get(cur) {
                Some(p) => cur = p,
                None => break,
            }
        }
        return Err((cur.to_string(), format!("{cur:?} is part of a cycle")));
    }
    Ok(())
}

/// Which kinds of assets a job needs.
#[derive(Debug, Clone, Copy, Default)]
pub struct Want {
    /// Images and SVGs drawn by the nodes.
    pub images: bool,
    /// Font assets of the families the text uses.
    pub fonts: bool,
    /// Audio and video media (video exports mix their sound).
    pub media: bool,
}

/// Assets to fetch for a job.
#[derive(Debug, Clone, Default)]
pub struct AssetNeeds {
    /// URLs to fetch.
    pub items: Vec<FetchItem>,
    /// Referenced assets without any URL (neither in `assetUrls` nor `AssetRef.url`).
    pub unresolved: Vec<Id>,
}

impl AssetNeeds {
    /// Adds font assets for `families`.
    pub fn add_fonts(
        &mut self,
        design_assets: &BTreeMap<Id, desyn_core::model::AssetRef>,
        families: &HashSet<String>,
        urls: &BTreeMap<String, String>,
        cfg: &AssetConfig,
    ) {
        let mut seen: HashSet<Id> = self.items.iter().map(|i| i.id.clone()).collect();
        for (id, a) in design_assets {
            if a.kind != AssetKind::Font || seen.contains(id) {
                continue;
            }
            let used = match a.family.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
                Some(f) => families.contains(&normalize_family(f)),
                // A font asset without a family is named by the file; it may be any of the families in use.
                None => true,
            };
            if !used {
                continue;
            }
            seen.insert(id.clone());
            match url_for(id, a.url.as_deref(), urls) {
                Some(url) => self.items.push(FetchItem {
                    id: id.clone(),
                    url,
                    max_bytes: cfg.max_asset_bytes,
                }),
                None => self.unresolved.push(id.clone()),
            }
        }
    }
}

fn url_for(id: &str, own: Option<&str>, urls: &BTreeMap<String, String>) -> Option<String> {
    urls.get(id)
        .map(String::as_str)
        .or(own)
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(str::to_string)
}

/// Normalized font families used by text, tables and charts in `nodes`.
pub fn families_of<'a>(nodes: impl IntoIterator<Item = &'a Node>) -> HashSet<String> {
    let mut out = HashSet::new();
    for n in nodes {
        for f in font_families(n) {
            for name in split_family_list(&f) {
                let key = normalize_family(&name);
                if !key.is_empty() {
                    out.insert(key);
                }
            }
        }
    }
    out
}

/// Nodes of the given pages (every node of the design when `pages` is `None`).
pub fn nodes_in<'a>(design: &'a Design, pages: Option<&[Id]>) -> Vec<&'a Node> {
    match pages {
        None => design.nodes.values().collect(),
        Some(pages) => {
            let mut out = Vec::new();
            for p in pages {
                design.walk(p, &mut |n, _| {
                    out.push(n);
                    true
                });
            }
            out
        }
    }
}

/// Assets the nodes of `pages` (or the whole design) need.
pub fn plan(
    design: &Design,
    pages: Option<&[Id]>,
    urls: &BTreeMap<String, String>,
    want: Want,
    cfg: &AssetConfig,
) -> AssetNeeds {
    let nodes = nodes_in(design, pages);
    let mut needs = AssetNeeds::default();
    let mut seen: BTreeSet<Id> = BTreeSet::new();
    for n in &nodes {
        for id in node_asset_refs(n) {
            if !seen.insert(id.clone()) {
                continue;
            }
            let Some(a) = design.assets.get(&id) else {
                needs.unresolved.push(id);
                continue;
            };
            let (wanted, max_bytes) = match a.kind {
                AssetKind::Image | AssetKind::Svg => (want.images, cfg.max_asset_bytes),
                AssetKind::Audio | AssetKind::Video => (want.media, cfg.max_media_bytes),
                AssetKind::Font => (want.fonts, cfg.max_asset_bytes),
                AssetKind::Lottie | AssetKind::Data => (false, 0),
            };
            if !wanted {
                continue;
            }
            match url_for(&id, a.url.as_deref(), urls) {
                Some(url) => needs.items.push(FetchItem { id, url, max_bytes }),
                None => needs.unresolved.push(id),
            }
        }
    }
    if want.fonts {
        let families = families_of(nodes.iter().copied());
        needs.add_fonts(&design.assets, &families, urls, cfg);
    }
    needs
}

/// With `strictAssets`, any asset that could not be fetched fails the request (422 when refused by policy or
/// missing a URL, 502 otherwise, so the caller's retry logic does the right thing).
pub fn check_strict(strict: bool, needs: &AssetNeeds, report: &FetchReport) -> ApiResult<()> {
    if !strict || (needs.unresolved.is_empty() && report.failed.is_empty()) {
        return Ok(());
    }
    let permanent = !needs.unresolved.is_empty()
        || report.failed.iter().any(|f| {
            matches!(
                f.reason,
                "blocked" | "invalid_url" | "too_large" | "too_many_assets"
            )
        });
    let status = if permanent {
        axum::http::StatusCode::UNPROCESSABLE_ENTITY
    } else {
        axum::http::StatusCode::BAD_GATEWAY
    };
    Err(ApiError::new(
        status,
        "asset_fetch_failed",
        format!(
            "{} asset(s) could not be loaded",
            needs.unresolved.len() + report.failed.len()
        ),
    )
    .with_details(json!({ "failed": report.failed, "unresolved": needs.unresolved })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn design() -> Design {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../spec/fixtures/render/social.json"
        ))
        .unwrap();
        let mut d = Design::from_json(&raw).unwrap();
        // The render fixtures leave page parents null; the contract says "root".
        for p in d.page_ids().to_vec() {
            d.nodes.get_mut(&p).unwrap().base_mut().parent = Some("root".into());
        }
        d
    }

    #[test]
    fn plans_page_assets_with_url_precedence() {
        let mut d = design();
        let cfg = AssetConfig::default();
        let mut urls = BTreeMap::new();
        urls.insert(
            "photo0000001".to_string(),
            "https://b.s3.amazonaws.com/photo".to_string(),
        );
        d.assets.get_mut("icon00000001").unwrap().url =
            Some("https://b.s3.amazonaws.com/icon".into());
        let pages = d.page_ids().to_vec();
        let needs = plan(
            &d,
            Some(&pages),
            &urls,
            Want {
                images: true,
                fonts: true,
                media: false,
            },
            &cfg,
        );
        let mut got: Vec<_> = needs
            .items
            .iter()
            .map(|i| (i.id.as_str(), i.url.as_str()))
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("icon00000001", "https://b.s3.amazonaws.com/icon"),
                ("photo0000001", "https://b.s3.amazonaws.com/photo")
            ]
        );
        assert!(needs.unresolved.is_empty());
        let none = plan(
            &d,
            Some(&pages),
            &BTreeMap::new(),
            Want {
                images: true,
                ..Want::default()
            },
            &cfg,
        );
        assert_eq!(none.unresolved, vec!["photo0000001".to_string()]);
        assert!(families_of(nodes_in(&d, None)).contains("inter"));
    }

    fn children<'a>(d: &'a mut Design, id: &str) -> &'a mut Vec<Id> {
        d.nodes
            .get_mut(id)
            .unwrap()
            .children_mut()
            .expect("container")
    }

    #[test]
    fn child_lists_must_form_a_tree() {
        let d = design();
        assert!(check_child_graph(&d).is_ok());
        let page = d.page_ids()[0].clone();
        let kid = d.node(&page).unwrap().child_ids()[0].clone();
        let mut twice = d.clone();
        children(&mut twice, &page).push(kid.clone());
        let (id, msg) = check_child_graph(&twice).unwrap_err();
        assert_eq!(id, kid);
        assert!(msg.contains("twice"), "{msg}");
        let mut root_listed = d.clone();
        children(&mut root_listed, &page).push(ROOT_ID.into());
        assert!(check_child_graph(&root_listed).is_err());
        let mut cycle = d.clone();
        children(&mut cycle, ROOT_ID).retain(|p| p != &page);
        children(&mut cycle, &page).push(page.clone());
        let (_, msg) = check_child_graph(&cycle).unwrap_err();
        assert!(msg.contains("twice") || msg.contains("cycle"), "{msg}");
        // Not a tree-shape problem: a page whose parent field is wrong.
        let mut loose = d.clone();
        loose.nodes.get_mut(&page).unwrap().base_mut().parent = None;
        assert!(check_child_graph(&loose).is_ok());
    }

    #[test]
    fn rejects_invalid_and_oversized_designs() {
        let mut d = design();
        assert!(
            check_design(&d, &Limits::default(), true)
                .unwrap()
                .is_empty()
        );
        let small = Limits {
            max_nodes: 2,
            ..Limits::default()
        };
        let e = check_design(&d, &small, false).unwrap_err();
        assert_eq!(e.code, "too_many_nodes");
        let page = d.page_ids()[0].clone();
        d.nodes.get_mut(&page).unwrap().base_mut().opacity = 7.0;
        let e = check_design(&d, &Limits::default(), true).unwrap_err();
        assert_eq!(e.code, "invalid_design");
        assert_eq!(e.status.as_u16(), 422);
        let warnings = check_design(&d, &Limits::default(), false).unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("opacity"), "{warnings:?}");
    }
}
