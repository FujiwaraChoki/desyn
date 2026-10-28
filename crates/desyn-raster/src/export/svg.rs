//! SVG writer for display lists: groups with transforms, opacity, blend modes (CSS `mix-blend-mode`), clip paths,
//! alpha / luminance masks, filters for shadows / blurs / glow / noise, linear and radial gradients, image patterns
//! and embedded images, and text either as `<text>` (with `@font-face` font embedding) or as outlines.
//! Conic gradients (no SVG equivalent) and background blurs are embedded as rendered images.

use std::collections::HashMap;
use std::fmt::Write as _;

use desyn_core::geometry::{Affine, Rect};
use desyn_core::model::{BlendMode, Design, Id};
use tiny_skia::PathSegment;

use super::xml::{base64, esc, num};
use super::{Background, ExportOptions, ExportOutput, Format, SvgText};
use crate::assets::{RasterImage, SourceFormat};
use crate::display::{
    BuildOptions, DisplayList, FillItem, FillRule, GlyphRunItem, ImageItem, Item, Layer,
    LayerEffect, LayerKind, LineCap, LineJoin, MaskKind, StrokeItem, TextItem,
};
use crate::error::RenderError;
use crate::geom;
use crate::paint::{Color4, Paint, Spread};
use crate::raster::render_layer;
use crate::renderer::Renderer;

/// SVG path data of a tiny-skia path.
pub fn path_data(p: &tiny_skia::Path) -> String {
    let mut d = String::with_capacity(p.len() * 12);
    let pt = |d: &mut String, p: tiny_skia::Point| {
        let _ = write!(d, "{} {}", num(f64::from(p.x)), num(f64::from(p.y)));
    };
    for seg in p.segments() {
        match seg {
            PathSegment::MoveTo(a) => {
                d.push('M');
                pt(&mut d, a);
            }
            PathSegment::LineTo(a) => {
                d.push('L');
                pt(&mut d, a);
            }
            PathSegment::QuadTo(a, b) => {
                d.push('Q');
                pt(&mut d, a);
                d.push(' ');
                pt(&mut d, b);
            }
            PathSegment::CubicTo(a, b, c) => {
                d.push('C');
                pt(&mut d, a);
                d.push(' ');
                pt(&mut d, b);
                d.push(' ');
                pt(&mut d, c);
            }
            PathSegment::Close => d.push('Z'),
        }
    }
    d
}

fn matrix(a: &Affine) -> String {
    format!(
        "matrix({} {} {} {} {} {})",
        num_t(a.a),
        num_t(a.b),
        num_t(a.c),
        num_t(a.d),
        num(a.e),
        num(a.f)
    )
}

fn num_t(v: f64) -> String {
    super::xml::num_p(v, 6)
}

fn blend_css(b: BlendMode) -> Option<&'static str> {
    (b != BlendMode::Normal).then(|| b.as_str())
}

fn image_href(img: &RasterImage) -> String {
    match img.source() {
        Some(src)
            if matches!(
                src.format,
                SourceFormat::Png | SourceFormat::Jpeg | SourceFormat::Webp | SourceFormat::Gif
            ) =>
        {
            format!("data:{};base64,{}", src.format.mime(), base64(&src.bytes))
        }
        _ => format!("data:image/png;base64,{}", base64(&img.encode_png())),
    }
}

/// Writes display lists as SVG.
pub struct SvgWriter<'a> {
    dl: &'a DisplayList,
    text: SvgText,
    defs: String,
    next: usize,
    images: HashMap<u64, String>,
    fonts: HashMap<usize, String>,
    embedded_faces: std::collections::HashSet<u32>,
    font_css: String,
    /// Device pixels per design px for rasterized fallbacks.
    raster_scale: f64,
    /// Problems worth reporting.
    pub warnings: Vec<String>,
}

impl<'a> SvgWriter<'a> {
    /// Writer for a display list.
    pub fn new(dl: &'a DisplayList, text: SvgText, raster_scale: f64) -> Self {
        SvgWriter {
            dl,
            text,
            defs: String::new(),
            next: 0,
            images: HashMap::new(),
            fonts: HashMap::new(),
            embedded_faces: std::collections::HashSet::new(),
            font_css: String::new(),
            raster_scale: raster_scale.clamp(1.0, 8.0),
            warnings: Vec::new(),
        }
    }

    fn id(&mut self, prefix: &str) -> String {
        self.next += 1;
        format!("dsn-{prefix}{}", self.next)
    }

    /// Complete SVG document covering `region` (page coordinates).
    pub fn write(mut self, region: Rect) -> (String, Vec<String>) {
        let mut body = String::new();
        // Walk the list itself, not a copy: background blur finds its layer by identity (`truncate_after`).
        let dl = self.dl;
        self.layer(&dl.root, &mut body, 0, &Affine::IDENTITY);
        for l in &self.dl.links {
            if let crate::display::LinkTarget::Url(u) = &l.target {
                let pts: Vec<String> = l
                    .quad
                    .iter()
                    .map(|p| format!("{},{}", num(p.x), num(p.y)))
                    .collect();
                let _ = write!(
                    body,
                    r##"<a href="{}" target="_blank"><polygon points="{}" fill="#000" fill-opacity="0"/></a>"##,
                    esc(u),
                    pts.join(" ")
                );
            }
        }
        let mut out = String::with_capacity(body.len() + self.defs.len() + 512);
        let _ = write!(
            out,
            r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{}" height="{}" viewBox="{} {} {} {}">"#,
            num(region.w),
            num(region.h),
            num(region.x),
            num(region.y),
            num(region.w),
            num(region.h)
        );
        if !self.defs.is_empty() || !self.font_css.is_empty() {
            out.push_str("<defs>");
            if !self.font_css.is_empty() {
                let _ = write!(out, "<style>{}</style>", esc(&self.font_css));
            }
            out.push_str(&self.defs);
            out.push_str("</defs>");
        }
        out.push_str(&body);
        out.push_str("</svg>");
        (out, self.warnings)
    }

    fn gradient(&mut self, p: &Paint, opacity: f32) -> Option<String> {
        let id = self.id("g");
        let stops = |s: &[crate::paint::GradientStop]| {
            let mut out = String::new();
            for st in s {
                let _ = write!(
                    out,
                    r#"<stop offset="{}" stop-color="{}" stop-opacity="{}"/>"#,
                    num(f64::from(st.pos)),
                    st.color.to_hex_rgb(),
                    num(f64::from(st.color.a * opacity))
                );
            }
            out
        };
        let spread = |s: Spread| match s {
            Spread::Pad => "pad",
            Spread::Repeat => "repeat",
            Spread::Reflect => "reflect",
        };
        match p {
            Paint::Linear {
                start,
                end,
                stops: s,
                spread: sp,
                transform,
            } => {
                let _ = write!(
                    self.defs,
                    r#"<linearGradient id="{id}" gradientUnits="userSpaceOnUse" x1="{}" y1="{}" x2="{}" y2="{}" gradientTransform="{}" spreadMethod="{}">{}</linearGradient>"#,
                    num(start.x),
                    num(start.y),
                    num(end.x),
                    num(end.y),
                    matrix(transform),
                    spread(*sp),
                    stops(s)
                );
            }
            Paint::Radial {
                c0,
                r0,
                c1,
                r1,
                stops: s,
                spread: sp,
                transform,
            } => {
                let _ = write!(
                    self.defs,
                    r#"<radialGradient id="{id}" gradientUnits="userSpaceOnUse" cx="{}" cy="{}" r="{}" fx="{}" fy="{}" fr="{}" gradientTransform="{}" spreadMethod="{}">{}</radialGradient>"#,
                    num(c1.x),
                    num(c1.y),
                    num_t(*r1),
                    num(c0.x),
                    num(c0.y),
                    num_t(*r0),
                    matrix(transform),
                    spread(*sp),
                    stops(s)
                );
            }
            _ => return None,
        }
        Some(format!("url(#{id})"))
    }

    fn image_def(&mut self, img: &RasterImage) -> String {
        if let Some(id) = self.images.get(&img.id()) {
            return id.clone();
        }
        let id = self.id("i");
        let _ = write!(
            self.defs,
            r#"<image id="{id}" width="{}" height="{}" preserveAspectRatio="none" href="{}"/>"#,
            img.width(),
            img.height(),
            image_href(img)
        );
        self.images.insert(img.id(), id.clone());
        id
    }

    /// Paint attribute value (`fill` / `stroke`) plus opacity, or `None` when the paint needs a fallback.
    fn paint_attr(&mut self, p: &Paint, opacity: f32) -> Option<(String, f32)> {
        match p {
            Paint::Solid(c) => Some((c.to_hex_rgb(), c.a * opacity)),
            Paint::Linear { .. } | Paint::Radial { .. } => Some((self.gradient(p, 1.0)?, opacity)),
            Paint::Image(ip) if ip.extend == crate::paint::ImageExtend::Repeat => {
                let img = self.image_def(&ip.image);
                let id = self.id("p");
                let _ = write!(
                    self.defs,
                    r##"<pattern id="{id}" patternUnits="userSpaceOnUse" width="{}" height="{}" patternTransform="{}"><use href="#{img}"/></pattern>"##,
                    ip.image.width(),
                    ip.image.height(),
                    matrix(&ip.transform)
                );
                Some((format!("url(#{id})"), opacity))
            }
            _ => None,
        }
    }

    fn style_blend(b: BlendMode) -> String {
        match blend_css(b) {
            Some(m) => format!(r#" style="mix-blend-mode:{m}""#),
            None => String::new(),
        }
    }

    fn clip_def(&mut self, path: &tiny_skia::Path, rule: FillRule) -> String {
        let id = self.id("c");
        let _ = write!(
            self.defs,
            r#"<clipPath id="{id}" clipPathUnits="userSpaceOnUse"><path d="{}" clip-rule="{}"/></clipPath>"#,
            path_data(path),
            if rule == FillRule::EvenOdd {
                "evenodd"
            } else {
                "nonzero"
            }
        );
        id
    }

    /// Fill / text paints SVG cannot express (conic gradients, unrepeated image patterns): the image is
    /// clipped to the path (image patterns) or the paint is rendered over the path bounds.
    fn fallback_fill(
        &mut self,
        path: &tiny_skia::Path,
        rule: FillRule,
        paint: &Paint,
        opacity: f32,
        blend: BlendMode,
        out: &mut String,
    ) {
        let clip = self.clip_def(path, rule);
        let _ = write!(
            out,
            r#"<g clip-path="url(#{clip})"{}>"#,
            Self::style_blend(blend)
        );
        match paint {
            Paint::Image(ip) => {
                let img = self.image_def(&ip.image);
                let _ = write!(
                    out,
                    r##"<use href="#{img}" transform="{}" opacity="{}"/>"##,
                    matrix(&ip.transform),
                    num(f64::from(opacity))
                );
            }
            _ => {
                let b = geom::path_bounds(path);
                let s = self.raster_scale;
                let (w, h) = (
                    (b.w * s).ceil().max(1.0) as u32,
                    (b.h * s).ceil().max(1.0) as u32,
                );
                let mut layer = Layer::new(LayerKind::Group, None, Affine::IDENTITY);
                if let Some(rp) = geom::rect_path(&b) {
                    layer.items.push(Item::Fill(FillItem {
                        path: std::sync::Arc::new(rp),
                        rule: FillRule::Nonzero,
                        paint: paint.clone(),
                        opacity,
                        blend: BlendMode::Normal,
                        bounds: b,
                    }));
                }
                layer.update_bounds();
                let t = Affine::scale(s, s) * Affine::translate(-b.x, -b.y);
                if let Some(pix) = render_layer(&layer, w.min(8192), h.min(8192), t) {
                    let img = RasterImage::new(pix, None);
                    let _ = write!(
                        out,
                        r#"<image x="{}" y="{}" width="{}" height="{}" preserveAspectRatio="none" href="data:image/png;base64,{}"/>"#,
                        num(b.x),
                        num(b.y),
                        num(b.w),
                        num(b.h),
                        base64(&img.encode_png())
                    );
                }
            }
        }
        out.push_str("</g>");
    }

    fn fill(&mut self, f: &FillItem, out: &mut String) {
        match self.paint_attr(&f.paint, f.opacity) {
            Some((fill, op)) => {
                let _ = write!(
                    out,
                    r#"<path d="{}" fill="{fill}"{}{}{}/>"#,
                    path_data(&f.path),
                    if op < 0.999 {
                        format!(r#" fill-opacity="{}""#, num(f64::from(op)))
                    } else {
                        String::new()
                    },
                    if f.rule == FillRule::EvenOdd {
                        r#" fill-rule="evenodd""#
                    } else {
                        ""
                    },
                    Self::style_blend(f.blend)
                );
            }
            None => self.fallback_fill(&f.path, f.rule, &f.paint, f.opacity, f.blend, out),
        }
    }

    fn stroke(&mut self, s: &StrokeItem, out: &mut String) {
        let (stroke, op) = match self.paint_attr(&s.paint, s.opacity) {
            Some(v) => v,
            None => (
                s.paint.average_color().to_hex_rgb(),
                s.opacity * s.paint.average_color().a,
            ),
        };
        let st = &s.stroke;
        let mut attrs = format!(r#" stroke-width="{}""#, num(st.width));
        match st.cap {
            LineCap::Butt => {}
            LineCap::Round => attrs.push_str(r#" stroke-linecap="round""#),
            LineCap::Square => attrs.push_str(r#" stroke-linecap="square""#),
        }
        match st.join {
            LineJoin::Miter => {
                if (st.miter_limit - 4.0).abs() > 1e-9 {
                    let _ = write!(attrs, r#" stroke-miterlimit="{}""#, num(st.miter_limit));
                }
            }
            LineJoin::Round => attrs.push_str(r#" stroke-linejoin="round""#),
            LineJoin::Bevel => attrs.push_str(r#" stroke-linejoin="bevel""#),
        }
        if let Some((d, off)) = &st.dash {
            let v: Vec<String> = d.iter().map(|x| num(*x)).collect();
            let _ = write!(attrs, r#" stroke-dasharray="{}""#, v.join(" "));
            if *off != 0.0 {
                let _ = write!(attrs, r#" stroke-dashoffset="{}""#, num(*off));
            }
        }
        if op < 0.999 {
            let _ = write!(attrs, r#" stroke-opacity="{}""#, num(f64::from(op)));
        }
        let _ = write!(
            out,
            r#"<path d="{}" fill="none" stroke="{stroke}"{attrs}{}/>"#,
            path_data(&s.path),
            Self::style_blend(s.blend)
        );
    }

    fn image(&mut self, i: &ImageItem, out: &mut String) {
        let img = self.image_def(&i.image);
        let _ = write!(
            out,
            r##"<use href="#{img}" transform="{}"{}{}/>"##,
            matrix(&i.transform),
            if i.opacity < 0.999 {
                format!(r#" opacity="{}""#, num(f64::from(i.opacity)))
            } else {
                String::new()
            },
            Self::style_blend(i.blend)
        );
    }

    fn font_family(&mut self, idx: usize) -> String {
        if let Some(f) = self.fonts.get(&idx) {
            return f.clone();
        }
        let Some(entry) = self.dl.fonts.entries.get(idx) else {
            return "sans-serif".into();
        };
        let family = entry
            .family
            .replace(['"', '\'', ';', '{', '}', '<', '>', '\\'], "");
        let name = match self.text {
            SvgText::Text { embed_fonts: true } => {
                // One @font-face per font file; instances select their axes with font-variation-settings.
                let local = format!("dsn-font-{}", entry.face);
                if self.embedded_faces.insert(entry.face) {
                    let mime = if entry.data.starts_with(b"OTTO") {
                        "font/otf"
                    } else {
                        "font/ttf"
                    };
                    let (lo, hi) = entry.weight_range;
                    let _ = write!(
                        self.font_css,
                        "@font-face{{font-family:\"{local}\";src:url(data:{mime};base64,{});font-weight:{} {};font-style:{};}}",
                        base64(&entry.data),
                        num(f64::from(lo.min(hi))),
                        num(f64::from(hi.max(lo))),
                        if entry.italic { "italic" } else { "normal" }
                    );
                }
                format!("'{local}', '{family}'")
            }
            _ => format!("'{family}'"),
        };
        self.fonts.insert(idx, name.clone());
        name
    }

    fn run(&mut self, r: &GlyphRunItem, fill: &str, op: f32, bold_attr: &str, out: &mut String) {
        let Some(entry) = self.dl.fonts.entries.get(r.font).cloned() else {
            return;
        };
        let family = self.font_family(r.font);
        let mut style = String::new();
        let axes: Vec<String> = entry
            .variations
            .iter()
            .filter(|(t, _)| t.len() == 4 && t.chars().all(|c| c.is_ascii_alphanumeric()))
            .map(|(t, v)| format!("\"{t}\" {}", num(f64::from(*v))))
            .collect();
        if !axes.is_empty() {
            let _ = write!(style, "font-variation-settings:{};", axes.join(","));
        }
        // Clusters in visual order with their first glyph's position.
        let mut clusters: Vec<(std::ops::Range<usize>, f64, f64)> = Vec::new();
        for g in &r.glyphs {
            if let Some(last) = clusters.last()
                && last.0 == g.text
            {
                continue;
            }
            clusters.push((g.text.clone(), g.x, g.y));
        }
        let simple =
            clusters.windows(2).all(|w| w[0].0.end <= w[1].0.start) && !clusters.is_empty();
        let text_of =
            |range: &std::ops::Range<usize>| r.text.get(range.clone()).unwrap_or("").to_string();
        let skew = if r.skew != 0.0 {
            format!(r#" transform="matrix(1 0 {} 1 0 0)""#, num_t(-r.skew))
        } else {
            String::new()
        };
        let common = format!(
            r#" font-family="{}" font-size="{}" font-weight="{}" font-style="{}" fill="{fill}"{}{bold_attr}{}{skew}"#,
            esc(&family),
            num(r.size),
            num(f64::from(entry.weight)),
            if entry.italic { "italic" } else { "normal" },
            if op < 0.999 {
                format!(r#" fill-opacity="{}""#, num(f64::from(op)))
            } else {
                String::new()
            },
            if style.is_empty() {
                String::new()
            } else {
                format!(r#" style="{}""#, esc(&style))
            }
        );
        if simple {
            let mut xs = Vec::new();
            let mut s = String::new();
            for (range, x, _) in &clusters {
                let t = text_of(range);
                let n = t.chars().count();
                if n == 0 {
                    continue;
                }
                // Only a cluster's first character is positioned; the others (ligatures) follow the font.
                xs.push(num(*x));
                s.push_str(&t);
            }
            if s.trim().is_empty() {
                return;
            }
            let y = clusters.first().map(|c| c.2).unwrap_or(0.0);
            let _ = write!(
                out,
                r#"<text xml:space="preserve" x="{}" y="{}"{common}>{}</text>"#,
                xs.join(" "),
                num(y),
                esc(&s)
            );
        } else {
            // Complex (bidi / reordered) runs: logical text at the run start, stretched to the shaped width.
            let start = r.glyphs.iter().map(|g| g.x).fold(f64::MAX, f64::min);
            let end = r
                .glyphs
                .iter()
                .map(|g| g.x + g.advance)
                .fold(f64::MIN, f64::max);
            let mut ranges: Vec<std::ops::Range<usize>> =
                clusters.iter().map(|c| c.0.clone()).collect();
            ranges.sort_by_key(|r| r.start);
            ranges.dedup();
            let s: String = ranges.iter().map(&text_of).collect();
            if s.trim().is_empty() {
                return;
            }
            let y = r.glyphs.first().map(|g| g.y).unwrap_or(0.0);
            let rtl = r
                .glyphs
                .first()
                .zip(r.glyphs.last())
                .is_some_and(|(a, b)| a.text.start > b.text.start);
            let (x, anchor) = if rtl {
                (end, r#" text-anchor="end" direction="rtl""#)
            } else {
                (start, "")
            };
            let _ = write!(
                out,
                r#"<text xml:space="preserve" x="{}" y="{}" textLength="{}" lengthAdjust="spacingAndGlyphs"{anchor}{common}>{}</text>"#,
                num(x),
                num(y),
                num((end - start).max(0.0)),
                esc(&s)
            );
        }
    }

    fn text(&mut self, t: &TextItem, out: &mut String) {
        let as_text = matches!(self.text, SvgText::Text { .. }) && !t.runs.is_empty();
        if !as_text {
            let f = FillItem {
                path: t.outline.clone(),
                rule: FillRule::Nonzero,
                paint: t.paint.clone(),
                opacity: t.opacity,
                blend: t.blend,
                bounds: t.bounds,
            };
            self.fill(&f, out);
            if t.bold > 0.0 {
                let s = StrokeItem {
                    path: t.outline.clone(),
                    stroke: crate::display::StrokeStyle {
                        width: t.bold,
                        cap: LineCap::Round,
                        join: LineJoin::Round,
                        miter_limit: 4.0,
                        dash: None,
                    },
                    paint: t.paint.clone(),
                    opacity: t.opacity,
                    blend: t.blend,
                    bounds: t.bounds,
                };
                self.stroke(&s, out);
            }
            return;
        }
        let (fill, op) = match self.paint_attr(&t.paint, t.opacity) {
            Some(v) => v,
            None => {
                // Paints SVG text cannot use: draw the outline through the fill fallback.
                self.fallback_fill(
                    &t.outline,
                    FillRule::Nonzero,
                    &t.paint,
                    t.opacity,
                    t.blend,
                    out,
                );
                return;
            }
        };
        let bold = if t.bold > 0.0 {
            format!(
                r#" stroke="{fill}" stroke-width="{}" stroke-linejoin="round""#,
                num(t.bold)
            )
        } else {
            String::new()
        };
        if t.blend != BlendMode::Normal {
            let _ = write!(out, r#"<g{}>"#, Self::style_blend(t.blend));
        }
        for r in &t.runs {
            self.run(r, &fill, op, &bold, out);
        }
        if t.blend != BlendMode::Normal {
            out.push_str("</g>");
        }
    }

    fn filter(&mut self, l: &Layer) -> Option<String> {
        let effects: Vec<&LayerEffect> = l
            .effects
            .iter()
            .filter(|e| !matches!(e, LayerEffect::BackgroundBlur { .. }))
            .collect();
        if effects.is_empty() {
            return None;
        }
        let mut region = l.content_bounds;
        for e in &effects {
            region = region.outset(e.outsets());
            if let LayerEffect::InnerShadow {
                dx,
                dy,
                blur,
                spread,
                ..
            } = **e
            {
                // The inverted alpha must extend past the shape for the blur to see "outside".
                region = region.inflate(blur * 1.5 + dx.abs().max(dy.abs()) + spread.abs());
            }
        }
        let region = region.inflate(2.0);
        let id = self.id("f");
        let mut f = format!(
            r#"<filter id="{id}" filterUnits="userSpaceOnUse" x="{}" y="{}" width="{}" height="{}" color-interpolation-filters="sRGB">"#,
            num(region.x),
            num(region.y),
            num(region.w),
            num(region.h)
        );
        let mut cur = "SourceGraphic".to_string();
        for (i, e) in effects.iter().enumerate() {
            let r = format!("r{i}");
            match **e {
                LayerEffect::DropShadow {
                    dx,
                    dy,
                    blur,
                    spread,
                    color,
                } => {
                    let morph = if spread > 0.0 {
                        format!(
                            r#"<feMorphology in="SourceAlpha" operator="dilate" radius="{}" result="{r}m"/>"#,
                            num(spread)
                        )
                    } else if spread < 0.0 {
                        format!(
                            r#"<feMorphology in="SourceAlpha" operator="erode" radius="{}" result="{r}m"/>"#,
                            num(-spread)
                        )
                    } else {
                        format!(r#"<feOffset in="SourceAlpha" dx="0" dy="0" result="{r}m"/>"#)
                    };
                    let _ = write!(
                        f,
                        r#"{morph}<feGaussianBlur in="{r}m" stdDeviation="{}" result="{r}b"/><feOffset in="{r}b" dx="{}" dy="{}" result="{r}o"/><feFlood flood-color="{}" flood-opacity="{}"/><feComposite in2="{r}o" operator="in" result="{r}s"/><feMerge result="{r}"><feMergeNode in="{r}s"/><feMergeNode in="{cur}"/></feMerge>"#,
                        num(blur / 2.0),
                        num(dx),
                        num(dy),
                        color.to_hex_rgb(),
                        num(f64::from(color.a))
                    );
                }
                LayerEffect::InnerShadow {
                    dx,
                    dy,
                    blur,
                    spread,
                    color,
                } => {
                    let choke = if spread > 0.0 {
                        format!(
                            r#"<feMorphology in="{r}i" operator="dilate" radius="{}" result="{r}i"/>"#,
                            num(spread)
                        )
                    } else {
                        String::new()
                    };
                    let _ = write!(
                        f,
                        r##"<feFlood flood-color="#000" result="{r}k"/><feComposite in="{r}k" in2="SourceAlpha" operator="out" result="{r}i"/>{choke}<feOffset in="{r}i" dx="{}" dy="{}" result="{r}o"/><feGaussianBlur in="{r}o" stdDeviation="{}" result="{r}b"/><feFlood flood-color="{}" flood-opacity="{}"/><feComposite in2="{r}b" operator="in" result="{r}c"/><feComposite in="{r}c" in2="SourceAlpha" operator="in" result="{r}s"/><feMerge result="{r}"><feMergeNode in="{cur}"/><feMergeNode in="{r}s"/></feMerge>"##,
                        num(dx),
                        num(dy),
                        num(blur / 2.0),
                        color.to_hex_rgb(),
                        num(f64::from(color.a))
                    );
                }
                LayerEffect::LayerBlur { radius } => {
                    let _ = write!(
                        f,
                        r#"<feGaussianBlur in="{cur}" stdDeviation="{}" result="{r}"/>"#,
                        num(radius / 2.0)
                    );
                }
                LayerEffect::Glow {
                    radius,
                    strength,
                    color,
                } => {
                    let gain = (0.6 + 1.6 * strength).min(2.2);
                    let _ = write!(
                        f,
                        r#"<feGaussianBlur in="SourceAlpha" stdDeviation="{}" result="{r}b"/><feComponentTransfer in="{r}b" result="{r}g"><feFuncA type="linear" slope="{}"/></feComponentTransfer><feFlood flood-color="{}" flood-opacity="{}"/><feComposite in2="{r}g" operator="in" result="{r}s"/><feMerge result="{r}"><feMergeNode in="{r}s"/><feMergeNode in="{cur}"/></feMerge>"#,
                        num(radius / 2.0),
                        num(gain),
                        color.to_hex_rgb(),
                        num(f64::from(color.a))
                    );
                }
                _ => continue,
            }
            cur = r;
        }
        f.push_str("</filter>");
        self.defs.push_str(&f);
        Some(id)
    }

    /// A layer with a background blur: the page region it covers, rendered with its backdrop, as an image.
    fn backdrop_image(&mut self, l: &Layer, page_t: &Affine, out: &mut String) -> bool {
        let region = page_t.transform_rect_bbox(&l.bounds);
        let Some(inv) = page_t.inverse() else {
            return false;
        };
        let Some(root) = crate::raster::truncate_after(&self.dl.root, l) else {
            return false;
        };
        let k = self
            .raster_scale
            .min(6000.0 / region.w.max(region.h).max(1.0));
        let Some(pix) = crate::raster::render_region(&root, &region, k) else {
            return false;
        };
        let img = RasterImage::new(pix, None);
        let _ = write!(
            out,
            r#"<image transform="{}" x="{}" y="{}" width="{}" height="{}" preserveAspectRatio="none" href="data:image/png;base64,{}"/>"#,
            matrix(&inv),
            num(region.x),
            num(region.y),
            num(region.w),
            num(region.h),
            base64(&img.encode_png())
        );
        true
    }

    /// A layer drawn as an image in its parent's space (grain is pixel-level: an SVG turbulence filter would look
    /// different from the raster, PNG and PDF exports and seam against backdrop images).
    fn layer_image(&mut self, l: &Layer, out: &mut String) -> bool {
        let region = l.bounds;
        let k = self
            .raster_scale
            .min(6000.0 / region.w.max(region.h).max(1.0));
        let (w, h) = (
            (region.w * k).ceil().max(1.0) as u32,
            (region.h * k).ceil().max(1.0) as u32,
        );
        let t = Affine::scale(k, k) * Affine::translate(-region.x, -region.y);
        let Some(pix) = render_layer(l, w, h, t) else {
            return false;
        };
        let img = RasterImage::new(pix, None);
        let style = blend_css(l.blend)
            .map(|m| format!(r#" style="mix-blend-mode:{m}""#))
            .unwrap_or_default();
        let _ = write!(
            out,
            r#"<image x="{}" y="{}" width="{}" height="{}" preserveAspectRatio="none"{style} href="data:image/png;base64,{}"/>"#,
            num(region.x),
            num(region.y),
            num(f64::from(w) / k),
            num(f64::from(h) / k),
            base64(&img.encode_png())
        );
        true
    }

    /// `page_t` maps the layer's parent space to page space.
    fn layer(&mut self, l: &Layer, out: &mut String, depth: usize, page_t: &Affine) {
        if depth > crate::display::MAX_RENDER_DEPTH * 2 {
            return;
        }
        if l.effects
            .iter()
            .any(|e| matches!(e, LayerEffect::BackgroundBlur { .. }))
            && self.backdrop_image(l, page_t, out)
        {
            return;
        }
        if l.effects
            .iter()
            .any(|e| matches!(e, LayerEffect::Noise { .. }))
            && self.layer_image(l, out)
        {
            return;
        }
        let inner_t = *page_t * l.transform;
        let mut open = String::from("<g");
        if l.transform != Affine::IDENTITY {
            let _ = write!(open, r#" transform="{}""#, matrix(&l.transform));
        }
        if l.opacity < 0.999 {
            let _ = write!(open, r#" opacity="{}""#, num(f64::from(l.opacity)));
        }
        let mut style = String::new();
        if let Some(m) = blend_css(l.blend) {
            let _ = write!(style, "mix-blend-mode:{m};");
        }
        if !style.is_empty() {
            let _ = write!(open, r#" style="{style}""#);
        }
        if let Some(c) = &l.clip {
            let id = self.clip_def(&c.path, c.rule);
            let _ = write!(open, r#" clip-path="url(#{id})""#);
        }
        if let Some(m) = &l.mask {
            let id = self.id("m");
            let mut content = String::new();
            self.layer(&m.layer, &mut content, depth + 1, &inner_t);
            let b = m.layer.bounds.inflate(1.0);
            let _ = write!(
                self.defs,
                r#"<mask id="{id}" maskUnits="userSpaceOnUse" x="{}" y="{}" width="{}" height="{}" style="mask-type:{}">{content}</mask>"#,
                num(b.x),
                num(b.y),
                num(b.w),
                num(b.h),
                if m.kind == MaskKind::Alpha {
                    "alpha"
                } else {
                    "luminance"
                }
            );
            let _ = write!(open, r#" mask="url(#{id})""#);
        }
        let filter = self.filter(l);
        open.push('>');
        out.push_str(&open);
        // Filters go on an inner group so they apply before the clip / mask of the outer one.
        if let Some(f) = &filter {
            let _ = write!(out, r#"<g filter="url(#{f})">"#);
        }
        for it in &l.items {
            match it {
                Item::Fill(f) => self.fill(f, out),
                Item::Stroke(s) => self.stroke(s, out),
                Item::Image(i) => self.image(i, out),
                Item::Text(t) => self.text(t, out),
                Item::Layer(c) => self.layer(c, out, depth + 1, &inner_t),
            }
        }
        if filter.is_some() {
            out.push_str("</g>");
        }
        out.push_str("</g>");
    }
}

/// SVG of a display list over `region` (page coordinates).
pub fn display_list_to_svg(
    dl: &DisplayList,
    region: Rect,
    text: SvgText,
    raster_scale: f64,
) -> (String, Vec<String>) {
    SvgWriter::new(dl, text, raster_scale).write(region)
}

/// Exports one page as SVG.
pub fn export_svg(
    renderer: &mut Renderer,
    design: &Design,
    page: &Id,
    opts: &ExportOptions,
) -> Result<ExportOutput, RenderError> {
    let build = BuildOptions {
        page: Some(page.clone()),
        background: matches!(opts.background, Background::Page),
        only: opts.only.clone(),
        hidden: opts.hidden.clone(),
        time_ms: opts.time_ms,
        vector: matches!(opts.svg_text, SvgText::Text { .. }),
        raster_scale: opts.scale.max(2.0),
        ..BuildOptions::default()
    };
    let mut dl = renderer.build(design, &build)?;
    if let Background::Color(c) = opts.background {
        prepend_background(&mut dl, c);
    }
    let region = opts.region.unwrap_or(dl.page_rect());
    let (svg, mut warnings) = display_list_to_svg(&dl, region, opts.svg_text, opts.scale.max(2.0));
    warnings.extend(dl.warnings);
    Ok(ExportOutput {
        bytes: svg.into_bytes(),
        mime: Format::Svg.mime(),
        extension: "svg",
        pages: 1,
        missing_assets: dl.missing_assets,
        missing_fonts: dl.missing_fonts,
        warnings,
    })
}

/// Paints `c` under the page content (vector exporters' background override).
pub(crate) fn prepend_background(dl: &mut DisplayList, c: Color4) {
    let r = dl.bleed_rect();
    if let Some(p) = geom::rect_path(&r) {
        dl.root.items.insert(
            0,
            Item::Fill(FillItem {
                path: std::sync::Arc::new(p),
                rule: FillRule::Nonzero,
                paint: Paint::Solid(c),
                opacity: 1.0,
                blend: BlendMode::Normal,
                bounds: r,
            }),
        );
        dl.root.update_bounds();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_data_is_compact() {
        let mut pb = tiny_skia::PathBuilder::new();
        pb.move_to(0.0, 0.0);
        pb.line_to(10.5, 0.0);
        pb.cubic_to(1.0, 2.0, 3.0, 4.0, 5.0, 6.0);
        pb.close();
        assert_eq!(path_data(&pb.finish().unwrap()), "M0 0L10.5 0C1 2 3 4 5 6Z");
        assert_eq!(matrix(&Affine::IDENTITY), "matrix(1 0 0 1 0 0)");
    }
}
