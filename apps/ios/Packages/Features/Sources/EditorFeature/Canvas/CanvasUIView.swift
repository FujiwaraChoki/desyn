import DesignSystem
import DesynEngine
import DesynKit
import QuartzCore
import UIKit

/// The editing surface: a `CAMetalLayer` showing frames from the Rust engine (damage rects only), with gestures
/// for selection, transform handles, marquee, panning / zooming, two-finger rotation, Apple Pencil drawing and
/// hover, a long-press context menu, hardware keyboard shortcuts and the native text editor.
@MainActor
final class CanvasUIView: UIView {
    override class var layerClass: AnyClass { CAMetalLayer.self }

    private var metalLayer: CAMetalLayer {
        // swiftlint:disable:next force_cast
        layer as! CAMetalLayer
    }

    weak var model: EditorModel?
    let overlay = SelectionOverlayView()
    private var renderer: MetalCanvasRenderer?
    private var frameBuffer: FrameBuffer?
    private(set) var viewport: Viewport?
    private var displayLink: CADisplayLink?
    private var needsRender = true
    private var needsDraw = true
    private var renderInFlight = false
    private var fittedPageId: String?
    /// Insets of the floating chrome (top bar, tool dock, pages strip) used when fitting the page.
    var chromeInsets = UIEdgeInsets(top: 72, left: 16, bottom: 176, right: 16)

    // Gestures
    let tap = UITapGestureRecognizer()
    let doubleTap = UITapGestureRecognizer()
    let pan = UIPanGestureRecognizer()
    let twoFingerPan = UIPanGestureRecognizer()
    let pinch = UIPinchGestureRecognizer()
    let rotation = UIRotationGestureRecognizer()
    let hover = UIHoverGestureRecognizer()
    private var interaction: CanvasInteraction?
    var textInput: TextInputView?

    init(model: EditorModel) {
        self.model = model
        super.init(frame: .zero)
        backgroundColor = UIPalette.canvas
        isMultipleTouchEnabled = true
        contentScaleFactor = max(1, traitCollection.displayScale)
        renderer = MetalCanvasRenderer(layer: metalLayer)
        overlay.frame = bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(overlay)
        interaction = CanvasInteraction(canvas: self)
        configureGestures()
        addInteraction(UIContextMenuInteraction(delegate: self))
        let pencil = UIPencilInteraction()
        pencil.delegate = self
        addInteraction(pencil)
        isAccessibilityElement = true
        accessibilityTraits = [.allowsDirectInteraction]
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: CanvasUIView, _: UITraitCollection) in
            view.needsDraw = true
        }
        NotificationCenter.default.addObserver(self, selector: #selector(memoryWarning), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    // MARK: Lifecycle

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            contentScaleFactor = window?.windowScene?.screen.scale ?? max(1, traitCollection.displayScale)
            startDisplayLink()
            becomeFirstResponder()
        } else {
            displayLink?.invalidate()
            displayLink = nil
        }
    }

    override var canBecomeFirstResponder: Bool { true }

    override var undoManager: UndoManager? { model?.undoManager }

    override func layoutSubviews() {
        super.layoutSubviews()
        let scale = contentScaleFactor
        let pixelSize = CGSize(width: (bounds.width * scale).rounded(), height: (bounds.height * scale).rounded())
        guard pixelSize.width >= 1, pixelSize.height >= 1 else { return }
        metalLayer.drawableSize = pixelSize
        if frameBuffer?.width != Int(pixelSize.width) || frameBuffer?.height != Int(pixelSize.height) {
            frameBuffer = FrameBuffer(width: Int(pixelSize.width), height: Int(pixelSize.height))
        }
        if let current = viewport, fittedPageId == model?.currentPageId {
            setViewport(Viewport(origin: DesignPoint(x: current.x, y: current.y), zoom: current.zoom, size: bounds.size, scale: scale))
        } else {
            fitPage()
        }
        textInput?.frame = bounds
    }

    private func startDisplayLink() {
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: DisplayLinkProxy(self), selector: #selector(DisplayLinkProxy.tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    fileprivate func step() {
        if needsRender, !renderInFlight {
            render()
        }
        if needsDraw {
            needsDraw = false
            draw()
        }
    }

    @objc private func memoryWarning() {
        renderer?.reset()
        Task { [weak self] in
            await self?.model?.engine.clearCaches(assets: false)
            self?.setNeedsRender()
        }
    }

    // MARK: Viewport

    /// Fits the current page into the area between the floating bars.
    func fitPage(animated: Bool = false) {
        guard let model, let page = model.currentPage, bounds.width > 0, bounds.height > 0 else { return }
        let available = bounds.inset(by: chromeInsets.adjusted(by: safeAreaInsets))
        let zoom = max(0.01, min(available.width / max(page.width, 1), available.height / max(page.height, 1)) * 0.94)
        let originX = page.width / 2 - Double(available.midX) / zoom
        let originY = page.height / 2 - Double(available.midY) / zoom
        fittedPageId = page.id
        setViewport(Viewport(origin: DesignPoint(x: originX, y: originY), zoom: zoom, size: bounds.size, scale: contentScaleFactor))
        if animated { Haptics.light() }
    }

    func setViewport(_ newValue: Viewport) {
        viewport = newValue
        overlay.viewport = newValue
        textInput?.viewportDidChange()
        model?.setZoom(newValue.zoom)
        needsRender = true
        needsDraw = true
    }

    /// Page point under a view point.
    func pagePoint(_ point: CGPoint) -> DesignPoint {
        viewport?.pagePoint(fromView: point) ?? DesignPoint(x: Double(point.x), y: Double(point.y))
    }

    func viewPoint(_ point: DesignPoint) -> CGPoint {
        viewport?.viewPoint(fromPage: point) ?? point.cgPoint
    }

    var zoom: Double { viewport?.zoom ?? 1 }

    /// Center of the visible canvas (inside the chrome) in page coordinates.
    func visiblePageCenter() -> DesignPoint {
        let available = bounds.inset(by: chromeInsets.adjusted(by: safeAreaInsets))
        return pagePoint(CGPoint(x: available.midX, y: available.midY))
    }

    // MARK: Rendering

    func setNeedsRender() {
        needsRender = true
    }

    private func render() {
        guard let model, let viewport, let buffer = frameBuffer, let pageId = model.currentPageId,
              Int(viewport.width) == buffer.width, Int(viewport.height) == buffer.height
        else { return }
        needsRender = false
        renderInFlight = true
        let request = RenderRequest(pageId: pageId, viewport: viewport, background: nil)
        Task { [weak self] in
            defer { self?.renderInFlight = false }
            do {
                let info = try await model.engine.render(request, into: buffer)
                guard let self else { return }
                self.renderer?.upload(buffer, viewport: viewport)
                self.needsDraw = true
                if !info.missingAssets.isEmpty {
                    model.fetchMissingAssets(info.missingAssets)
                }
            } catch {
                // No design loaded yet or the page vanished: the next change renders again.
            }
        }
    }

    private func draw() {
        guard let renderer, let viewport, let model else { return }
        let page = model.currentPage
        renderer.draw(
            in: metalLayer,
            viewport: viewport,
            canvasColor: UIPalette.canvas,
            dotColor: UIPalette.canvasDot,
            pageSize: CGSize(width: page?.width ?? 0, height: page?.height ?? 0),
            traits: traitCollection
        )
    }

    // MARK: Model notifications

    func documentDidChange() {
        needsRender = true
        interaction?.refreshSelectionGeometry()
        textInput?.documentDidChange()
        overlay.clearInk()
    }

    func selectionDidChange() {
        interaction?.refreshSelectionGeometry()
        updateAccessibility()
    }

    func pageDidChange() {
        renderer?.reset()
        fittedPageId = nil
        fitPage()
        interaction?.refreshSelectionGeometry()
        updateAccessibility()
    }

    func toolDidChange() {
        interaction?.toolDidChange()
    }

    // MARK: Text editing

    func beginTextEditing(_ id: String, selectAll: Bool) {
        guard let model else { return }
        textInput?.removeFromSuperview()
        let input = TextInputView(model: model, canvas: self, nodeId: id)
        input.frame = bounds
        input.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(input)
        textInput = input
        overlay.showsHandles = false
        interaction?.textEditingDidChange()
        input.start(selectAll: selectAll)
    }

    func endTextEditing() {
        guard let input = textInput else { return }
        textInput = nil
        input.finish()
        input.removeFromSuperview()
        overlay.showsHandles = true
        overlay.editingBox = nil
        interaction?.textEditingDidChange()
        becomeFirstResponder()
    }

    // MARK: Gestures

    private func configureGestures() {
        guard let interaction else { return }
        tap.addTarget(interaction, action: #selector(CanvasInteraction.handleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        doubleTap.addTarget(interaction, action: #selector(CanvasInteraction.handleDoubleTap(_:)))
        pan.maximumNumberOfTouches = 1
        pan.addTarget(interaction, action: #selector(CanvasInteraction.handlePan(_:)))
        twoFingerPan.minimumNumberOfTouches = 2
        twoFingerPan.maximumNumberOfTouches = 2
        twoFingerPan.addTarget(interaction, action: #selector(CanvasInteraction.handleTwoFingerPan(_:)))
        pinch.addTarget(interaction, action: #selector(CanvasInteraction.handlePinch(_:)))
        rotation.addTarget(interaction, action: #selector(CanvasInteraction.handleRotation(_:)))
        hover.addTarget(interaction, action: #selector(CanvasInteraction.handleHover(_:)))
        for recognizer in [tap, doubleTap, pan, twoFingerPan, pinch, rotation] as [UIGestureRecognizer] {
            recognizer.delegate = interaction
            addGestureRecognizer(recognizer)
        }
        addGestureRecognizer(hover)
    }

    /// Single-finger recognizers stay off while the pen tool draws with touches.
    func setDrawingMode(_ drawing: Bool) {
        tap.isEnabled = !drawing
        doubleTap.isEnabled = !drawing
        pan.isEnabled = !drawing
    }

    // MARK: Touches (pen tool)

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesBegan(touches, with: event)
        interaction?.touchesBegan(touches, event: event)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesMoved(touches, with: event)
        interaction?.touchesMoved(touches, event: event)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        interaction?.touchesEnded(touches, event: event, cancelled: false)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesCancelled(touches, with: event)
        interaction?.touchesEnded(touches, event: event, cancelled: true)
    }

    // MARK: Keyboard

    override var keyCommands: [UIKeyCommand]? {
        guard textInput == nil else { return nil }
        let delete = UIKeyCommand(title: "Delete", action: #selector(deleteSelection), input: "\u{8}")
        delete.wantsPriorityOverSystemBehavior = true
        return [
            delete,
            UIKeyCommand(title: "Duplicate", action: #selector(duplicateSelection), input: "d", modifierFlags: .command),
            UIKeyCommand(title: "Deselect", action: #selector(deselect), input: UIKeyCommand.inputEscape),
            UIKeyCommand(title: "Zoom to fit", action: #selector(zoomToFit), input: "1", modifierFlags: .shift),
            UIKeyCommand(title: "Nudge left", action: #selector(nudgeLeft), input: UIKeyCommand.inputLeftArrow),
            UIKeyCommand(title: "Nudge right", action: #selector(nudgeRight), input: UIKeyCommand.inputRightArrow),
            UIKeyCommand(title: "Nudge up", action: #selector(nudgeUp), input: UIKeyCommand.inputUpArrow),
            UIKeyCommand(title: "Nudge down", action: #selector(nudgeDown), input: UIKeyCommand.inputDownArrow),
            UIKeyCommand(action: #selector(nudgeLeft10), input: UIKeyCommand.inputLeftArrow, modifierFlags: .shift),
            UIKeyCommand(action: #selector(nudgeRight10), input: UIKeyCommand.inputRightArrow, modifierFlags: .shift),
            UIKeyCommand(action: #selector(nudgeUp10), input: UIKeyCommand.inputUpArrow, modifierFlags: .shift),
            UIKeyCommand(action: #selector(nudgeDown10), input: UIKeyCommand.inputDownArrow, modifierFlags: .shift),
        ]
    }

    @objc private func deleteSelection() { Task { await model?.deleteSelection() } }
    @objc private func duplicateSelection() { Task { await model?.duplicateSelection() } }
    @objc private func deselect() { model?.clearSelection() }
    @objc private func zoomToFit() { fitPage(animated: true) }
    @objc private func nudgeLeft() { interaction?.nudge(dx: -1, dy: 0) }
    @objc private func nudgeRight() { interaction?.nudge(dx: 1, dy: 0) }
    @objc private func nudgeUp() { interaction?.nudge(dx: 0, dy: -1) }
    @objc private func nudgeDown() { interaction?.nudge(dx: 0, dy: 1) }
    @objc private func nudgeLeft10() { interaction?.nudge(dx: -10, dy: 0) }
    @objc private func nudgeRight10() { interaction?.nudge(dx: 10, dy: 0) }
    @objc private func nudgeUp10() { interaction?.nudge(dx: 0, dy: -10) }
    @objc private func nudgeDown10() { interaction?.nudge(dx: 0, dy: 10) }

    // MARK: Accessibility

    private func updateAccessibility() {
        guard let model else { return }
        let pageText = "Page \(model.currentPageIndex + 1) of \(max(1, model.pages.count))"
        accessibilityLabel = "Design canvas, \(pageText)"
        switch model.selectedNodes.count {
        case 0: accessibilityValue = "Nothing selected"
        case 1: accessibilityValue = "Selected: \(model.selectedNodes[0].displayName)"
        default: accessibilityValue = "\(model.selectedNodes.count) layers selected"
        }
        accessibilityHint = "Tap to select, drag to move, pinch to zoom."
        var actions: [UIAccessibilityCustomAction] = []
        if !model.selection.isEmpty, model.canEdit {
            actions.append(UIAccessibilityCustomAction(name: "Delete") { [weak model] _ in
                Task { await model?.deleteSelection() }
                return true
            })
            actions.append(UIAccessibilityCustomAction(name: "Duplicate") { [weak model] _ in
                Task { await model?.duplicateSelection() }
                return true
            })
        }
        actions.append(UIAccessibilityCustomAction(name: "Zoom to fit") { [weak self] _ in
            self?.fitPage(animated: true)
            return true
        })
        accessibilityCustomActions = actions
    }
}

// MARK: Context menu

extension CanvasUIView: UIContextMenuInteractionDelegate {
    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard let model, model.tool == .select, textInput == nil, let pageId = model.currentPageId else { return nil }
        let point = pagePoint(location)
        let options = HitOptions(deep: false, includeLocked: true, includeHidden: false, tolerance: 8 / zoom)
        guard let hit = try? model.engine.core.hitTest(pageId: pageId, point: point, options: options) else { return nil }
        if !model.selection.contains(hit) {
            model.select([hit])
        }
        Haptics.medium()
        return UIContextMenuConfiguration(identifier: hit as NSString, previewProvider: nil) { [weak self] _ in
            self?.contextMenu()
        }
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration, highlightPreviewForItemWithIdentifier identifier: any NSCopying) -> UITargetedPreview? {
        targetedPreview(for: configuration)
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration, dismissalPreviewForItemWithIdentifier identifier: any NSCopying) -> UITargetedPreview? {
        targetedPreview(for: configuration)
    }

    /// Lifts just the pressed layer (rendered alone at the current zoom) instead of the whole canvas.
    private func targetedPreview(for configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
        guard let model, let id = configuration.identifier as? String, let pageId = model.currentPageId,
              let viewport, let bounds = try? model.engine.core.nodeBounds(id: id)
        else { return nil }
        let corners = bounds.corners.map { viewPoint($0) }
        let xs = corners.map(\.x)
        let ys = corners.map(\.y)
        guard let minX = xs.min(), let maxX = xs.max(), let minY = ys.min(), let maxY = ys.max() else { return nil }
        let rect = CGRect(x: minX, y: minY, width: max(8, maxX - minX), height: max(8, maxY - minY))
        let pageCorners = bounds.corners
        let region = DesignRect(
            x: pageCorners.map(\.x).min() ?? 0,
            y: pageCorners.map(\.y).min() ?? 0,
            width: max(1, (pageCorners.map(\.x).max() ?? 0) - (pageCorners.map(\.x).min() ?? 0)),
            height: max(1, (pageCorners.map(\.y).max() ?? 0) - (pageCorners.map(\.y).min() ?? 0))
        )
        let request = PageImageRequest(
            pageId: pageId,
            scale: min(4, viewport.zoom * viewport.deviceScale),
            region: region,
            transparent: true,
            only: [id]
        )
        guard let frame = try? model.engine.core.renderPage(request: request), let image = frame.makeCGImage() else { return nil }
        let imageView = UIImageView(image: UIImage(cgImage: image, scale: contentScaleFactor, orientation: .up))
        imageView.frame = rect
        let parameters = UIPreviewParameters()
        parameters.backgroundColor = .clear
        return UITargetedPreview(view: imageView, parameters: parameters, target: UIPreviewTarget(container: self, center: CGPoint(x: rect.midX, y: rect.midY)))
    }

    private func contextMenu() -> UIMenu {
        guard let model else { return UIMenu(children: []) }
        let isText = model.selectedNodes.count == 1 && model.selectedNodes[0].type == .text
        var edit: [UIMenuElement] = []
        if model.canEdit {
            if isText, let id = model.selection.first {
                edit.append(UIAction(title: "Edit text", image: UIImage(systemName: "character.cursor.ibeam")) { [weak model] _ in
                    model?.beginTextEditing(id)
                })
            }
            edit.append(UIAction(title: "Duplicate", image: UIImage(systemName: "plus.square.on.square")) { [weak model] _ in
                Task { await model?.duplicateSelection() }
            })
            edit.append(UIAction(title: model.selectionIsLocked ? "Unlock" : "Lock", image: UIImage(systemName: model.selectionIsLocked ? "lock.open" : "lock")) { [weak model] _ in
                Task { await model?.toggleLock() }
            })
        }
        let arrange = UIMenu(title: "Arrange", image: UIImage(systemName: "square.3.layers.3d"), children: [
            UIAction(title: "Bring to front", image: UIImage(systemName: "square.3.layers.3d.top.filled")) { [weak model] _ in Task { await model?.arrange(.front) } },
            UIAction(title: "Bring forward", image: UIImage(systemName: "square.2.layers.3d.top.filled")) { [weak model] _ in Task { await model?.arrange(.forward) } },
            UIAction(title: "Send backward", image: UIImage(systemName: "square.2.layers.3d.bottom.filled")) { [weak model] _ in Task { await model?.arrange(.backward) } },
            UIAction(title: "Send to back", image: UIImage(systemName: "square.3.layers.3d.bottom.filled")) { [weak model] _ in Task { await model?.arrange(.back) } },
        ])
        let align = UIMenu(title: "Align to page", image: UIImage(systemName: "align.horizontal.center"), children: EditorModel.PageAlignment.allCases.map { alignment in
            UIAction(title: alignment.title, image: UIImage(systemName: alignment.systemImage)) { [weak model] _ in
                Task { await model?.align(alignment) }
            }
        })
        guard model.canEdit else { return UIMenu(children: []) }
        let delete = UIAction(title: "Delete", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak model] _ in
            Task { await model?.deleteSelection() }
        }
        return UIMenu(children: [
            UIMenu(options: .displayInline, children: edit),
            UIMenu(options: .displayInline, children: [arrange, align]),
            UIMenu(options: .displayInline, children: [delete]),
        ])
    }
}

// MARK: Apple Pencil

extension CanvasUIView: UIPencilInteractionDelegate {
    /// Double tap / squeeze-free tap on the Pencil: switch between the pen and the previous tool (respecting the
    /// user's system preference to ignore taps).
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        guard let model, UIPencilInteraction.preferredTapAction != .ignore else { return }
        if model.tool == .pen {
            model.tool = model.previousTool == .pen ? .select : model.previousTool
        } else {
            model.tool = .pen
        }
        Haptics.selection()
    }
}

/// Breaks the display link's strong reference to the view.
private final class DisplayLinkProxy: NSObject {
    weak var target: CanvasUIView?

    init(_ target: CanvasUIView) {
        self.target = target
    }

    @objc func tick() {
        MainActor.assumeIsolated {
            target?.step()
        }
    }
}

private extension UIEdgeInsets {
    func adjusted(by safeArea: UIEdgeInsets) -> UIEdgeInsets {
        UIEdgeInsets(top: top + safeArea.top, left: left + safeArea.left, bottom: bottom + safeArea.bottom, right: right + safeArea.right)
    }
}
