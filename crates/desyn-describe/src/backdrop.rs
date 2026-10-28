//! What is painted behind a point: composites the page background and every node below a given paint order
//! (shapes, gradients, image layers through the [`ImageSampler`]) to find the real color text sits on.

use desyn_core::color::Rgba;
use desyn_core::geometry::{Point, Rect};
use desyn_core::{BlendMode, Fill, ImageFill, ImageFillMode, ImageFit, Node};

use crate::paint::{self, ImageColors};
use crate::sampler::ImageSampler;
use crate::scene::Scene;

/// Backdrop at a point.
#[derive(Debug, Clone, Copy)]
pub struct Backdrop {
    /// With average image pixels.
    pub average: Rgba,
    /// With the darkest image pixels.
    pub darkest: Rgba,
    /// With the lightest image pixels.
    pub lightest: Rgba,
    /// An image (photo, image fill, video) shows at this point.
    pub on_image: bool,
    /// An image layer could not be sampled and nothing opaque covers it: the colors are unknown.
    pub unknown: bool,
    /// Top-most node painting at the point (`None` = page background).
    pub top: Option<usize>,
}

/// Normalized source rectangle of an image shown in a `w x h` box, for the box-local `region`.
pub fn source_region(
    mode: SourceMode,
    asset: Option<(f64, f64)>,
    (w, h): (f64, f64),
    region: Rect,
) -> Rect {
    let unit = |r: Rect| {
        let x0 = r.x.clamp(0.0, 1.0);
        let y0 = r.y.clamp(0.0, 1.0);
        let x1 = (r.x + r.w).clamp(0.0, 1.0);
        let y1 = (r.y + r.h).clamp(0.0, 1.0);
        Rect::new(x0, y0, (x1 - x0).max(0.0), (y1 - y0).max(0.0))
    };
    if w <= 0.0 || h <= 0.0 {
        return Rect::new(0.0, 0.0, 1.0, 1.0);
    }
    let stretch = Rect::new(region.x / w, region.y / h, region.w / w, region.h / h);
    let Some((aw, ah)) = asset.filter(|(a, b)| *a > 0.0 && *b > 0.0) else {
        return unit(stretch);
    };
    match mode {
        SourceMode::Stretch => unit(stretch),
        SourceMode::Tile => Rect::new(0.0, 0.0, 1.0, 1.0),
        SourceMode::Crop(c) => unit(Rect::new(
            c.x + stretch.x * c.w,
            c.y + stretch.y * c.h,
            stretch.w * c.w,
            stretch.h * c.h,
        )),
        SourceMode::Cover | SourceMode::Contain => {
            let s = if mode == SourceMode::Cover {
                (w / aw).max(h / ah)
            } else {
                (w / aw).min(h / ah)
            };
            let (dw, dh) = (aw * s, ah * s);
            let (ox, oy) = ((w - dw) / 2.0, (h - dh) / 2.0);
            unit(Rect::new(
                (region.x - ox) / dw,
                (region.y - oy) / dh,
                region.w / dw,
                region.h / dh,
            ))
        }
    }
}

/// How an image maps onto its box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SourceMode {
    /// Scaled to cover, centered (`fit: "fill"`, image fill `"fill"`).
    Cover,
    /// Scaled to fit, centered.
    Contain,
    /// Stretched to the box.
    Stretch,
    /// Repeated (sampled as the whole image).
    Tile,
    /// Normalized crop rectangle stretched to the box.
    Crop(Rect),
}

impl SourceMode {
    /// Mode of an image node.
    pub fn of_node(fit: ImageFit, crop: Option<&desyn_core::Crop>) -> Self {
        match fit {
            ImageFit::Fill => SourceMode::Cover,
            ImageFit::Fit => SourceMode::Contain,
            ImageFit::Tile => SourceMode::Tile,
            ImageFit::Crop => match crop {
                Some(c) => SourceMode::Crop(Rect::new(c.x, c.y, c.w, c.h)),
                None => SourceMode::Cover,
            },
        }
    }

    /// Mode of an image fill.
    pub fn of_fill(f: &ImageFill) -> Self {
        match f.mode {
            ImageFillMode::Fill => SourceMode::Cover,
            ImageFillMode::Fit => SourceMode::Contain,
            ImageFillMode::Tile => SourceMode::Tile,
            ImageFillMode::Stretch => SourceMode::Stretch,
        }
    }
}

/// Neutral stand-in while an unsampled image is in the stack.
const UNKNOWN_GREY: Rgba = Rgba {
    r: 0.5,
    g: 0.5,
    b: 0.5,
    a: 1.0,
};

/// Per-layer image facts collected while compositing.
#[derive(Default)]
struct LayerImages {
    present: bool,
    unknown: bool,
}

/// Composites everything painted strictly below paint order `below` at page point `p` (items in `exclude` are
/// skipped). `region` is the page rectangle used to sample image layers (the text's ink box), so every point of one
/// text shares the sample.
pub fn backdrop_at(
    scene: &mut Scene<'_>,
    below: usize,
    exclude: &[usize],
    p: Point,
    region: Rect,
    mut sampler: Option<&mut (dyn ImageSampler + '_)>,
) -> Backdrop {
    let design = scene.design;
    let styles = &design.styles;
    let mut sample =
        |asset_id: &str, mode: SourceMode, size: (f64, f64), local: Rect| -> Option<ImageColors> {
            let asset = design
                .assets
                .get(asset_id)
                .and_then(|a| Some((a.width?, a.height?)));
            let src = source_region(mode, asset, size, local);
            let s = sampler.as_deref_mut()?.sample(asset_id, src)?;
            Some((s.average, s.darkest, s.lightest))
        };

    // The page renders on white; its background paints over that.
    let page = scene.page;
    let page_size = (page.base.width, page.base.height);
    let mut acc = [Rgba::WHITE; 3];
    let mut on_image;
    let mut unknown;
    {
        let mut li = LayerImages::default();
        let mut image = |f: &ImageFill| {
            li.present = true;
            let r = sample(&f.asset_id, SourceMode::of_fill(f), page_size, region);
            li.unknown |= r.is_none();
            Some(r.unwrap_or((UNKNOWN_GREY, UNKNOWN_GREY, UNKNOWN_GREY)))
        };
        if let Some(c) = paint::composite_fills(
            acc,
            &page.background,
            styles,
            paint::LayerAt {
                size: page_size,
                point: (p.x, p.y),
                opacity: 1.0,
                blend: BlendMode::Normal,
            },
            &mut image,
        ) {
            acc = c;
        }
        on_image = li.present;
        unknown = li.unknown;
    }

    let mut top = None;
    for i in scene.candidates_at(p) {
        if i >= below || exclude.contains(&i) || !scene.items[i].visible {
            continue;
        }
        let paints = matches!(
            scene.items[i].node,
            Node::Rect(_)
                | Node::Frame(_)
                | Node::Ellipse(_)
                | Node::Polygon(_)
                | Node::Star(_)
                | Node::Path(_)
                | Node::Boolean(_)
                | Node::Image(_)
                | Node::Video(_)
                | Node::Qr(_)
        );
        if !paints || !scene.paint_contains(i, p) {
            continue;
        }
        let it = &scene.items[i];
        let b = it.node.base();
        let size = (b.width, b.height);
        let Some(inv) = it.world.inverse() else {
            continue;
        };
        let lp = inv.apply(p);
        let local_region = inv.transform_rect_bbox(&region);
        let (opacity, mode) = (it.opacity, b.blend);
        let mut li = LayerImages::default();
        let result = match it.node {
            Node::Image(img) => {
                li.present = true;
                let s = sample(
                    &img.asset_id,
                    SourceMode::of_node(img.fit, img.crop.as_ref()),
                    size,
                    local_region,
                );
                li.unknown = s.is_none();
                let (a, d, l) = s.unwrap_or((UNKNOWN_GREY, UNKNOWN_GREY, UNKNOWN_GREY));
                Some(composite_layer(acc, [a, d, l], opacity, mode))
            }
            Node::Video(_) => {
                li.present = true;
                li.unknown = true;
                Some(composite_layer(acc, [UNKNOWN_GREY; 3], opacity, mode))
            }
            Node::Qr(q) => Some(composite_layer(
                acc,
                [Rgba::from_color(&q.bg); 3],
                opacity,
                mode,
            )),
            other => {
                let mut image = |f: &ImageFill| {
                    li.present = true;
                    let r = sample(&f.asset_id, SourceMode::of_fill(f), size, local_region);
                    li.unknown |= r.is_none();
                    Some(r.unwrap_or((UNKNOWN_GREY, UNKNOWN_GREY, UNKNOWN_GREY)))
                };
                paint::composite_fills(
                    acc,
                    other.fills(),
                    styles,
                    paint::LayerAt {
                        size,
                        point: (lp.x, lp.y),
                        opacity,
                        blend: mode,
                    },
                    &mut image,
                )
            }
        };
        let Some(next) = result else { continue };
        if next == acc && !li.present {
            continue;
        }
        acc = next;
        top = Some(i);
        if covers(it.node, opacity, mode, styles) {
            // Whatever was below is hidden now.
            on_image = li.present;
            unknown = li.unknown;
        } else {
            on_image |= li.present;
            unknown |= li.unknown;
        }
    }
    Backdrop {
        average: acc[0],
        darkest: acc[1],
        lightest: acc[2],
        on_image,
        unknown,
        top,
    }
}

/// Whether the node paints an opaque layer with normal blending (hides everything below it).
fn covers(node: &Node, opacity: f64, mode: BlendMode, styles: &desyn_core::DesignStyles) -> bool {
    if opacity < 0.99 || mode != BlendMode::Normal {
        return false;
    }
    match node {
        Node::Image(_) | Node::Video(_) | Node::Qr(_) => true,
        other => other.fills().iter().any(|f| {
            f.is_visible()
                && f.flags().opacity.unwrap_or(1.0) >= 0.99
                && f.flags().blend.unwrap_or(BlendMode::Normal) == BlendMode::Normal
                && match f {
                    Fill::Solid(s) => paint::resolve(&s.color, styles).is_some_and(|c| c.a >= 0.99),
                    Fill::Image(_) => true,
                    _ => f
                        .stops()
                        .unwrap_or(&[])
                        .iter()
                        .all(|s| paint::resolve(&s.color, styles).is_some_and(|c| c.a >= 0.99)),
                }
        }),
    }
}

fn composite_layer(acc: [Rgba; 3], src: [Rgba; 3], opacity: f64, mode: BlendMode) -> [Rgba; 3] {
    let mut out = acc;
    for k in 0..3 {
        out[k] = desyn_core::color::blend(mode, acc[k], src[k].with_alpha(src[k].a * opacity));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_mapping() {
        // 200x100 image covering a 100x100 box: scale 1, the middle half of the image shows.
        let r = source_region(
            SourceMode::Cover,
            Some((200.0, 100.0)),
            (100.0, 100.0),
            Rect::new(0.0, 0.0, 100.0, 100.0),
        );
        assert!((r.x - 0.25).abs() < 1e-9 && (r.w - 0.5).abs() < 1e-9 && r.h == 1.0);
        let r = source_region(
            SourceMode::Crop(Rect::new(0.5, 0.5, 0.5, 0.5)),
            Some((10.0, 10.0)),
            (100.0, 100.0),
            Rect::new(0.0, 0.0, 50.0, 50.0),
        );
        assert!((r.x - 0.5).abs() < 1e-9 && (r.w - 0.25).abs() < 1e-9);
    }
}
