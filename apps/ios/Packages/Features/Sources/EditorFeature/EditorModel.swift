import CoreGraphics
import DesignSystem
import DesynEngine
import DesynKit
import FeatureCore
import Foundation
import Observation

/// One open design: the engine, the sync session, selection, tools, history and page thumbnails. The canvas
/// (UIKit) draws and handles gestures; SwiftUI chrome reads this model.
@MainActor
@Observable
public final class EditorModel {
    public enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    public enum Tool: String, CaseIterable, Identifiable, Sendable {
        case select, hand, text, rect, ellipse, triangle, line, pen

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .select: "Select"
            case .hand: "Hand"
            case .text: "Text"
            case .rect: "Rectangle"
            case .ellipse: "Ellipse"
            case .triangle: "Triangle"
            case .line: "Line"
            case .pen: "Pen"
            }
        }

        public var systemImage: String {
            switch self {
            case .select: "cursorarrow"
            case .hand: "hand.raised"
            case .text: "textformat"
            case .rect: "rectangle"
            case .ellipse: "circle"
            case .triangle: "triangle"
            case .line: "line.diagonal"
            case .pen: "pencil.tip"
            }
        }

        /// Tools that place a shape by tapping or dragging out a box.
        public var isShape: Bool {
            switch self {
            case .rect, .ellipse, .triangle, .line: true
            default: false
            }
        }
    }

    public let route: DesignRoute
    public let session: AppSession

    public private(set) var phase: Phase = .loading
    public internal(set) var name: String
    public private(set) var canEdit = false
    public internal(set) var pages: [PageInfo] = []
    public internal(set) var currentPageId: String?
    public internal(set) var selection: [String] = []
    /// Parsed nodes of the selection (inspector).
    public internal(set) var selectedNodes: [Node] = []
    public internal(set) var editingTextId: String?
    public internal(set) var canUndo = false
    public internal(set) var canRedo = false
    public internal(set) var undoLabel: String?
    public internal(set) var redoLabel: String?
    public private(set) var zoomPercent = 100
    public private(set) var revision: UInt64 = 0
    public private(set) var pageThumbnails: [String: CGImage] = [:]
    public private(set) var isUploading = false
    /// The document's named colors (`Design.styles.colors`, by name) for the inspector swatches.
    public private(set) var styleColors: [String] = []

    public var tool: Tool = .select {
        didSet {
            guard tool != oldValue else { return }
            previousTool = oldValue
            if tool != .select, editingTextId != nil { endTextEditing() }
            canvas?.toolDidChange()
        }
    }

    public private(set) var previousTool: Tool = .select
    /// Pen tool ink.
    public var penColor = "#ffb02e"
    public var penWidth: Double = 8

    public let undoManager = UndoManager()

    @ObservationIgnored let engine: DesynEngine
    @ObservationIgnored weak var canvas: CanvasUIView?
    @ObservationIgnored private(set) var sync: SyncSession?
    @ObservationIgnored private let document: EngineDocument
    @ObservationIgnored private var assets: AssetRepository?
    @ObservationIgnored var assetRefs: [String: AssetRef] = [:]
    @ObservationIgnored private var workspaceId: String?
    @ObservationIgnored private var fetchingAssets: Set<String> = []
    @ObservationIgnored private var thumbnailTask: Task<Void, Never>?
    /// The next thumbnail pass renders every page (pages added / removed / reordered, remote edits, new
    /// assets); otherwise only the current page, which local edits touch.
    @ObservationIgnored private var thumbnailsNeedAll = true
    @ObservationIgnored private var connectionTask: Task<Void, Never>?
    @ObservationIgnored var undoStack: [HistoryEntry] = []
    @ObservationIgnored var redoStack: [HistoryEntry] = []
    @ObservationIgnored var historyTail: Task<Void, Never>?
    /// Server AI runs started here whose transactions become one undo step each (run id -> step label).
    @ObservationIgnored var trackedRuns: [String: String] = [:]
    @ObservationIgnored private var share: ShareAccess?
    @ObservationIgnored private var permission = "view"
    @ObservationIgnored private var designKey = ""
    @ObservationIgnored private var kind = "custom"
    /// The cached copy on screen may hold edits the server refused or reordered (`CachedDesign.needsServerCopy`):
    /// replace it with the server copy (pending work re-applied on top) as soon as one loads.
    @ObservationIgnored private var cacheNeedsServerCopy = false

    public init(route: DesignRoute, session: AppSession) {
        self.route = route
        self.session = session
        name = route.name
        engine = DesynEngine()
        document = EngineDocument(engine: engine)
        share = route.share
        undoManager.levelsOfUndo = 200
        document.onChange = { [weak self] in self?.documentChanged() }
    }

    public var syncStatus: SyncSession.Status { sync?.status ?? (canEdit ? .synced : .readOnly) }
    public var currentPage: PageInfo? { pages.first { $0.id == currentPageId } ?? pages.first }
    public var currentPageIndex: Int { pages.firstIndex { $0.id == currentPage?.id } ?? 0 }

    // MARK: Opening

    /// Opens the design: the cached copy first (works offline), then the server copy, then live sync.
    public func open() async {
        guard phase != .ready else { return }
        session.openDesignId = route.designId
        if let store = session.store, let cached = store.loadDesign(route.designId) {
            do {
                try await engine.load(designJSON: cached.designJSON, normalize: false)
                designKey = cached.key
                kind = cached.kind
                cacheNeedsServerCopy = cached.needsServerCopy
                if let cachedShare = cached.share { share = cachedShare }
                configure(name: cached.name, permission: cached.permission, workspaceId: cached.workspaceId)
                startSync(confirmedSeq: cached.confirmedSeq, pending: cached.pending)
                if let design = try? Design(jsonString: cached.designJSON) {
                    assetRefs = design.assets
                    updateStyleColors(design.styles)
                }
                phase = .ready
            } catch {
                // A corrupt cache entry: drop it and load from the server.
                store.removeDesign(route.designId)
            }
        }
        do {
            let loaded = try await session.api.loadDesign(designId: route.designId, share: share)
            assetRefs.merge(loaded.design.assets) { _, new in new }
            updateStyleColors(loaded.design.styles)
            designKey = loaded.header.key
            kind = loaded.header.kind
            if sync == nil {
                _ = try await engine.load(designJSON: loaded.design.serialized(), normalize: false)
                configure(name: loaded.header.name, permission: loaded.permission, workspaceId: loaded.header.workspaceId)
                startSync(confirmedSeq: loaded.seq, pending: [])
                phase = .ready
                // Derived geometry measured with real fonts, queued like any other change (exact inverse) so
                // other clients converge.
                try? await sync?.relayout()
            } else if cacheNeedsServerCopy, let sync {
                // The cached state is not "server state + pending": take the server copy and replay pending on it.
                configure(name: loaded.header.name, permission: loaded.permission, workspaceId: loaded.header.workspaceId)
                try await sync.reload(designJSON: loaded.design.serialized(), seq: loaded.seq)
                cacheNeedsServerCopy = false
            } else {
                // The cached copy is on screen; sync catches up from its seq. Refresh metadata only.
                configure(name: loaded.header.name, permission: loaded.permission, workspaceId: loaded.header.workspaceId)
            }
        } catch {
            let mapped = DesynError(error)
            if sync == nil {
                phase = .failed(mapped.isTransient ? "You're offline and this design isn't on this \(DeviceName.current) yet. Connect and try again." : mapped.message)
            } else if !mapped.isTransient {
                session.toasts.show(mapped.message, tone: .error)
            }
        }
    }

    /// Stops syncing (the editor closes). Pending changes stay in the offline cache and sync next time.
    public func close() {
        endTextEditing()
        if session.openDesignId == route.designId { session.openDesignId = nil }
        sync?.stop()
        connectionTask?.cancel()
        thumbnailTask?.cancel()
    }

    private func configure(name: String, permission: String, workspaceId: String) {
        self.name = name
        self.permission = permission
        self.workspaceId = workspaceId
        canEdit = permission == "edit" || permission == "manage"
        if assets == nil, let store = session.store {
            assets = AssetRepository(api: session.api, store: store, designId: route.designId, share: share)
        }
        refreshPages()
    }

    private func startSync(confirmedSeq: Int, pending: [PendingTransaction]) {
        let sync = SyncSession(
            designId: route.designId,
            share: share,
            canEdit: canEdit,
            confirmedSeq: confirmedSeq,
            pending: pending,
            applier: document,
            backend: session.api
        )
        sync.onRemoteChange = { [weak self] tx in self?.remoteChanged(tx) }
        sync.onRemoteApplied = { [weak self] tx, inverseJSON in self?.recordRunStep(tx, inverseJSON: inverseJSON) }
        sync.onRejected = { [weak self] label, error in
            self?.session.toasts.show("\(label) couldn't be saved: \(error.message)", tone: .error)
        }
        sync.onReloadNeeded = { [weak self] in
            Task { await self?.reloadAfterGap() }
        }
        sync.onCheckpoint = { [weak self] checkpoint in self?.saveCheckpoint(checkpoint) }
        sync.setOnline(session.isOnline)
        self.sync = sync
        sync.start()
        watchConnectivity()
    }

    private func watchConnectivity() {
        connectionTask?.cancel()
        connectionTask = Task { [weak self] in
            var last: (Bool, Bool)?
            while !Task.isCancelled {
                guard let self else { return }
                let state = (self.session.isOnline, self.session.isAuthenticated)
                if last == nil || last! != state {
                    self.sync?.setOnline(state.0 && state.1)
                    if let last, !last.1, state.1 { self.sync?.resume() }
                    last = state
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func reloadAfterGap() async {
        do {
            let loaded = try await session.api.loadDesign(designId: route.designId, share: share)
            assetRefs.merge(loaded.design.assets) { _, new in new }
            try await sync?.reload(designJSON: loaded.design.serialized(), seq: loaded.seq)
            cacheNeedsServerCopy = false
        } catch {
            session.toasts.show("Couldn't refresh the design. \(DesynError(error).message)", tone: .error)
        }
    }

    private func saveCheckpoint(_ checkpoint: SyncCheckpoint) {
        guard let store = session.store, let workspaceId else { return }
        try? store.saveDesign(CachedDesign(
            designId: route.designId,
            key: designKey,
            name: name,
            kind: kind,
            workspaceId: workspaceId,
            permission: permission,
            confirmedSeq: checkpoint.confirmedSeq,
            designJSON: checkpoint.designJSON,
            pending: checkpoint.pending,
            share: share,
            needsServerCopy: cacheNeedsServerCopy
        ))
    }

    // MARK: Changes

    private func documentChanged() {
        revision &+= 1
        canvas?.documentDidChange()
        let pageIds = pages.map(\.id)
        refreshPages()
        refreshSelection()
        scheduleThumbnails(all: pages.map(\.id) != pageIds)
    }

    private func remoteChanged(_ tx: DesignTransaction) {
        let touchesStyles = tx.ops.contains { op in
            if case .styles = op { return true }
            return false
        }
        if touchesStyles {
            Task { [weak self] in
                guard let self, let json = try? await self.engine.snapshot(), let design = try? Design(jsonString: json) else { return }
                self.updateStyleColors(design.styles)
            }
        }
        for op in tx.ops {
            if case let .asset(set, remove) = op {
                assetRefs.merge(set) { _, new in new }
                for id in remove { assetRefs[id] = nil }
            }
            if case let .doc(set, _) = op, let newName = set["name"]?.stringValue {
                name = newName
            }
        }
        if let editing = editingTextId, (try? engine.core.nodeJson(id: editing)) == nil {
            endTextEditing()
        }
        // A collaborator may have changed any page.
        scheduleThumbnails(all: true)
    }

    private func updateStyleColors(_ styles: DesignStyles) {
        let colors = styles.json["colors"]?.objectValue ?? [:]
        styleColors = colors.values
            .compactMap { entry -> (name: String, hex: String)? in
                guard let hex = entry["value"]?.stringValue, HexColor.parse(hex) != nil else { return nil }
                return (entry["name"]?.stringValue ?? "", String(hex.lowercased().prefix(7)))
            }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            .map { $0.hex }
    }

    func refreshPages() {
        pages = (try? engine.core.pages()) ?? []
        if currentPageId == nil || !pages.contains(where: { $0.id == currentPageId }) {
            currentPageId = pages.first?.id
            canvas?.pageDidChange()
        }
    }

    func refreshSelection() {
        let nodes = selection.compactMap { id -> Node? in
            guard let json = try? engine.core.nodeJson(id: id) else { return nil }
            return try? Node(jsonString: json)
        }
        if nodes.count != selection.count {
            selection = nodes.map(\.id)
        }
        selectedNodes = nodes
        canvas?.selectionDidChange()
    }

    // MARK: Selection

    public func select(_ ids: [String]) {
        guard ids != selection else { return }
        if let editing = editingTextId, ids != [editing] { endTextEditing() }
        selection = ids
        refreshSelection()
        if !ids.isEmpty { Haptics.selection() }
    }

    public func clearSelection() {
        select([])
    }

    public func showPage(_ id: String) {
        guard id != currentPageId else { return }
        endTextEditing()
        selection = []
        selectedNodes = []
        currentPageId = id
        canvas?.pageDidChange()
        canvas?.selectionDidChange()
        Haptics.selection()
    }

    func setZoom(_ zoom: Double) {
        let percent = Int((zoom * 100).rounded())
        if percent != zoomPercent { zoomPercent = percent }
    }

    // MARK: Committing

    /// Applies ops as one undoable transaction (and queues it for the server).
    @discardableResult
    func commit(_ ops: [Op], label: String) async -> Bool {
        await commit(opsJSON: Op.serialize(ops), label: label)
    }

    @discardableResult
    func commit(opsJSON: String, label: String) async -> Bool {
        guard canEdit, let sync else {
            session.toasts.show("This design is view only.", tone: .info)
            return false
        }
        do {
            guard let local = try await sync.commit(opsJSON: opsJSON, label: label) else { return false }
            recordHistory(local)
            return true
        } catch {
            session.toasts.show(DesynError(error).message, tone: .error)
            return false
        }
    }

    /// Live preview of a gesture (not committed, not in history).
    func preview(opsJSON: String) async {
        guard canEdit, let sync else { return }
        try? await sync.setPreview(opsJSON: opsJSON)
    }

    func cancelPreview() async {
        try? await sync?.clearPreview()
    }

    // MARK: Text editing

    public func beginTextEditing(_ id: String, selectAll: Bool = false) {
        guard canEdit else { return }
        if selection != [id] {
            selection = [id]
            refreshSelection()
        }
        editingTextId = id
        canvas?.beginTextEditing(id, selectAll: selectAll)
    }

    public func endTextEditing() {
        guard editingTextId != nil else { return }
        canvas?.endTextEditing()
        editingTextId = nil
    }

    // MARK: Assets

    /// Fetches bytes for assets the last frame could not draw, then renders again.
    func fetchMissingAssets(_ ids: [String]) {
        guard let assets else { return }
        for id in ids where !fetchingAssets.contains(id) {
            fetchingAssets.insert(id)
            let ref = assetRefs[id]
            Task { [weak self] in
                let data = await assets.data(for: id, ref: ref)
                guard let self else { return }
                if let data {
                    if ref?.kind == "font" {
                        _ = try? await self.engine.setFont(data, family: ref?.family)
                        // Text measured with the real font now: relayout through the sync queue (exact inverse,
                        // never between a rebase's rewind and replay).
                        if let sync = self.sync {
                            try? await sync.relayout()
                        } else {
                            _ = try? await self.document.relayout()
                        }
                    } else {
                        await self.engine.setAsset(id, data: data)
                    }
                    self.canvas?.documentDidChange()
                    self.scheduleThumbnails(all: true)
                    self.fetchingAssets.remove(id)
                } else {
                    // Try again after a while (offline or not signed yet), without hammering.
                    try? await Task.sleep(for: .seconds(20))
                    self.fetchingAssets.remove(id)
                }
            }
        }
    }

    /// Uploads an image and places it on the current page.
    public func insertImage(data: Data, mime: String, name: String, pixelSize: CGSize) async {
        guard canEdit, let page = currentPage else { return }
        guard let workspaceId else { return }
        isUploading = true
        defer { isUploading = false }
        do {
            let info = try await AssetUploader(api: session.api).upload(
                data,
                name: name,
                mime: mime,
                workspaceId: workspaceId,
                width: Double(pixelSize.width),
                height: Double(pixelSize.height)
            )
            let ref = info.assetRef
            await engine.setAsset(ref.id, data: data)
            await assets?.remember(data, id: ref.id, ref: ref)
            assetRefs[ref.id] = ref
            let fit = min(page.width * 0.6 / max(1, pixelSize.width), page.height * 0.6 / max(1, pixelSize.height))
            let size = CGSize(width: pixelSize.width * fit, height: pixelSize.height * fit)
            let center = canvas?.visiblePageCenter() ?? DesignPoint(x: page.width / 2, y: page.height / 2)
            let node = NodeFactory.image(
                parent: page.id,
                assetId: ref.id,
                frame: PageRect(x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height),
                name: name
            )
            if await commit([.asset(set: [ref.id: ref], remove: []), .create(nodes: [node], parent: page.id, index: nil)], label: "Add image") {
                select([node.id])
                tool = .select
            }
        } catch {
            let mapped = DesynError(error)
            session.toasts.show(mapped.isTransient ? "Connect to the internet to add photos." : mapped.message, tone: .error)
        }
    }

    // MARK: Thumbnails

    private func scheduleThumbnails(all: Bool = false) {
        if all { thumbnailsNeedAll = true }
        thumbnailTask?.cancel()
        thumbnailTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled, let self else { return }
            await self.renderThumbnails()
        }
    }

    /// Renders the strip's thumbnails: every page after structural or remote changes, else just the current
    /// page (a 60-page deck must not re-render 60 pages, on the engine's serial queue, after every keystroke).
    private func renderThumbnails() async {
        let renderAll = thumbnailsNeedAll || pageThumbnails.isEmpty
        thumbnailsNeedAll = false
        let visible = Set(pages.prefix(60).map(\.id))
        var images = renderAll ? [:] : pageThumbnails.filter { visible.contains($0.key) }
        let targets = renderAll ? Array(pages.prefix(60)) : [currentPage].compactMap { $0 }
        for page in targets {
            let longest = max(page.width, page.height, 1)
            let scale = min(1, 240 / longest)
            if let frame = try? await engine.renderPage(PageImageRequest(pageId: page.id, scale: scale)), let image = frame.makeCGImage() {
                images[page.id] = image
            }
            if Task.isCancelled {
                if renderAll { thumbnailsNeedAll = true }
                return
            }
        }
        pageThumbnails = images
    }
}
