import DesignSystem
import DesynEngine
import DesynKit
import UIKit

/// Gesture logic of the canvas. Transforms run as engine previews (one transaction per gesture, committed on
/// release); pointer updates are coalesced so a slow frame never queues a backlog.
@MainActor
final class CanvasInteraction: NSObject, UIGestureRecognizerDelegate {
    /// Handles drawn at 10 pt with 17 pt of slop: 44 pt touch targets (Apple HIG); rotate zones just outside the corners.
    static let touchStyle = HandleStyle(size: 10, slop: 17, rotateRadius: 26, minSideForEdges: 44)

    private enum DragKind {
        case move
        case resize(HandleKind)
        case rotate
        case marquee
        case pan
        case createShape(EditorModel.Tool)
    }

    private struct DragState {
        var kind: DragKind
        var ids: [String]
        var startBox: OrientedBox?
        var startAABB: DesignRect?
        var startRotation: Double
        var startPage: DesignPoint
        var startViewport: Viewport?
        var lastOps: String?
        var angle: Double?
    }

    private weak var canvas: CanvasUIView?
    private var model: EditorModel? { canvas?.model }
    private var drag: DragState?
    private var latestPoint: DesignPoint?
    private var stepScheduled = false
    private var dragTail: Task<Void, Never>?
    private var snapSignature = ""
    private var rotationActive = false
    private var rotationOffset: Double = 0
    private var geometryTask: Task<Void, Never>?

    // Ink
    private var inkTouch: UITouch?
    private var inkSamples: [InkSample] = []
    private var inkPoints: [CGPoint] = []
    private var inkWidths: [CGFloat] = []

    init(canvas: CanvasUIView) {
        self.canvas = canvas
    }

    // MARK: Selection geometry

    /// Reloads the selection box and handles from the engine (after selection or document changes).
    func refreshSelectionGeometry() {
        geometryTask?.cancel()
        guard let canvas, let model else { return }
        let ids = model.selection
        if ids.isEmpty {
            canvas.overlay.selectionBox = nil
            canvas.overlay.handles = []
            canvas.overlay.nodeBoxes = []
            return
        }
        let zoom = canvas.zoom
        geometryTask = Task { [weak self] in
            let bounds = try? await model.engine.selectionBounds(ids)
            let handles = try? await model.engine.handles(for: ids, zoom: zoom, style: Self.touchStyle)
            var boxes: [OrientedBox] = []
            if ids.count > 1 {
                for id in ids {
                    if let box = try? await model.engine.bounds(of: id) { boxes.append(box) }
                }
            }
            guard let self, !Task.isCancelled, self.drag == nil, let canvas = self.canvas else { return }
            canvas.overlay.selectionBox = bounds?.obb
            canvas.overlay.handles = handles?.resize ?? []
            canvas.overlay.nodeBoxes = boxes
        }
    }

    func toolDidChange() {
        guard let canvas, let model else { return }
        canvas.setDrawingMode(model.tool == .pen)
        cancelInk()
        canvas.overlay.hoverBox = nil
        canvas.overlay.showCursor(at: nil, radius: 0)
    }

    func textEditingDidChange() {
        canvas?.overlay.hoverBox = nil
    }

    // MARK: Tap

    @objc func handleTap(_ recognizer: UITapGestureRecognizer) {
        guard recognizer.state == .ended, let canvas, let model else { return }
        let point = canvas.pagePoint(recognizer.location(in: canvas))
        if model.editingTextId != nil {
            model.endTextEditing()
            if model.tool == .select {
                select(at: point, deep: false)
                return
            }
        }
        switch model.tool {
        case .select:
            select(at: point, deep: false)
        case .text:
            Task { await model.insertText(at: point) }
        case .rect, .ellipse, .triangle, .line:
            let side = defaultShapeSide()
            let frame = PageRect(x: point.x - side / 2, y: point.y - side / 2, width: side, height: side)
            Task { await model.insertShape(model.tool, frame: frame) }
        case .hand, .pen:
            break
        }
    }

    @objc func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
        guard recognizer.state == .ended, let canvas, let model, model.tool == .select else { return }
        let point = canvas.pagePoint(recognizer.location(in: canvas))
        guard let id = hit(at: point, deep: true) else {
            canvas.fitPage(animated: true)
            return
        }
        if model.node(id)?.type == .text, model.canEdit {
            model.beginTextEditing(id)
        } else {
            model.select([id])
        }
    }

    private func select(at point: DesignPoint, deep: Bool) {
        guard let model else { return }
        if let id = hit(at: point, deep: deep) {
            model.select([id])
        } else {
            model.clearSelection()
        }
    }

    private func hit(at point: DesignPoint, deep: Bool) -> String? {
        guard let canvas, let model, let pageId = model.currentPageId else { return nil }
        let options = HitOptions(deep: deep, includeLocked: true, includeHidden: false, tolerance: 8 / canvas.zoom)
        return (try? model.engine.core.hitTest(pageId: pageId, point: point, options: options)) ?? nil
    }

    private func defaultShapeSide() -> Double {
        guard let page = model?.currentPage else { return 120 }
        return max(24, min(page.width, page.height) * 0.28)
    }

    // MARK: One-finger drag

    @objc func handlePan(_ recognizer: UIPanGestureRecognizer) {
        guard let canvas else { return }
        switch recognizer.state {
        case .began:
            let location = recognizer.location(in: canvas)
            let translation = recognizer.translation(in: canvas)
            let start = CGPoint(x: location.x - translation.x, y: location.y - translation.y)
            beginDrag(at: canvas.pagePoint(start))
            Haptics.prepare()
        case .changed:
            if case .pan? = drag?.kind, let startViewport = drag?.startViewport {
                canvas.setViewport(startViewport.panned(by: recognizer.translation(in: canvas)))
                return
            }
            dragChanged(to: canvas.pagePoint(recognizer.location(in: canvas)))
        case .ended:
            if case .pan? = drag?.kind {
                drag = nil
                return
            }
            dragEnded(cancelled: false)
        case .cancelled, .failed:
            dragEnded(cancelled: true)
        default:
            break
        }
    }

    private func beginDrag(at point: DesignPoint) {
        guard let canvas, let model, model.currentPageId != nil else { return }
        latestPoint = nil
        snapSignature = ""
        switch model.tool {
        case .hand:
            drag = DragState(kind: .pan, ids: [], startBox: nil, startAABB: nil, startRotation: 0, startPage: point, startViewport: canvas.viewport)
            return
        case .rect, .ellipse, .triangle, .line:
            guard model.canEdit else { return }
            drag = DragState(kind: .createShape(model.tool), ids: [], startBox: nil, startAABB: nil, startRotation: 0, startPage: point)
            return
        case .text, .pen:
            return
        case .select:
            break
        }
        var kind: DragKind = .marquee
        if model.canEdit, !model.selection.isEmpty,
           let handle = try? model.engine.core.hitHandles(ids: model.selection, zoom: canvas.zoom, style: Self.touchStyle, point: point) {
            switch handle {
            case let .resize(kindOfHandle): kind = .resize(kindOfHandle)
            case .rotate: kind = .rotate
            }
        } else if let id = hit(at: point, deep: false) {
            if !model.selection.contains(id) {
                model.select([id])
            }
            kind = model.canEdit ? .move : .marquee
            if !model.canEdit { return }
        }
        var state = DragState(kind: kind, ids: model.selection, startBox: nil, startAABB: nil, startRotation: 0, startPage: point)
        if case .marquee = kind {
            state.ids = []
        } else if let bounds = try? model.engine.core.selectionBounds(ids: model.selection) {
            state.startBox = bounds.obb
            state.startAABB = bounds.aabb
            state.startRotation = bounds.rotation
        } else {
            return
        }
        drag = state
        canvas.overlay.hoverBox = nil
    }

    private func dragChanged(to point: DesignPoint) {
        guard let drag, let canvas else { return }
        switch drag.kind {
        case .marquee:
            canvas.overlay.marquee = Self.rect(drag.startPage, point)
            return
        case .createShape:
            let rect = Self.rect(drag.startPage, point)
            canvas.overlay.shapePreview = rect
            canvas.overlay.showMeasurement("\(Int(rect.width.rounded())) × \(Int(rect.height.rounded()))", near: canvas.viewPoint(DesignPoint(x: rect.x + rect.width / 2, y: rect.y + rect.height)))
            return
        case .pan:
            return
        case .move, .resize, .rotate:
            break
        }
        latestPoint = point
        guard !stepScheduled else { return }
        stepScheduled = true
        enqueue { [weak self] in
            guard let self else { return }
            self.stepScheduled = false
            if let target = self.latestPoint {
                await self.step(to: target)
            }
        }
    }

    private func dragEnded(cancelled: Bool) {
        guard let state = drag, let canvas, let model else { return }
        switch state.kind {
        case .marquee:
            let rect = canvas.overlay.marquee
            canvas.overlay.marquee = nil
            drag = nil
            guard !cancelled, let rect, let pageId = model.currentPageId else { return }
            Task {
                let ids = (try? await model.engine.marquee(rect, mode: .intersect, page: pageId)) ?? []
                model.select(ids)
            }
            return
        case let .createShape(tool):
            let rect = canvas.overlay.shapePreview
            canvas.overlay.shapePreview = nil
            canvas.overlay.showMeasurement(nil, near: .zero)
            drag = nil
            guard !cancelled, let rect, rect.width * canvas.zoom > 6 || rect.height * canvas.zoom > 6 else { return }
            let frame = PageRect(x: rect.x, y: rect.y, width: max(1, rect.width), height: max(1, rect.height))
            Task { await model.insertShape(tool, frame: frame) }
            return
        case .pan:
            drag = nil
            return
        case .move, .resize, .rotate:
            break
        }
        let final = latestPoint
        enqueue { [weak self] in
            guard let self else { return }
            if !cancelled, let final {
                await self.step(to: final)
            }
            await self.complete(cancelled: cancelled)
        }
    }

    private func enqueue(_ work: @escaping @MainActor () async -> Void) {
        let previous = dragTail
        dragTail = Task {
            await previous?.value
            await work()
        }
    }

    /// One preview step of a move / resize / rotate gesture.
    private func step(to point: DesignPoint) async {
        guard let state = drag, let startBox = state.startBox, let canvas, let model, let pageId = model.currentPageId else { return }
        let zoom = canvas.zoom
        var target = startBox
        var measurement: String?
        var guides: [SnapGuide] = []

        switch state.kind {
        case .move:
            var dx = point.x - state.startPage.x
            var dy = point.y - state.startPage.y
            if let aabb = state.startAABB {
                let moved = DesignRect(x: aabb.x + dx, y: aabb.y + dy, width: aabb.width, height: aabb.height)
                if let snap = try? await model.engine.snapMove(moved, excluding: state.ids, page: pageId, options: SnapOptions(threshold: 6 / zoom)) {
                    dx += snap.dx
                    dy += snap.dy
                    guides = snap.guides
                }
                measurement = "X \(Int((aabb.x + dx).rounded()))  Y \(Int((aabb.y + dy).rounded()))"
            }
            target = startBox.offsetBy(dx: dx, dy: dy)
        case let .resize(handle):
            let corner = Self.isCorner(handle)
            var pointer = point
            var result = resizeBox(bounds: startBox, handle: handle, pointer: pointer, options: ResizeOptions(keepAspect: corner, fromCenter: false))
            if abs(state.startRotation) < 0.01, !corner {
                let box = result.bounds
                let rect = DesignRect(x: box.transform.tx, y: box.transform.ty, width: box.width, height: box.height)
                let edges = ResizeEdges(
                    left: handle == .left, right: handle == .right, top: handle == .top, bottom: handle == .bottom
                )
                if let snap = try? await model.engine.snapResize(rect, edges: edges, excluding: state.ids, page: pageId, options: SnapOptions(threshold: 6 / zoom)) {
                    pointer = DesignPoint(x: pointer.x + snap.dx, y: pointer.y + snap.dy)
                    result = resizeBox(bounds: startBox, handle: handle, pointer: pointer, options: ResizeOptions(keepAspect: false, fromCenter: false))
                    guides = snap.guides
                }
            }
            target = result.bounds
            measurement = "\(Int(target.width.rounded())) × \(Int(target.height.rounded()))"
            if let ops = try? await model.engine.transformOps(for: state.ids, from: startBox, to: target, flipX: result.flipX, flipY: result.flipY) {
                drag?.lastOps = ops
                await model.preview(opsJSON: ops)
            }
            show(target: target, guides: guides, measurement: measurement)
            return
        case .rotate:
            let center = startBox.center
            var angle = state.angle ?? rotationDelta(center: center, start: state.startPage, pointer: point, step: nil)
            if let snapped = CanvasGeometry.snappedRotation(startRotation: state.startRotation, delta: angle) {
                angle = snapped
                let signature = "rot\(Int((state.startRotation + angle).rounded()))"
                if signature != snapSignature {
                    snapSignature = signature
                    Haptics.snap()
                }
            } else {
                snapSignature = ""
            }
            target = CanvasGeometry.rotate(startBox, degrees: angle, around: center)
            var display = (state.startRotation + angle).truncatingRemainder(dividingBy: 360)
            if display < 0 { display += 360 }
            measurement = "\(Int(display.rounded()))°"
        case .marquee, .pan, .createShape:
            return
        }

        if let ops = try? await model.engine.transformOps(for: state.ids, from: startBox, to: target) {
            drag?.lastOps = ops
            await model.preview(opsJSON: ops)
        }
        show(target: target, guides: guides, measurement: measurement)
    }

    private func show(target: OrientedBox, guides: [SnapGuide], measurement: String?) {
        guard let canvas else { return }
        canvas.overlay.selectionBox = target
        canvas.overlay.handles = handlesForBox(bounds: target, zoom: canvas.zoom, style: Self.touchStyle).resize
        canvas.overlay.nodeBoxes = []
        canvas.overlay.guides = guides
        let signature = guides.map { "\($0.axis == .x ? "x" : "y")\(Int($0.pos.rounded()))" }.sorted().joined(separator: ",")
        if case .rotate? = drag?.kind {
            // Rotation snapping gives its own feedback.
        } else if !signature.isEmpty, signature != snapSignature {
            Haptics.snap()
            snapSignature = signature
        } else if signature.isEmpty {
            snapSignature = ""
        }
        let bottom = target.corners.max { $0.y < $1.y } ?? target.center
        canvas.overlay.showMeasurement(measurement, near: canvas.viewPoint(DesignPoint(x: target.center.x, y: bottom.y)))
    }

    private func complete(cancelled: Bool) async {
        guard let state = drag, let canvas, let model else { return }
        drag = nil
        canvas.overlay.guides = []
        canvas.overlay.showMeasurement(nil, near: .zero)
        if cancelled || state.lastOps == nil {
            await model.cancelPreview()
        } else if let ops = state.lastOps {
            let label: String
            switch state.kind {
            case .move: label = "Move"
            case .resize: label = "Resize"
            case .rotate: label = "Rotate"
            default: label = "Edit"
            }
            await model.commit(opsJSON: ops, label: label)
        }
        refreshSelectionGeometry()
    }

    // MARK: Two fingers

    @objc func handleTwoFingerPan(_ recognizer: UIPanGestureRecognizer) {
        guard let canvas, let viewport = canvas.viewport else { return }
        if recognizer.state == .changed {
            let translation = recognizer.translation(in: canvas)
            recognizer.setTranslation(.zero, in: canvas)
            canvas.setViewport(viewport.panned(by: translation))
        }
    }

    @objc func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
        guard let canvas, let viewport = canvas.viewport else { return }
        if recognizer.state == .changed || recognizer.state == .ended {
            let anchor = recognizer.location(in: canvas)
            let factor = Double(recognizer.scale)
            recognizer.scale = 1
            guard factor.isFinite, factor > 0 else { return }
            canvas.setViewport(viewport.zoomed(by: factor, anchor: anchor, minZoom: 0.02, maxZoom: 64))
        }
        if recognizer.state == .ended {
            refreshSelectionGeometry()
        }
    }

    /// Two-finger twist rotates the selection (after a 10 degree dead zone so pinching never rotates by accident).
    @objc func handleRotation(_ recognizer: UIRotationGestureRecognizer) {
        guard let model, model.canEdit, model.tool == .select, !model.selection.isEmpty else { return }
        let degrees = Double(recognizer.rotation) * 180 / .pi
        switch recognizer.state {
        case .began:
            rotationActive = false
        case .changed:
            if !rotationActive {
                guard abs(degrees) > 10, drag == nil,
                      let bounds = try? model.engine.core.selectionBounds(ids: model.selection)
                else { return }
                rotationActive = true
                rotationOffset = degrees
                snapSignature = ""
                drag = DragState(
                    kind: .rotate, ids: model.selection, startBox: bounds.obb, startAABB: bounds.aabb,
                    startRotation: bounds.rotation, startPage: bounds.obb.center
                )
                Haptics.prepare()
            }
            drag?.angle = degrees - rotationOffset
            dragChanged(to: drag?.startPage ?? DesignPoint(x: 0, y: 0))
        case .ended, .cancelled, .failed:
            if rotationActive {
                dragEnded(cancelled: recognizer.state != .ended)
            }
            rotationActive = false
        default:
            break
        }
    }

    // MARK: Hover (Apple Pencil hover, trackpad pointer)

    @objc func handleHover(_ recognizer: UIHoverGestureRecognizer) {
        guard let canvas, let model else { return }
        switch recognizer.state {
        case .began, .changed:
            let location = recognizer.location(in: canvas)
            if model.tool == .pen {
                canvas.overlay.showCursor(at: location, radius: max(2, CGFloat(model.penWidth * canvas.zoom) / 2))
                canvas.overlay.hoverBox = nil
                return
            }
            canvas.overlay.showCursor(at: nil, radius: 0)
            guard model.tool == .select, drag == nil, model.editingTextId == nil else {
                canvas.overlay.hoverBox = nil
                return
            }
            if let id = hit(at: canvas.pagePoint(location), deep: false), !model.selection.contains(id) {
                canvas.overlay.hoverBox = (try? model.engine.core.nodeBounds(id: id)) ?? nil
            } else {
                canvas.overlay.hoverBox = nil
            }
        default:
            canvas.overlay.hoverBox = nil
            canvas.overlay.showCursor(at: nil, radius: 0)
        }
    }

    // MARK: Keyboard nudge

    func nudge(dx: Double, dy: Double) {
        guard let model, model.canEdit, !model.selection.isEmpty, drag == nil else { return }
        Task {
            guard let bounds = try? await model.engine.selectionBounds(model.selection),
                  let ops = try? await model.engine.transformOps(for: model.selection, from: bounds.obb, to: bounds.obb.offsetBy(dx: dx, dy: dy))
            else { return }
            await model.commit(opsJSON: ops, label: "Nudge")
        }
    }

    // MARK: Pen (touches)

    func touchesBegan(_ touches: Set<UITouch>, event: UIEvent?) {
        guard let model, model.tool == .pen, model.canEdit else { return }
        if (event?.allTouches?.count ?? touches.count) > 1 {
            cancelInk()
            return
        }
        guard inkTouch == nil, let touch = touches.first else { return }
        inkTouch = touch
        inkSamples = []
        inkPoints = []
        inkWidths = []
        append(touch)
        updateInkOverlay()
    }

    func touchesMoved(_ touches: Set<UITouch>, event: UIEvent?) {
        guard let inkTouch, touches.contains(inkTouch) else { return }
        if (event?.allTouches?.count ?? 1) > 1 {
            cancelInk()
            return
        }
        for touch in event?.coalescedTouches(for: inkTouch) ?? [inkTouch] {
            append(touch)
        }
        updateInkOverlay()
    }

    func touchesEnded(_ touches: Set<UITouch>, event: UIEvent?, cancelled: Bool) {
        guard let inkTouch, touches.contains(inkTouch), let model else { return }
        if cancelled {
            cancelInk()
            return
        }
        append(inkTouch)
        let samples = inkSamples
        self.inkTouch = nil
        inkSamples = []
        inkPoints = []
        inkWidths = []
        // The live stroke stays until the engine frame with the committed path replaces it.
        Task { await model.insertInk(samples) }
    }

    private func append(_ touch: UITouch) {
        guard let canvas, let model else { return }
        let location = touch.preciseLocation(in: canvas)
        let page = canvas.pagePoint(location)
        let pressure: Double
        if touch.type == .pencil, touch.maximumPossibleForce > 0 {
            pressure = Double(min(1, max(0, touch.force / touch.maximumPossibleForce)))
        } else {
            pressure = 0.5
        }
        inkSamples.append(InkSample(x: page.x, y: page.y, pressure: pressure))
        inkPoints.append(location)
        inkWidths.append(CGFloat(model.penWidth * canvas.zoom * (0.35 + 0.65 * pressure)))
    }

    private func updateInkOverlay() {
        guard let canvas, let model else { return }
        canvas.overlay.showInk(points: inkPoints, widths: inkWidths, color: UIColor(hex: model.penColor))
    }

    private func cancelInk() {
        inkTouch = nil
        inkSamples = []
        inkPoints = []
        inkWidths = []
        canvas?.overlay.clearInk()
    }

    // MARK: Gesture delegate

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        guard let canvas else { return false }
        let navigation: [UIGestureRecognizer] = [canvas.twoFingerPan, canvas.pinch, canvas.rotation]
        return navigation.contains(gestureRecognizer) && navigation.contains(other)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // Touches inside the text editor belong to its own text interaction.
        if let input = canvas?.textInput, let view = touch.view, view.isDescendant(of: input) {
            return false
        }
        return true
    }

    // MARK: Geometry helpers

    private static func rect(_ a: DesignPoint, _ b: DesignPoint) -> DesignRect {
        DesignRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }

    private static func isCorner(_ handle: HandleKind) -> Bool {
        switch handle {
        case .topLeft, .topRight, .bottomLeft, .bottomRight: true
        default: false
        }
    }

}
