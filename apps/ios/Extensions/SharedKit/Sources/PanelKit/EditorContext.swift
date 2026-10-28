import DesignSystem
import DesynKit
import EditorFeature
import Foundation
import Observation
import SharedKit

/// The panels feature modules open over the editor (one at a time; presented by the canvas overlay).
public enum EditorPanel: Hashable, Identifiable, Sendable {
    case insert(InsertTab)
    case brand
    case aiTools
    case export
    case share
    case comments
    case history

    public var id: String {
        switch self {
        case let .insert(tab): "insert.\(tab.rawValue)"
        case .brand: "brand"
        case .aiTools: "aiTools"
        case .export: "export"
        case .share: "share"
        case .comments: "comments"
        case .history: "history"
        }
    }
}

/// Tabs of the insert sheet.
public enum InsertTab: String, CaseIterable, Sendable, Identifiable {
    case elements, text, photos, icons, charts, uploads

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .elements: "Shapes"
        case .text: "Text"
        case .photos: "Photos"
        case .icons: "Icons"
        case .charts: "Charts"
        case .uploads: "Uploads"
        }
    }

    public var systemImage: String {
        switch self {
        case .elements: "square.on.circle"
        case .text: "textformat"
        case .photos: "photo.on.rectangle"
        case .icons: "star.square"
        case .charts: "chart.bar"
        case .uploads: "tray.and.arrow.up"
        }
    }
}

/// Layers highlighted on the canvas while the AI works ("pulse") and when its changes land ("sunrise" sweep).
public struct CanvasHighlight: Equatable, Sendable, Identifiable {
    public enum Style: Equatable, Sendable {
        /// A soft breathing sun glow on layers the agent is working on.
        case pulse
        /// One warm sweep across changed layers, then gone.
        case sunrise
    }

    public let id: UUID
    public let nodeIds: [String]
    public let style: Style
    public let start: Date

    public init(nodeIds: [String], style: Style, start: Date = Date()) {
        id = UUID()
        self.nodeIds = nodeIds
        self.style = style
        self.start = start
    }

    /// Seconds a sunrise sweep lasts.
    public static let sunriseDuration: TimeInterval = 1.8
}

/// Shared state of the feature modules for one open design: which panel is open, AI highlights, comment pins, the
/// AI dock and fonts. One per `EditorModel` (`EditorContext.for(model)`), released with it.
@MainActor
@Observable
public final class EditorContext {
    public var panel: EditorPanel?
    /// The AI dock sheet is open.
    public var isAIDockOpen = false
    /// Comment pins are drawn on the canvas.
    public var showsCommentPins = false
    /// The next tap on the canvas places a new comment (the pins overlay catches it).
    public var isPlacingComment = false
    /// A page point where a new comment is being placed (pin follows the composer).
    public var commentDraftPoint: PagePoint?
    /// Threads of the open design (filled by the comments module; pins read them).
    public var commentThreads: [CommentThread] = []
    /// The thread the pins / panel focus.
    public var focusedThreadId: String?
    public private(set) var highlights: [CanvasHighlight] = []
    /// The run the AI dock follows.
    public var activeRunId: String?
    /// A prompt to send once the dock opens (from Shortcuts / the widget / "Create design from prompt").
    public var queuedPrompt: (text: String, mode: AIMode)?
    /// The design's workspace (resolved once; uploads and brand kits live there).
    public private(set) var workspaceId: String?
    /// The signed-in person's plan features: the plan known offline first, then what `profiles:me` resolves (feature
    /// flags included). Gates what the device makes on its own (local exports, charts, tables, QR codes, advanced
    /// effects, animations); the server enforces its own checks.
    public private(set) var planFeatures: PlanFeatures

    public let fonts: FontService
    @ObservationIgnored public private(set) weak var model: EditorModel?

    private init(model: EditorModel) {
        self.model = model
        fonts = FontService.shared
        planFeatures = PlanFeatures.resolve(live: nil, plan: model.session.profile?.plan)
        if let launch = EditorLaunchActions.take(designId: model.designId) {
            queuedPrompt = (launch.prompt, launch.mode)
            isAIDockOpen = true
        }
        Task { [weak self] in await self?.refreshPlanFeatures() }
    }

    // MARK: Plan

    /// Reads the resolved features once from `profiles:me` (keeps the offline plan when that fails).
    public func refreshPlanFeatures() async {
        guard let api = model?.session.api else { return }
        do {
            for try await profile in api.accountProfileUpdates() {
                if let profile {
                    planFeatures = PlanFeatures.resolve(live: profile.features, plan: profile.plan)
                }
                break
            }
        } catch {
            // Offline or signed out: the plan known from the cached profile stays in effect.
        }
    }

    /// True when the plan lacks `feature` (the control shows a PRO pill).
    public func isLocked(_ feature: String) -> Bool {
        !planFeatures.allows(feature)
    }

    /// True when `feature` is included; otherwise says it is part of Pro (no purchase links, App Store 3.1.1).
    @discardableResult
    public func require(_ feature: String) -> Bool {
        guard isLocked(feature) else { return true }
        Haptics.selection()
        model?.session.toasts.show(PlanFeatures.lockedMessage(feature), tone: .info)
        return false
    }

    // MARK: Registry

    private static var contexts: [ObjectIdentifier: EditorContext] = [:]

    /// The context of `model` (created on first use).
    public static func `for`(_ model: EditorModel) -> EditorContext {
        contexts = contexts.filter { $0.value.model != nil }
        let key = ObjectIdentifier(model)
        if let existing = contexts[key] { return existing }
        let context = EditorContext(model: model)
        contexts[key] = context
        return context
    }

    // MARK: Panels

    /// Opens a panel. The AI dock is a separate sheet: it closes first and the panel follows once it is gone (two
    /// sheets cannot animate at the same time).
    public func open(_ panel: EditorPanel) {
        Haptics.selection()
        guard isAIDockOpen else {
            self.panel = panel
            return
        }
        isAIDockOpen = false
        Task { [weak self] in
            try? await Task.sleep(for: Self.sheetHandoff)
            self?.panel = panel
        }
    }

    /// Opens the AI dock, optionally with a prompt to send, after closing any open panel.
    public func openAIDock(prompt: (text: String, mode: AIMode)? = nil) {
        if let prompt { queuedPrompt = prompt }
        guard panel != nil else {
            isAIDockOpen = true
            return
        }
        panel = nil
        Task { [weak self] in
            try? await Task.sleep(for: Self.sheetHandoff)
            self?.isAIDockOpen = true
        }
    }

    /// Time for one sheet to finish dismissing before the next is presented.
    private static let sheetHandoff: Duration = .milliseconds(450)

    // MARK: Highlights

    /// Pulses `nodeIds` while the AI edits them (replaces the previous pulse).
    public func pulse(_ nodeIds: [String]) {
        highlights.removeAll { $0.style == .pulse }
        guard !nodeIds.isEmpty else { return }
        highlights.append(CanvasHighlight(nodeIds: nodeIds, style: .pulse))
    }

    /// Ends the pulse and sweeps the sunrise over `nodeIds` (the agent finished).
    public func sunrise(_ nodeIds: [String]) {
        highlights.removeAll { $0.style == .pulse }
        guard !nodeIds.isEmpty else { return }
        let highlight = CanvasHighlight(nodeIds: nodeIds, style: .sunrise)
        highlights.append(highlight)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(CanvasHighlight.sunriseDuration + 0.1))
            self?.highlights.removeAll { $0.id == highlight.id }
        }
    }

    public func clearHighlights() {
        highlights.removeAll()
    }

    // MARK: Workspace

    /// The workspace that owns the design (uploads, AI results and brand kits go there).
    public func resolveWorkspaceId() async throws -> String {
        if let workspaceId { return workspaceId }
        guard let model else { throw DesynError.unexpected("The design is closed.") }
        if let cached = model.session.store?.loadDesign(model.designId)?.workspaceId, !cached.isEmpty {
            workspaceId = cached
            return cached
        }
        let detail = try await model.session.api.design(designId: model.designId, share: model.route.share)
        workspaceId = detail.workspaceId
        return detail.workspaceId
    }
}

/// Things to do when a design opens: set by App Intents, the widget or the share extension flow before the editor
/// appears, taken once by the design's `EditorContext`.
@MainActor
public enum EditorLaunchActions {
    public struct Action: Sendable {
        public let prompt: String
        public let mode: AIMode
    }

    private static var pending: [String: Action] = [:]

    /// Starts an AI run with `prompt` when `designId` opens.
    public static func queuePrompt(_ prompt: String, mode: AIMode, for designId: String) {
        pending[designId] = Action(prompt: prompt, mode: mode)
    }

    static func take(designId: String) -> Action? {
        pending.removeValue(forKey: designId)
    }
}
