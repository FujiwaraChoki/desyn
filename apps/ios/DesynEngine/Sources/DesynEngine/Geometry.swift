import CoreGraphics
import Foundation

// Conversions between the engine's geometry records and CoreGraphics. Engine geometry is in design px (page
// coordinates); views work in points. `Viewport` maps between them.

public extension DesignPoint {
    init(_ p: CGPoint) {
        self.init(x: Double(p.x), y: Double(p.y))
    }

    var cgPoint: CGPoint { CGPoint(x: x, y: y) }
}

public extension DesignRect {
    init(_ r: CGRect) {
        self.init(x: Double(r.minX), y: Double(r.minY), width: Double(r.width), height: Double(r.height))
    }

    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

public extension PixelRect {
    var cgRect: CGRect { CGRect(x: Int(x), y: Int(y), width: Int(width), height: Int(height)) }
}

public extension Affine {
    static let identity = Affine(a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0)

    init(_ t: CGAffineTransform) {
        self.init(a: Double(t.a), b: Double(t.b), c: Double(t.c), d: Double(t.d), tx: Double(t.tx), ty: Double(t.ty))
    }

    /// Same matrix layout as the engine (`x' = a x + c y + tx`, `y' = b x + d y + ty`).
    var cgAffineTransform: CGAffineTransform { CGAffineTransform(a: a, b: b, c: c, d: d, tx: tx, ty: ty) }

    func apply(_ p: DesignPoint) -> DesignPoint {
        DesignPoint(x: a * p.x + c * p.y + tx, y: b * p.x + d * p.y + ty)
    }

    /// `self` after `other` (applies `other` first).
    func concatenating(_ other: Affine) -> Affine {
        Affine(other.cgAffineTransform.concatenating(cgAffineTransform))
    }

    /// The inverse (identity when the matrix is singular).
    var inverted: Affine {
        let det = a * d - b * c
        guard det != 0, det.isFinite else { return .identity }
        return Affine(cgAffineTransform.inverted())
    }

    /// Rotation in degrees (clockwise in the y-down page space).
    var rotationDegrees: Double { atan2(b, a) * 180 / .pi }
}

public extension OrientedBox {
    /// An axis-aligned box.
    init(_ rect: DesignRect) {
        self.init(transform: Affine(a: 1, b: 0, c: 0, d: 1, tx: rect.x, ty: rect.y), width: rect.width, height: rect.height)
    }

    /// Corners in page coordinates: top-left, top-right, bottom-right, bottom-left.
    var corners: [DesignPoint] {
        [
            transform.apply(DesignPoint(x: 0, y: 0)),
            transform.apply(DesignPoint(x: width, y: 0)),
            transform.apply(DesignPoint(x: width, y: height)),
            transform.apply(DesignPoint(x: 0, y: height)),
        ]
    }

    var center: DesignPoint { transform.apply(DesignPoint(x: width / 2, y: height / 2)) }

    /// The same box moved by `(dx, dy)` page px.
    func offsetBy(dx: Double, dy: Double) -> OrientedBox {
        var moved = self
        moved.transform.tx += dx
        moved.transform.ty += dy
        return moved
    }
}

public extension Viewport {
    /// A viewport of `size` points at `scale` (device pixels per point) showing the page from `origin` at `zoom`.
    init(origin: DesignPoint, zoom: Double, size: CGSize, scale: CGFloat) {
        self.init(
            x: origin.x,
            y: origin.y,
            zoom: zoom,
            width: UInt32(max(1, (size.width * scale).rounded())),
            height: UInt32(max(1, (size.height * scale).rounded())),
            deviceScale: Double(scale)
        )
    }

    /// A viewport that fits a `pageWidth x pageHeight` page into `size` points with `inset` points of margin,
    /// centered.
    static func fitting(
        pageWidth: Double,
        pageHeight: Double,
        in size: CGSize,
        scale: CGFloat,
        inset: CGFloat = 24
    ) -> Viewport {
        let availableW = max(1, Double(size.width - 2 * inset))
        let availableH = max(1, Double(size.height - 2 * inset))
        let zoom = max(0.01, min(availableW / max(pageWidth, 1), availableH / max(pageHeight, 1)))
        let originX = (pageWidth - Double(size.width) / zoom) / 2
        let originY = (pageHeight - Double(size.height) / zoom) / 2
        return Viewport(origin: DesignPoint(x: originX, y: originY), zoom: zoom, size: size, scale: scale)
    }

    /// Page point under a view point.
    func pagePoint(fromView p: CGPoint) -> DesignPoint {
        DesignPoint(x: x + Double(p.x) / zoom, y: y + Double(p.y) / zoom)
    }

    /// View point of a page point.
    func viewPoint(fromPage p: DesignPoint) -> CGPoint {
        CGPoint(x: (p.x - x) * zoom, y: (p.y - y) * zoom)
    }

    /// Page px to view points (`CGAffineTransform` for overlays drawn in the view's coordinate space).
    var pageToView: CGAffineTransform {
        CGAffineTransform(a: zoom, b: 0, c: 0, d: zoom, tx: -x * zoom, ty: -y * zoom)
    }

    /// The visible page rectangle.
    var visiblePageRect: DesignRect {
        DesignRect(x: x, y: y, width: Double(width) / (zoom * deviceScale), height: Double(height) / (zoom * deviceScale))
    }

    /// Zooms by `factor` keeping the page point under `anchor` (view points) in place.
    func zoomed(by factor: Double, anchor: CGPoint, minZoom: Double = 0.02, maxZoom: Double = 64) -> Viewport {
        let target = min(maxZoom, max(minZoom, zoom * factor))
        let fixed = pagePoint(fromView: anchor)
        var out = self
        out.zoom = target
        out.x = fixed.x - Double(anchor.x) / target
        out.y = fixed.y - Double(anchor.y) / target
        return out
    }

    /// Pans by a view-space translation (points).
    func panned(by translation: CGPoint) -> Viewport {
        var out = self
        out.x -= Double(translation.x) / zoom
        out.y -= Double(translation.y) / zoom
        return out
    }
}
