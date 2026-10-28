import DesignSystem
import DesynKit
import FeatureCore
import Foundation
import Observation

/// The library: recent designs, folders, shared with me, templates and brand kits for the current workspace.
/// Lists come from the offline cache first, then from Convex (the recent list stays live while visible).
@MainActor
@Observable
public final class LibraryModel {
    public enum Tab: String, CaseIterable, Hashable, Sendable {
        case recent, folders, shared, templates, brand

        public var title: String {
            switch self {
            case .recent: "Recent"
            case .folders: "Folders"
            case .shared: "Shared"
            case .templates: "Templates"
            case .brand: "Brand"
            }
        }

        public var systemImage: String {
            switch self {
            case .recent: "clock"
            case .folders: "folder"
            case .shared: "person.2"
            case .templates: "square.grid.2x2"
            case .brand: "paintpalette"
            }
        }
    }

    public var tab: Tab = .recent {
        didSet { if tab != oldValue { Task { await self.loadCurrentTab() } } }
    }

    public var query = "" {
        didSet { if query != oldValue { scheduleSearch() } }
    }

    public private(set) var recent: [DesignSummary] = []
    public private(set) var shared: [DesignSummary] = []
    public private(set) var folders: [Folder] = []
    public private(set) var templates: [TemplateSummary] = []
    public private(set) var brandKits: [BrandKit] = []
    public private(set) var loading: Set<Tab> = []
    public private(set) var loaded: Set<Tab> = []
    public private(set) var canLoadMore: Set<Tab> = []
    public var errorMessage: String?

    public let session: AppSession

    @ObservationIgnored private var cursors: [Tab: String] = [:]
    @ObservationIgnored private var liveTask: Task<Void, Never>?
    @ObservationIgnored private var searchTask: Task<Void, Never>?

    public init(session: AppSession) {
        self.session = session
    }

    private var workspaceId: String? { session.workspaceId }
    private var trimmedQuery: String? {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    // MARK: Loading

    /// Shows cached lists immediately, then loads the visible tab.
    public func appear() async {
        restoreCache()
        Task { await self.flushOfflineEdits() }
        if tab != .folders {
            // Folder names for "Move to folder" on design cards.
            Task { await self.load(.folders, append: false) }
        }
        await loadCurrentTab()
    }

    /// Pull to refresh.
    public func refresh() async {
        cursors[tab] = nil
        await flushOfflineEdits()
        await load(tab, append: false)
    }

    /// Sends edits made offline in designs that are closed now (they would otherwise wait for a reopen).
    private func flushOfflineEdits() async {
        guard session.isAuthenticated, let store = session.store else { return }
        let session = self.session
        // Asked again after every commit: a design opened meanwhile belongs to its editor.
        let report = await PendingFlush.run(store: store, backend: session.api, isOpen: { session.openDesignId == $0 })
        if report.rejected > 0 {
            let changes = report.rejected == 1 ? "1 offline change" : "\(report.rejected) offline changes"
            session.toasts.show("\(changes) couldn't be saved; the server refused them.", tone: .error)
        } else if report.sent > 0 {
            session.toasts.show("Synced your offline edits.", tone: .success)
        }
    }

    public func loadMore() async {
        guard canLoadMore.contains(tab), !loading.contains(tab) else { return }
        await load(tab, append: true)
    }

    /// The workspace changed: start over.
    public func workspaceChanged() async {
        recent = []
        folders = []
        brandKits = []
        loaded = []
        cursors = [:]
        restoreCache()
        await loadCurrentTab()
    }

    func loadCurrentTab() async {
        if tab == .recent { startLiveRecent() } else { stopLive() }
        await load(tab, append: false)
    }

    private func load(_ tab: Tab, append: Bool) async {
        guard session.isAuthenticated else { return }
        loading.insert(tab)
        defer { loading.remove(tab) }
        do {
            switch tab {
            case .recent:
                guard let workspaceId else { return }
                let page = try await session.api.designs(workspaceId: workspaceId, filter: .recent, search: trimmedQuery, cursor: append ? cursors[.recent] : nil)
                recent = append ? recent + page.page.filter { item in !recent.contains { $0.id == item.id } } : page.page
                track(page.continueCursor, done: page.isDone, for: .recent)
                if trimmedQuery == nil { session.store?.saveList(recent, key: "recent/\(workspaceId)") }
            case .shared:
                let page = try await session.api.designs(workspaceId: nil, filter: .shared, search: trimmedQuery, cursor: append ? cursors[.shared] : nil)
                shared = append ? shared + page.page : page.page
                track(page.continueCursor, done: page.isDone, for: .shared)
                if trimmedQuery == nil { session.store?.saveList(shared, key: "shared") }
            case .folders:
                guard let workspaceId else { return }
                for try await list in session.api.folders(workspaceId: workspaceId) {
                    folders = list
                    break
                }
                session.store?.saveList(folders, key: "folders/\(workspaceId)")
            case .templates:
                let page: PaginatedResult<TemplateSummary>
                if let trimmedQuery {
                    page = try await session.api.searchTemplates(query: trimmedQuery, cursor: append ? cursors[.templates] : nil)
                } else {
                    page = try await session.api.templates(cursor: append ? cursors[.templates] : nil)
                }
                templates = append ? templates + page.page : page.page
                track(page.continueCursor, done: page.isDone, for: .templates)
                if trimmedQuery == nil { session.store?.saveList(templates, key: "templates") }
            case .brand:
                guard let workspaceId else { return }
                brandKits = try await session.api.brandKits(workspaceId: workspaceId)
                session.store?.saveList(brandKits, key: "brand/\(workspaceId)")
            }
            loaded.insert(tab)
            errorMessage = nil
        } catch {
            let mapped = DesynError(error)
            // Offline keeps the cached list on screen; other errors are worth saying.
            if !mapped.isTransient { errorMessage = mapped.message }
        }
    }

    private func track(_ cursor: String?, done: Bool, for tab: Tab) {
        cursors[tab] = cursor
        if done || cursor == nil { canLoadMore.remove(tab) } else { canLoadMore.insert(tab) }
    }

    private func restoreCache() {
        guard let store = session.store else { return }
        if let workspaceId {
            if recent.isEmpty, let cached = store.loadList([DesignSummary].self, key: "recent/\(workspaceId)") { recent = cached }
            if folders.isEmpty, let cached = store.loadList([Folder].self, key: "folders/\(workspaceId)") { folders = cached }
            if brandKits.isEmpty, let cached = store.loadList([BrandKit].self, key: "brand/\(workspaceId)") { brandKits = cached }
        }
        if shared.isEmpty, let cached = store.loadList([DesignSummary].self, key: "shared") { shared = cached }
        if templates.isEmpty, let cached = store.loadList([TemplateSummary].self, key: "templates") { templates = cached }
    }

    /// Keeps the first page of recent designs live (edits on other devices reorder it).
    private func startLiveRecent() {
        stopLive()
        guard session.isAuthenticated, let workspaceId else { return }
        let api = session.api
        let search = trimmedQuery
        liveTask = Task { [weak self] in
            do {
                for try await page in api.designUpdates(workspaceId: workspaceId, filter: .recent, search: search) {
                    guard let self, !Task.isCancelled else { return }
                    // Keep pages loaded beyond the first.
                    let extra = self.recent.dropFirst(page.page.count).filter { item in !page.page.contains { $0.id == item.id } }
                    self.recent = page.page + extra
                    if search == nil { self.session.store?.saveList(self.recent, key: "recent/\(workspaceId)") }
                }
            } catch {
                // The next appear / refresh restarts it.
            }
        }
    }

    private func stopLive() {
        liveTask?.cancel()
        liveTask = nil
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, let self else { return }
            self.cursors[self.tab] = nil
            await self.loadCurrentTab()
        }
    }

    /// Designs inside a folder (loaded on demand by the folder screen).
    public func designs(inFolder folderId: String) async throws -> [DesignSummary] {
        guard let workspaceId else { return [] }
        let page = try await session.api.designs(workspaceId: workspaceId, filter: .folder, folderId: folderId, pageSize: 100)
        session.store?.saveList(page.page, key: "folder/\(folderId)")
        return page.page
    }

    public func cachedDesigns(inFolder folderId: String) -> [DesignSummary] {
        session.store?.loadList([DesignSummary].self, key: "folder/\(folderId)") ?? []
    }

    // MARK: Creating

    /// Creates a design from a preset and returns the route to open it.
    public func create(preset: PagePreset) async -> DesignRoute? {
        await perform("Couldn't create the design.") {
            guard let workspaceId = self.workspaceId else { throw DesynError.unexpected("No workspace is selected.") }
            let created = try await self.session.api.createDesign(
                workspaceId: workspaceId, kind: preset.kind, presetId: preset.id, name: "Untitled \(preset.kind.label.lowercased())"
            )
            Haptics.success()
            return DesignRoute(designId: created.designId, name: "Untitled \(preset.kind.label.lowercased())")
        }
    }

    /// Creates a design with a custom page size.
    public func createCustom(width: Double, height: Double, unit: PageUnit) async -> DesignRoute? {
        await perform("Couldn't create the design.") {
            guard let workspaceId = self.workspaceId else { throw DesynError.unexpected("No workspace is selected.") }
            let px = (width * unit.pxPerUnit, height * unit.pxPerUnit)
            guard px.0 >= 1, px.1 >= 1, px.0 <= 20_000, px.1 <= 20_000 else {
                throw DesynError.server(code: "INVALID_ARGUMENT", message: "Pick a size between 1 and 20000 px on each side.")
            }
            let created = try await self.session.api.createDesign(
                workspaceId: workspaceId, kind: .custom, presetId: nil, size: (px.0, px.1, unit), name: "Untitled design"
            )
            Haptics.success()
            return DesignRoute(designId: created.designId, name: "Untitled design")
        }
    }

    public func use(template: TemplateSummary) async -> DesignRoute? {
        await perform("Couldn't use this template.") {
            guard let workspaceId = self.workspaceId else { throw DesynError.unexpected("No workspace is selected.") }
            let created = try await self.session.api.instantiateTemplate(templateId: template.id, workspaceId: workspaceId)
            Haptics.success()
            return DesignRoute(designId: created.designId, name: template.title)
        }
    }

    // MARK: Managing

    public func rename(_ design: DesignSummary, to name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != design.name else { return }
        _ = await perform("Couldn't rename the design.") {
            try await self.session.api.renameDesign(designId: design.id, name: trimmed)
            await self.refresh()
            return true
        }
    }

    public func duplicate(_ design: DesignSummary) async {
        _ = await perform("Couldn't duplicate the design.") {
            _ = try await self.session.api.duplicateDesign(designId: design.id)
            self.session.toasts.show("Duplicated \(design.name).", tone: .success)
            await self.refresh()
            return true
        }
    }

    /// Whether the signed-in user can add designs and folders to the current workspace (editor or above).
    public var canEditWorkspace: Bool {
        guard let role = session.currentWorkspace?.role else { return false }
        return ["owner", "admin", "editor"].contains(role)
    }

    /// Creates a folder (inside `parentId` when given) and refreshes the folder list.
    @discardableResult
    public func createFolder(named name: String, parentId: String? = nil) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return await perform("Couldn't create the folder.") {
            guard let workspaceId = self.workspaceId else { throw DesynError.unexpected("No workspace is selected.") }
            _ = try await self.session.api.createFolder(workspaceId: workspaceId, name: trimmed, parentId: parentId)
            Haptics.success()
            await self.load(.folders, append: false)
            return true
        } ?? false
    }

    /// Moves a design into a folder (nil = out of every folder).
    public func move(_ design: DesignSummary, to folderId: String?) async {
        _ = await perform("Couldn't move the design.") {
            try await self.session.api.moveDesign(designId: design.id, folderId: folderId)
            let target = folderId.flatMap { id in self.folders.first { $0.id == id }?.name }
            self.session.toasts.show(target.map { "Moved \(design.name) to \($0)." } ?? "Moved \(design.name) out of its folder.", tone: .success)
            await self.refresh()
            return true
        }
    }

    public func trash(_ design: DesignSummary) async {
        _ = await perform("Couldn't move the design to the trash.") {
            try await self.session.api.trashDesign(designId: design.id)
            self.recent.removeAll { $0.id == design.id }
            self.session.store?.removeDesign(design.id)
            self.session.toasts.show("Moved \(design.name) to the trash.")
            return true
        }
    }

    private func perform<T>(_ fallback: String, _ operation: @escaping @MainActor () async throws -> T) async -> T? {
        do {
            return try await operation()
        } catch {
            let mapped = DesynError(error)
            session.toasts.show(mapped.isTransient ? "You're offline. \(fallback)" : mapped.message, tone: .error)
            return nil
        }
    }
}
