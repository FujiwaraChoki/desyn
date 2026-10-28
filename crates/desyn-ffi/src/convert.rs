//! Conversions between engine types and FFI records.

use desyn_core::geometry as geo;
use desyn_core::hit as core_hit;
use desyn_core::snap as core_snap;
use desyn_raster::Color4;
use desyn_raster::tiny_skia::IntRect;

use crate::error::EngineError;
use crate::types::*;

impl From<geo::Point> for DesignPoint {
    fn from(p: geo::Point) -> Self {
        DesignPoint { x: p.x, y: p.y }
    }
}

impl From<DesignPoint> for geo::Point {
    fn from(p: DesignPoint) -> Self {
        geo::Point::new(p.x, p.y)
    }
}

impl From<geo::Rect> for DesignRect {
    fn from(r: geo::Rect) -> Self {
        DesignRect {
            x: r.x,
            y: r.y,
            width: r.w,
            height: r.h,
        }
    }
}

impl From<DesignRect> for geo::Rect {
    fn from(r: DesignRect) -> Self {
        geo::Rect::new(r.x, r.y, r.width, r.height)
    }
}

impl From<geo::Affine> for Affine {
    fn from(t: geo::Affine) -> Self {
        Affine {
            a: t.a,
            b: t.b,
            c: t.c,
            d: t.d,
            tx: t.e,
            ty: t.f,
        }
    }
}

impl From<Affine> for geo::Affine {
    fn from(t: Affine) -> Self {
        geo::Affine::new([t.a, t.b, t.c, t.d, t.tx, t.ty])
    }
}

impl From<geo::OrientedBox> for OrientedBox {
    fn from(b: geo::OrientedBox) -> Self {
        OrientedBox {
            transform: b.transform.into(),
            width: b.width,
            height: b.height,
        }
    }
}

impl From<OrientedBox> for geo::OrientedBox {
    fn from(b: OrientedBox) -> Self {
        geo::OrientedBox {
            transform: b.transform.into(),
            width: b.width,
            height: b.height,
        }
    }
}

impl From<IntRect> for PixelRect {
    fn from(r: IntRect) -> Self {
        PixelRect {
            x: r.x().max(0) as u32,
            y: r.y().max(0) as u32,
            width: r.width(),
            height: r.height(),
        }
    }
}

impl From<Viewport> for desyn_raster::Viewport {
    fn from(v: Viewport) -> Self {
        desyn_raster::Viewport {
            x: v.x,
            y: v.y,
            zoom: v.zoom,
            width: v.width,
            height: v.height,
            device_scale: v.device_scale,
        }
    }
}

impl From<HitOptions> for core_hit::HitOptions {
    fn from(o: HitOptions) -> Self {
        core_hit::HitOptions {
            deep: o.deep,
            include_locked: o.include_locked,
            include_hidden: o.include_hidden,
            tolerance: if o.tolerance.is_finite() {
                o.tolerance.max(0.0)
            } else {
                0.0
            },
        }
    }
}

impl From<MarqueeMode> for core_hit::MarqueeMode {
    fn from(m: MarqueeMode) -> Self {
        match m {
            MarqueeMode::Contain => core_hit::MarqueeMode::Contain,
            MarqueeMode::Intersect => core_hit::MarqueeMode::Intersect,
        }
    }
}

impl From<core_hit::SelectionBounds> for SelectionBounds {
    fn from(s: core_hit::SelectionBounds) -> Self {
        SelectionBounds {
            aabb: s.aabb.into(),
            obb: s.obb.into(),
            rotation: s.rotation,
        }
    }
}

impl From<core_hit::HandleKind> for HandleKind {
    fn from(k: core_hit::HandleKind) -> Self {
        use core_hit::HandleKind as K;
        match k {
            K::TopLeft => HandleKind::TopLeft,
            K::Top => HandleKind::Top,
            K::TopRight => HandleKind::TopRight,
            K::Right => HandleKind::Right,
            K::BottomRight => HandleKind::BottomRight,
            K::Bottom => HandleKind::Bottom,
            K::BottomLeft => HandleKind::BottomLeft,
            K::Left => HandleKind::Left,
        }
    }
}

impl From<HandleKind> for core_hit::HandleKind {
    fn from(k: HandleKind) -> Self {
        use core_hit::HandleKind as K;
        match k {
            HandleKind::TopLeft => K::TopLeft,
            HandleKind::Top => K::Top,
            HandleKind::TopRight => K::TopRight,
            HandleKind::Right => K::Right,
            HandleKind::BottomRight => K::BottomRight,
            HandleKind::Bottom => K::Bottom,
            HandleKind::BottomLeft => K::BottomLeft,
            HandleKind::Left => K::Left,
        }
    }
}

impl From<HandleStyle> for core_hit::HandleStyle {
    fn from(s: HandleStyle) -> Self {
        core_hit::HandleStyle {
            size: s.size,
            slop: s.slop,
            rotate_radius: s.rotate_radius,
            min_side_for_edges: s.min_side_for_edges,
        }
    }
}

impl From<core_hit::Handles> for Handles {
    fn from(h: core_hit::Handles) -> Self {
        Handles {
            bounds: h.bounds.into(),
            resize: h
                .resize
                .into_iter()
                .map(|r| ResizeHandle {
                    kind: r.kind.into(),
                    center: r.center.into(),
                    rect: r.rect.into(),
                    cursor_angle: r.cursor_angle,
                    visible: r.visible,
                })
                .collect(),
            rotate: h
                .rotate
                .into_iter()
                .map(|z| RotateZone {
                    corner: z.corner.into(),
                    center: z.center.into(),
                    radius: z.radius,
                })
                .collect(),
        }
    }
}

impl From<core_hit::HandleHit> for HandleHit {
    fn from(h: core_hit::HandleHit) -> Self {
        match h {
            core_hit::HandleHit::Resize(kind) => HandleHit::Resize { kind: kind.into() },
            core_hit::HandleHit::Rotate(corner) => HandleHit::Rotate {
                corner: corner.into(),
            },
        }
    }
}

impl From<ResizeOptions> for core_hit::ResizeOptions {
    fn from(o: ResizeOptions) -> Self {
        core_hit::ResizeOptions {
            keep_aspect: o.keep_aspect,
            from_center: o.from_center,
        }
    }
}

impl From<core_hit::ResizeResult> for ResizeResult {
    fn from(r: core_hit::ResizeResult) -> Self {
        ResizeResult {
            bounds: r.bounds.into(),
            flip_x: r.flip_x,
            flip_y: r.flip_y,
        }
    }
}

impl From<core_snap::Axis> for SnapAxis {
    fn from(a: core_snap::Axis) -> Self {
        match a {
            core_snap::Axis::X => SnapAxis::X,
            core_snap::Axis::Y => SnapAxis::Y,
        }
    }
}

impl From<core_snap::SnapKind> for SnapKind {
    fn from(k: core_snap::SnapKind) -> Self {
        match k {
            core_snap::SnapKind::Edge => SnapKind::Edge,
            core_snap::SnapKind::Center => SnapKind::Center,
            core_snap::SnapKind::PageEdge => SnapKind::PageEdge,
            core_snap::SnapKind::PageCenter => SnapKind::PageCenter,
            core_snap::SnapKind::Guide => SnapKind::Guide,
            core_snap::SnapKind::Grid => SnapKind::Grid,
        }
    }
}

impl From<SnapOptions> for core_snap::SnapOptions {
    fn from(o: SnapOptions) -> Self {
        core_snap::SnapOptions {
            threshold: if o.threshold.is_finite() {
                o.threshold.max(0.0)
            } else {
                0.0
            },
            objects: o.objects,
            page: o.page,
            guides: o.guides,
            grid: o.grid,
            spacing: o.spacing,
        }
    }
}

impl From<ResizeEdges> for core_snap::ResizeEdges {
    fn from(e: ResizeEdges) -> Self {
        core_snap::ResizeEdges {
            left: e.left,
            right: e.right,
            top: e.top,
            bottom: e.bottom,
        }
    }
}

impl From<core_snap::SnapResult> for SnapResult {
    fn from(r: core_snap::SnapResult) -> Self {
        SnapResult {
            dx: r.dx,
            dy: r.dy,
            guides: r
                .guides
                .into_iter()
                .map(|g| SnapGuide {
                    axis: g.axis.into(),
                    pos: g.pos,
                    from: g.from,
                    to: g.to,
                    kind: g.kind.into(),
                })
                .collect(),
            spacing: r
                .spacing
                .into_iter()
                .map(|s| SpacingGuide {
                    axis: s.axis.into(),
                    gap: s.gap,
                    segments: s
                        .segments
                        .into_iter()
                        .map(|(start, end, cross)| SpacingSegment { start, end, cross })
                        .collect(),
                })
                .collect(),
            sizes: r
                .sizes
                .into_iter()
                .map(|m| SizeMatch {
                    axis: m.axis.into(),
                    size: m.size,
                    with: m.with.into(),
                })
                .collect(),
        }
    }
}

impl From<desyn_raster::display::LinkArea> for LinkArea {
    fn from(l: desyn_raster::display::LinkArea) -> Self {
        let (url, page_id) = match l.target {
            desyn_raster::display::LinkTarget::Url(u) => (Some(u), None),
            desyn_raster::display::LinkTarget::Page(p) => (None, Some(p)),
        };
        LinkArea {
            rect: l.rect.into(),
            url,
            page_id,
        }
    }
}

impl From<ExportFormat> for desyn_raster::export::Format {
    fn from(f: ExportFormat) -> Self {
        use desyn_raster::export::Format as F;
        match f {
            ExportFormat::Png => F::Png,
            ExportFormat::Jpeg => F::Jpeg,
            ExportFormat::Webp => F::Webp,
            ExportFormat::Svg => F::Svg,
            ExportFormat::Pdf => F::Pdf,
            ExportFormat::Pptx => F::Pptx,
            ExportFormat::Gif => F::Gif,
        }
    }
}

impl From<desyn_raster::export::ExportOutput> for ExportResult {
    fn from(o: desyn_raster::export::ExportOutput) -> Self {
        ExportResult {
            bytes: o.bytes,
            mime: o.mime.to_string(),
            extension: o.extension.to_string(),
            pages: u32::try_from(o.pages).unwrap_or(u32::MAX),
            missing_assets: o.missing_assets,
            missing_fonts: o.missing_fonts,
            warnings: o.warnings,
        }
    }
}

/// Parses a `#rrggbb` / `#rrggbbaa` color.
pub(crate) fn parse_color(hex: &str) -> Result<Color4, EngineError> {
    Color4::parse_hex(hex.trim()).ok_or_else(|| EngineError::arg(format!("color {hex:?}")))
}

/// Parses an optional color argument.
pub(crate) fn parse_opt_color(hex: Option<&str>) -> Result<Option<Color4>, EngineError> {
    hex.map(parse_color).transpose()
}

/// Validates a design-space rectangle argument.
pub(crate) fn finite_rect(r: DesignRect, what: &str) -> Result<geo::Rect, EngineError> {
    if [r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite()) {
        Ok(r.into())
    } else {
        Err(EngineError::arg(format!("{what} must be finite")))
    }
}

/// Validates a point argument.
pub(crate) fn finite_point(p: DesignPoint, what: &str) -> Result<geo::Point, EngineError> {
    if p.x.is_finite() && p.y.is_finite() {
        Ok(p.into())
    } else {
        Err(EngineError::arg(format!("{what} must be finite")))
    }
}

/// Validates an oriented box argument.
pub(crate) fn finite_box(b: OrientedBox, what: &str) -> Result<geo::OrientedBox, EngineError> {
    let t = b.transform;
    if [t.a, t.b, t.c, t.d, t.tx, t.ty, b.width, b.height]
        .iter()
        .all(|v| v.is_finite())
    {
        Ok(b.into())
    } else {
        Err(EngineError::arg(format!("{what} must be finite")))
    }
}

/// `usize` -> `u32` for counts and indices that cross the FFI.
pub(crate) fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}
