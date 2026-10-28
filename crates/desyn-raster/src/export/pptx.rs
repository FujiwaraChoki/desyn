//! PowerPoint export: a zip of hand-written OOXML (PresentationML + DrawingML). Slide size follows the page;
//! rectangles, ellipses, polygons, stars, paths and booleans become editable shapes (preset or custom
//! geometry) with solid / gradient / image fills, outlines and shadows / glow; lines become connectors with
//! arrow heads; text nodes become text boxes with styled runs and paragraphs; images become pictures; groups and
//! frames become group shapes; page backgrounds, transitions and speaker notes are kept. Everything PowerPoint
//! cannot express (SVG, charts, tables, QR codes, masks, clipping frames with overflowing content, curved text,
//! blend modes, blurs, noise, conic gradients, image adjustments) is embedded as a picture rendered by the
//! rasterizer at 2x.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::{Cursor, Write as _};

use desyn_core::geometry::{Affine, Rect};
use desyn_core::model::{
    BlendMode, Cap, Design, Effect, Fill, FontStyle, Id, ImageFit, ImageNode, LineHeightUnit,
    ListStyle, Node, PageNode, Stroke, StrokeAlign, StrokeCap, StrokeJoin, TextAlign, TextCase,
    TextDecoration, TextNode, TextStyle, TransitionKind, VerticalAlign,
};
use desyn_core::paths::kurbo::PathEl;

use super::xml::esc;
use super::{Background, ExportOptions, ExportOutput, Format};
use crate::assets::SourceFormat;
use crate::display::{BuildOptions, DisplayList, Fit, Item, Layer, LinkTarget, placement};
use crate::error::RenderError;
use crate::export::bitmap::encode_png;
use crate::paint::Color4;
use crate::renderer::{PageRenderOptions, Renderer};

/// EMU per design px (914400 EMU per inch, 96 px per inch).
const EMU_PER_PX: f64 = 9525.0;
/// PowerPoint's slide size limits (EMU).
const MIN_SLIDE_EMU: f64 = 914_400.0;
const MAX_SLIDE_EMU: f64 = 51_206_400.0;
/// Resolution of rendered fallbacks.
const FALLBACK_SCALE: f64 = 2.0;

const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#;

struct Media {
    name: String,
    bytes: Vec<u8>,
}

struct SlideOut {
    xml: String,
    rels: Vec<(String, String, String, bool)>, // id, type, target, external
    notes: Option<String>,
}

/// Writer state for one slide.
struct SlideWriter<'a> {
    design: &'a Design,
    page: &'a PageNode,
    k: f64,
    next_id: u32,
    rels: Vec<(String, String, String, bool)>,
    media: &'a mut Vec<Media>,
    media_index: &'a mut HashMap<String, String>,
    bounds: HashMap<String, Rect>,
    renderer: &'a mut Renderer,
    opts: &'a ExportOptions,
    warnings: Vec<String>,
    /// Slide number (1-based) of every exported page, for `page:` links.
    slide_of: &'a HashMap<String, usize>,
}

fn emu(v: f64, k: f64) -> i64 {
    (v * k * EMU_PER_PX).round() as i64
}

fn hex(c: &Color4) -> String {
    c.to_hex_rgb().trim_start_matches('#').to_uppercase()
}

fn srgb(c: Color4, opacity: f32) -> String {
    let a = ((c.a * opacity).clamp(0.0, 1.0) * 100_000.0).round() as i64;
    if a >= 100_000 {
        format!(r#"<a:srgbClr val="{}"/>"#, hex(&c))
    } else {
        format!(
            r#"<a:srgbClr val="{}"><a:alpha val="{a}"/></a:srgbClr>"#,
            hex(&c)
        )
    }
}

/// Walks a display list collecting the page-space paint bounds of every node layer.
fn collect_bounds(l: &Layer, parent: &Affine, out: &mut HashMap<String, Rect>) {
    if let Some(n) = &l.node {
        out.insert(n.clone(), parent.transform_rect_bbox(&l.bounds));
    }
    let inner = *parent * l.transform;
    for it in &l.items {
        if let Item::Layer(c) = it {
            collect_bounds(c, &inner, out);
        }
    }
}

fn effects_xml(effects: &[Effect], k: f64) -> String {
    let mut out = String::new();
    for e in effects.iter().filter(|e| e.is_visible()) {
        match e {
            Effect::DropShadow(s) | Effect::InnerShadow(s) => {
                let dist = (s.x * s.x + s.y * s.y).sqrt();
                let dir =
                    ((s.y.atan2(s.x).to_degrees().rem_euclid(360.0)) * 60000.0).round() as i64;
                let tag = if matches!(e, Effect::DropShadow(_)) {
                    "outerShdw"
                } else {
                    "innerShdw"
                };
                let extra = if tag == "outerShdw" {
                    r#" algn="ctr" rotWithShape="0""#
                } else {
                    ""
                };
                let _ = write!(
                    out,
                    r#"<a:{tag} blurRad="{}" dist="{}" dir="{dir}"{extra}>{}</a:{tag}>"#,
                    emu(s.blur.max(0.0), k),
                    emu(dist, k),
                    srgb(Color4::from_color(&s.color), 1.0)
                );
            }
            Effect::Glow(g) => {
                let _ = write!(
                    out,
                    r#"<a:glow rad="{}">{}</a:glow>"#,
                    emu(g.radius.max(0.0), k),
                    srgb(
                        Color4::from_color(&g.color),
                        (0.4 + 0.6 * g.strength) as f32
                    )
                );
            }
            _ => {}
        }
    }
    if out.is_empty() {
        String::new()
    } else {
        format!("<a:effectLst>{out}</a:effectLst>")
    }
}

/// Effects / features that need a rendered picture.
fn needs_fallback(design: &Design, n: &Node) -> Option<&'static str> {
    let b = n.base();
    if b.blend != BlendMode::Normal {
        return Some("blend mode");
    }
    if b.effects.iter().any(|e| {
        e.is_visible()
            && matches!(
                e,
                Effect::LayerBlur(_) | Effect::BackgroundBlur(_) | Effect::Noise(_)
            )
    }) {
        return Some("blur / noise effect");
    }
    let fills_need = |fills: &[Fill]| {
        fills
            .iter()
            .any(|f| f.is_visible() && matches!(f, Fill::Conic(_)))
    };
    let fill_count = n.fills().iter().filter(|f| f.is_visible()).count();
    match n {
        Node::Svg(_) | Node::Chart(_) | Node::Table(_) | Node::Qr(_) => return Some("node type"),
        Node::Text(t) => {
            if t.curve.is_some_and(|c| c.abs() >= 0.01) {
                return Some("curved text");
            }
            if t.strokes
                .as_ref()
                .is_some_and(|s| s.iter().any(Stroke::is_visible))
            {
                return Some("outlined text");
            }
        }
        Node::Image(i) => {
            if i.adjust.is_some() || i.mask_asset_id.is_some() || i.fit == ImageFit::Tile {
                return Some("image adjustments");
            }
            if matches!(i.shape, Some(desyn_core::model::ImageShape::Path { .. })) {
                return Some("image clip path");
            }
        }
        Node::Group(g) => {
            if b.opacity < 0.999 && g.container.children.len() > 1 {
                return Some("group opacity");
            }
            if g.container.clip && overflows(design, n) {
                return Some("clipped content");
            }
            if g.container
                .children
                .iter()
                .any(|c| design.node(c).is_some_and(|c| c.base().is_mask()))
            {
                return Some("mask");
            }
        }
        Node::Frame(f) => {
            if b.opacity < 0.999 && !f.container.children.is_empty() {
                return Some("frame opacity");
            }
            if f.container
                .children
                .iter()
                .any(|c| design.node(c).is_some_and(|c| c.base().is_mask()))
            {
                return Some("mask");
            }
            if f.container.clip && overflows(design, n) {
                return Some("clipped content");
            }
        }
        _ => {}
    }
    if fills_need(n.fills()) || fill_count > 1 {
        return Some("layered / conic fills");
    }
    if n.strokes().iter().filter(|s| s.is_visible()).count() > 1 {
        return Some("multiple strokes");
    }
    None
}

/// A clipping container whose children reach outside its box.
fn overflows(design: &Design, n: &Node) -> bool {
    let b = n.base();
    n.child_ids()
        .iter()
        .filter_map(|c| design.node(c))
        .any(|c| {
            let r = desyn_core::geometry::bounds_in_parent(c.base());
            r.x < -0.5 || r.y < -0.5 || r.right() > b.width + 0.5 || r.bottom() > b.height + 0.5
        })
}

impl SlideWriter<'_> {
    fn id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }

    fn add_media(&mut self, key: String, ext: &str, bytes: impl FnOnce() -> Vec<u8>) -> String {
        let name = match self.media_index.get(&key) {
            Some(n) => n.clone(),
            None => {
                let n = format!("image{}.{ext}", self.media.len() + 1);
                self.media.push(Media {
                    name: n.clone(),
                    bytes: bytes(),
                });
                self.media_index.insert(key, n.clone());
                n
            }
        };
        let rid = format!("rId{}", self.rels.len() + 2);
        self.rels.push((
            rid.clone(),
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image".into(),
            format!("../media/{name}"),
            false,
        ));
        rid
    }

    /// `<a:hlinkClick>` for a design link: external URLs (safe schemes only) or a jump to another exported slide.
    fn link_xml(&mut self, link: Option<&str>) -> String {
        let rid = format!("rId{}", self.rels.len() + 2);
        match link.and_then(crate::display::parse_link) {
            Some(LinkTarget::Url(url)) => {
                self.rels.push((
                    rid.clone(),
                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
                        .into(),
                    url,
                    true,
                ));
                format!(r#"<a:hlinkClick r:id="{rid}"/>"#)
            }
            Some(LinkTarget::Page(page)) => match self.slide_of.get(&page) {
                Some(n) => {
                    self.rels.push((
                        rid.clone(),
                        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
                            .into(),
                        format!("slide{n}.xml"),
                        false,
                    ));
                    format!(r#"<a:hlinkClick r:id="{rid}" action="ppaction://hlinksldjump"/>"#)
                }
                None => String::new(),
            },
            None => String::new(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn xfrm(
        &self,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        rot: f64,
        flip_x: bool,
        flip_y: bool,
        child: bool,
    ) -> String {
        let k = self.k;
        let mut attrs = String::new();
        let r = rot.rem_euclid(360.0);
        if r.abs() > 1e-6 {
            let _ = write!(attrs, r#" rot="{}""#, (r * 60000.0).round() as i64);
        }
        if flip_x {
            attrs.push_str(r#" flipH="1""#);
        }
        if flip_y {
            attrs.push_str(r#" flipV="1""#);
        }
        let child_xml = if child {
            format!(
                r#"<a:chOff x="{}" y="{}"/><a:chExt cx="{}" cy="{}"/>"#,
                0,
                0,
                emu(w.max(0.0), k).max(1),
                emu(h.max(0.0), k).max(1)
            )
        } else {
            String::new()
        };
        format!(
            r#"<a:xfrm{attrs}><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/>{child_xml}</a:xfrm>"#,
            emu(x, k),
            emu(y, k),
            emu(w.max(0.0), k).max(1),
            emu(h.max(0.0), k).max(1)
        )
    }

    /// `<a:solidFill>` / `<a:gradFill>` / `<a:blipFill>` of a model fill.
    fn fill_xml(&mut self, f: &Fill, opacity: f32) -> Option<String> {
        if !f.is_visible() {
            return None;
        }
        let styles = &self.design.styles;
        let op = f.flags().opacity.unwrap_or(1.0).clamp(0.0, 1.0) as f32 * opacity;
        let stops = |s: &[desyn_core::model::Stop]| -> String {
            let mut out = String::new();
            for st in crate::paint::resolve_stops(s, styles) {
                let _ = write!(
                    out,
                    r#"<a:gs pos="{}">{}</a:gs>"#,
                    (f64::from(st.pos) * 100_000.0).round() as i64,
                    srgb(st.color, op)
                );
            }
            out
        };
        Some(match f {
            Fill::Solid(s) => format!(
                "<a:solidFill>{}</a:solidFill>",
                srgb(crate::paint::resolve(&s.color, styles)?, op)
            ),
            Fill::Linear(l) => {
                let ang = ((l.angle - 90.0).rem_euclid(360.0) * 60000.0).round() as i64;
                format!(
                    r#"<a:gradFill rotWithShape="1"><a:gsLst>{}</a:gsLst><a:lin ang="{ang}" scaled="0"/></a:gradFill>"#,
                    stops(&l.stops)
                )
            }
            Fill::Radial(r) => format!(
                r#"<a:gradFill rotWithShape="1"><a:gsLst>{}</a:gsLst><a:path path="circle"><a:fillToRect l="{}" t="{}" r="{}" b="{}"/></a:path></a:gradFill>"#,
                stops(&r.stops),
                (r.cx * 100_000.0).round() as i64,
                (r.cy * 100_000.0).round() as i64,
                ((1.0 - r.cx) * 100_000.0).round() as i64,
                ((1.0 - r.cy) * 100_000.0).round() as i64
            ),
            Fill::Conic(_) => return None,
            Fill::Image(i) => {
                let img = self
                    .renderer
                    .assets_mut()
                    .image(&i.asset_id, self.design.assets.get(&i.asset_id))
                    .ok()?;
                let (key, ext, bytes): (String, &str, Box<dyn FnOnce() -> Vec<u8>>) =
                    match img.source() {
                        Some(s) if matches!(s.format, SourceFormat::Jpeg) => {
                            let b = s.bytes.to_vec();
                            (format!("asset:{}", i.asset_id), "jpeg", Box::new(move || b))
                        }
                        Some(s) if matches!(s.format, SourceFormat::Png) => {
                            let b = s.bytes.to_vec();
                            (format!("asset:{}", i.asset_id), "png", Box::new(move || b))
                        }
                        _ => {
                            let i2 = img.clone();
                            (
                                format!("asset:{}", i.asset_id),
                                "png",
                                Box::new(move || i2.encode_png()),
                            )
                        }
                    };
                let rid = self.add_media(key, ext, bytes);
                let alpha = if op < 0.999 {
                    format!(
                        r#"<a:alphaModFix amt="{}"/>"#,
                        (op * 100_000.0).round() as i64
                    )
                } else {
                    String::new()
                };
                let mode = match i.mode {
                    desyn_core::model::ImageFillMode::Tile => {
                        r#"<a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" algn="tl"/>"#
                            .to_string()
                    }
                    _ => "<a:stretch><a:fillRect/></a:stretch>".to_string(),
                };
                format!(
                    r#"<a:blipFill rotWithShape="1"><a:blip r:embed="{rid}">{alpha}</a:blip>{mode}</a:blipFill>"#
                )
            }
        })
    }

    fn line_xml(&mut self, s: &Stroke, extra: &str) -> Option<String> {
        if !s.is_visible() {
            return None;
        }
        let fill = s.fills.iter().find_map(|f| self.fill_xml(f, 1.0))?;
        let cap = match s.cap {
            StrokeCap::Butt => "flat",
            StrokeCap::Round => "rnd",
            StrokeCap::Square => "sq",
        };
        let algn = if s.align == StrokeAlign::Inside {
            r#" algn="in""#
        } else {
            ""
        };
        let dash = match &s.dash {
            Some(d) if d.len() >= 2 && s.width > 0.0 => {
                let mut ds = String::new();
                for pair in d.chunks(2) {
                    let dl = (pair[0] / s.width * 100_000.0).round().max(1.0) as i64;
                    let sp = (pair.get(1).copied().unwrap_or(pair[0]) / s.width * 100_000.0)
                        .round()
                        .max(1.0) as i64;
                    let _ = write!(ds, r#"<a:ds d="{dl}" sp="{sp}"/>"#);
                }
                format!("<a:custDash>{ds}</a:custDash>")
            }
            _ => String::new(),
        };
        let join = match s.join {
            StrokeJoin::Miter => format!(
                r#"<a:miter lim="{}"/>"#,
                (s.miter_limit.unwrap_or(4.0) * 100_000.0).round() as i64
            ),
            StrokeJoin::Round => "<a:round/>".into(),
            StrokeJoin::Bevel => "<a:bevel/>".into(),
        };
        Some(format!(
            r#"<a:ln w="{}" cap="{cap}"{algn}>{fill}{dash}{join}{extra}</a:ln>"#,
            emu(s.width.max(0.0), self.k)
        ))
    }

    fn cust_geom(&self, bez: &desyn_core::paths::kurbo::BezPath, w: f64, h: f64) -> String {
        let k = self.k;
        let mut p = String::new();
        let pt = |x: f64, y: f64| format!(r#"<a:pt x="{}" y="{}"/>"#, emu(x, k), emu(y, k));
        for el in bez.elements() {
            match *el {
                PathEl::MoveTo(a) => {
                    let _ = write!(p, "<a:moveTo>{}</a:moveTo>", pt(a.x, a.y));
                }
                PathEl::LineTo(a) => {
                    let _ = write!(p, "<a:lnTo>{}</a:lnTo>", pt(a.x, a.y));
                }
                PathEl::QuadTo(a, b) => {
                    let _ = write!(
                        p,
                        "<a:quadBezTo>{}{}</a:quadBezTo>",
                        pt(a.x, a.y),
                        pt(b.x, b.y)
                    );
                }
                PathEl::CurveTo(a, b, c) => {
                    let _ = write!(
                        p,
                        "<a:cubicBezTo>{}{}{}</a:cubicBezTo>",
                        pt(a.x, a.y),
                        pt(b.x, b.y),
                        pt(c.x, c.y)
                    );
                }
                PathEl::ClosePath => p.push_str("<a:close/>"),
            }
        }
        format!(
            r#"<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="{}" h="{}">{p}</a:path></a:pathLst></a:custGeom>"#,
            emu(w.max(0.0), k).max(1),
            emu(h.max(0.0), k).max(1)
        )
    }

    fn geom_xml(&mut self, n: &Node) -> String {
        let b = n.base();
        let (w, h) = (b.width.max(0.0), b.height.max(0.0));
        match n {
            Node::Rect(_) | Node::Frame(_) | Node::Image(_) | Node::Video(_) => {
                let radii = n.corner_radii();
                let smoothing = n.shaped().and_then(|s| s.corner_smoothing).unwrap_or(0.0);
                if let Node::Image(i) = n
                    && matches!(
                        i.shape,
                        Some(desyn_core::model::ImageShape::Named(
                            desyn_core::model::ImageShapeKind::Ellipse
                        ))
                    )
                {
                    return r#"<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>"#.into();
                }
                if radii.iter().all(|r| *r <= 0.0) {
                    return r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>"#.into();
                }
                if radii.iter().all(|r| (r - radii[0]).abs() < 1e-9) && smoothing <= 0.0 {
                    let adj = (radii[0] / w.min(h).max(1e-9) * 100_000.0)
                        .round()
                        .clamp(0.0, 50_000.0) as i64;
                    return format!(
                        r#"<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val {adj}"/></a:avLst></a:prstGeom>"#
                    );
                }
                let bez = desyn_core::paths::rect_path(w, h, radii, smoothing);
                self.cust_geom(&bez, w, h)
            }
            Node::Ellipse(e) if e.arc.is_none() => {
                r#"<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>"#.into()
            }
            _ => match desyn_core::paths::node_outline(self.design, n.id(), 0.25) {
                Some(o) => self.cust_geom(&o.path, w, h),
                None => r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>"#.into(),
            },
        }
    }

    /// Picture of a node rendered by the rasterizer, placed at its page-space bounds (`origin` = page position
    /// of the current group's top-left).
    fn fallback(&mut self, n: &Node, origin: (f64, f64), why: &str) -> String {
        let Some(r) = self.bounds.get(n.id()).copied() else {
            return String::new();
        };
        if !(r.w > 0.0 && r.h > 0.0) {
            return String::new();
        }
        let scale = FALLBACK_SCALE.min(8192.0 / r.w.max(r.h));
        let ro = PageRenderOptions {
            page: Some(self.page.base.id.clone()),
            scale,
            region: Some(r),
            transparent: true,
            background: None,
            time_ms: self.opts.time_ms,
            bleed: false,
            only: Some(vec![n.id().to_string()]),
            hidden: self.opts.hidden.clone(),
            show_hidden: false,
        };
        let png = match self
            .renderer
            .render_page(self.design, &ro)
            .and_then(|p| encode_png(&p.pixmap, Some(96.0 * scale)))
        {
            Ok(b) => b,
            Err(e) => {
                self.warnings.push(format!("{}: {e}", n.id()));
                return String::new();
            }
        };
        self.warnings.push(format!(
            "{} ({}): exported as a picture ({why})",
            n.base().name,
            n.id()
        ));
        let rid = self.add_media(
            format!("node:{}:{}", self.page.base.id, n.id()),
            "png",
            move || png,
        );
        self.pic_xml(
            &n.base().name,
            &rid,
            r.x - origin.0,
            r.y - origin.1,
            r.w,
            r.h,
            0.0,
            false,
            false,
            "",
            r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>"#,
            "",
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn pic_xml(
        &mut self,
        name: &str,
        rid: &str,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        rot: f64,
        fx: bool,
        fy: bool,
        src_rect: &str,
        geom: &str,
        extra: &str,
    ) -> String {
        let id = self.id();
        format!(
            r#"<p:pic><p:nvPicPr><p:cNvPr id="{id}" name="{}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="{rid}"/>{src_rect}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>{}{geom}{extra}</p:spPr></p:pic>"#,
            esc(name),
            self.xfrm(x, y, w, h, rot, fx, fy, false)
        )
    }

    fn image_xml(&mut self, i: &ImageNode, n: &Node) -> String {
        let b = &i.base;
        let Ok(img) = self
            .renderer
            .assets_mut()
            .image(&i.asset_id, self.design.assets.get(&i.asset_id))
        else {
            self.warnings
                .push(format!("{}: image asset {} missing", b.id, i.asset_id));
            return String::new();
        };
        let (key, ext): (String, &str) = (
            format!("asset:{}", i.asset_id),
            match img.source().map(|s| s.format) {
                Some(SourceFormat::Jpeg) => "jpeg",
                _ => "png",
            },
        );
        let img2 = img.clone();
        let rid = self.add_media(key, ext, move || match img2.source() {
            Some(s) if matches!(s.format, SourceFormat::Jpeg | SourceFormat::Png) => {
                s.bytes.to_vec()
            }
            _ => img2.encode_png(),
        });
        // Source rectangle (fractions of the image cut away on each side) for cover / crop / contain.
        let (iw, ih) = (f64::from(img.width()), f64::from(img.height()));
        let fit = match i.fit {
            ImageFit::Fill => Fit::Fill,
            ImageFit::Fit => Fit::Fit,
            ImageFit::Crop => Fit::Crop(i.crop.as_ref()),
            ImageFit::Tile => Fit::Fill,
        };
        let (t, _) = placement(fit, iw, ih, (iw, ih), b.width, b.height);
        let src = match t.inverse() {
            Some(inv) => {
                let tl = inv.apply(desyn_core::geometry::Point::new(0.0, 0.0));
                let br = inv.apply(desyn_core::geometry::Point::new(b.width, b.height));
                let l = (tl.x / iw * 100_000.0).round() as i64;
                let tp = (tl.y / ih * 100_000.0).round() as i64;
                let r = ((iw - br.x) / iw * 100_000.0).round() as i64;
                let bt = ((ih - br.y) / ih * 100_000.0).round() as i64;
                format!(r#"<a:srcRect l="{l}" t="{tp}" r="{r}" b="{bt}"/>"#)
            }
            None => String::new(),
        };
        let geom = self.geom_xml(n);
        let mut extra = String::new();
        if let Some(ln) = i.strokes.iter().find_map(|s| self.line_xml(s, "")) {
            extra.push_str(&ln);
        }
        extra.push_str(&effects_xml(&b.effects, self.k));
        self.pic_xml(
            &b.name,
            &rid,
            b.x,
            b.y,
            b.width,
            b.height,
            b.rotation,
            b.flipped_x(),
            b.flipped_y(),
            &src,
            &geom,
            &extra,
        )
    }

    fn run_props(&mut self, s: &TextStyle, opacity: f32, link: Option<&str>) -> String {
        let k = self.k;
        let sz = (s.font_size * k * 0.75 * 100.0)
            .round()
            .clamp(100.0, 400_000.0) as i64;
        let mut attrs = format!(r#" lang="en-US" sz="{sz}""#);
        if s.font_weight >= 600.0 {
            attrs.push_str(r#" b="1""#);
        }
        if s.font_style == FontStyle::Italic {
            attrs.push_str(r#" i="1""#);
        }
        match s.decoration {
            TextDecoration::Underline => attrs.push_str(r#" u="sng""#),
            TextDecoration::Strikethrough => attrs.push_str(r#" strike="sngStrike""#),
            TextDecoration::None => {}
        }
        if s.text_case == TextCase::Upper {
            attrs.push_str(r#" cap="all""#);
        }
        if s.letter_spacing.abs() > 1e-9 {
            let spc = (s.letter_spacing * s.font_size * k * 0.75 * 100.0).round() as i64;
            let _ = write!(attrs, r#" spc="{spc}""#);
        }
        let fill = s
            .fills
            .iter()
            .find_map(|f| self.fill_xml(f, opacity))
            .unwrap_or_default();
        let highlight = s
            .highlight
            .as_ref()
            .map(|h| {
                format!(
                    "<a:highlight>{}</a:highlight>",
                    srgb(Color4::from_color(h), 1.0)
                )
            })
            .unwrap_or_default();
        let family = esc(&desyn_text::font::split_family_list(&s.font_family)
            .first()
            .cloned()
            .unwrap_or_else(|| "Inter".into()));
        let link_xml = self.link_xml(link);
        format!(
            r#"<a:rPr{attrs} dirty="0">{fill}{highlight}<a:latin typeface="{family}"/><a:ea typeface="{family}"/><a:cs typeface="{family}"/>{link_xml}</a:rPr>"#
        )
    }

    fn text_xml(&mut self, t: &TextNode) -> String {
        let b = &t.base;
        let k = self.k;
        let p = &t.paragraph;
        let algn = match p.align {
            TextAlign::Left => "l",
            TextAlign::Center => "ctr",
            TextAlign::Right => "r",
            TextAlign::Justify => "just",
        };
        let ln = match p.line_height.unit {
            LineHeightUnit::Percent => format!(
                r#"<a:lnSpc><a:spcPct val="{}"/></a:lnSpc>"#,
                (p.line_height.value * 1000.0).round() as i64
            ),
            LineHeightUnit::Px => format!(
                r#"<a:lnSpc><a:spcPts val="{}"/></a:lnSpc>"#,
                (p.line_height.value * k * 75.0).round() as i64
            ),
            LineHeightUnit::Auto => String::new(),
        };
        let aft = if p.spacing > 0.0 {
            format!(
                r#"<a:spcAft><a:spcPts val="{}"/></a:spcAft>"#,
                (p.spacing * k * 75.0).round() as i64
            )
        } else {
            String::new()
        };
        let bullet = match p.list {
            ListStyle::Bullet => r#"<a:buFont typeface="Arial"/><a:buChar char="•"/>"#,
            ListStyle::Number => {
                r#"<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>"#
            }
            ListStyle::None => "<a:buNone/>",
        };
        let indent = if p.list != ListStyle::None {
            let m = (t.style.font_size * 1.5 * k * EMU_PER_PX).round() as i64;
            format!(r#" marL="{m}" indent="-{m}""#)
        } else if p.indent != 0.0 {
            format!(r#" indent="{}""#, emu(p.indent, k))
        } else {
            String::new()
        };
        let rtl = if p.direction == desyn_core::model::TextDirection::Rtl {
            r#" rtl="1""#
        } else {
            ""
        };
        let ppr = format!(r#"<a:pPr algn="{algn}"{indent}{rtl}>{ln}{aft}{bullet}</a:pPr>"#);
        // Split runs into paragraphs at "\n".
        let mut paragraphs: Vec<Vec<(String, TextStyle)>> = vec![Vec::new()];
        for r in &t.runs {
            let st = match &r.style {
                Some(s) => t.style.merged(s),
                None => t.style.clone(),
            };
            for (i, part) in r.text.split('\n').enumerate() {
                if i > 0 {
                    paragraphs.push(Vec::new());
                }
                if !part.is_empty() {
                    paragraphs
                        .last_mut()
                        .expect("non-empty")
                        .push((part.to_string(), st.clone()));
                }
            }
        }
        let mut body = String::new();
        for para in &paragraphs {
            body.push_str("<a:p>");
            body.push_str(&ppr);
            for (txt, st) in para {
                let text = match st.text_case {
                    TextCase::Lower => txt.to_lowercase(),
                    TextCase::Title => title_case(txt),
                    _ => txt.trim_start_matches('\t').to_string(),
                };
                let rpr = self.run_props(st, 1.0, st.link.as_deref());
                let _ = write!(body, "<a:r>{rpr}<a:t>{}</a:t></a:r>", esc(&text));
            }
            let end = self
                .run_props(&t.style, 1.0, None)
                .replace("<a:rPr", "<a:endParaRPr")
                .replace("</a:rPr>", "</a:endParaRPr>");
            body.push_str(&end);
            body.push_str("</a:p>");
        }
        let anchor = match t.vertical_align {
            VerticalAlign::Top => "t",
            VerticalAlign::Middle => "ctr",
            VerticalAlign::Bottom => "b",
        };
        let (wrap, autofit) = match t.auto_resize {
            desyn_core::model::AutoResize::Width => ("none", "<a:spAutoFit/>"),
            desyn_core::model::AutoResize::Height => ("square", "<a:spAutoFit/>"),
            desyn_core::model::AutoResize::None => ("square", "<a:noAutofit/>"),
        };
        let id = self.id();
        format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>{}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>{}</p:spPr><p:txBody><a:bodyPr wrap="{wrap}" lIns="0" tIns="0" rIns="0" bIns="0" anchor="{anchor}" rtlCol="0">{autofit}</a:bodyPr><a:lstStyle/>{body}</p:txBody></p:sp>"#,
            esc(&b.name),
            self.xfrm(
                b.x,
                b.y,
                b.width,
                b.height,
                b.rotation,
                b.flipped_x(),
                b.flipped_y(),
                false
            ),
            effects_xml(&b.effects, k)
        )
    }

    fn shape_xml(&mut self, n: &Node, txt_body: &str) -> String {
        let b = n.base();
        let geom = self.geom_xml(n);
        let fill = n
            .fills()
            .iter()
            .find_map(|f| self.fill_xml(f, b.opacity.clamp(0.0, 1.0) as f32))
            .unwrap_or_else(|| "<a:noFill/>".into());
        let ln = n
            .strokes()
            .iter()
            .find_map(|s| self.line_xml(s, ""))
            .unwrap_or_else(|| "<a:ln><a:noFill/></a:ln>".into());
        let id = self.id();
        let link = self.link_xml(b.link.as_deref());
        format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{}"{}>{link}</p:cNvPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>{}{geom}{fill}{ln}{}</p:spPr>{txt_body}</p:sp>"#,
            esc(&b.name),
            b.alt
                .as_deref()
                .map(|a| format!(r#" descr="{}""#, esc(a)))
                .unwrap_or_default(),
            self.xfrm(
                b.x,
                b.y,
                b.width,
                b.height,
                b.rotation,
                b.flipped_x(),
                b.flipped_y(),
                false
            ),
            effects_xml(&b.effects, self.k)
        )
    }

    fn line_node_xml(&mut self, n: &Node) -> String {
        let Node::Line(l) = n else {
            return String::new();
        };
        let b = &l.base;
        let head = |c: Cap, tag: &str| -> String {
            let t = match c {
                Cap::None | Cap::Bar | Cap::Square => return String::new(),
                Cap::Arrow => "arrow",
                Cap::Triangle => "triangle",
                Cap::Circle => "oval",
                Cap::Diamond => "diamond",
            };
            format!(r#"<a:{tag} type="{t}" w="med" len="med"/>"#)
        };
        let ends = format!(
            "{}{}",
            head(l.start_cap, "headEnd"),
            head(l.end_cap, "tailEnd")
        );
        let ln = l
            .strokes
            .iter()
            .find_map(|s| self.line_xml(s, &ends))
            .unwrap_or_else(|| "<a:ln><a:noFill/></a:ln>".into());
        let id = self.id();
        format!(
            r#"<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{id}" name="{}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>{}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>{ln}{}</p:spPr></p:cxnSp>"#,
            esc(&b.name),
            self.xfrm(
                b.x,
                b.y,
                b.width,
                0.0,
                b.rotation,
                b.flipped_x(),
                b.flipped_y(),
                false
            ),
            effects_xml(&b.effects, self.k)
        )
    }

    /// Shapes of `ids` (children of a container at page position `origin`).
    fn children_xml(&mut self, ids: &[Id], origin: (f64, f64), depth: usize) -> String {
        let mut out = String::new();
        for id in ids {
            let Some(n) = self.design.node(id) else {
                continue;
            };
            if !n.base().visible || self.opts.hidden.contains(id) {
                continue;
            }
            out.push_str(&self.node_xml(n, origin, depth));
        }
        out
    }

    fn node_xml(&mut self, n: &Node, origin: (f64, f64), depth: usize) -> String {
        if depth > 64 {
            return String::new();
        }
        if n.base().is_mask() {
            // Masks are rendered with their group (see `needs_fallback`).
            return String::new();
        }
        if let Some(why) = needs_fallback(self.design, n) {
            return self.fallback(n, origin, why);
        }
        let b = n.base();
        match n {
            Node::Text(t) => self.text_xml(t),
            Node::Line(_) => self.line_node_xml(n),
            Node::Image(i) => self.image_xml(i, n),
            Node::Video(v) => match v.poster_asset_id.as_deref() {
                Some(_) => self.fallback(n, origin, "video poster"),
                None => self.shape_xml(n, ""),
            },
            Node::Group(g) => {
                let id = self.id();
                let inner_origin = (origin.0 + b.x, origin.1 + b.y);
                let kids = self.children_xml(&g.container.children, inner_origin, depth + 1);
                format!(
                    r#"<p:grpSp><p:nvGrpSpPr><p:cNvPr id="{id}" name="{}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>{}</p:grpSpPr>{kids}</p:grpSp>"#,
                    esc(&b.name),
                    self.xfrm(
                        b.x,
                        b.y,
                        b.width,
                        b.height,
                        b.rotation,
                        b.flipped_x(),
                        b.flipped_y(),
                        true
                    )
                )
            }
            Node::Frame(f) => {
                let id = self.id();
                let inner_origin = (origin.0 + b.x, origin.1 + b.y);
                // The frame's own fill / stroke as a shape at (0,0) inside the group.
                let mut frame_shape = n.clone();
                {
                    let fb = frame_shape.base_mut();
                    fb.x = 0.0;
                    fb.y = 0.0;
                    fb.rotation = 0.0;
                    fb.flip_x = None;
                    fb.flip_y = None;
                }
                let shape = self.shape_xml(&frame_shape, "");
                let kids = self.children_xml(&f.container.children, inner_origin, depth + 1);
                format!(
                    r#"<p:grpSp><p:nvGrpSpPr><p:cNvPr id="{id}" name="{}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>{}</p:grpSpPr>{shape}{kids}</p:grpSp>"#,
                    esc(&b.name),
                    self.xfrm(
                        b.x,
                        b.y,
                        b.width,
                        b.height,
                        b.rotation,
                        b.flipped_x(),
                        b.flipped_y(),
                        true
                    )
                )
            }
            Node::Audio(_) | Node::Root(_) | Node::Page(_) => String::new(),
            _ => self.shape_xml(n, ""),
        }
    }

    fn background_xml(&mut self) -> String {
        if !matches!(self.opts.background, Background::Page) {
            return match self.opts.background {
                Background::Color(c) => format!(
                    "<p:bg><p:bgPr><a:solidFill>{}</a:solidFill><a:effectLst/></p:bgPr></p:bg>",
                    srgb(c, 1.0)
                ),
                _ => String::new(),
            };
        }
        let visible: Vec<&Fill> = self
            .page
            .background
            .iter()
            .filter(|f| f.is_visible())
            .collect();
        if visible.len() == 1
            && !matches!(visible[0], Fill::Conic(_))
            && let Some(f) = self.fill_xml(visible[0], 1.0)
        {
            return format!("<p:bg><p:bgPr>{f}<a:effectLst/></p:bgPr></p:bg>");
        }
        String::new()
    }

    /// Background that needs a picture (several fills, conic gradients).
    fn background_picture(&mut self) -> String {
        if !matches!(self.opts.background, Background::Page) {
            return String::new();
        }
        let visible: Vec<&Fill> = self
            .page
            .background
            .iter()
            .filter(|f| f.is_visible())
            .collect();
        if visible.len() <= 1 && !visible.iter().any(|f| matches!(f, Fill::Conic(_))) {
            return String::new();
        }
        let (w, h) = (self.page.base.width, self.page.base.height);
        let mut ro = PageRenderOptions {
            page: Some(self.page.base.id.clone()),
            scale: FALLBACK_SCALE.min(8192.0 / w.max(h).max(1.0)),
            ..PageRenderOptions::default()
        };
        // Render only the background: hide every child of the page.
        ro.hidden = self.page.container.children.clone();
        let Ok(png) = self
            .renderer
            .render_page(self.design, &ro)
            .and_then(|p| encode_png(&p.pixmap, None))
        else {
            return String::new();
        };
        let rid = self.add_media(format!("bg:{}", self.page.base.id), "png", move || png);
        self.pic_xml(
            "Background",
            &rid,
            0.0,
            0.0,
            w,
            h,
            0.0,
            false,
            false,
            "",
            r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>"#,
            "",
        )
    }
}

fn title_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut start = true;
    for c in s.chars() {
        if start && c.is_alphabetic() {
            out.extend(c.to_uppercase());
            start = false;
        } else {
            out.push(c);
            if c.is_whitespace() {
                start = true;
            } else if c.is_alphabetic() {
                start = false;
            }
        }
    }
    out
}

fn transition_xml(p: &PageNode) -> String {
    let Some(t) = &p.transition else {
        return String::new();
    };
    let el = match t.kind {
        TransitionKind::None => return String::new(),
        TransitionKind::Fade => "<p:fade/>",
        TransitionKind::Dissolve => "<p:dissolve/>",
        TransitionKind::Slide => r#"<p:cover dir="l"/>"#,
        TransitionKind::Push => r#"<p:push dir="l"/>"#,
        TransitionKind::Zoom => "<p:zoom/>",
    };
    let spd = if t.duration_ms < 600.0 {
        "fast"
    } else if t.duration_ms < 1200.0 {
        "med"
    } else {
        "slow"
    };
    let adv = p
        .duration_ms
        .filter(|d| d.is_finite() && *d > 0.0)
        .map(|d| format!(r#" advTm="{}""#, d.round() as i64))
        .unwrap_or_default();
    format!(r#"<p:transition spd="{spd}"{adv}>{el}</p:transition>"#)
}

fn notes_xml(text: &str, slide_no: usize) -> String {
    let mut paras = String::new();
    for line in text.split('\n') {
        let _ = write!(
            paras,
            r#"<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>{}</a:t></a:r></a:p>"#,
            esc(line)
        );
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes {NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image {slide_no}"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes {slide_no}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"#
    )
}

const THEME: &str = r#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Desyn"><a:themeElements><a:clrScheme name="Desyn"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1B1446"/></a:dk2><a:lt2><a:srgbClr val="F3F1EC"/></a:lt2><a:accent1><a:srgbClr val="FFB02E"/></a:accent1><a:accent2><a:srgbClr val="4F8CFF"/></a:accent2><a:accent3><a:srgbClr val="2FBF71"/></a:accent3><a:accent4><a:srgbClr val="E5484D"/></a:accent4><a:accent5><a:srgbClr val="A463F2"/></a:accent5><a:accent6><a:srgbClr val="14B8A6"/></a:accent6><a:hlink><a:srgbClr val="4F8CFF"/></a:hlink><a:folHlink><a:srgbClr val="A463F2"/></a:folHlink></a:clrScheme><a:fontScheme name="Desyn"><a:majorFont><a:latin typeface="Instrument Serif"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Inter"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Desyn"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"#;

const CLR_MAP: &str = r#"bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink""#;

const EMPTY_TREE: &str = r#"<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>"#;

fn level_styles() -> String {
    let mut s = String::new();
    for i in 1..=9 {
        let _ = write!(
            s,
            r#"<a:lvl{i}pPr marL="{}" algn="l" defTabSz="914400"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl{i}pPr>"#,
            (i - 1) * 457_200
        );
    }
    s
}

fn rels_xml(rels: &[(String, String, String, bool)]) -> String {
    let mut out = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for (id, ty, target, external) in rels {
        let _ = write!(
            out,
            r#"<Relationship Id="{id}" Type="{ty}" Target="{}"{}/>"#,
            esc(target),
            if *external {
                r#" TargetMode="External""#
            } else {
                ""
            }
        );
    }
    out.push_str("</Relationships>");
    out
}

const REL_SLIDE_LAYOUT: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const REL_NOTES: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

/// Exports pages as a PowerPoint presentation.
pub fn export_pptx(
    renderer: &mut Renderer,
    design: &Design,
    pages: &[Id],
    opts: &ExportOptions,
) -> Result<ExportOutput, RenderError> {
    let first = match design.node(&pages[0]) {
        Some(Node::Page(p)) => p,
        _ => return Err(RenderError::NoPage(pages[0].clone())),
    };
    let (pw, ph) = (first.base.width.max(1.0), first.base.height.max(1.0));
    // Fit the slide into PowerPoint's size limits, scaling every coordinate alike.
    let k = {
        let long = pw.max(ph) * EMU_PER_PX;
        let short = pw.min(ph) * EMU_PER_PX;
        if long > MAX_SLIDE_EMU {
            MAX_SLIDE_EMU / long
        } else if short < MIN_SLIDE_EMU {
            (MIN_SLIDE_EMU / short).min(MAX_SLIDE_EMU / long)
        } else {
            1.0
        }
    };
    let mut media: Vec<Media> = Vec::new();
    let mut media_index: HashMap<String, String> = HashMap::new();
    let mut slides: Vec<SlideOut> = Vec::new();
    let mut warnings = Vec::new();
    let mut missing_assets = Vec::new();
    let slide_of: HashMap<String, usize> = pages
        .iter()
        .enumerate()
        .map(|(i, p)| (p.clone(), i + 1))
        .collect();
    for page_id in pages {
        let Some(Node::Page(page)) = design.node(page_id) else {
            return Err(RenderError::NoPage(page_id.clone()));
        };
        let dl: DisplayList = renderer.build(
            design,
            &BuildOptions {
                page: Some(page_id.clone()),
                time_ms: opts.time_ms,
                hidden: opts.hidden.clone(),
                ..BuildOptions::default()
            },
        )?;
        missing_assets.extend(dl.missing_assets.iter().cloned());
        let mut bounds = HashMap::new();
        collect_bounds(&dl.root, &Affine::IDENTITY, &mut bounds);
        let mut w = SlideWriter {
            design,
            page,
            k,
            next_id: 1,
            rels: Vec::new(),
            media: &mut media,
            media_index: &mut media_index,
            bounds,
            renderer,
            opts,
            warnings: Vec::new(),
            slide_of: &slide_of,
        };
        let bg = w.background_xml();
        let bg_pic = w.background_picture();
        let children = match &opts.only {
            Some(only) => only.clone(),
            None => page.container.children.clone(),
        };
        let shapes = w.children_xml(&children, (0.0, 0.0), 0);
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld {NS}><p:cSld name="{}">{bg}<p:spTree>{EMPTY_TREE}{bg_pic}{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>{}</p:sld>"#,
            esc(&page.base.name),
            transition_xml(page)
        );
        warnings.append(&mut w.warnings);
        let rels = std::mem::take(&mut w.rels);
        slides.push(SlideOut {
            xml,
            rels,
            notes: page.base.notes.clone().filter(|n| !n.trim().is_empty()),
        });
    }
    let has_notes = slides.iter().any(|s| s.notes.is_some());
    let (cx, cy) = (emu(pw, k), emu(ph, k));
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let o = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let put = |zip: &mut zip::ZipWriter<Cursor<Vec<u8>>>,
               name: &str,
               data: &[u8],
               opt: zip::write::SimpleFileOptions|
     -> Result<(), RenderError> {
        zip.start_file(name, opt)
            .map_err(|e| RenderError::Encode(e.to_string()))?;
        zip.write_all(data)
            .map_err(|e| RenderError::Encode(e.to_string()))
    };
    // [Content_Types].xml
    let mut ct = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>"#,
    );
    for (i, s) in slides.iter().enumerate() {
        let _ = write!(
            ct,
            r#"<Override PartName="/ppt/slides/slide{}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>"#,
            i + 1
        );
        if s.notes.is_some() {
            let _ = write!(
                ct,
                r#"<Override PartName="/ppt/notesSlides/notesSlide{}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>"#,
                i + 1
            );
        }
    }
    if has_notes {
        ct.push_str(r#"<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>"#);
    }
    ct.push_str("</Types>");
    put(&mut zip, "[Content_Types].xml", ct.as_bytes(), o)?;
    put(
        &mut zip,
        "_rels/.rels",
        rels_xml(&[
            ("rId1".into(), "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument".into(), "ppt/presentation.xml".into(), false),
            ("rId2".into(), "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties".into(), "docProps/core.xml".into(), false),
            ("rId3".into(), "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties".into(), "docProps/app.xml".into(), false),
        ])
        .as_bytes(),
        o,
    )?;
    let title = esc(&design.name);
    put(
        &mut zip,
        "docProps/core.xml",
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>{title}</dc:title><dc:creator>Desyn</dc:creator></cp:coreProperties>"#).as_bytes(),
        o,
    )?;
    put(
        &mut zip,
        "docProps/app.xml",
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Desyn</Application><Slides>{}</Slides><PresentationFormat>Custom</PresentationFormat></Properties>"#, slides.len()).as_bytes(),
        o,
    )?;
    // Presentation.
    let mut sld_ids = String::new();
    let mut pres_rels = vec![(
        "rId1".to_string(),
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"
            .to_string(),
        "slideMasters/slideMaster1.xml".to_string(),
        false,
    )];
    for i in 0..slides.len() {
        let rid = format!("rId{}", i + 2);
        let _ = write!(sld_ids, r#"<p:sldId id="{}" r:id="{rid}"/>"#, 256 + i);
        pres_rels.push((
            rid,
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide".into(),
            format!("slides/slide{}.xml", i + 1),
            false,
        ));
    }
    let n = slides.len() + 2;
    pres_rels.push((
        format!("rId{n}"),
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps".into(),
        "presProps.xml".into(),
        false,
    ));
    pres_rels.push((
        format!("rId{}", n + 1),
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps".into(),
        "viewProps.xml".into(),
        false,
    ));
    pres_rels.push((
        format!("rId{}", n + 2),
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme".into(),
        "theme/theme1.xml".into(),
        false,
    ));
    pres_rels.push((
        format!("rId{}", n + 3),
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles".into(),
        "tableStyles.xml".into(),
        false,
    ));
    let notes_master = if has_notes {
        let rid = format!("rId{}", n + 4);
        pres_rels.push((
            rid.clone(),
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster"
                .into(),
            "notesMasters/notesMaster1.xml".into(),
            false,
        ));
        format!(r#"<p:notesMasterIdLst><p:notesMasterId r:id="{rid}"/></p:notesMasterIdLst>"#)
    } else {
        String::new()
    };
    put(
        &mut zip,
        "ppt/presentation.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation {NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>{notes_master}<p:sldIdLst>{sld_ids}</p:sldIdLst><p:sldSz cx="{cx}" cy="{cy}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle>{}</p:defaultTextStyle></p:presentation>"#,
            level_styles()
        )
        .as_bytes(),
        o,
    )?;
    put(
        &mut zip,
        "ppt/_rels/presentation.xml.rels",
        rels_xml(&pres_rels).as_bytes(),
        o,
    )?;
    put(
        &mut zip,
        "ppt/presProps.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr {NS}/>"#
        )
        .as_bytes(),
        o,
    )?;
    put(
        &mut zip,
        "ppt/viewProps.xml",
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr {NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>"#).as_bytes(),
        o,
    )?;
    put(
        &mut zip,
        "ppt/tableStyles.xml",
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>"#,
        o,
    )?;
    put(
        &mut zip,
        "ppt/theme/theme1.xml",
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>{THEME}"#).as_bytes(),
        o,
    )?;
    put(
        &mut zip,
        "ppt/slideMasters/slideMaster1.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster {NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>{EMPTY_TREE}</p:spTree></p:cSld><p:clrMap {CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle>{0}</p:titleStyle><p:bodyStyle>{0}</p:bodyStyle><p:otherStyle>{0}</p:otherStyle></p:txStyles></p:sldMaster>"#,
            level_styles()
        )
        .as_bytes(),
        o,
    )?;
    put(
        &mut zip,
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        rels_xml(&[
            (
                "rId1".into(),
                REL_SLIDE_LAYOUT.into(),
                "../slideLayouts/slideLayout1.xml".into(),
                false,
            ),
            (
                "rId2".into(),
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme".into(),
                "../theme/theme1.xml".into(),
                false,
            ),
        ])
        .as_bytes(),
        o,
    )?;
    put(
        &mut zip,
        "ppt/slideLayouts/slideLayout1.xml",
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout {NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>{EMPTY_TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#).as_bytes(),
        o,
    )?;
    put(
        &mut zip,
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        rels_xml(&[(
            "rId1".into(),
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"
                .into(),
            "../slideMasters/slideMaster1.xml".into(),
            false,
        )])
        .as_bytes(),
        o,
    )?;
    if has_notes {
        put(
            &mut zip,
            "ppt/theme/theme2.xml",
            format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>{THEME}"#).as_bytes(),
            o,
        )?;
        put(
            &mut zip,
            "ppt/notesMasters/notesMaster1.xml",
            format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notesMaster {NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>{EMPTY_TREE}</p:spTree></p:cSld><p:clrMap {CLR_MAP}/><p:notesStyle>{}</p:notesStyle></p:notesMaster>"#, level_styles()).as_bytes(),
            o,
        )?;
        put(
            &mut zip,
            "ppt/notesMasters/_rels/notesMaster1.xml.rels",
            rels_xml(&[(
                "rId1".into(),
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme".into(),
                "../theme/theme2.xml".into(),
                false,
            )])
            .as_bytes(),
            o,
        )?;
    }
    for (i, s) in slides.iter().enumerate() {
        let no = i + 1;
        put(
            &mut zip,
            &format!("ppt/slides/slide{no}.xml"),
            s.xml.as_bytes(),
            o,
        )?;
        let mut rels = vec![(
            "rId1".to_string(),
            REL_SLIDE_LAYOUT.to_string(),
            "../slideLayouts/slideLayout1.xml".to_string(),
            false,
        )];
        rels.extend(s.rels.iter().cloned());
        if let Some(text) = &s.notes {
            rels.push((
                format!("rId{}", rels.len() + 1),
                REL_NOTES.into(),
                format!("../notesSlides/notesSlide{no}.xml"),
                false,
            ));
            put(
                &mut zip,
                &format!("ppt/notesSlides/notesSlide{no}.xml"),
                notes_xml(text, no).as_bytes(),
                o,
            )?;
            put(
                &mut zip,
                &format!("ppt/notesSlides/_rels/notesSlide{no}.xml.rels"),
                rels_xml(&[
                    ("rId1".into(), "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster".into(), "../notesMasters/notesMaster1.xml".into(), false),
                    ("rId2".into(), "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide".into(), format!("../slides/slide{no}.xml"), false),
                ])
                .as_bytes(),
                o,
            )?;
        }
        put(
            &mut zip,
            &format!("ppt/slides/_rels/slide{no}.xml.rels"),
            rels_xml(&rels).as_bytes(),
            o,
        )?;
    }
    for m in &media {
        put(&mut zip, &format!("ppt/media/{}", m.name), &m.bytes, stored)?;
    }
    let bytes = zip
        .finish()
        .map_err(|e| RenderError::Encode(e.to_string()))?
        .into_inner();
    missing_assets.sort();
    missing_assets.dedup();
    Ok(ExportOutput {
        bytes,
        mime: Format::Pptx.mime(),
        extension: "pptx",
        pages: slides.len(),
        missing_assets,
        missing_fonts: Vec::new(),
        warnings,
    })
}
