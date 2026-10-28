//! Glyph outlines, text-to-outlines, color glyph layers, synthetic styles and text on paths.

mod common;

use common::*;
use desyn_core::paths::bez_bounds;
use desyn_core::paths::kurbo::{BezPath, Circle, Point, Shape};
use desyn_text::{
    BitmapImage, ColorPaint, GlyphKind, PathAlign, PathTextOptions, TextEngine, TextPathKind,
    place_on_curve, place_on_path, placements_bounds,
};

#[test]
fn glyph_paths_have_font_geometry() {
    let mut e = engine();
    let l = lay(&mut e, &plain("H", "JetBrains Mono", 100.0), None);
    let run = &l.runs[0];
    let p = e.glyph_path(run.instance, run.glyphs[0].id, 100.0).unwrap();
    let b = bez_bounds(&p).unwrap();
    // Cap height 730 / 1000 -> the H rises ~73 px above the origin (y down = negative).
    assert!((b.y + 73.0).abs() < 1.5, "top {}", b.y);
    assert!(b.y + b.h <= 0.5 && b.y + b.h > -1.0, "sits on the baseline");
    assert!(b.x >= 0.0 && b.x + b.w <= 60.0);
    assert_eq!(
        e.glyph_kind(run.instance, run.glyphs[0].id),
        GlyphKind::Outline
    );
    // Cached.
    let before = e.cache_stats().outline_entries;
    e.glyph_path(run.instance, run.glyphs[0].id, 50.0).unwrap();
    assert_eq!(e.cache_stats().outline_entries, before);
}

#[test]
fn text_to_outlines_matches_layout() {
    let mut e = engine();
    let mut c = plain("Desyn type", "Instrument Serif", 48.0);
    c.spans[0].style.underline = true;
    c.spans[0].style.highlight = Some([255, 176, 46, 255]);
    let l = lay(&mut e, &c, None);
    let paths = e.text_paths(&l);
    assert_eq!(
        paths[0].kind,
        TextPathKind::Highlight,
        "highlights paint first"
    );
    assert_eq!(paths.last().unwrap().kind, TextPathKind::Underline);
    let glyphs = paths
        .iter()
        .filter(|p| p.kind == TextPathKind::Glyph)
        .count();
    assert_eq!(glyphs, 9, "the space has no outline");
    let outline = e.text_outline(&l);
    let b = bez_bounds(&outline).unwrap();
    assert!(b.x >= -1.0 && b.x + b.w <= l.content_width + 1.0);
    assert!(b.y >= l.lines[0].top - 1.0 && b.y + b.h <= l.lines[0].top + l.lines[0].height + 1.0);
    let svg = e.text_outline_vector(&l).to_svg();
    assert!(svg.starts_with('M') && svg.len() > 200);
}

#[test]
fn synthetic_bold_and_oblique() {
    let mut e = engine();
    let mut c = plain("I", "Instrument Serif", 100.0);
    let upright = lay(&mut e, &c, None);
    c.spans[0].style.weight = 700.0;
    let bold = lay(&mut e, &c, None);
    assert!(bold.runs[0].synthetic_bold > 0.0);
    let thin = bez_bounds(&e.text_outline(&upright)).unwrap();
    let thick = bez_bounds(&e.text_outline(&bold)).unwrap();
    assert!(
        thick.w > thin.w + bold.runs[0].synthetic_bold * 0.9,
        "emboldened outline is wider"
    );
    // JetBrains Mono has an italic file in fonts/ but the test engine registers only the upright: synthesize.
    let mut c = plain("I", "JetBrains Mono", 100.0);
    c.spans[0].style.italic = true;
    let l = lay(&mut e, &c, None);
    assert!(l.runs[0].skew > 0.0);
    let p = e.text_paths(&l);
    let b = bez_bounds(&p[0].path).unwrap();
    let straight = lay(&mut e, &plain("I", "JetBrains Mono", 100.0), None);
    let sb = bez_bounds(&e.text_paths(&straight)[0].path).unwrap();
    assert!(
        b.w > sb.w + 5.0,
        "slanted stem is wider: {} vs {}",
        b.w,
        sb.w
    );
}

#[test]
fn color_emoji_layers() {
    let mut e = engine();
    let l = lay(&mut e, &plain("😀", "Inter", 64.0), None);
    let run = &l.runs[0];
    let g = run.glyphs[0].id;
    assert_eq!(e.glyph_kind(run.instance, g), GlyphKind::Color);
    let layers = e
        .color_glyph(run.instance, g, 64.0, [0, 0, 0, 255])
        .unwrap();
    assert!(layers.len() > 3, "{} layers", layers.len());
    assert!(
        layers
            .iter()
            .any(|l| !matches!(l.paint, ColorPaint::Solid { .. })),
        "COLRv1 gradients"
    );
    let mut bounds = None::<desyn_core::geometry::Rect>;
    for layer in &layers {
        if let Some(b) = bez_bounds(&layer.path) {
            bounds = Some(bounds.map_or(b, |a| a.union(&b)));
        }
    }
    let b = bounds.unwrap();
    assert!(b.w > 40.0 && b.w < 90.0 && b.y < -30.0, "{b:?}");
    assert!(
        e.bitmap_glyph(run.instance, g, 64.0).is_none(),
        "COLR font has no bitmaps"
    );
    // Text-to-outlines keeps color glyphs as silhouettes.
    let paths = e.text_paths(&l);
    assert_eq!(paths.len(), 1);
    assert!(paths[0].color_glyph && paths[0].glyph_index == Some(0));
    let sb = bez_bounds(&paths[0].path).unwrap();
    assert!((sb.w - b.w).abs() < 1e-6);
    assert!(!e.text_outline(&l).elements().is_empty());
    // Outline fonts have no color layers.
    let l = lay(&mut e, &plain("A", "Inter", 20.0), None);
    assert!(
        e.color_glyph(l.runs[0].instance, l.runs[0].glyphs[0].id, 20.0, [0; 4])
            .is_none()
    );
}

#[test]
fn text_on_a_straight_path_matches_layout() {
    let mut e = engine();
    let l = lay(&mut e, &plain("HHH", "JetBrains Mono", 10.0), None);
    let mut path = BezPath::new();
    path.move_to((0.0, 100.0));
    path.line_to((500.0, 100.0));
    let placed = place_on_path(&l, &path, &PathTextOptions::default());
    assert_eq!(placed.len(), 3);
    for (i, p) in placed.iter().enumerate() {
        let o = p.transform.to_kurbo() * Point::ORIGIN;
        assert!(
            (o.x - 6.0 * i as f64).abs() < 1e-6 && (o.y - 100.0).abs() < 1e-6,
            "{o:?}"
        );
        assert!(p.visible);
    }
    let centered = place_on_path(
        &l,
        &path,
        &PathTextOptions {
            align: PathAlign::Center,
            ..Default::default()
        },
    );
    let o = centered[0].transform.to_kurbo() * Point::ORIGIN;
    assert!((o.x - (250.0 - 9.0)).abs() < 1e-6);
    // Glyphs past the end of an open path are flagged.
    let far = place_on_path(
        &l,
        &path,
        &PathTextOptions {
            offset: 495.0,
            ..Default::default()
        },
    );
    assert!(far[0].visible && !far[2].visible);
}

#[test]
fn text_on_a_circle_and_on_an_arc() {
    let mut e = engine();
    let l = lay(&mut e, &plain("AROUND THE SUN", "Inter", 20.0), None);
    let circle = Circle::new((200.0, 200.0), 100.0).to_path(0.01);
    let placed = place_on_path(&l, &circle, &PathTextOptions::default());
    for p in &placed {
        let center =
            p.transform.to_kurbo() * Point::new(l.runs[p.run].glyphs[p.glyph].advance / 2.0, 0.0);
        let r = center.distance(Point::new(200.0, 200.0));
        assert!(
            (r - 100.0).abs() < 0.5,
            "glyph baseline center on the circle: {r}"
        );
    }
    // Rainbow arc: the middle glyph is highest, the ends lean outwards.
    let curved = place_on_curve(&l, 120.0);
    let ys: Vec<f64> = curved
        .iter()
        .map(|p| (p.transform.to_kurbo() * Point::ORIGIN).y)
        .collect();
    let mid = ys.len() / 2;
    assert!(ys[mid] < ys[0] && ys[mid] < ys[ys.len() - 1]);
    let smile = place_on_curve(&l, -120.0);
    let ys: Vec<f64> = smile
        .iter()
        .map(|p| (p.transform.to_kurbo() * Point::ORIGIN).y)
        .collect();
    assert!(ys[mid] > ys[0]);
    // Straight curve keeps the layout.
    let flat = place_on_curve(&l, 0.0);
    let o = flat[1].transform.to_kurbo() * Point::ORIGIN;
    assert!((o.x - l.runs[0].glyphs[1].x).abs() < 1e-9);
    let b = placements_bounds(&l, &curved).unwrap();
    assert!(b.h > l.lines[0].height);
}

#[test]
fn cbdt_bitmap_emoji() {
    // Bitmap-only color font (CBDT / CBLC, no outlines): the Noto Color Emoji build most Linux systems ship.
    let mut e = TextEngine::new();
    e.db_mut().add_static_font(INTER).unwrap();
    e.db_mut()
        .add_static_font(include_bytes!("fonts/NotoColorEmoji-CBDT-subset.ttf"))
        .unwrap();
    let l = lay(&mut e, &plain("A😀", "Inter", 64.0), None);
    let ri = l
        .runs
        .iter()
        .position(|r| r.range.start == 1)
        .expect("emoji run");
    let run = &l.runs[ri];
    let g = run.glyphs[0];
    assert_eq!(e.glyph_kind(run.instance, g.id), GlyphKind::Bitmap);
    assert!(e.color_glyph(run.instance, g.id, 64.0, [0; 4]).is_none());
    assert!(
        e.glyph_path(run.instance, g.id, 64.0)
            .is_none_or(|p| p.elements().is_empty())
    );
    let img = e.bitmap_glyph(run.instance, g.id, 64.0).expect("bitmap");
    let BitmapImage::Png(png) = &img.image else {
        panic!("Noto Color Emoji strikes are PNG");
    };
    assert_eq!(&png[1..4], b"PNG");
    let r = img.rect;
    // The image is about one em wide, sits on the baseline area and ends near the advance.
    assert!(r.w > 64.0 * 0.95 && r.w < 64.0 * 1.4, "{r:?}");
    assert!(r.y < -40.0 && r.y + r.h > 0.0 && r.y + r.h < 25.0, "{r:?}");
    assert!(
        r.x > -2.0 && r.x + r.w <= g.advance + 4.0,
        "{r:?} advance {}",
        g.advance
    );
    // text_paths reports the image rectangle (flagged) at the glyph position; text-to-outlines skips it.
    let paths = e.text_paths(&l);
    let emoji = paths
        .iter()
        .find(|p| p.run == Some(ri))
        .expect("emoji path");
    assert!(emoji.color_glyph);
    let b = bez_bounds(&emoji.path).unwrap();
    assert!((b.x - (g.x + r.x)).abs() < 1e-6 && (b.y - (g.y + r.y)).abs() < 1e-6);
    assert!((b.w - r.w).abs() < 1e-6 && (b.h - r.h).abs() < 1e-6);
    let outline = bez_bounds(&e.text_outline(&l)).unwrap();
    assert!(
        outline.x + outline.w < g.x + 1.0,
        "only the A is converted: {outline:?}"
    );
    // Smaller sizes scale the same strike.
    let small = e.bitmap_glyph(run.instance, g.id, 16.0).unwrap();
    assert!((small.rect.w * 4.0 - r.w).abs() < 1e-6);
}
