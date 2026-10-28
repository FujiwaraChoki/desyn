import DesignSystem
import DesynEngine
import UIKit

/// Everything drawn over the canvas in view coordinates: selection boxes and handles, snap guides, the marquee,
/// shape previews, live ink, the hover outline, the pen cursor and the measurement pill. Geometry is kept in
/// page coordinates and re-projected whenever the viewport changes.
final class SelectionOverlayView: UIView {
    // Page-space state.
    var selectionBox: OrientedBox? { didSet { setNeedsLayout() } }
    var nodeBoxes: [OrientedBox] = [] { didSet { setNeedsLayout() } }
    var handles: [ResizeHandle] = [] { didSet { setNeedsLayout() } }
    var guides: [SnapGuide] = [] { didSet { setNeedsLayout() } }
    var marquee: DesignRect? { didSet { setNeedsLayout() } }
    var shapePreview: DesignRect? { didSet { setNeedsLayout() } }
    var hoverBox: OrientedBox? { didSet { setNeedsLayout() } }
    var editingBox: OrientedBox? { didSet { setNeedsLayout() } }
    var showsHandles = true { didSet { setNeedsLayout() } }

    var viewport: Viewport? { didSet { setNeedsLayout() } }

    private let outlineLayer = CAShapeLayer()
    private let nodeOutlineLayer = CAShapeLayer()
    private let handleLayer = CAShapeLayer()
    private let guideLayer = CAShapeLayer()
    private let marqueeLayer = CAShapeLayer()
    private let previewLayer = CAShapeLayer()
    private let hoverLayer = CAShapeLayer()
    private let inkLayer = CAShapeLayer()
    private let cursorLayer = CAShapeLayer()
    private let measureLabel = PaddedLabel()

    /// Visual handle size (the hit area is 44 pt, see `CanvasUIView.touchHandles`).
    static let handleSize: CGFloat = 10

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        for layer in [hoverLayer, nodeOutlineLayer, outlineLayer, guideLayer, marqueeLayer, previewLayer, inkLayer, handleLayer, cursorLayer] {
            layer.fillColor = UIColor.clear.cgColor
            layer.actions = ["path": NSNull(), "position": NSNull(), "bounds": NSNull(), "opacity": NSNull()]
            self.layer.addSublayer(layer)
        }
        outlineLayer.lineWidth = 1.5
        nodeOutlineLayer.lineWidth = 1
        handleLayer.lineWidth = 1.5
        guideLayer.lineWidth = 1
        marqueeLayer.lineWidth = 1
        previewLayer.lineWidth = 1.5
        previewLayer.lineDashPattern = [6, 4]
        hoverLayer.lineWidth = 1.5
        cursorLayer.lineWidth = 1.5
        handleLayer.shadowColor = UIColor.black.cgColor
        handleLayer.shadowOpacity = 0.35
        handleLayer.shadowRadius = 2
        handleLayer.shadowOffset = .zero

        measureLabel.font = DSFont.uiMono(12)
        measureLabel.textColor = UIPalette.onSun
        measureLabel.backgroundColor = UIPalette.sun
        measureLabel.layer.cornerRadius = 9
        measureLabel.layer.masksToBounds = true
        measureLabel.isHidden = true
        addSubview(measureLabel)
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: SelectionOverlayView, _: UITraitCollection) in
            view.applyColors()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func applyColors() {
        let sun = UIPalette.sun.resolvedColor(with: traitCollection)
        outlineLayer.strokeColor = sun.cgColor
        nodeOutlineLayer.strokeColor = sun.withAlphaComponent(0.6).cgColor
        handleLayer.strokeColor = sun.cgColor
        handleLayer.fillColor = UIColor.white.cgColor
        guideLayer.strokeColor = UIPalette.guide.resolvedColor(with: traitCollection).cgColor
        marqueeLayer.strokeColor = sun.cgColor
        marqueeLayer.fillColor = sun.withAlphaComponent(0.1).cgColor
        previewLayer.strokeColor = sun.cgColor
        previewLayer.fillColor = sun.withAlphaComponent(0.08).cgColor
        hoverLayer.strokeColor = sun.withAlphaComponent(0.55).cgColor
        cursorLayer.strokeColor = sun.cgColor
        measureLabel.backgroundColor = sun
    }

    // MARK: Ink

    /// Shows a live pen stroke (view coordinates; filled outline built from the samples).
    func showInk(points: [CGPoint], widths: [CGFloat], color: UIColor) {
        inkLayer.fillColor = color.cgColor
        inkLayer.strokeColor = nil
        inkLayer.path = Self.inkPath(points: points, widths: widths)
    }

    func clearInk() {
        inkLayer.path = nil
    }

    /// Pen tip preview while the Pencil hovers.
    func showCursor(at point: CGPoint?, radius: CGFloat) {
        guard let point else {
            cursorLayer.path = nil
            return
        }
        cursorLayer.path = UIBezierPath(ovalIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)).cgPath
    }

    /// The size / angle pill near the selection while transforming (nil hides it).
    func showMeasurement(_ text: String?, near point: CGPoint) {
        guard let text else {
            measureLabel.isHidden = true
            return
        }
        measureLabel.text = text
        measureLabel.isHidden = false
        let size = measureLabel.intrinsicContentSize
        var origin = CGPoint(x: point.x - size.width / 2, y: point.y + 14)
        origin.x = min(max(8, origin.x), bounds.width - size.width - 8)
        origin.y = min(max(8, origin.y), bounds.height - size.height - 8)
        measureLabel.frame = CGRect(origin: origin, size: size)
    }

    // MARK: Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        for layer in [outlineLayer, nodeOutlineLayer, handleLayer, guideLayer, marqueeLayer, previewLayer, hoverLayer, inkLayer, cursorLayer] {
            layer.frame = bounds
        }
        guard let viewport else {
            for layer in [outlineLayer, nodeOutlineLayer, handleLayer, guideLayer, marqueeLayer, previewLayer, hoverLayer] {
                layer.path = nil
            }
            return
        }
        let toView = viewport.pageToView

        outlineLayer.path = (editingBox ?? selectionBox).map { boxPath($0, toView) }
        outlineLayer.opacity = editingBox == nil ? 1 : 0.6

        let outlines = CGMutablePath()
        if nodeBoxes.count > 1 {
            for box in nodeBoxes { outlines.addPath(boxPath(box, toView)) }
        }
        nodeOutlineLayer.path = outlines

        let handlePath = CGMutablePath()
        if showsHandles, editingBox == nil, let box = selectionBox {
            let angle = atan2(box.transform.b, box.transform.a)
            let half = Self.handleSize / 2
            for handle in handles where handle.visible {
                let center = handle.center.cgPoint.applying(toView)
                let square = CGPath(
                    roundedRect: CGRect(x: -half, y: -half, width: Self.handleSize, height: Self.handleSize),
                    cornerWidth: 2,
                    cornerHeight: 2,
                    transform: nil
                )
                var transform = CGAffineTransform(translationX: center.x, y: center.y).rotated(by: angle)
                if let placed = square.copy(using: &transform) {
                    handlePath.addPath(placed)
                }
            }
        }
        handleLayer.path = handlePath

        let guidePath = CGMutablePath()
        for guide in guides {
            switch guide.axis {
            case .x:
                guidePath.move(to: CGPoint(x: guide.pos, y: guide.from).applying(toView))
                guidePath.addLine(to: CGPoint(x: guide.pos, y: guide.to).applying(toView))
            case .y:
                guidePath.move(to: CGPoint(x: guide.from, y: guide.pos).applying(toView))
                guidePath.addLine(to: CGPoint(x: guide.to, y: guide.pos).applying(toView))
            }
        }
        guideLayer.path = guidePath

        marqueeLayer.path = marquee.map { CGPath(rect: $0.cgRect.applying(toView), transform: nil) }
        previewLayer.path = shapePreview.map { CGPath(rect: $0.cgRect.applying(toView), transform: nil) }
        hoverLayer.path = hoverBox.map { boxPath($0, toView) }
    }

    private func boxPath(_ box: OrientedBox, _ toView: CGAffineTransform) -> CGPath {
        let corners = box.corners.map { $0.cgPoint.applying(toView) }
        let path = CGMutablePath()
        path.addLines(between: corners)
        path.closeSubpath()
        return path
    }

    /// Variable-width stroke outline in view space (left side forward, right side back, round ends).
    static func inkPath(points: [CGPoint], widths: [CGFloat]) -> CGPath? {
        guard let first = points.first else { return nil }
        let path = CGMutablePath()
        if points.count == 1 {
            let r = (widths.first ?? 2) / 2
            path.addEllipse(in: CGRect(x: first.x - r, y: first.y - r, width: r * 2, height: r * 2))
            return path
        }
        var left: [CGPoint] = []
        var right: [CGPoint] = []
        for i in points.indices {
            let prev = points[max(0, i - 1)]
            let next = points[min(points.count - 1, i + 1)]
            var dx = next.x - prev.x
            var dy = next.y - prev.y
            let length = max(0.0001, hypot(dx, dy))
            dx /= length
            dy /= length
            let r = (i < widths.count ? widths[i] : widths.last ?? 2) / 2
            left.append(CGPoint(x: points[i].x - dy * r, y: points[i].y + dx * r))
            right.append(CGPoint(x: points[i].x + dy * r, y: points[i].y - dx * r))
        }
        path.addLines(between: left + right.reversed())
        path.closeSubpath()
        for (i, point) in points.enumerated() where i == 0 || i == points.count - 1 {
            let r = (i < widths.count ? widths[i] : 2) / 2
            path.addEllipse(in: CGRect(x: point.x - r, y: point.y - r, width: r * 2, height: r * 2))
        }
        return path
    }
}

/// A label with horizontal padding (the measurement pill).
final class PaddedLabel: UILabel {
    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + 16, height: max(18, size.height + 6))
    }

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.insetBy(dx: 8, dy: 3))
    }
}
