import DesignSystem
import DesynKit
import FeatureCore
import SwiftUI

/// The home screen: greeting, search, section tabs and a create button.
public struct LibraryView: View {
    @Bindable private var model: LibraryModel
    private let onOpen: (DesignRoute) -> Void

    @State private var showCreate = false
    @State private var renaming: DesignSummary?
    @State private var renameText = ""
    @State private var templatePreview: TemplateSummary?
    @State private var showAccount = false
    @Environment(\.libraryExtensions) private var extensions

    public init(model: LibraryModel, onOpen: @escaping (DesignRoute) -> Void) {
        self.model = model
        self.onOpen = onOpen
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Spacing.lg, pinnedViews: [.sectionHeaders]) {
                header
                Section {
                    content
                        .padding(.horizontal, Spacing.gutter)
                } header: {
                    VStack(spacing: Spacing.sm) {
                        DSTextField("", text: $model.query, prompt: searchPrompt, kind: .search, submitLabel: .search)
                            .padding(.horizontal, Spacing.gutter)
                        DSTabStrip(selection: $model.tab, tabs: LibraryModel.Tab.allCases.map { ($0, $0.title, $0.systemImage) })
                    }
                    .padding(.vertical, Spacing.sm)
                    .background(Palette.background.opacity(0.94))
                }
            }
            .padding(.bottom, 120)
        }
        .scrollDismissesKeyboard(.immediately)
        .refreshable { await model.refresh() }
        .background { OrbsBackground(intensity: 0.45) }
        .overlay(alignment: .bottomTrailing) { createButton }
        .overlay(alignment: .top) { offlineBanner }
        .task { await model.appear() }
        .onChange(of: model.session.isAuthenticated) { _, authenticated in
            if authenticated { Task { await model.appear() } }
        }
        .onChange(of: model.session.workspaceId) { _, _ in
            Task { await model.workspaceChanged() }
        }
        .sheet(isPresented: $showCreate) {
            CreateDesignSheet(model: model) { route in
                showCreate = false
                onOpen(route)
            }
        }
        .sheet(item: $templatePreview) { template in
            TemplatePreviewSheet(template: template, store: model.session.store) {
                Task {
                    if let route = await model.use(template: template) {
                        templatePreview = nil
                        onOpen(route)
                    }
                }
            }
        }
        .sheet(isPresented: $showAccount) {
            if let account = extensions.account {
                account(model.session)
            } else {
                AccountSheet(session: model.session)
            }
        }
        .alert("Rename design", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $renameText)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Rename") {
                if let design = renaming {
                    Task { await model.rename(design, to: renameText) }
                }
                renaming = nil
            }
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack {
                SunMark(size: 22)
                Spacer()
                Button {
                    showAccount = true
                } label: {
                    AvatarView(name: model.session.profile?.displayName ?? model.session.user?.email ?? "?")
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel("Account")
            }
            SerifHeadline("\(Greeting.forHour(Calendar.current.component(.hour, from: Date())).lowercased()), *\(firstName)*.", size: 36)
                .lineLimit(2)
            if let workspace = model.session.currentWorkspace, model.session.workspaces.count > 1 {
                Menu {
                    ForEach(model.session.workspaces) { item in
                        Button {
                            model.session.workspaceId = item.id
                        } label: {
                            if item.id == workspace.id {
                                Label(item.name, systemImage: "checkmark")
                            } else {
                                Text(item.name)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: Spacing.xs) {
                        Text(workspace.name)
                        Image(systemName: "chevron.down").font(.caption)
                    }
                    .font(.dsCallout)
                    .foregroundStyle(Palette.muted)
                    .frame(minHeight: Spacing.touchTarget)
                }
            }
        }
        .padding(.horizontal, Spacing.gutter)
        .padding(.top, Spacing.lg)
    }

    private var firstName: String {
        (model.session.profile?.firstName ?? model.session.user?.name?.split(separator: " ").first.map(String.init) ?? "there").lowercased()
    }

    private var searchPrompt: String {
        switch model.tab {
        case .templates: "Search templates"
        case .shared: "Search shared designs"
        default: "Search your designs"
        }
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if let error = model.errorMessage {
            Label(error, systemImage: "exclamationmark.triangle")
                .font(.dsCallout)
                .foregroundStyle(Palette.danger)
                .padding(.vertical, Spacing.sm)
        }
        switch model.tab {
        case .recent:
            designsSection(model.recent, tab: .recent, empty: {
                EmptyStateView(
                    model.query.isEmpty ? "your canvas is *waiting*." : "nothing *found*.",
                    message: model.query.isEmpty
                        ? "Start from a size or a template. Everything you make appears here and on your other devices."
                        : "No design matches \u{201C}\(model.query)\u{201D}. Try another word.",
                    systemImage: model.query.isEmpty ? "sun.max" : "magnifyingglass",
                    actionTitle: model.query.isEmpty ? "Create a design" : nil,
                    action: model.query.isEmpty ? { showCreate = true } : nil
                )
            })
        case .shared:
            designsSection(model.shared, tab: .shared, empty: {
                EmptyStateView(
                    "nothing shared *yet*.",
                    message: "Designs people share with you appear here once you open their link.",
                    systemImage: "person.2"
                )
            })
        case .folders:
            FoldersSection(model: model, onOpen: onOpen)
        case .templates:
            TemplatesSection(model: model) { templatePreview = $0 }
        case .brand:
            BrandSection(model: model)
        }
    }

    @ViewBuilder
    private func designsSection<Empty: View>(_ designs: [DesignSummary], tab: LibraryModel.Tab, @ViewBuilder empty: () -> Empty) -> some View {
        if designs.isEmpty {
            if model.loading.contains(tab) && !model.loaded.contains(tab) {
                LoadingState("Gathering your designs")
                    .frame(height: 280)
            } else {
                empty()
                    .frame(maxWidth: .infinity)
                    .padding(.top, Spacing.xxl)
            }
        } else {
            DesignGrid(designs: designs, store: model.session.store, folders: tab == .recent ? model.folders : [], onOpen: onOpen) { action, design in
                switch action {
                case .rename:
                    renameText = design.name
                    renaming = design
                case .duplicate:
                    Task { await model.duplicate(design) }
                case .trash:
                    Task { await model.trash(design) }
                case let .move(folderId):
                    Task { await model.move(design, to: folderId) }
                }
            }
            if model.canLoadMore.contains(tab) {
                ProgressRow()
                    .task { await model.loadMore() }
            }
        }
    }

    // MARK: Chrome

    private var createButton: some View {
        Button {
            Haptics.light()
            showCreate = true
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(Palette.onSun)
                .frame(width: 64, height: 64)
                .background(Palette.sunGradient, in: Circle())
                .dsGlow(radius: 22)
        }
        .buttonStyle(PressScaleStyle())
        .padding(Spacing.xl)
        .accessibilityLabel("Create a design")
    }

    @ViewBuilder private var offlineBanner: some View {
        if !model.session.isOnline {
            Label("Offline. Showing what's on this \(DeviceName.current).", systemImage: "icloud.slash")
                .font(.dsFootnote)
                .foregroundStyle(Palette.foreground)
                .padding(.horizontal, Spacing.md)
                .padding(.vertical, Spacing.sm)
                .dsGlass(cornerRadius: Radius.pill)
                .padding(.top, Spacing.xs)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}

/// Infinite-scroll trigger row.
struct ProgressRow: View {
    var body: some View {
        HStack {
            Spacer()
            SunSpinner(size: 22)
            Spacer()
        }
        .padding(.vertical, Spacing.lg)
    }
}

/// Initials in a sun ring.
struct AvatarView: View {
    let name: String

    var body: some View {
        Text(initials)
            .font(DSFont.sans(14, weight: .semibold, relativeTo: .callout))
            .foregroundStyle(Palette.foreground)
            .frame(width: 40, height: 40)
            .background(Palette.surface2, in: Circle())
            .overlay(Circle().strokeBorder(Palette.sun.opacity(0.5), lineWidth: 1.5))
            .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
    }

    private var initials: String {
        let parts = name.split(whereSeparator: { $0 == " " || $0 == "@" || $0 == "." }).prefix(2)
        let letters = parts.compactMap(\.first).map { String($0).uppercased() }.joined()
        return letters.isEmpty ? "?" : letters
    }
}
