@_exported import DesynFFI
import Dispatch
import Foundation

/// The Desyn engine for one open design, as a Swift actor.
///
/// Every call runs on the actor's own serial dispatch queue, never on the main thread and never on the cooperative
/// thread pool (rendering, exporting and describing block for milliseconds to seconds). Call it from the main actor
/// with `await`:
///
/// ```swift
/// let engine = DesynEngine()
/// try await engine.load(designJSON: json)
/// let frame = try await engine.render(RenderRequest(viewport: viewport))
/// layer.contents = frame.makeCGImage()
/// ```
///
/// The wrapped Rust object (`core`) is itself thread-safe (`Send + Sync`, one internal lock), so a dedicated render
/// thread (e.g. a `CADisplayLink` target on a background run loop) may call `core` synchronously as well; calls are
/// serialized either way.
public actor DesynEngine {
    /// The UniFFI object. Thread-safe; prefer the actor methods from async code.
    public nonisolated let core: Engine

    private nonisolated let queue: DispatchSerialQueue

    public nonisolated var unownedExecutor: UnownedSerialExecutor {
        queue.asUnownedSerialExecutor()
    }

    /// An engine with the bundled fonts (Inter, Instrument Sans / Serif, JetBrains Mono, Noto Arabic / Hebrew /
    /// Emoji). `assetBudgetMB` bounds the memory of decoded images.
    public init(bundledFonts: Bool = true, assetBudgetMB: UInt32 = 384) {
        self.init(core: Engine.withOptions(bundledFonts: bundledFonts, assetBudgetMb: assetBudgetMB))
    }

    /// Wraps an existing engine object.
    public init(core: Engine) {
        self.core = core
        self.queue = DispatchSerialQueue(label: "app.desyn.engine", qos: .userInitiated)
    }

    /// Version of the Rust engine.
    public static var version: String { engineVersion() }

    // MARK: Design

    /// Loads a `Design` (JSON, e.g. assembled from `designs.load`). With `normalize`, derived geometry is
    /// recomputed with the real fonts; commit `layoutOpsJson` as one `system` transaction when it is not `[]`.
    @discardableResult
    public func load(designJSON: String, normalize: Bool = true) throws -> LoadResult {
        try core.load(designJson: designJSON, normalize: normalize)
    }

    /// Closes the design.
    public func unload() { core.unload() }

    /// The current design as JSON.
    public func snapshot(canonical: Bool = false) throws -> String {
        try core.snapshot(canonical: canonical)
    }

    /// Pages in order.
    public func pages() throws -> [PageInfo] { try core.pages() }

    /// One node as JSON.
    public func nodeJSON(_ id: String) throws -> String? { try core.nodeJson(id: id) }

    /// Changes whenever the design, fonts or assets change.
    public func revision() -> UInt64 { core.revision() }

    /// Applies a `Transaction` (JSON). Use `normalize: true` for local edits and `false` for remote transactions
    /// and inverses. Commit `applied` (not the raw ops) when normalizing.
    @discardableResult
    public func apply(transactionJSON: String, normalize: Bool = true) throws -> ApplyOutcome {
        try core.applyTransaction(txJson: transactionJSON, normalize: normalize)
    }

    /// Builds and applies a transaction from ops (JSON `Op[]`). Returns the outcome and the transaction JSON that
    /// was applied, ready for `designs.commit`.
    @discardableResult
    public func apply(
        opsJSON: String,
        label: String,
        source: TransactionSource = .user,
        normalize: Bool = true
    ) throws -> (outcome: ApplyOutcome, transactionJSON: String) {
        let tx = try DesynTransaction.json(opsJSON: opsJSON, label: label, source: source)
        return (try core.applyTransaction(txJson: tx, normalize: normalize), tx)
    }

    /// Recomputes derived boxes with the current fonts (after `setFont` / font assets arrived).
    public func relayout() throws -> LayoutOutcome { try core.relayout() }

    // MARK: Live previews (drag, resize, typing)

    /// Shows a `Transaction` (JSON) on top of the committed state without committing it; each call replaces the
    /// previous preview. Remote transactions applied meanwhile (`apply(transactionJSON:normalize: false)`) go
    /// under it and it is re-applied on top.
    @discardableResult
    public func preview(transactionJSON: String, normalize: Bool = true) throws -> ApplyOutcome {
        try core.preview(txJson: transactionJSON, normalize: normalize)
    }

    /// Builds a transaction from ops (JSON `Op[]`, e.g. from `transformOps`) and shows it as the preview. Returns
    /// the outcome and the transaction JSON.
    @discardableResult
    public func preview(
        opsJSON: String,
        label: String,
        source: TransactionSource = .user,
        normalize: Bool = true
    ) throws -> (outcome: ApplyOutcome, transactionJSON: String) {
        let tx = try DesynTransaction.json(opsJSON: opsJSON, label: label, source: source)
        return (try core.preview(txJson: tx, normalize: normalize), tx)
    }

    /// Keeps the preview as committed state (pointer-up). Commit `appliedJson` through `designs.commit` (with the
    /// id of the last previewed transaction) and keep `inverseJson` for undo. `nil` when no preview was active.
    @discardableResult
    public func commitPreview() -> ApplyOutcome? { core.commitPreview() }

    /// Drops the preview (gesture cancelled). Returns whether one was active.
    @discardableResult
    public func cancelPreview() -> Bool { core.cancelPreview() }

    /// Whether a preview is active.
    public var hasPreview: Bool { core.hasPreview() }

    // MARK: Rendering

    /// Renders the interactive frame and returns all of its pixels (premultiplied RGBA).
    public func render(_ request: RenderRequest) throws -> RenderedFrame {
        try core.render(request: request)
    }

    /// Renders the interactive frame into `buffer` (only the damage unless `copyAll`).
    public func render(_ request: RenderRequest, into buffer: FrameBuffer, copyAll: Bool = false) throws -> FrameInfo {
        try buffer.render(core: core, request: request, copyAll: copyAll)
    }

    /// One-shot render of a page (thumbnails, previews).
    public func renderPage(_ request: PageImageRequest = PageImageRequest()) throws -> RenderedFrame {
        try core.renderPage(request: request)
    }

    /// Frees the interactive frame buffer.
    public func resetFrame() { core.resetFrame() }

    /// Drops caches (`assets: true` also drops decoded images), e.g. on a memory warning.
    public func clearCaches(assets: Bool = false) { core.clearCaches(assets: assets) }

    // MARK: Picking and gestures

    public func hitTest(_ point: DesignPoint, page: String? = nil, options: HitOptions = HitOptions()) throws -> String? {
        try core.hitTest(pageId: page, point: point, options: options)
    }

    public func hitPath(_ point: DesignPoint, page: String? = nil, options: HitOptions = HitOptions()) throws -> [String] {
        try core.hitPath(pageId: page, point: point, options: options)
    }

    public func nodes(at point: DesignPoint, page: String? = nil, options: HitOptions = HitOptions()) throws -> [String] {
        try core.nodesAt(pageId: page, point: point, options: options)
    }

    public func marquee(
        _ rect: DesignRect,
        mode: MarqueeMode = .intersect,
        page: String? = nil,
        options: HitOptions = HitOptions()
    ) throws -> [String] {
        try core.marquee(pageId: page, rect: rect, mode: mode, options: options)
    }

    public func bounds(of id: String) throws -> OrientedBox? { try core.nodeBounds(id: id) }

    public func selectionBounds(_ ids: [String]) throws -> SelectionBounds? {
        try core.selectionBounds(ids: ids)
    }

    public func handles(for ids: [String], zoom: Double, style: HandleStyle = .touch) throws -> Handles? {
        try core.handles(ids: ids, zoom: zoom, style: style)
    }

    public func hitHandles(
        for ids: [String],
        zoom: Double,
        at point: DesignPoint,
        style: HandleStyle = .touch
    ) throws -> HandleHit? {
        try core.hitHandles(ids: ids, zoom: zoom, style: style, point: point)
    }

    public func snapMove(
        _ moving: DesignRect,
        excluding ids: [String],
        page: String? = nil,
        options: SnapOptions = SnapOptions()
    ) throws -> SnapResult {
        try core.snapMove(pageId: page, moving: moving, exclude: ids, options: options)
    }

    public func snapResize(
        _ moving: DesignRect,
        edges: ResizeEdges,
        excluding ids: [String],
        page: String? = nil,
        options: SnapOptions = SnapOptions()
    ) throws -> SnapResult {
        try core.snapResize(pageId: page, moving: moving, edges: edges, exclude: ids, options: options)
    }

    public func distanceLabels(_ box: DesignRect, excluding ids: [String], page: String? = nil) throws -> [DistanceLabel] {
        try core.distanceLabels(pageId: page, moving: box, exclude: ids)
    }

    /// Ops (JSON `Op[]`) carrying the selection from `from` (box at gesture start) to `to`, computed against the
    /// committed state: `preview` them on every step and `commitPreview()` on pointer-up.
    public func transformOps(
        for ids: [String],
        from: OrientedBox,
        to: OrientedBox,
        flipX: Bool = false,
        flipY: Bool = false
    ) throws -> String {
        try core.transformSelection(ids: ids, from: from, to: to, flipX: flipX, flipY: flipY)
    }

    // MARK: Text

    public func measure(requestJSON: String) throws -> [TextSize] { try core.measure(requestJson: requestJSON) }

    public func textLayout(_ id: String) throws -> TextLayout { try core.textLayout(nodeId: id) }

    /// The text node as outlines (box coordinates), for "convert to paths".
    public func textOutline(_ id: String) throws -> TextOutline { try core.textOutline(nodeId: id) }

    public func textPosition(in id: String, at pagePoint: DesignPoint) throws -> TextPosition {
        try core.textHitTest(nodeId: id, point: pagePoint)
    }

    public func caret(in id: String, at position: TextPosition) throws -> CaretRect {
        try core.textCaret(nodeId: id, position: position)
    }

    public func selectionRects(in id: String, range: TextRange) throws -> [DesignRect] {
        try core.textSelectionRects(nodeId: id, range: range)
    }

    public func wordRange(in id: String, at index: UInt32) throws -> TextRange {
        try core.textWordRange(nodeId: id, index: index)
    }

    public func lineRange(in id: String, at position: TextPosition) throws -> TextRange {
        try core.textLineRange(nodeId: id, position: position)
    }

    public func paragraphRange(in id: String, at index: UInt32) throws -> TextRange {
        try core.textParagraphRange(nodeId: id, index: index)
    }

    public func move(
        _ position: TextPosition,
        in id: String,
        by movement: TextMovement,
        x: Double? = nil
    ) throws -> TextPosition {
        try core.textMove(nodeId: id, position: position, movement: movement, x: x)
    }

    // MARK: Understanding

    /// `Description` JSON (DOCUMENT_MODEL section 7) for `DescribeOptions` JSON (`""` = defaults).
    public func describe(optionsJSON: String = "") throws -> String { try core.describe(optionsJson: optionsJSON) }

    /// `Issue[]` JSON.
    public func lint(optionsJSON: String = "") throws -> String { try core.lint(optionsJson: optionsJSON) }

    /// Token-budgeted text description (untrusted design content: wrap it as data in prompts).
    public func describeText(optionsJSON: String = "", maxTokens: UInt32 = 2000) throws -> String {
        try core.describeText(optionsJson: optionsJSON, maxTokens: maxTokens)
    }

    public func designTokens(page: String? = nil) throws -> String { try core.designTokens(pageId: page) }

    // MARK: Export

    public func export(_ request: ExportRequest) throws -> ExportResult { try core.export(request: request) }

    public func exportPages(_ request: ExportRequest) throws -> [ExportedPage] {
        try core.exportPages(request: request)
    }

    // MARK: Fonts and assets

    @discardableResult
    public func setFont(_ data: Data, family: String? = nil) throws -> [FontFace] {
        try core.setFont(bytes: data, family: family)
    }

    public func fontFamilies() -> [String] { core.fontFamilies() }

    public func takeFontRequests() -> [FontRequest] { core.takeFontRequests() }

    public func setAsset(_ id: String, data: Data) { core.setAsset(id: id, bytes: data) }

    public func removeAsset(_ id: String) { core.removeAsset(id: id) }

    public func takeMissingAssets() -> [String] { core.takeMissingAssets() }
}

public extension HandleStyle {
    /// Handles sized for fingers: 10 pt squares with 14 pt of slop and 18 pt rotate zones.
    static let touch = HandleStyle(size: 10, slop: 14, rotateRadius: 18, minSideForEdges: 32)
    /// Pointer-sized handles (DESIGN_SYSTEM.md).
    static let pointer = HandleStyle()
}

public extension EngineError {
    /// A sentence for logs and alerts.
    var message: String {
        switch self {
        case let .InvalidJson(detail): "Invalid JSON: \(detail)"
        case .NoDesign: "No design is loaded."
        case let .PageNotFound(id): "No page \(id)."
        case let .NodeNotFound(id): "No layer \(id)."
        case let .NotText(id): "Layer \(id) is not text."
        case let .InvalidArgument(detail): "Invalid argument: \(detail)"
        case let .Render(detail): "Rendering failed: \(detail)"
        case let .Font(detail): "The font could not be used: \(detail)"
        }
    }
}
