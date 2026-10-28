//! Fixture designs (`tests/fixtures/*.json`) covering every IssueCode / lint rule and every grouping heuristic.
//!
//! The fixtures are generated from the builders below (`DESYN_UPDATE_FIXTURES=1 cargo test --test fixtures`
//! rewrites them; otherwise a test fails when they are stale) and are plain JSON: a `Design`, describe
//! `options`, synthetic `images` for the sampler and the `expect`ations, so other hosts (the TypeScript
//! MemoryHost) can run them too.

mod support;

use std::collections::BTreeMap;

use desyn_core::{AssetKind, DesignKind, TextAlign, TextDirection, Unit};
use serde_json::json;
use support::*;

fn fixture(description: &str, design: desyn_core::Design, expect: Expect) -> Fixture {
    Fixture {
        description: description.into(),
        design,
        options: serde_json::Value::Null,
        images: BTreeMap::new(),
        expect,
    }
}

fn rules(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// A well-made poster: nothing but intentional choices, so no rule may fire.
fn clean_poster() -> Fixture {
    let mut b = B::new(DesignKind::Poster, 1080.0, 1350.0);
    b.rect("", "Background", 0.0, 0.0, 1080.0, 1350.0, "#0f1115");
    b.role("Background", "background");
    b.svg("", "Brand mark", "markasset", 96.0, 96.0, 48.0, 48.0);
    b.role("Brand mark", "logo")
        .alt("Brand mark", "Desyn sun mark");
    b.asset("markasset", AssetKind::Svg, 48.0, 48.0);
    b.text(
        "",
        "Brand name",
        "Desyn",
        160.0,
        104.0,
        200.0,
        28.0,
        600.0,
        "#f5f2ea",
    );
    b.text(
        "",
        "Headline",
        "Design at the speed of thought",
        96.0,
        420.0,
        888.0,
        96.0,
        700.0,
        "#ffffff",
    );
    b.role("Headline", "headline");
    b.text(
        "",
        "Subhead",
        "Make posters, decks and posts with an AI that edits real layers.",
        96.0,
        680.0,
        760.0,
        36.0,
        400.0,
        "#c9c4b8",
    );
    b.role("Subhead", "subhead");
    // A straight divider has no height: it lies on the page (regression: it was reported as off-page).
    b.line("", "Divider", 96.0, 1040.0, 320.0);
    b.role("Divider", "divider");
    b.frame("", "CTA button", 96.0, 1100.0, 320.0, 96.0, "#ffb02e");
    b.role("CTA button", "cta");
    b.text(
        "CTA button",
        "CTA label",
        "Start free",
        40.0,
        26.0,
        240.0,
        36.0,
        600.0,
        "#111111",
    );
    b.align("CTA label", TextAlign::Center);
    fixture(
        "A clean poster: background, logo lockup, headline, subhead, a divider line and a CTA button. No rule fires.",
        b.finish(),
        Expect {
            only_rules: Some(vec![]),
            groups: vec![
                ExpectGroup {
                    kind: "button".into(),
                    node: Some("CTA button".into()),
                    ..Default::default()
                },
                group("logo-lockup", &["Brand mark", "Brand name"]),
            ],
            reading_order: Some(rules(&[
                "Brand mark",
                "Brand name",
                "Headline",
                "Subhead",
                "CTA label",
            ])),
            direction: Some("ltr".into()),
            semantic: BTreeMap::from([(
                "CTA button".to_string(),
                "CTA button: \"Start free\"".to_string(),
            )]),
            ..Default::default()
        },
    )
}

/// Contrast: plain colors, a gradient, photos through the sampler (calm, busy, unknown), a QR code and a
/// quiet watermark.
fn contrast() -> Fixture {
    let mut b = B::new(DesignKind::SocialPost, 1080.0, 1080.0);
    b.text(
        "",
        "Grey on white",
        "Barely visible caption text",
        80.0,
        80.0,
        600.0,
        32.0,
        400.0,
        "#d0d0d0",
    );
    b.text(
        "",
        "Yellow on white",
        "Sunny but hard to read",
        80.0,
        160.0,
        600.0,
        32.0,
        400.0,
        "#e0a800",
    );
    b.rect("", "Dark panel", 80.0, 240.0, 600.0, 120.0, "");
    if let Some(s) = b.node("Dark panel").shaped_mut() {
        s.fills = linear(90.0, "#101010", "#2a2a2a");
    }
    b.text(
        "",
        "On gradient",
        "Readable on the dark gradient",
        100.0,
        270.0,
        560.0,
        32.0,
        400.0,
        "#ffffff",
    );
    b.asset("brightphoto", AssetKind::Image, 600.0, 400.0);
    b.image("", "Bright photo", "brightphoto", 80.0, 400.0, 600.0, 200.0);
    b.alt("Bright photo", "Snowy field");
    b.text(
        "",
        "White on snow",
        "Winter sale",
        100.0,
        460.0,
        400.0,
        40.0,
        700.0,
        "#ffffff",
    );
    b.asset("busyphoto", AssetKind::Image, 600.0, 400.0);
    b.image("", "Busy photo", "busyphoto", 80.0, 640.0, 600.0, 200.0);
    b.alt("Busy photo", "Black and white stripes");
    b.text(
        "",
        "On stripes",
        "White type on stripes",
        100.0,
        700.0,
        400.0,
        40.0,
        700.0,
        "#ffffff",
    );
    b.asset("unknownphoto", AssetKind::Image, 600.0, 400.0);
    b.image(
        "",
        "Unsampled photo",
        "unknownphoto",
        720.0,
        400.0,
        300.0,
        200.0,
    );
    b.alt("Unsampled photo", "A beach");
    b.text(
        "",
        "On unknown",
        "Beach day",
        740.0,
        460.0,
        260.0,
        40.0,
        700.0,
        "#ffffff",
    );
    b.qr("", "Faint QR", 760.0, 80.0, 160.0, "#bbbbbb", "#ffffff");
    b.text(
        "",
        "Watermark",
        "DRAFT",
        760.0,
        900.0,
        260.0,
        40.0,
        700.0,
        "#f2f2f2",
    );
    b.role("Watermark", "watermark");
    let mut f = fixture(
        "Low contrast on flat colors and on sampled photos, a busy photo, an unsampled photo, a faint QR code.",
        b.finish(),
        Expect {
            issues: vec![
                ExpectIssue {
                    severity: Some("error".into()),
                    fix: true,
                    ..issue("low-contrast", "low-contrast", &["Grey on white"])
                },
                ExpectIssue {
                    severity: Some("warn".into()),
                    fix: true,
                    ..issue("low-contrast", "low-contrast", &["Yellow on white"])
                },
                issue("low-contrast", "low-contrast", &["White on snow"]),
                issue("busy-background", "low-contrast", &["On stripes"]),
                ExpectIssue {
                    fix: true,
                    ..issue("qr-contrast", "low-contrast", &["Faint QR"])
                },
            ],
            flags: BTreeMap::from([
                ("On unknown".to_string(), rules(&["on-image"])),
                ("Grey on white".to_string(), rules(&["low-contrast"])),
            ]),
            ..Default::default()
        },
    );
    f.images.insert(
        nid("brightphoto"),
        SynthImage {
            width: 60,
            height: 40,
            pattern: "solid:#f4f6f8".into(),
        },
    );
    f.images.insert(
        nid("busyphoto"),
        SynthImage {
            width: 64,
            height: 40,
            pattern: "stripes:#000000,#ffffff".into(),
        },
    );
    f
}

/// Text fit: tiny text, overflow, truncation, clipping, orphans, widows, empty text, overlaps, covered text.
fn text_fit() -> Fixture {
    let mut b = B::new(DesignKind::SocialPost, 1080.0, 1080.0);
    b.text(
        "",
        "Legal",
        "Terms apply. Offer valid while stocks last.",
        80.0,
        1000.0,
        600.0,
        9.0,
        400.0,
        "#333333",
    );
    b.text("", "Overflowing", "This paragraph has far more words than its fixed box can show at this size, so it spills out.", 80.0, 80.0, 300.0, 28.0, 400.0, "#111111");
    b.fixed("Overflowing", 40.0);
    b.text(
        "",
        "Truncated",
        "A long single line that will be cut with an ellipsis",
        80.0,
        300.0,
        300.0,
        24.0,
        400.0,
        "#111111",
    );
    b.text_mut("Truncated").max_lines = Some(1);
    b.frame("", "Clip card", 600.0, 80.0, 300.0, 120.0, "#eeeeee");
    if let Some(c) = b.node("Clip card").container_mut() {
        c.clip = true;
    }
    b.text(
        "Clip card",
        "Clipped",
        "Text that hangs out of its card",
        20.0,
        80.0,
        400.0,
        28.0,
        400.0,
        "#111111",
    );
    b.text(
        "",
        "Orphan",
        "Our summer collection arrives today",
        80.0,
        420.0,
        640.0,
        64.0,
        700.0,
        "#111111",
    );
    b.text("", "Widow", "First paragraph fits in the box.\nSecond paragraph starts on the last visible line and continues well beyond the bottom of the box.", 760.0, 420.0, 280.0, 20.0, 400.0, "#111111");
    b.fixed("Widow", 50.0);
    b.text(
        "", "Empty", "   ", 80.0, 700.0, 300.0, 24.0, 400.0, "#111111",
    );
    b.text(
        "",
        "First overlap",
        "Overlapping words",
        600.0,
        700.0,
        300.0,
        32.0,
        400.0,
        "#111111",
    );
    b.text(
        "",
        "Second overlap",
        "Collide here",
        640.0,
        710.0,
        300.0,
        32.0,
        400.0,
        "#111111",
    );
    b.text(
        "",
        "Hidden text",
        "Covered by a sticker",
        80.0,
        820.0,
        400.0,
        32.0,
        400.0,
        "#111111",
    );
    b.ellipse("", "Sticker", 60.0, 790.0, 220.0, 100.0, "#ff5a5f");
    fixture(
        "Tiny text, overflow, maxLines truncation, clipping, an orphan, a widow, empty text, overlapping and covered text.",
        b.finish(),
        Expect {
            issues: vec![
                ExpectIssue {
                    fix: true,
                    ..issue("tiny-text", "tiny-text", &["Legal"])
                },
                ExpectIssue {
                    fix: true,
                    ..issue("text-overflow", "text-overflow", &["Overflowing"])
                },
                issue("text-truncated", "text-overflow", &["Truncated"]),
                issue("text-clipped", "text-overflow", &["Clipped", "Clip card"]),
                issue("orphan-line", "orphan-line", &["Orphan"]),
                issue("widow-line", "orphan-line", &["Widow"]),
                ExpectIssue {
                    fix: true,
                    ..issue("empty-text", "unlabeled-group", &["Empty"])
                },
                issue("overlap", "overlap", &["First overlap", "Second overlap"]),
                issue("text-covered", "overlap", &["Hidden text", "Sticker"]),
            ],
            flags: BTreeMap::from([
                ("First overlap".to_string(), rules(&["overlaps"])),
                ("Legal".to_string(), rules(&["tiny-text"])),
            ]),
            ..Default::default()
        },
    )
}

/// Placement: off-page, cut by the page edge, safe area, near-miss alignment, off-center, uneven list spacing.
fn layout() -> Fixture {
    let mut b = B::new(DesignKind::Story, 1080.0, 1920.0);
    b.rect("", "Lost shape", 1200.0, 300.0, 100.0, 100.0, "#ff0000");
    b.text(
        "",
        "Cut headline",
        "Big sale",
        900.0,
        600.0,
        400.0,
        64.0,
        700.0,
        "#111111",
    );
    b.text(
        "",
        "Top note",
        "New arrivals",
        120.0,
        120.0,
        400.0,
        40.0,
        600.0,
        "#111111",
    );
    b.text(
        "",
        "Left a",
        "Aligned left edge",
        120.0,
        900.0,
        500.0,
        32.0,
        400.0,
        "#111111",
    );
    b.text(
        "",
        "Left b",
        "Almost aligned left edge",
        124.0,
        960.0,
        500.0,
        32.0,
        400.0,
        "#111111",
    );
    b.text(
        "",
        "Centered",
        "Centered title",
        245.0,
        760.0,
        600.0,
        48.0,
        700.0,
        "#111111",
    );
    b.align("Centered", TextAlign::Center);
    for (k, y) in [1200.0, 1260.0, 1320.0, 1387.0].iter().enumerate() {
        let name = format!("Item {k}");
        b.text(
            "",
            &name,
            &format!("List entry number {k}"),
            120.0,
            *y,
            600.0,
            32.0,
            400.0,
            "#111111",
        );
    }
    fixture(
        "A story with an off-page shape, a headline past the edge, text in the top safe area, near-miss edges, an almost centered title and a list with one uneven gap.",
        b.finish(),
        Expect {
            issues: vec![
                ExpectIssue {
                    severity: Some("error".into()),
                    fix: true,
                    ..issue("off-page", "off-page", &["Lost shape"])
                },
                ExpectIssue {
                    fix: true,
                    ..issue("cut-by-page", "off-page", &["Cut headline"])
                },
                ExpectIssue {
                    fix: true,
                    ..issue("unsafe-margin", "unsafe-margin", &["Top note"])
                },
                ExpectIssue {
                    fix: true,
                    ..issue("misaligned", "misaligned", &["Left a", "Left b"])
                },
                ExpectIssue {
                    fix: true,
                    ..issue("off-center", "misaligned", &["Centered"])
                },
                ExpectIssue {
                    fix: true,
                    ..issue("uneven-spacing", "uneven-spacing", &["Item 0", "Item 3"])
                },
            ],
            groups: vec![group("list", &["Item 0", "Item 1", "Item 2", "Item 3"])],
            ..Default::default()
        },
    )
}

/// Print: missing bleed, a low-resolution photo and text below the print minimum.
fn print() -> Fixture {
    let mut b = B::new(DesignKind::Flyer, 559.37, 793.7).print(Unit::Mm, 11.34);
    b.asset("flyerphoto", AssetKind::Image, 300.0, 200.0);
    b.image("", "Cover photo", "flyerphoto", 0.0, 0.0, 559.37, 360.0);
    b.alt("Cover photo", "Mountain lake");
    b.text(
        "",
        "Title",
        "Lake retreat",
        40.0,
        400.0,
        480.0,
        40.0,
        700.0,
        "#111111",
    );
    b.text(
        "",
        "Fine print",
        "Prices include tax.",
        40.0,
        740.0,
        300.0,
        7.0,
        400.0,
        "#333333",
    );
    fixture(
        "An A5 flyer whose cover photo stops at the trim, is far below 300 dpi, and fine print below 7 pt.",
        b.finish(),
        Expect {
            issues: vec![
                ExpectIssue {
                    fix: true,
                    ..issue("missing-bleed", "unsafe-margin", &["Cover photo"])
                },
                ExpectIssue {
                    severity: Some("error".into()),
                    ..issue("image-low-res", "image-low-res", &["Cover photo"])
                },
                issue("tiny-text", "tiny-text", &["Fine print"]),
            ],
            ..Default::default()
        },
    )
}

/// Typography: five families, eight sizes, then a weak hierarchy on a second design.
fn typography() -> Fixture {
    let mut b = B::new(DesignKind::Poster, 1080.0, 1350.0);
    let fams = [
        "Inter",
        "Instrument Serif",
        "Instrument Sans",
        "JetBrains Mono",
        "Playfair Display",
    ];
    let sizes = [96.0, 72.0, 60.0, 48.0, 40.0, 32.0, 28.0, 24.0];
    for (k, size) in sizes.iter().enumerate() {
        let name = format!("Line {k}");
        b.text(
            "",
            &name,
            &format!("Sample line {k}"),
            80.0,
            80.0 + k as f64 * 140.0,
            900.0,
            *size,
            400.0,
            "#111111",
        );
        b.family(&name, fams[k % fams.len()]);
    }
    fixture(
        "Eight text sizes in five font families.",
        b.finish(),
        Expect {
            issues: vec![
                issue("too-many-fonts", "too-many-fonts", &["Line 0"]),
                issue("too-many-sizes", "too-many-fonts", &["Line 7"]),
            ],
            ..Default::default()
        },
    )
}

fn weak_hierarchy() -> Fixture {
    let mut b = B::new(DesignKind::SocialPost, 1080.0, 1080.0);
    b.text(
        "",
        "Headline",
        "Weekend workshop",
        80.0,
        120.0,
        900.0,
        40.0,
        600.0,
        "#111111",
    );
    b.text(
        "",
        "Body",
        "Join us for two days of hands-on printmaking with local artists and plenty of coffee.",
        80.0,
        200.0,
        900.0,
        34.0,
        400.0,
        "#333333",
    );
    fixture(
        "A headline barely larger than the body copy.",
        b.finish(),
        Expect {
            issues: vec![issue(
                "weak-hierarchy",
                "weak-hierarchy",
                &["Headline", "Body"],
            )],
            ..Default::default()
        },
    )
}

/// Ten distinct colors.
fn colors() -> Fixture {
    let mut b = B::new(DesignKind::Infographic, 1080.0, 1080.0);
    let palette = [
        "#e63946", "#f1a208", "#2a9d8f", "#264653", "#8338ec", "#3a86ff", "#ff006e", "#06d6a0",
        "#8d99ae", "#6b4226",
    ];
    for (k, c) in palette.iter().enumerate() {
        let name = format!("Swatch {k}");
        b.rect(
            "",
            &name,
            80.0 + (k % 5) as f64 * 190.0,
            200.0 + (k / 5) as f64 * 300.0,
            160.0,
            160.0,
            c,
        );
    }
    fixture(
        "Ten unrelated colors.",
        b.finish(),
        Expect {
            issues: vec![issue("too-many-colors", "too-many-colors", &[])],
            ..Default::default()
        },
    )
}

/// Brand kit: an off-palette color and an off-brand font, both with fixes.
fn brand() -> Fixture {
    let mut b = B::new(DesignKind::SocialPost, 1080.0, 1080.0);
    b.rect("", "Promo band", 0.0, 760.0, 1080.0, 200.0, "#ff0066");
    b.text(
        "",
        "Promo title",
        "Brand day",
        80.0,
        120.0,
        800.0,
        96.0,
        700.0,
        "#111111",
    );
    b.family("Promo title", "Playfair Display");
    b.text(
        "",
        "Promo body",
        "All products twenty percent off today only.",
        80.0,
        300.0,
        800.0,
        32.0,
        400.0,
        "#111111",
    );
    let mut f = fixture(
        "Brand kit check: a pink band outside the palette and a headline in a non-brand font.",
        b.finish(),
        Expect {
            issues: vec![
                ExpectIssue {
                    fix: true,
                    ..issue("off-brand-color", "too-many-colors", &["Promo band"])
                },
                ExpectIssue {
                    fix: true,
                    ..issue("off-brand-font", "too-many-fonts", &["Promo title"])
                },
            ],
            absent: rules(&["too-many-fonts"]),
            ..Default::default()
        },
    );
    f.options = json!({
        "brand": {
            "name": "Desyn",
            "colors": [{ "value": "#ffb02e", "name": "Sun", "role": "primary" }, { "value": "#111111", "role": "text" }],
            "fonts": [{ "family": "Instrument Serif", "role": "heading" }, { "family": "Inter", "role": "body" }]
        }
    });
    f
}

/// Structure: unnamed groups, default-named key elements, empty frames, missing alt text, upscaled images.
fn structure() -> Fixture {
    let mut b = B::new(DesignKind::SocialPost, 1080.0, 1080.0);
    b.asset("smallphoto", AssetKind::Image, 200.0, 200.0);
    b.image("", "Image", "smallphoto", 80.0, 80.0, 600.0, 600.0);
    b.group("", "Group 3", 720.0, 80.0, 300.0, 120.0);
    b.text(
        "Group 3",
        "Price tag",
        "Only today",
        0.0,
        0.0,
        300.0,
        40.0,
        700.0,
        "#111111",
    );
    b.text(
        "Group 3",
        "Price note",
        "while stocks last",
        0.0,
        60.0,
        300.0,
        24.0,
        400.0,
        "#333333",
    );
    b.frame("", "Frame 7", 720.0, 400.0, 200.0, 200.0, "");
    b.text(
        "",
        "Body copy",
        "Fresh flowers delivered to your door every week.",
        80.0,
        760.0,
        900.0,
        40.0,
        400.0,
        "#111111",
    );
    fixture(
        "A default-named, upscaled photo without alt text, an unnamed group and an empty frame.",
        b.finish(),
        Expect {
            issues: vec![
                issue("missing-alt", "missing-alt", &["Image"]),
                ExpectIssue {
                    severity: Some("error".into()),
                    ..issue("image-low-res", "image-low-res", &["Image"])
                },
                issue("unlabeled-group", "unlabeled-group", &["Group 3"]),
                issue("unnamed-important", "unlabeled-group", &["Image"]),
                ExpectIssue {
                    fix: true,
                    ..issue("empty-frame", "unlabeled-group", &["Frame 7"])
                },
            ],
            ..Default::default()
        },
    )
}

fn product_card(b: &mut B, k: usize, x: f64, y: f64) {
    let n = |s: &str| format!("{s}{k}");
    b.rect("", &n("card"), x, y, 300.0, 440.0, "#f6f3ee");
    b.image(
        "",
        &n("photo"),
        "productshot",
        x + 16.0,
        y + 16.0,
        268.0,
        220.0,
    );
    b.alt(&n("photo"), "Ceramic mug");
    b.text(
        "",
        &n("title"),
        "Ceramic mug",
        x + 16.0,
        y + 252.0,
        268.0,
        24.0,
        600.0,
        "#111111",
    );
    b.text(
        "",
        &n("price"),
        "$24",
        x + 16.0,
        y + 292.0,
        268.0,
        22.0,
        400.0,
        "#333333",
    );
    b.rect("", &n("btnbg"), x + 16.0, y + 360.0, 140.0, 48.0, "#111111");
    b.text(
        "",
        &n("btnlabel"),
        "Add to cart",
        x + 26.0,
        y + 360.0,
        120.0,
        18.0,
        600.0,
        "#ffffff",
    );
    b.align(&n("btnlabel"), TextAlign::Center)
        .fixed(&n("btnlabel"), 48.0);
    b.text_mut(&n("btnlabel")).vertical_align = desyn_core::VerticalAlign::Middle;
}

/// Semantic grouping on a shop page: a header container with a logo lockup and a nav bar, a 3 x 2 grid of loose
/// product cards (each with a CTA button made of a rectangle and a label) and a footer.
fn shop_page() -> Fixture {
    let mut b = B::new(DesignKind::Website, 1200.0, 1500.0);
    b.asset("logoasset", AssetKind::Svg, 40.0, 40.0);
    b.asset("productshot", AssetKind::Image, 800.0, 660.0);
    b.frame("", "Header", 0.0, 0.0, 1200.0, 96.0, "#ffffff");
    b.svg("Header", "Logo mark", "logoasset", 48.0, 28.0, 40.0, 40.0);
    b.role("Logo mark", "logo").alt("Logo mark", "Shop logo");
    b.text(
        "Header",
        "Shop name",
        "Kiln",
        100.0,
        32.0,
        120.0,
        28.0,
        700.0,
        "#111111",
    );
    for (k, label) in ["Shop", "About", "Journal", "Contact"].iter().enumerate() {
        b.text(
            "Header",
            &format!("Nav {k}"),
            label,
            700.0 + k as f64 * 110.0,
            38.0,
            90.0,
            18.0,
            500.0,
            "#111111",
        );
    }
    for k in 0..6 {
        product_card(
            &mut b,
            k,
            120.0 + (k % 3) as f64 * 340.0,
            160.0 + (k / 3) as f64 * 480.0,
        );
    }
    b.frame("", "Footer", 0.0, 1380.0, 1200.0, 120.0, "#111111");
    b.text(
        "Footer",
        "Footer note",
        "© 2026 Kiln ceramics",
        48.0,
        50.0,
        400.0,
        14.0,
        400.0,
        "#cccccc",
    );
    b.text(
        "Footer",
        "Footer link",
        "Privacy",
        1060.0,
        50.0,
        100.0,
        14.0,
        400.0,
        "#cccccc",
    );
    fixture(
        "Header with logo lockup and nav, a grid of six loose product cards with CTA buttons, a footer.",
        b.finish(),
        Expect {
            groups: vec![
                ExpectGroup {
                    kind: "header".into(),
                    node: Some("Header".into()),
                    ..Default::default()
                },
                group("logo-lockup", &["Logo mark", "Shop name"]),
                group("nav-bar", &["Nav 0", "Nav 1", "Nav 2", "Nav 3"]),
                ExpectGroup {
                    count: Some(6),
                    ..group("product-card", &[])
                },
                group(
                    "product-card",
                    &["card0", "photo0", "title0", "price0", "btnbg0", "btnlabel0"],
                ),
                ExpectGroup {
                    count: Some(6),
                    ..group("button", &[])
                },
                group("button", &["btnbg3", "btnlabel3"]),
                group("grid", &["card0", "card5"]),
                ExpectGroup {
                    kind: "footer".into(),
                    node: Some("Footer".into()),
                    ..Default::default()
                },
            ],
            semantic: BTreeMap::from([
                ("Header".to_string(), "header".to_string()),
                ("Footer".to_string(), "footer".to_string()),
            ]),
            absent: rules(&[
                "uneven-spacing",
                "misaligned",
                "low-contrast",
                "overlap",
                "text-covered",
            ]),
            ..Default::default()
        },
    )
}

/// Semantic grouping: stat, quote, image with caption, text block, labelled icon, card, vertical list.
fn patterns() -> Fixture {
    let mut b = B::new(DesignKind::Infographic, 1200.0, 1600.0);
    b.text(
        "",
        "Stat value",
        "98%",
        80.0,
        80.0,
        300.0,
        96.0,
        800.0,
        "#111111",
    );
    b.text(
        "",
        "Stat label",
        "of readers finish the page",
        80.0,
        200.0,
        300.0,
        22.0,
        400.0,
        "#444444",
    );
    b.text(
        "",
        "Quote text",
        "“The best tool we have used this year.”",
        600.0,
        80.0,
        520.0,
        36.0,
        400.0,
        "#111111",
    );
    b.text(
        "",
        "Quote author",
        "Ada, studio lead",
        600.0,
        190.0,
        400.0,
        20.0,
        600.0,
        "#444444",
    );
    b.asset("lakephoto", AssetKind::Image, 1200.0, 800.0);
    b.image("", "Lake photo", "lakephoto", 80.0, 400.0, 480.0, 320.0);
    b.alt("Lake photo", "Lake at dawn");
    b.text(
        "",
        "Lake caption",
        "Lake Bled at dawn",
        80.0,
        732.0,
        480.0,
        16.0,
        400.0,
        "#666666",
    );
    b.text(
        "",
        "Block title",
        "Why it matters",
        640.0,
        400.0,
        480.0,
        48.0,
        700.0,
        "#111111",
    );
    b.text(
        "",
        "Block body",
        "Good layouts guide the eye from the headline to the action without friction.",
        640.0,
        470.0,
        480.0,
        22.0,
        400.0,
        "#333333",
    );
    b.asset("staricon", AssetKind::Svg, 24.0, 24.0);
    b.svg("", "Star icon", "staricon", 640.0, 700.0, 28.0, 28.0);
    b.role("Star icon", "icon");
    b.text(
        "",
        "Star label",
        "Top rated",
        680.0,
        702.0,
        200.0,
        20.0,
        600.0,
        "#111111",
    );
    b.rect("", "Info card", 80.0, 860.0, 480.0, 260.0, "#eef2f7");
    b.svg("", "Card art", "staricon", 104.0, 884.0, 64.0, 64.0);
    b.alt("Card art", "Star");
    b.text(
        "",
        "Card title",
        "Free shipping",
        104.0,
        968.0,
        420.0,
        28.0,
        700.0,
        "#111111",
    );
    b.text(
        "",
        "Card text",
        "On every order over fifty euros, worldwide.",
        104.0,
        1010.0,
        420.0,
        20.0,
        400.0,
        "#333333",
    );
    for k in 0..4 {
        b.text(
            "",
            &format!("Step {k}"),
            &format!("Step {} of the process", k + 1),
            640.0,
            860.0 + k as f64 * 64.0,
            480.0,
            24.0,
            400.0,
            "#111111",
        );
    }
    fixture(
        "Stat, quote, image with caption, text block, labelled icon, card on a backing shape and a vertical list.",
        b.finish(),
        Expect {
            groups: vec![
                group("stat", &["Stat value", "Stat label"]),
                group("quote", &["Quote text", "Quote author"]),
                group("image-with-caption", &["Lake photo", "Lake caption"]),
                group("text-block", &["Block title", "Block body"]),
                group("labelled-icon", &["Star icon", "Star label"]),
                group("card", &["Info card", "Card title", "Card text"]),
                group("list", &["Step 0", "Step 1", "Step 2", "Step 3"]),
            ],
            absent: rules(&["uneven-spacing"]),
            ..Default::default()
        },
    )
}

/// Right-to-left page: two columns read right column first.
fn rtl() -> Fixture {
    let mut b = B::new(DesignKind::Poster, 1080.0, 1350.0);
    b.design_meta("locale", "ar");
    b.text(
        "",
        "Title",
        "عرض الصيف",
        80.0,
        100.0,
        920.0,
        72.0,
        700.0,
        "#111111",
    );
    b.text(
        "",
        "Right column",
        "النص في العمود الأيمن يقرأ أولا",
        560.0,
        300.0,
        440.0,
        28.0,
        400.0,
        "#111111",
    );
    b.text(
        "",
        "Left column",
        "ثم ينتقل القارئ إلى العمود الأيسر",
        80.0,
        300.0,
        440.0,
        28.0,
        400.0,
        "#111111",
    );
    for n in ["Title", "Right column", "Left column"] {
        b.text_mut(n).paragraph.direction = TextDirection::Rtl;
        b.align(n, TextAlign::Right);
    }
    fixture(
        "Arabic two-column page: direction rtl, the right column reads before the left one.",
        b.finish(),
        Expect {
            direction: Some("rtl".into()),
            reading_order: Some(rules(&["Title", "Right column", "Left column"])),
            ..Default::default()
        },
    )
}

/// Explicit roles win over inference; colors come through `$style` / `$var` references.
fn roles_and_refs() -> Fixture {
    let mut b = B::new(DesignKind::SocialPost, 1080.0, 1080.0);
    b.d.styles.colors.insert(
        "stylesun0001".into(),
        serde_json::from_value(json!({ "name": "Sun", "value": "#ffb02e" })).unwrap(),
    );
    b.d.styles.variables.insert(
        "brand.ink".into(),
        serde_json::from_value(json!("#1b1b1b")).unwrap(),
    );
    b.frame("", "Offer", 80.0, 80.0, 920.0, 300.0, "");
    if let Some(s) = b.node("Offer").shaped_mut() {
        s.fills = vec![
            serde_json::from_value(
                json!({ "type": "solid", "color": { "$style": "stylesun0001" } }),
            )
            .unwrap(),
        ];
    }
    b.role("Offer", "product-card");
    b.text(
        "Offer",
        "Offer title",
        "Two for one",
        40.0,
        40.0,
        600.0,
        64.0,
        700.0,
        "#000000",
    );
    b.text_mut("Offer title").style.fills = vec![
        serde_json::from_value(json!({ "type": "solid", "color": { "$var": "brand.ink" } }))
            .unwrap(),
    ];
    b.text(
        "Offer",
        "Offer body",
        "This weekend at every store.",
        40.0,
        140.0,
        600.0,
        32.0,
        400.0,
        "#1b1b1b",
    );
    b.group("", "Story", 80.0, 500.0, 600.0, 200.0);
    b.role("Story", "section");
    b.text(
        "Story",
        "Story title",
        "Our story",
        0.0,
        0.0,
        600.0,
        48.0,
        700.0,
        "#111111",
    );
    b.text(
        "Story",
        "Story body",
        "Founded in a small workshop in 1998.",
        0.0,
        70.0,
        600.0,
        28.0,
        400.0,
        "#333333",
    );
    fixture(
        "A frame with an explicit product-card role (wins over the text-only inference), a section group, and colors set through a color style and a variable.",
        b.finish(),
        Expect {
            groups: vec![
                ExpectGroup {
                    kind: "product-card".into(),
                    node: Some("Offer".into()),
                    ..Default::default()
                },
                ExpectGroup {
                    kind: "role".into(),
                    node: Some("Story".into()),
                    ..Default::default()
                },
            ],
            semantic: BTreeMap::from([
                ("Offer".to_string(), "product card".to_string()),
                ("Story".to_string(), "section".to_string()),
            ]),
            only_rules: Some(vec![]),
            ..Default::default()
        },
    )
}

fn cases() -> Vec<(&'static str, Fixture)> {
    vec![
        ("clean-poster", clean_poster()),
        ("contrast", contrast()),
        ("text-fit", text_fit()),
        ("layout", layout()),
        ("print", print()),
        ("typography", typography()),
        ("weak-hierarchy", weak_hierarchy()),
        ("colors", colors()),
        ("brand", brand()),
        ("structure", structure()),
        ("shop-page", shop_page()),
        ("patterns", patterns()),
        ("rtl", rtl()),
        ("roles-and-refs", roles_and_refs()),
    ]
}

fn pretty(f: &Fixture) -> String {
    // Sorted keys, so the files are identical whether or not another crate in the build enables serde_json's
    // `preserve_order` (the desktop app does, in `cargo test --workspace`).
    let v = sorted_keys(serde_json::to_value(f).expect("fixture json"));
    let mut s = serde_json::to_string_pretty(&v).expect("pretty");
    s.push('\n');
    s
}

#[test]
fn fixtures_are_current() {
    let dir = fixtures_dir();
    let update = std::env::var("DESYN_UPDATE_FIXTURES").is_ok_and(|v| v == "1");
    let mut stale = Vec::new();
    for (name, f) in cases() {
        let path = dir.join(format!("{name}.json"));
        let want = pretty(&f);
        let have = std::fs::read_to_string(&path).unwrap_or_default();
        if have != want {
            if update {
                std::fs::write(&path, want).expect("write fixture");
            } else {
                stale.push(name);
            }
        }
    }
    assert!(
        stale.is_empty(),
        "stale fixtures {stale:?}: run DESYN_UPDATE_FIXTURES=1 cargo test --test fixtures"
    );
}

#[test]
fn fixtures_pass() {
    let mut fails = Vec::new();
    let mut seen = 0;
    let mut entries: Vec<_> = std::fs::read_dir(fixtures_dir())
        .expect("fixtures dir")
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let f: Fixture = serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let desc = run_fixture(&f);
        fails.extend(check(&name, &desc, &f.expect));
        seen += 1;
    }
    assert!(seen > 0, "no fixtures found");
    assert!(fails.is_empty(), "{}", fails.join("\n\n"));
}

#[test]
fn every_rule_and_group_kind_has_a_fixture() {
    let mut rules_seen = std::collections::BTreeSet::new();
    let mut kinds_seen = std::collections::BTreeSet::new();
    for (_, f) in cases() {
        rules_seen.extend(f.expect.issues.iter().map(|i| i.rule.clone()));
        kinds_seen.extend(f.expect.groups.iter().map(|g| g.kind.clone()));
    }
    for (rule, code, _) in desyn_describe::lint::RULES {
        assert!(
            rules_seen.contains(*rule),
            "no fixture expects rule {rule} ({})",
            code.as_str()
        );
    }
    for kind in [
        "product-card",
        "card",
        "button",
        "logo-lockup",
        "image-with-caption",
        "header",
        "footer",
        "nav-bar",
        "list",
        "grid",
        "stat",
        "quote",
        "text-block",
        "labelled-icon",
        "role",
    ] {
        assert!(
            kinds_seen.contains(kind),
            "no fixture expects group kind {kind}"
        );
    }
}

fn sorted_keys(v: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
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
