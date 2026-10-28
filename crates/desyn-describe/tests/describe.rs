//! Behavior tests: options, page resolution, determinism, fixes that really fix, compact renderings, tokens.

mod support;

use desyn_core::{ApplyOptions, AssetKind, DesignKind, Transaction, apply_transaction};
use desyn_describe::{
    CompactOptions, DescribeError, DescribeOptions, Detail, PixelSampler, compact_text,
    compact_value, describe, design_tokens, estimate_tokens, lint,
};
use desyn_text::TextEngine;
use support::*;

fn load(name: &str) -> Fixture {
    let path = fixtures_dir().join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("fixture json")
}

fn engine() -> TextEngine {
    TextEngine::with_bundled_fonts()
}

fn sample_design() -> desyn_core::Design {
    let mut b = B::new(DesignKind::SocialPost, 1080.0, 1080.0);
    b.frame("", "Card", 100.0, 100.0, 600.0, 400.0, "#f0f0f0");
    b.text(
        "Card",
        "Card title",
        "Hello",
        40.0,
        40.0,
        400.0,
        48.0,
        700.0,
        "#111111",
    );
    b.group("Card", "Inner", 40.0, 160.0, 400.0, 200.0);
    b.text(
        "Inner",
        "Deep text",
        "Nested copy for the depth test",
        0.0,
        0.0,
        400.0,
        24.0,
        400.0,
        "#111111",
    );
    b.text(
        "",
        "Hidden note",
        "Not shown",
        100.0,
        800.0,
        400.0,
        24.0,
        400.0,
        "#111111",
    );
    b.node("Hidden note").base_mut().visible = false;
    b.finish()
}

#[test]
fn page_resolution_and_errors() {
    let d = sample_design();
    let mut e = engine();
    let by_selection = describe(
        &d,
        &DescribeOptions {
            selection: vec![nid("Deep text"), "missing00000".into()],
            ..Default::default()
        },
        &mut e,
        None,
    )
    .unwrap();
    assert_eq!(by_selection.page.id, PAGE);
    assert_eq!(
        by_selection.selection,
        vec![nid("Deep text")],
        "unknown ids are dropped from the echo"
    );
    let missing = describe(
        &d,
        &DescribeOptions {
            page_id: Some("nopage000000".into()),
            ..Default::default()
        },
        &mut e,
        None,
    );
    assert_eq!(
        missing.unwrap_err(),
        DescribeError::PageNotFound("nopage000000".into())
    );
    let empty = desyn_core::Design::new("design000002", "Empty", DesignKind::Custom);
    assert_eq!(
        describe(&empty, &DescribeOptions::default(), &mut e, None).unwrap_err(),
        DescribeError::NoPages
    );
    // `page` is accepted as an alias of `pageId`, `depth` of `maxDepth`.
    let opts: DescribeOptions = serde_json::from_value(
        serde_json::json!({ "page": PAGE, "depth": 2, "detail": "summary" }),
    )
    .unwrap();
    assert_eq!(opts.page_id.as_deref(), Some(PAGE));
    assert_eq!(opts.depth(), 2);
}

#[test]
fn selection_flag_hidden_depth_and_max_nodes() {
    let d = sample_design();
    let mut e = engine();
    let full = describe(
        &d,
        &DescribeOptions {
            selection: vec![nid("Card title")],
            ..Default::default()
        },
        &mut e,
        None,
    )
    .unwrap();
    let card = full.tree.iter().find(|n| n.id == nid("Card")).unwrap();
    let title = &card.children.as_ref().unwrap()[0];
    assert_eq!(title.flags.as_ref().unwrap()[0], "selected");
    assert!(
        full.tree
            .iter()
            .any(|n| n.id == nid("Hidden note") && !n.visible),
        "hidden nodes are kept by default"
    );
    assert!(
        !full
            .issues
            .iter()
            .any(|i| i.ids.contains(&nid("Hidden note"))),
        "hidden nodes are never linted"
    );

    let no_hidden = describe(
        &d,
        &DescribeOptions {
            include_hidden: Some(false),
            ..Default::default()
        },
        &mut e,
        None,
    )
    .unwrap();
    assert!(!no_hidden.tree.iter().any(|n| n.id == nid("Hidden note")));
    assert_eq!(no_hidden.omitted, 1);

    let shallow = describe(
        &d,
        &DescribeOptions {
            max_depth: Some(1),
            ..Default::default()
        },
        &mut e,
        None,
    )
    .unwrap();
    assert!(shallow.tree.iter().all(|n| n.children.is_none()));
    assert_eq!(
        shallow.omitted, 3,
        "card title, inner group and its text are cut"
    );

    let capped = describe(
        &d,
        &DescribeOptions {
            max_nodes: Some(2),
            ..Default::default()
        },
        &mut e,
        None,
    )
    .unwrap();
    let mut count = 0;
    fn walk(n: &[desyn_describe::DNode], c: &mut usize) {
        for d in n {
            *c += 1;
            walk(d.children.as_deref().unwrap_or(&[]), c);
        }
    }
    walk(&capped.tree, &mut count);
    assert_eq!(count, 2);
    assert_eq!(capped.omitted, 3);
}

#[test]
fn detail_summary_truncates_and_tokens_follow_detail() {
    let mut b = B::new(DesignKind::Document, 816.0, 1056.0);
    let long = "word ".repeat(80);
    b.text(
        "",
        "Long body",
        long.trim(),
        72.0,
        72.0,
        672.0,
        14.0,
        400.0,
        "#111111",
    );
    let d = b.finish();
    let mut e = engine();
    let summary = describe(
        &d,
        &DescribeOptions {
            detail: Detail::Summary,
            ..Default::default()
        },
        &mut e,
        None,
    )
    .unwrap();
    let t = summary.tree[0].text.clone().unwrap();
    assert_eq!(
        t.chars().count(),
        desyn_describe::options::SUMMARY_TEXT_CHARS
    );
    assert!(t.ends_with('…'));
    assert!(summary.tokens.is_none());
    let full = describe(&d, &DescribeOptions::default(), &mut e, None).unwrap();
    assert_eq!(full.tree[0].text.as_deref(), Some(long.trim()));
    assert!(full.tokens.is_some());
    let no_lint = describe(
        &d,
        &DescribeOptions {
            lint: Some(false),
            include_styles: Some(false),
            ..Default::default()
        },
        &mut e,
        None,
    )
    .unwrap();
    assert!(no_lint.issues.is_empty() && no_lint.tokens.is_none());
}

#[test]
fn output_is_deterministic() {
    for name in ["shop-page", "patterns", "text-fit", "contrast"] {
        let f = load(name);
        let a = serde_json::to_string(&run_fixture(&f)).unwrap();
        let b = serde_json::to_string(&run_fixture(&f)).unwrap();
        assert_eq!(a, b, "{name}");
    }
}

#[test]
fn lint_matches_describe_issues() {
    let f = load("layout");
    let mut e = engine();
    let opts = DescribeOptions::default();
    let issues = lint(&f.design, &opts, &mut e, None).unwrap();
    let desc = describe(&f.design, &opts, &mut e, None).unwrap();
    assert_eq!(
        serde_json::to_value(&issues).unwrap(),
        serde_json::to_value(&desc.issues).unwrap()
    );
}

/// Applying an issue's fix (as one transaction through the core) removes that issue.
#[test]
fn fixes_resolve_their_issue() {
    let mut checked = 0;
    for name in [
        "contrast",
        "text-fit",
        "layout",
        "print",
        "brand",
        "structure",
    ] {
        let f = load(name);
        let opts: DescribeOptions = if f.options.is_null() {
            DescribeOptions::default()
        } else {
            serde_json::from_value(f.options.clone()).unwrap()
        };
        let before = run_fixture(&f);
        for issue in before.issues.iter().filter(|i| i.fix.is_some()) {
            let mut design = f.design.clone();
            let mut e = engine();
            let tx = Transaction::new("fixtx0000001", "Fix", issue.fix.clone().unwrap());
            let result = apply_transaction(&mut design, &tx, ApplyOptions::normalized(&mut e));
            assert!(
                result.dropped.is_empty(),
                "{name}/{}: fix ops dropped {:?}",
                issue.rule,
                result.dropped
            );
            let mut sampler = PixelSampler::new();
            for (id, img) in &f.images {
                sampler.insert(id.clone(), img.width, img.height, img.pixels());
            }
            let after = describe(&design, &opts, &mut e, Some(&mut sampler)).unwrap();
            let again = after
                .issues
                .iter()
                .find(|i| i.rule == issue.rule && i.ids.first() == issue.ids.first());
            assert!(
                again.is_none(),
                "{name}: fix for {} {:?} did not resolve it: {:?}",
                issue.rule,
                issue.ids,
                again.map(|i| &i.message)
            );
            checked += 1;
        }
    }
    assert!(checked >= 15, "only {checked} fixes checked");
}

#[test]
fn compact_value_has_the_ai_shape() {
    let desc = run_fixture(&load("shop-page"));
    let v = compact_value(&desc, None);
    let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "grid",
            "hierarchy",
            "issues",
            "page",
            "palette",
            "fonts",
            "tree",
            "typography"
        ]
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>()
    );
    let header = &v["tree"][0];
    assert_eq!(header["type"], "frame");
    assert_eq!(header["box"], serde_json::json!([0.0, 0.0, 1200.0, 96.0]));
    assert!(header["semantic"].as_str().unwrap().starts_with("header"));
    let font = header["children"][1]["font"].as_str().unwrap();
    assert_eq!(font, "Inter 700 28px #111111 left");
    assert!(v["palette"][0].as_str().unwrap().ends_with('%'));
    assert!(v["fonts"][0].as_str().unwrap().contains(") ×"));
    assert!(v["hierarchy"].as_array().unwrap().len() <= 6);
}

#[test]
fn compact_text_respects_the_budget_and_is_stable() {
    for name in ["shop-page", "patterns", "text-fit"] {
        let desc = run_fixture(&load(name));
        let mut last = 0;
        for budget in [200usize, 400, 800, 1600, 4000] {
            let o = CompactOptions {
                max_tokens: budget,
                ..Default::default()
            };
            let text = compact_text(&desc, &o);
            assert_eq!(text, compact_text(&desc, &o), "stable");
            let tokens: usize = text.lines().map(|l| estimate_tokens(l) + 1).sum();
            // The fixed header / summary block is always present; everything else respects the budget.
            assert!(
                tokens <= budget.max(300),
                "{name}: {tokens} tokens for budget {budget}"
            );
            assert!(text.len() >= last, "a larger budget never shows less");
            last = text.len();
        }
    }
}

#[test]
fn tokens_cover_palette_type_and_spacing() {
    let f = load("shop-page");
    let mut e = engine();
    let t = design_tokens(&f.design, None, &mut e).unwrap();
    assert_eq!(
        t.palette[0].color, "#111111",
        "most used color first: {:?}",
        t.palette
    );
    assert!(
        t.palette
            .iter()
            .any(|c| c.color == "#f6f3ee" && c.count == 6)
    );
    let sizes: Vec<f64> = t.type_scale.iter().map(|s| s.size).collect();
    assert_eq!(sizes, vec![28.0, 24.0, 22.0, 18.0, 14.0]);
    assert!(
        t.spacing_scale.iter().any(|s| s.value == 40.0),
        "card gaps: {:?}",
        t.spacing_scale
    );
    assert!(design_tokens(&f.design, Some("nopage000000"), &mut e).is_err());
}

#[test]
fn sampler_drives_image_contrast() {
    let mut b = B::new(DesignKind::SocialPost, 1080.0, 1080.0);
    b.asset("photo", AssetKind::Image, 100.0, 100.0);
    b.image("", "Photo", "photo", 0.0, 0.0, 1080.0, 1080.0);
    b.alt("Photo", "Night sky");
    b.text(
        "",
        "Title",
        "Night market",
        100.0,
        100.0,
        800.0,
        72.0,
        700.0,
        "#ffffff",
    );
    let d = b.finish();
    let mut e = engine();
    let opts = DescribeOptions::default();
    let mut dark = PixelSampler::new();
    dark.insert(nid("photo"), 10, 10, [10u8, 10, 20, 255].repeat(100));
    let ok = describe(&d, &opts, &mut e, Some(&mut dark)).unwrap();
    assert!(!ok.issues.iter().any(|i| i.rule == "low-contrast"));
    let mut light = PixelSampler::new();
    light.insert(nid("photo"), 10, 10, [240u8, 240, 235, 255].repeat(100));
    let bad = describe(&d, &opts, &mut e, Some(&mut light)).unwrap();
    assert!(
        bad.issues
            .iter()
            .any(|i| i.rule == "low-contrast" && i.ids == [nid("Title")])
    );
    let unknown = describe(&d, &opts, &mut e, None).unwrap();
    assert!(!unknown.issues.iter().any(|i| i.rule == "low-contrast"));
    let title = unknown.tree.iter().find(|n| n.id == nid("Title")).unwrap();
    assert!(
        title
            .flags
            .as_ref()
            .unwrap()
            .contains(&"on-image".to_string())
    );
}

#[test]
fn page_coordinates_and_resolved_style_references() {
    let d = sample_design();
    let mut e = engine();
    let desc = describe(&d, &DescribeOptions::default(), &mut e, None).unwrap();
    let card = desc.tree.iter().find(|n| n.id == nid("Card")).unwrap();
    let title = &card.children.as_ref().unwrap()[0];
    assert_eq!(
        (title.bbox.x, title.bbox.y),
        (140.0, 140.0),
        "child boxes are in page coordinates"
    );
    let inner = &card.children.as_ref().unwrap()[1];
    let deep = &inner.children.as_ref().unwrap()[0];
    assert_eq!((deep.bbox.x, deep.bbox.y), (140.0, 260.0));

    let refs = run_fixture(&load("roles-and-refs"));
    let offer = refs.tree.iter().find(|n| n.id == nid("Offer")).unwrap();
    assert_eq!(offer.fill.as_deref(), Some("#ffb02e"), "$style resolved");
    let title = &offer.children.as_ref().unwrap()[0];
    assert_eq!(
        title.font.as_ref().unwrap().color,
        "#1b1b1b",
        "$var resolved"
    );
    assert!(refs.palette.iter().any(|p| p.color == "#ffb02e"));
}
