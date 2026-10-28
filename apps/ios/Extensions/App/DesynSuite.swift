import AIFeature
import AppFeature
import AssetsFeature
import CommentsFeature
import DesignSystem
import DesynKit
import EditorFeature
import ExportFeature
import FeatureCore
import InspectorFeature
import LibraryFeature
import PanelKit
import SettingsFeature
import ShareFeature
import SharedKit
import SwiftUI

/// The composition root of the editor features (apps/ios/Features/*) and the app extensions: registers the
/// editor's and library's extension points, routes Desyn's own links (widget, Shortcuts) and keeps the widget's
/// recent-designs snapshot current. Called once from `DesynApp`.
@MainActor
enum DesynSuite {
    private(set) static var app: AppModel?

    static func install(app: AppModel) {
        self.app = app
        EditorExtensions.registered = EditorExtensions(
            topBarTrailing: { AnyView(EditorTopBarItems(editor: $0)) },
            dockAccessory: { AnyView(InsertDockButton(editor: $0)) },
            bottomAccessory: { AnyView(AIPromptBar(editor: $0)) },
            canvasOverlay: { AnyView(EditorOverlayHost(editor: $0)) },
            inspector: { AnyView(InspectorView(editor: $0)) }
        )
        LibraryExtensions.registered = LibraryExtensions(account: { AnyView(SettingsView(session: $0)) })
        AppModel.linkHandler = { url, app in await DesynLinks.handle(url, app: app) }
    }
}

/// `desyn://new[?kind=]` and `desyn://create?prompt=&kind=` (widget, Shortcuts, other apps).
@MainActor
enum DesynLinks {
    static func handle(_ url: URL, app: AppModel) async -> Bool {
        guard url.scheme == AppEnvironment.callbackScheme, url.host == "new" || url.host == "create" else { return false }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let prompt = items.first { $0.name == "prompt" }?.value
        let kind = items.first { $0.name == "kind" }?.value.map(DesignKind.init(rawValue:))
        do {
            _ = try await DesignCreator.create(app: app, kind: kind, prompt: prompt)
        } catch {
            app.session.toasts.show(DesynError(error).message, tone: .error)
        }
        return true
    }
}

/// Creates a design (optionally starting the AI on it) and opens it in the editor.
@MainActor
enum DesignCreator {
    struct Created {
        let designId: String
        let name: String
    }

    static func create(app: AppModel, kind: DesignKind?, prompt: String?) async throws -> Created {
        let session = app.session
        guard session.phase == .signedIn else {
            throw DesynError.server(code: "UNAUTHENTICATED", message: "Sign in to Desyn first, then try again.")
        }
        if session.workspaceId == nil { await session.refreshAccount() }
        guard let workspaceId = session.workspaceId ?? session.currentWorkspace?.id else {
            throw DesynError.offline("Connect to the internet to create a design.")
        }
        let trimmed = prompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let resolvedKind = kind ?? Self.kind(for: trimmed)
        let name = trimmed.isEmpty ? "Untitled \(resolvedKind.label.lowercased())" : String(trimmed.prefix(60))
        let created = try await session.api.createDesign(workspaceId: workspaceId, kind: resolvedKind, presetId: nil, name: name)
        if !trimmed.isEmpty {
            EditorLaunchActions.queuePrompt(trimmed, mode: .generate, for: created.designId)
        }
        app.openDesign = DesignRoute(designId: created.designId, name: name)
        return Created(designId: created.designId, name: name)
    }

    /// A design kind guessed from a prompt ("an instagram story about..." -> story), social post otherwise.
    static func kind(for prompt: String) -> DesignKind {
        let text = prompt.lowercased()
        let rules: [(words: [String], kind: String)] = [
            (["story", "stories", "reel"], "story"),
            (["presentation", "slides", "deck", "pitch"], "presentation"),
            (["poster"], "poster"),
            (["flyer", "leaflet"], "flyer"),
            (["youtube", "thumbnail"], "thumbnail"),
            (["banner", "header", "cover photo"], "banner"),
            (["business card"], "business-card"),
            (["resume", "cv"], "resume"),
            (["invitation", "invite", "wedding"], "invitation"),
            (["menu"], "menu"),
            (["logo"], "logo"),
            (["newsletter"], "newsletter"),
            (["infographic"], "infographic"),
            (["certificate"], "certificate"),
            (["book cover"], "book-cover"),
            (["ad ", "advert"], "ad"),
        ]
        for rule in rules where rule.words.contains(where: { text.contains($0) }) {
            return DesignKind(rawValue: rule.kind)
        }
        return .socialPost
    }
}

// MARK: Editor chrome

/// Top bar items: comments and share always; export and history directly on wide screens, in a menu on phones.
struct EditorTopBarItems: View {
    let editor: EditorModel
    @State private var context: EditorContext
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(editor: EditorModel) {
        self.editor = editor
        _context = State(initialValue: EditorContext.for(editor))
    }

    var body: some View {
        GlassBar {
            if sizeClass == .regular {
                GlassIconButton("text.bubble", label: "Comments", badge: hasOpenComments) { context.open(.comments) }
                GlassIconButton("clock.arrow.circlepath", label: "Version history") { context.open(.history) }
                GlassIconButton("square.and.arrow.up", label: "Export") { context.open(.export) }
                GlassIconButton("person.crop.circle.badge.plus", label: "Share") { context.open(.share) }
            } else {
                Menu {
                    Button { context.open(.share) } label: { Label("Share", systemImage: "person.crop.circle.badge.plus") }
                    Button { context.open(.export) } label: { Label("Export", systemImage: "square.and.arrow.up") }
                    Button { context.open(.comments) } label: { Label("Comments", systemImage: "text.bubble") }
                    Button { context.open(.history) } label: { Label("Version history", systemImage: "clock.arrow.circlepath") }
                    if editor.canEdit {
                        Divider()
                        Button { context.open(.brand) } label: { Label("Brand", systemImage: "seal") }
                        Button { context.open(.aiTools) } label: { Label("Create with AI", systemImage: "square.and.pencil") }
                    }
                } label: {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Palette.foreground)
                        .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
                        .overlay(alignment: .topTrailing) {
                            if hasOpenComments {
                                Circle().fill(Palette.sun).frame(width: 7, height: 7).offset(x: -9, y: 9)
                            }
                        }
                }
                .accessibilityLabel("Share, export and more")
            }
        }
    }

    private var hasOpenComments: Bool { context.commentThreads.contains { !$0.resolved } }
}

/// The "+" at the end of the tool dock: the insert sheet, with quick access to the other insert tabs, brand and AI
/// tools.
struct InsertDockButton: View {
    let editor: EditorModel
    @State private var context: EditorContext

    init(editor: EditorModel) {
        self.editor = editor
        _context = State(initialValue: EditorContext.for(editor))
    }

    var body: some View {
        Menu {
            ForEach(InsertTab.allCases) { tab in
                Button { context.open(.insert(tab)) } label: { Label(tab.title, systemImage: tab.systemImage) }
            }
            Divider()
            Button { context.open(.brand) } label: { Label("Brand kit", systemImage: "seal") }
            Button { context.open(.aiTools) } label: { Label("Create with AI", systemImage: "square.and.pencil") }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Palette.onSun)
                .frame(width: 36, height: 36)
                .background(Palette.sunGradient, in: Circle())
                .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
        } primaryAction: {
            context.open(.insert(.elements))
        }
        .accessibilityLabel("Add elements")
        .accessibilityHint("Opens shapes, text, photos, icons and charts. Long press for more.")
    }
}

/// Full-screen layer between the canvas and the chrome: AI highlights, comment pins, the feature sheets, and the
/// engine's font requests (Google Fonts families a design uses load on demand).
struct EditorOverlayHost: View {
    let editor: EditorModel
    @State private var context: EditorContext

    init(editor: EditorModel) {
        self.editor = editor
        _context = State(initialValue: EditorContext.for(editor))
    }

    var body: some View {
        ZStack {
            AIHighlightOverlay(editor: editor)
            CommentPinsOverlay(editor: editor)
        }
        .ignoresSafeArea()
        .background {
            Color.clear
                .sheet(item: $context.panel) { panel in
                    panelView(panel)
                }
        }
        .background {
            Color.clear
                .sheet(isPresented: $context.isAIDockOpen) {
                    AIDockSheet(editor: editor)
                }
        }
        .task(id: editor.revision) {
            // Debounced: the request list drains after the document settles.
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await context.fonts.serviceEngineRequests(for: editor)
        }
        .onDisappear {
            AIDocks.release(editor)
        }
    }

    @ViewBuilder private func panelView(_ panel: EditorPanel) -> some View {
        switch panel {
        case let .insert(tab): InsertSheet(editor: editor, context: context, tab: tab)
        case .brand: BrandPanel(editor: editor, context: context)
        case .aiTools: GenerativeToolsPanel(editor: editor, context: context)
        case .export: ExportSheet(editor: editor, context: context)
        case .share: SharePanel(editor: editor)
        case .comments: CommentsPanel(editor: editor)
        case .history: HistoryPanel(editor: editor)
        }
    }
}
