//! Renders a text specimen (mixed scripts, lists, justification, decorations, color emoji, curved text) to SVG
//! using only the engine's outlines: `cargo run --example specimen -- /tmp/specimen.svg`.

use std::fmt::Write as _;

use desyn_core::geometry::Affine as CoreAffine;
use desyn_core::model::{ListStyle, TextAlign};
use desyn_core::paths::bez_to_svg;
use desyn_core::paths::kurbo::{Affine, BezPath};
use desyn_text::content::{ParagraphFormat, Span, SpanStyle, TextContent};
use desyn_text::{
    ColorPaint, GlyphKind, LaidOutText, LayoutOptions, TextEngine, TextPathKind, place_on_curve,
};

const FONTS: &[&[u8]] = &[
    include_bytes!("../fonts/Inter-VF.ttf"),
    include_bytes!("../fonts/Inter-Italic-VF.ttf"),
    include_bytes!("../fonts/InstrumentSerif-Regular.ttf"),
    include_bytes!("../fonts/InstrumentSerif-Italic.ttf"),
    include_bytes!("../fonts/JetBrainsMono-VF.ttf"),
    include_bytes!("../fonts/NotoSansArabic-VF.ttf"),
    include_bytes!("../fonts/NotoSansHebrew-VF.ttf"),
    include_bytes!("../tests/fonts/NotoSansSC-subset.ttf"),
    include_bytes!("../tests/fonts/NotoColorEmoji-subset.ttf"),
];

fn rgba(c: Option<[u8; 4]>) -> String {
    let [r, g, b, a] = c.unwrap_or([17, 17, 17, 255]);
    format!("rgba({r},{g},{b},{:.3})", f64::from(a) / 255.0)
}

fn style(family: &str, size: f64, color: [u8; 4]) -> SpanStyle {
    SpanStyle {
        families: vec![family.into()],
        size,
        color: Some(color),
        ..SpanStyle::default()
    }
}

fn svg_affine(a: CoreAffine) -> String {
    let k = a.to_kurbo().as_coeffs();
    format!(
        "matrix({} {} {} {} {} {})",
        k[0], k[1], k[2], k[3], k[4], k[5]
    )
}

#[derive(Default)]
struct Svg {
    body: String,
    defs: String,
    gradients: usize,
}

/// Draws laid out text at (dx, dy); `curve` places the glyphs on an arc instead.
fn draw(
    e: &mut TextEngine,
    l: &LaidOutText,
    (dx, dy): (f64, f64),
    curve: Option<f64>,
    svg: &mut Svg,
) {
    let Svg {
        body: out,
        defs,
        gradients: gid,
    } = svg;
    let _ = writeln!(out, r#"<g transform="translate({dx} {dy})">"#);
    let placed = curve.map(|c| place_on_curve(l, c));
    for tp in e.text_paths(l) {
        if tp.kind != TextPathKind::Glyph {
            if curve.is_none() {
                let _ = writeln!(
                    out,
                    r#"<path d="{}" fill="{}"/>"#,
                    bez_to_svg(&tp.path),
                    rgba(tp.color)
                );
            }
            continue;
        }
        let (Some(ri), Some(gi), Some(glyph)) = (tp.run, tp.glyph_index, tp.glyph) else {
            continue;
        };
        let run = &l.runs[ri];
        let g = run.glyphs[gi];
        let transform = match &placed {
            Some(p) => p
                .iter()
                .find(|p| p.run == ri && p.glyph == gi)
                .map(|p| p.transform.to_kurbo() * Affine::translate((-g.x, -g.y)))
                .unwrap_or(Affine::IDENTITY),
            None => Affine::IDENTITY,
        };
        if tp.color_glyph
            && e.glyph_kind(run.instance, glyph) == GlyphKind::Color
            && let Some(layers) = e.color_glyph(run.instance, glyph, run.size, [17, 17, 17, 255])
        {
            {
                let place = transform * Affine::translate((g.x, g.y));
                for layer in layers {
                    let path: BezPath = place * layer.path.clone();
                    let fill = match &layer.paint {
                        ColorPaint::Solid { color } => rgba(Some(*color)),
                        ColorPaint::Linear { p0, p1, stops, .. } => {
                            *gid += 1;
                            let gt = CoreAffine::new(
                                (place * layer.paint_transform.to_kurbo()).as_coeffs(),
                            );
                            let _ = write!(
                                defs,
                                r#"<linearGradient id="g{gid}" gradientUnits="userSpaceOnUse" x1="{}" y1="{}" x2="{}" y2="{}" gradientTransform="{}">"#,
                                p0.0,
                                p0.1,
                                p1.0,
                                p1.1,
                                svg_affine(gt)
                            );
                            for s in stops {
                                let _ = write!(
                                    defs,
                                    r#"<stop offset="{}" stop-color="{}"/>"#,
                                    s.offset,
                                    rgba(Some(s.color))
                                );
                            }
                            defs.push_str("</linearGradient>");
                            format!("url(#g{gid})")
                        }
                        ColorPaint::Radial {
                            c0,
                            r0,
                            c1,
                            r1,
                            stops,
                            ..
                        } => {
                            *gid += 1;
                            let gt = CoreAffine::new(
                                (place * layer.paint_transform.to_kurbo()).as_coeffs(),
                            );
                            let _ = write!(
                                defs,
                                r#"<radialGradient id="g{gid}" gradientUnits="userSpaceOnUse" fx="{}" fy="{}" fr="{}" cx="{}" cy="{}" r="{}" gradientTransform="{}">"#,
                                c0.0,
                                c0.1,
                                r0,
                                c1.0,
                                c1.1,
                                r1,
                                svg_affine(gt)
                            );
                            for s in stops {
                                let _ = write!(
                                    defs,
                                    r#"<stop offset="{}" stop-color="{}"/>"#,
                                    s.offset,
                                    rgba(Some(s.color))
                                );
                            }
                            defs.push_str("</radialGradient>");
                            format!("url(#g{gid})")
                        }
                        ColorPaint::Sweep { stops, .. } => rgba(stops.first().map(|s| s.color)),
                    };
                    let _ = writeln!(out, r#"<path d="{}" fill="{fill}"/>"#, bez_to_svg(&path));
                }
                continue;
            }
        }
        let path = transform * tp.path.clone();
        let stroke = if tp.stroke > 0.0 {
            format!(
                r#" stroke="{}" stroke-width="{}" stroke-linejoin="round""#,
                rgba(tp.color),
                tp.stroke
            )
        } else {
            String::new()
        };
        let _ = writeln!(
            out,
            r#"<path d="{}" fill="{}"{stroke}/>"#,
            bez_to_svg(&path),
            rgba(tp.color)
        );
    }
    for line in &l.lines {
        let _ = writeln!(
            out,
            r##"<rect x="{}" y="{}" width="{}" height="{}" fill="none" stroke="#ffb02e" stroke-opacity="0.35" stroke-width="0.5"/>"##,
            line.x, line.top, line.width, line.height
        );
    }
    out.push_str("</g>\n");
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "specimen.svg".into());
    let mut e = TextEngine::new();
    for f in FONTS {
        e.db_mut().add_static_font(f).expect("bundled font");
    }
    let ink = [235, 230, 220, 255];
    let sun = [255, 176, 46, 255];
    let mut svg = Svg::default();

    let title = TextContent::plain(
        "Atmospheric Minimalism",
        style("Instrument Serif", 56.0, ink),
        ParagraphFormat::default(),
    );
    let l = e.layout(&title, &LayoutOptions::default());
    draw(&mut e, &l, (40.0, 30.0), None, &mut svg);

    let text = "Desyn lays out every script: English, العربية تتصل حروفها, עברית מימין לשמאל, 中文排版：标点符号不能出现在行首，日本語の文章も。 Emoji 😀 👍 ❤\u{FE0F} 🇩🇪 and soft\u{AD}hyphen\u{AD}ation.";
    let mut c = TextContent::plain(
        text,
        style("Inter", 20.0, ink),
        ParagraphFormat {
            align: TextAlign::Justify,
            ..ParagraphFormat::default()
        },
    );
    let s = text.find("English").unwrap();
    let mut hl = style("Inter", 20.0, [17, 17, 17, 255]);
    hl.highlight = Some(sun);
    hl.weight = 700.0;
    let mut under = style("Inter", 20.0, sun);
    under.underline = true;
    under.italic = true;
    let u0 = text.find("Emoji").unwrap();
    c.spans = vec![
        Span {
            range: 0..s,
            style: style("Inter", 20.0, ink),
        },
        Span {
            range: s..s + 7,
            style: hl,
        },
        Span {
            range: s + 7..u0,
            style: style("Inter", 20.0, ink),
        },
        Span {
            range: u0..u0 + 5,
            style: under,
        },
        Span {
            range: u0 + 5..text.len(),
            style: style("Inter", 20.0, ink),
        },
    ];
    let l = e.layout(&c, &LayoutOptions::wrapping(520.0));
    draw(&mut e, &l, (40.0, 120.0), None, &mut svg);

    let mut list = TextContent::plain(
        "Generate complete designs\n\tas real layers\n\tthat stay editable\nUnderstand the canvas\nPolish with the brand kit",
        style("Inter", 18.0, ink),
        ParagraphFormat {
            list: ListStyle::Number,
            ..ParagraphFormat::default()
        },
    );
    let l = e.layout(&list, &LayoutOptions::wrapping(300.0));
    draw(&mut e, &l, (40.0, 330.0), None, &mut svg);
    list.paragraph.list = ListStyle::Bullet;
    let l = e.layout(&list, &LayoutOptions::wrapping(300.0));
    draw(&mut e, &l, (330.0, 330.0), None, &mut svg);

    let mut rtl = TextContent::plain(
        "مرحبا بالعالم — שלום עולם",
        style("Inter", 26.0, ink),
        ParagraphFormat::default(),
    );
    rtl.paragraph.align = TextAlign::Right;
    let l = e.layout(&rtl, &LayoutOptions::wrapping(520.0));
    draw(&mut e, &l, (40.0, 500.0), None, &mut svg);

    let arc = TextContent::plain(
        "TEXT ON A SUNNY ARC",
        style("JetBrains Mono", 22.0, sun),
        ParagraphFormat::default(),
    );
    let l = e.layout(&arc, &LayoutOptions::default());
    draw(&mut e, &l, (150.0, 640.0), Some(140.0), &mut svg);

    let doc = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="600" height="760" viewBox="0 0 600 760"><defs>{}</defs><rect width="600" height="760" fill="#0b0b0c"/>{}</svg>"##,
        svg.defs, svg.body
    );
    std::fs::write(&path, doc).expect("write svg");
    println!("wrote {path}");
}
