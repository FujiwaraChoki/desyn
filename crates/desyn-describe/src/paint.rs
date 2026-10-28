//! Paint helpers: resolving colors through `DesignStyles`, representative colors of fill stacks, CSS-ish
//! summaries, compositing fill stacks at a point, perceptual distance and contrast repair.

use desyn_core::color::{
    Rgba, blend, conic_gradient_t, contrast_ratio, linear_gradient_t, radial_gradient_t,
    resolve_color, sample_resolved,
};
use desyn_core::{BlendMode, ColorValue, DesignStyles, Fill, ImageFill, Stop};

/// Resolves `Color | ColorRef`.
pub fn resolve(v: &ColorValue, styles: &DesignStyles) -> Option<Rgba> {
    resolve_color(v, styles).map(|c| Rgba::from_color(&c))
}

/// `#rrggbb` (alpha dropped).
pub fn hex6(c: Rgba) -> String {
    let s = c.with_alpha(1.0).to_color();
    s.as_str()[..7].to_string()
}

/// `#rrggbb` or `#rrggbbaa` (alpha kept when below 1).
pub fn hex(c: Rgba) -> String {
    c.to_color().as_str().to_string()
}

fn fill_opacity(f: &Fill) -> f64 {
    f.flags().opacity.unwrap_or(1.0).clamp(0.0, 1.0)
}

fn stop_colors(stops: &[Stop], styles: &DesignStyles) -> Vec<Rgba> {
    stops
        .iter()
        .filter_map(|s| resolve(&s.color, styles))
        .collect()
}

/// Running average used by the TypeScript describe (`mix(acc, c, 1 / (i + 1))`), so both pick the same color.
fn average(colors: &[Rgba]) -> Option<Rgba> {
    let mut it = colors.iter();
    let mut acc = *it.next()?;
    for (i, c) in it.enumerate() {
        let t = 1.0 / (i as f64 + 2.0);
        acc = Rgba::new(
            acc.r + (c.r - acc.r) * t,
            acc.g + (c.g - acc.g) * t,
            acc.b + (c.b - acc.b) * t,
            acc.a + (c.a - acc.a) * t,
        );
    }
    Some(acc)
}

/// Representative color of a fill stack: the top-most visible fill (opacity above 5%); gradients average their
/// stops; an image fill on top yields `None`. Mirrors `fillColor` of `@desyn/ai`.
pub fn representative(fills: &[Fill], styles: &DesignStyles) -> Option<Rgba> {
    representative_paint(fills, styles).map(|(c, _)| c)
}

/// [`representative`] plus the opacity of the fill it comes from (`Fill.opacity`, 1 when unset), for contrast
/// checks that need what actually reaches the page.
pub fn representative_paint(fills: &[Fill], styles: &DesignStyles) -> Option<(Rgba, f64)> {
    for f in fills.iter().rev() {
        if f.flags().visible == Some(false) || fill_opacity(f) <= 0.05 {
            continue;
        }
        match f {
            Fill::Solid(s) => return resolve(&s.color, styles).map(|c| (c, fill_opacity(f))),
            Fill::Image(_) => return None,
            _ => {
                let stops = stop_colors(f.stops().unwrap_or(&[]), styles);
                if let Some(c) = average(&stops) {
                    return Some((c, fill_opacity(f)));
                }
            }
        }
    }
    None
}

/// Whether the top-most visible fill is an image.
pub fn top_is_image(fills: &[Fill]) -> bool {
    fills
        .iter()
        .rev()
        .find(|f| f.flags().visible != Some(false) && fill_opacity(f) > 0.05)
        .is_some_and(|f| matches!(f, Fill::Image(_)))
}

/// Every resolved color a fill stack shows (solid colors and gradient stops), for palettes and brand checks.
pub fn colors_of(fills: &[Fill], styles: &DesignStyles) -> Vec<Rgba> {
    let mut out = Vec::new();
    for f in fills {
        if !f.is_visible() {
            continue;
        }
        match f {
            Fill::Solid(s) => out.extend(resolve(&s.color, styles)),
            Fill::Image(_) => {}
            _ => out.extend(stop_colors(f.stops().unwrap_or(&[]), styles)),
        }
    }
    out
}

/// CSS-ish one-line summary: `"#ffffff"`, `"linear(#ff0000 → #0000ff) @50%"`, `"image(<id>)"`, joined with
/// `" + "`, or `"none"`. Same format as `describeFills` of `@desyn/ai`.
pub fn summarize(fills: &[Fill], styles: &DesignStyles) -> String {
    let parts: Vec<String> = fills
        .iter()
        .filter(|f| f.flags().visible != Some(false))
        .map(|f| {
            let op = match f.flags().opacity {
                Some(o) if o < 1.0 => format!(" @{}%", (o * 100.0).round()),
                _ => String::new(),
            };
            match f {
                Fill::Solid(s) => format!(
                    "{}{op}",
                    resolve_color(&s.color, styles)
                        .map(|c| c.as_str().to_string())
                        .unwrap_or_else(|| "ref".into())
                ),
                Fill::Image(i) => format!("image({}){op}", i.asset_id),
                _ => {
                    let kind = match f {
                        Fill::Linear(_) => "linear",
                        Fill::Radial(_) => "radial",
                        _ => "conic",
                    };
                    let stops: Vec<String> = f
                        .stops()
                        .unwrap_or(&[])
                        .iter()
                        .map(|s| {
                            resolve_color(&s.color, styles)
                                .map(|c| c.as_str().to_string())
                                .unwrap_or_else(|| "ref".into())
                        })
                        .collect();
                    format!("{kind}({}){op}", stops.join(" → "))
                }
            }
        })
        .collect();
    if parts.is_empty() {
        "none".into()
    } else {
        parts.join(" + ")
    }
}

/// What the image layers of a stack show at a point: `(average, darkest, lightest)`.
pub type ImageColors = (Rgba, Rgba, Rgba);

/// Where and how a fill stack is composited.
#[derive(Debug, Clone, Copy)]
pub struct LayerAt {
    /// Box size.
    pub size: (f64, f64),
    /// Box-local point.
    pub point: (f64, f64),
    /// Layer (node) opacity.
    pub opacity: f64,
    /// Layer (node) blend mode.
    pub blend: BlendMode,
}

/// Composites a fill stack at a box-local point over `backdrop` (three variants: average / darkest / lightest
/// image pixels). `image` answers for image fills; when it returns `None` the result is `None` (unknown).
pub fn composite_fills(
    backdrop: [Rgba; 3],
    fills: &[Fill],
    styles: &DesignStyles,
    at: LayerAt,
    image: &mut dyn FnMut(&ImageFill) -> Option<ImageColors>,
) -> Option<[Rgba; 3]> {
    let LayerAt {
        size,
        point: p,
        opacity: layer_opacity,
        blend: layer_blend,
    } = at;
    // Paint the stack into an isolated layer first, then composite the layer with its blend mode and opacity.
    let mut layer = [Rgba::TRANSPARENT; 3];
    let mut painted = false;
    for f in fills {
        if !f.is_visible() {
            continue;
        }
        let op = fill_opacity(f);
        let mode = f.flags().blend.unwrap_or(BlendMode::Normal);
        let src: [Rgba; 3] = match f {
            Fill::Solid(s) => {
                let c = resolve(&s.color, styles)?;
                [c; 3]
            }
            Fill::Image(i) => {
                let (a, d, l) = image(i)?;
                [a, d, l]
            }
            _ => {
                let c = sample_gradient(f, styles, size, p)?;
                [c; 3]
            }
        };
        for k in 0..3 {
            layer[k] = blend(mode, layer[k], src[k].with_alpha(src[k].a * op));
        }
        painted = true;
    }
    if !painted {
        return Some(backdrop);
    }
    let mut out = backdrop;
    for k in 0..3 {
        out[k] = blend(
            layer_blend,
            backdrop[k],
            layer[k].with_alpha(layer[k].a * layer_opacity),
        );
    }
    Some(out)
}

fn sample_gradient(
    f: &Fill,
    styles: &DesignStyles,
    (w, h): (f64, f64),
    (x, y): (f64, f64),
) -> Option<Rgba> {
    let stops = f.stops()?;
    let mut resolved: Vec<(f64, Rgba)> = stops
        .iter()
        .map(|s| {
            (
                s.pos,
                resolve(&s.color, styles).unwrap_or(Rgba::TRANSPARENT),
            )
        })
        .collect();
    if resolved.is_empty() {
        return None;
    }
    let t = match f {
        Fill::Linear(g) => linear_gradient_t(g.angle, w, h, x, y),
        Fill::Radial(g) => radial_gradient_t(g.cx, g.cy, g.rx, g.ry, w, h, x, y),
        Fill::Conic(g) => conic_gradient_t(g.cx, g.cy, g.angle, w, h, x, y),
        _ => return None,
    };
    Some(sample_resolved(&mut resolved, t))
}

/// OKLab distance (the `deltaE` of `@desyn/schema`): about 0.02 is a just-noticeable difference.
pub fn delta_e(a: Rgba, b: Rgba) -> f64 {
    let (l1, a1, b1) = a.to_oklab();
    let (l2, a2, b2) = b.to_oklab();
    ((l1 - l2).powi(2) + (a1 - a2).powi(2) + (b1 - b2).powi(2)).sqrt()
}

/// OKLCH chroma (0 for greys).
pub fn chroma(c: Rgba) -> f64 {
    c.to_oklch().1
}

/// WCAG "large text": at least 24 px, or bold (700+) and at least 18.66 px.
pub fn is_large_text(size: f64, weight: f64) -> bool {
    size >= 24.0 || (weight >= 700.0 && size >= 18.66)
}

/// Contrast after compositing a (possibly translucent) foreground over an opaque background.
pub fn contrast_over(fg: Rgba, bg: Rgba) -> f64 {
    let bg = Rgba { a: 1.0, ..bg };
    let fg = blend(BlendMode::Normal, bg, fg);
    contrast_ratio(fg, bg)
}

/// Adjusts the OKLCH lightness of `fg` (hue and chroma kept) until it reaches `target` contrast on `bg`; black or
/// white when no shade of the hue does. Same search as `ensureContrast` of `@desyn/schema`.
pub fn ensure_contrast(fg: Rgba, bg: Rgba, target: f64) -> Rgba {
    let fg = fg.with_alpha(1.0);
    if contrast_ratio(fg, bg) >= target {
        return fg;
    }
    let (l, c, h) = fg.to_oklch();
    let search = |toward_light: bool| -> Option<(Rgba, f64)> {
        let end = if toward_light { 1.0 } else { 0.0 };
        if contrast_ratio(Rgba::from_oklch(end, c, h, 1.0), bg) < target {
            return None;
        }
        let (mut lo, mut hi) = (l, end);
        for _ in 0..30 {
            let mid = (lo + hi) / 2.0;
            if contrast_ratio(Rgba::from_oklch(mid, c, h, 1.0), bg) >= target {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        Some((Rgba::from_oklch(hi, c, h, 1.0), (hi - l).abs()))
    };
    match (search(true), search(false)) {
        (Some(a), Some(b)) => {
            if a.1 <= b.1 {
                a.0
            } else {
                b.0
            }
        }
        (Some(a), None) => a.0,
        (None, Some(b)) => b.0,
        (None, None) => {
            if contrast_ratio(Rgba::BLACK, bg) >= contrast_ratio(Rgba::WHITE, bg) {
                Rgba::BLACK
            } else {
                Rgba::WHITE
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::Color;

    fn c(s: &str) -> Rgba {
        Rgba::from_color(&Color::new(s).unwrap())
    }

    #[test]
    fn contrast_repair_reaches_target() {
        let bg = c("#ffffff");
        let fixed = ensure_contrast(c("#ffb02e"), bg, 4.7);
        assert!(contrast_ratio(fixed, bg) >= 4.7);
        // Hue kept: still orange-ish (red channel dominant).
        assert!(fixed.r > fixed.b);
    }

    #[test]
    fn summaries_match_ts_format() {
        let styles = DesignStyles::default();
        let fills = vec![Fill::solid(Color::new("#ff0000").unwrap())];
        assert_eq!(summarize(&fills, &styles), "#ff0000");
        assert_eq!(summarize(&[], &styles), "none");
    }

    #[test]
    fn translucent_composite() {
        let white = [Rgba::WHITE; 3];
        let fills = vec![Fill::solid(Color::new("#00000080").unwrap())];
        let out = composite_fills(
            white,
            &fills,
            &DesignStyles::default(),
            LayerAt {
                size: (10.0, 10.0),
                point: (5.0, 5.0),
                opacity: 1.0,
                blend: BlendMode::Normal,
            },
            &mut |_| None,
        )
        .unwrap();
        assert!((out[0].r - 0.498).abs() < 0.01);
    }
}
