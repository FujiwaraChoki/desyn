import CoreGraphics
import DesynEngine

/// Pure canvas math shared by the gestures and the renderer (public for tests).
public enum CanvasGeometry {
    /// `box` rotated by `degrees` (clockwise in the y-down page space) about the page point `center`.
    public static func rotate(_ box: OrientedBox, degrees: Double, around center: DesignPoint) -> OrientedBox {
        let rotation = CGAffineTransform(translationX: center.x, y: center.y)
            .rotated(by: degrees * .pi / 180)
            .translatedBy(x: -center.x, y: -center.y)
        return OrientedBox(
            transform: Affine(box.transform.cgAffineTransform.concatenating(rotation)),
            width: box.width,
            height: box.height
        )
    }

    /// Page px between canvas grid dots: 8 x 2^n so they stay 16-48 pt apart at any zoom (0 for invalid zoom).
    public static func dotSpacing(zoom: Double) -> Double {
        guard zoom > 0, zoom.isFinite else { return 0 }
        var spacing = 8.0
        while spacing * zoom < 16 { spacing *= 2 }
        while spacing * zoom > 48, spacing > 1 { spacing /= 2 }
        return spacing
    }

    /// Rotation snapping: the angle delta that lands `startRotation + delta` on a multiple of `step` degrees when
    /// it is within `tolerance`, else nil.
    public static func snappedRotation(startRotation: Double, delta: Double, step: Double = 15, tolerance: Double = 2.5) -> Double? {
        let total = startRotation + delta
        let nearest = (total / step).rounded() * step
        return abs(total - nearest) < tolerance ? delta + (nearest - total) : nil
    }

    /// Byte size of the fragment uniforms (must equal the Metal struct: 96).
    public static var uniformsStride: Int { MemoryLayout<CanvasUniforms>.stride }
}
