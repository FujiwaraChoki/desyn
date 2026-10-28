import DesignSystem
import DesynKit
import FeatureCore
import SwiftUI

// MARK: Folders

struct FoldersSection: View {
    let model: LibraryModel
    let onOpen: (DesignRoute) -> Void

    @State private var naming = false
    @State private var newName = ""

    var body: some View {
        Group {
            if model.folders.isEmpty {
                if model.loading.contains(.folders) && !model.loaded.contains(.folders) {
                    LoadingState().frame(height: 240)
                } else {
                    EmptyStateView(
                        "no folders *yet*.",
                        message: "Folders keep a project's designs together, here and on every other device.",
                        systemImage: "folder",
                        actionTitle: model.canEditWorkspace ? "New folder" : nil,
                        action: model.canEditWorkspace ? { startNaming() } : nil
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, Spacing.xxl)
                }
            } else {
                list
            }
        }
        .alert("New folder", isPresented: $naming) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let name = newName
                Task { await model.createFolder(named: name) }
            }
        }
    }

    private func startNaming() {
        newName = ""
        naming = true
    }

    private var list: some View {
        VStack(spacing: Spacing.sm) {
            if model.canEditWorkspace {
                HStack {
                    Spacer()
                    DSButton("New folder", systemImage: "folder.badge.plus", kind: .secondary, size: .small) { startNaming() }
                        .fixedSize()
                }
            }
            VStack(spacing: Spacing.sm) {
                ForEach(rootFolders) { folder in
                    NavigationLink {
                        FolderDesignsView(model: model, folder: folder, onOpen: onOpen)
                    } label: {
                        FolderRow(folder: folder, subfolderCount: model.folders.filter { $0.parentId == folder.id }.count)
                    }
                    .buttonStyle(CardPressStyle())
                }
            }
        }
    }

    private var rootFolders: [Folder] {
        model.folders.filter { folder in
            folder.parentId == nil || !model.folders.contains { $0.id == folder.parentId }
        }
    }
}

struct FolderRow: View {
    let folder: Folder
    let subfolderCount: Int

    var body: some View {
        HStack(spacing: Spacing.md) {
            Image(systemName: "folder.fill")
                .font(.system(size: 22))
                .foregroundStyle(folder.color.map { Color(hex: $0) } ?? Palette.sun)
                .frame(width: 40, height: 40)
                .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(folder.name)
                    .font(DSFont.sans(16, weight: .medium))
                    .foregroundStyle(Palette.foreground)
                if subfolderCount > 0 {
                    Text(subfolderCount == 1 ? "1 folder inside" : "\(subfolderCount) folders inside")
                        .font(.dsFootnote)
                        .foregroundStyle(Palette.muted)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.muted)
        }
        .padding(Spacing.md)
        .background(Palette.surface1, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1)
        }
        .frame(minHeight: Spacing.touchTarget)
        .accessibilityElement(children: .combine)
    }
}

/// Designs and subfolders of one folder.
struct FolderDesignsView: View {
    let model: LibraryModel
    let folder: Folder
    let onOpen: (DesignRoute) -> Void

    @State private var designs: [DesignSummary] = []
    @State private var isLoading = true
    @State private var error: String?
    @State private var renaming: DesignSummary?
    @State private var renameText = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                SerifHeadline(folder.name, size: 34)
                let children = model.folders.filter { $0.parentId == folder.id }
                ForEach(children) { child in
                    NavigationLink {
                        FolderDesignsView(model: model, folder: child, onOpen: onOpen)
                    } label: {
                        FolderRow(folder: child, subfolderCount: model.folders.filter { $0.parentId == child.id }.count)
                    }
                    .buttonStyle(CardPressStyle())
                }
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle").font(.dsCallout).foregroundStyle(Palette.danger)
                }
                if designs.isEmpty {
                    if isLoading {
                        LoadingState().frame(height: 220)
                    } else if children.isEmpty {
                        EmptyStateView("an empty *folder*.", message: "Move a design here from its menu: press and hold it in Recent.", systemImage: "folder")
                            .frame(maxWidth: .infinity)
                            .padding(.top, Spacing.xl)
                    }
                } else {
                    DesignGrid(designs: designs, store: model.session.store, folders: model.folders, onOpen: onOpen) { action, design in
                        switch action {
                        case .rename:
                            renameText = design.name
                            renaming = design
                        case .duplicate: Task { await model.duplicate(design); await reload() }
                        case .trash: Task { await model.trash(design); await reload() }
                        case let .move(folderId): Task { await model.move(design, to: folderId); await reload() }
                        }
                    }
                }
            }
            .padding(.horizontal, Spacing.gutter)
            .padding(.vertical, Spacing.lg)
        }
        .background(Palette.background)
        .refreshable { await reload() }
        .task {
            designs = model.cachedDesigns(inFolder: folder.id)
            await reload()
        }
        .alert("Rename design", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $renameText)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Rename") {
                if let design = renaming {
                    let name = renameText
                    Task {
                        await model.rename(design, to: name)
                        await reload()
                    }
                }
                renaming = nil
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    private func reload() async {
        isLoading = true
        defer { isLoading = false }
        do {
            designs = try await model.designs(inFolder: folder.id)
            error = nil
        } catch {
            let mapped = DesynError(error)
            if !mapped.isTransient { self.error = mapped.message }
        }
    }
}

// MARK: Templates

struct TemplatesSection: View {
    let model: LibraryModel
    let onSelect: (TemplateSummary) -> Void

    private let columns = [GridItem(.adaptive(minimum: 150, maximum: 240), spacing: Spacing.lg, alignment: .top)]

    var body: some View {
        if model.templates.isEmpty {
            if model.loading.contains(.templates) {
                LoadingState("Finding templates").frame(height: 240)
            } else {
                EmptyStateView(
                    model.query.isEmpty ? "templates are on their *way*." : "nothing *found*.",
                    message: model.query.isEmpty ? "Pull to refresh when you're online." : "Try a different word, like \u{201C}poster\u{201D} or \u{201C}story\u{201D}.",
                    systemImage: "square.grid.2x2"
                )
                .frame(maxWidth: .infinity)
                .padding(.top, Spacing.xxl)
            }
        } else {
            LazyVGrid(columns: columns, alignment: .leading, spacing: Spacing.xl) {
                ForEach(model.templates) { template in
                    Button {
                        Haptics.light()
                        onSelect(template)
                    } label: {
                        TemplateCard(template: template, store: model.session.store)
                    }
                    .buttonStyle(CardPressStyle())
                }
            }
            if model.canLoadMore.contains(.templates) {
                ProgressRow().task { await model.loadMore() }
            }
        }
    }
}

struct TemplateCard: View {
    let template: TemplateSummary
    let store: OfflineStore?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            ThumbnailView(
                url: template.thumbnail(near: 480)?.url,
                cacheKey: "tpl-\(template.id)",
                aspectRatio: template.aspectRatio,
                placeholderSymbol: DesignKind(rawValue: template.kind).systemImage,
                store: store
            )
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(alignment: .topTrailing) {
                if template.premium { ProPill().padding(Spacing.sm) }
            }
            .overlay {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1)
            }
            Text(template.title)
                .font(DSFont.sans(14, weight: .medium, relativeTo: .subheadline))
                .foregroundStyle(Palette.foreground)
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
    }
}

struct TemplatePreviewSheet: View {
    let template: TemplateSummary
    let store: OfflineStore?
    let onUse: () -> Void

    @State private var isWorking = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                SheetHeader(template.title, subtitle: DesignKind(rawValue: template.kind).label) { dismiss() }
                    .padding(.horizontal, -Spacing.gutter)
                ThumbnailView(
                    url: template.thumbnail(near: 1200)?.url,
                    cacheKey: "tpl-large-\(template.id)",
                    aspectRatio: template.aspectRatio,
                    placeholderSymbol: DesignKind(rawValue: template.kind).systemImage,
                    store: store
                )
                .clipShape(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
                .dsCardShadow()
                if let description = template.description, !description.isEmpty {
                    Text(description)
                        .font(.dsBody)
                        .foregroundStyle(Palette.muted)
                }
                HStack(spacing: Spacing.sm) {
                    DSBadge("\(Int(template.width)) x \(Int(template.height)) px")
                    DSBadge(template.pageCount == 1 ? "1 page" : "\(Int(template.pageCount)) pages")
                    if template.premium { ProPill() }
                }
                DSButton("Use this template", size: .large, isLoading: isWorking) {
                    isWorking = true
                    onUse()
                }
            }
            .padding(.horizontal, Spacing.gutter)
            .padding(.bottom, Spacing.xxl)
        }
        .dsSheet()
        .presentationDetents([.large])
    }
}

// MARK: Brand

struct BrandSection: View {
    let model: LibraryModel

    var body: some View {
        if model.brandKits.isEmpty {
            if model.loading.contains(.brand) && !model.loaded.contains(.brand) {
                LoadingState().frame(height: 240)
            } else {
                EmptyStateView(
                    "make it *yours*.",
                    message: "Brand kits keep your colors, fonts and logos one tap away. Create one on the web app; it syncs here.",
                    systemImage: "paintpalette"
                )
                .frame(maxWidth: .infinity)
                .padding(.top, Spacing.xxl)
            }
        } else {
            VStack(spacing: Spacing.lg) {
                ForEach(model.brandKits) { kit in
                    BrandKitCard(kit: kit)
                }
            }
        }
    }
}

struct BrandKitCard: View {
    let kit: BrandKit

    var body: some View {
        DSCard(highlighted: kit.isDefault) {
            VStack(alignment: .leading, spacing: Spacing.md) {
                HStack {
                    Text(kit.name)
                        .font(.dsTitle2)
                        .foregroundStyle(Palette.foreground)
                    Spacer()
                    if kit.isDefault { DSBadge("Default", tone: .sun) }
                }
                if !kit.colors.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Spacing.sm) {
                            ForEach(Array(kit.colors.enumerated()), id: \.offset) { _, color in
                                VStack(spacing: Spacing.xs) {
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .fill(Color(hex: color.value))
                                        .frame(width: 52, height: 52)
                                        .overlay {
                                            RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1)
                                        }
                                    Text(color.name)
                                        .font(.dsCaption)
                                        .foregroundStyle(Palette.muted)
                                        .lineLimit(1)
                                        .frame(width: 60)
                                }
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel("\(color.name), \(color.value)")
                            }
                        }
                    }
                }
                let fonts = [("Heading", kit.fonts.heading), ("Body", kit.fonts.body), ("Accent", kit.fonts.accent)]
                    .compactMap { label, slot in slot.map { (label, $0.family) } }
                if !fonts.isEmpty {
                    HStack(spacing: Spacing.lg) {
                        ForEach(fonts, id: \.0) { label, family in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(label).dsEyebrow()
                                Text(family)
                                    .font(.dsCallout)
                                    .foregroundStyle(Palette.foreground)
                            }
                        }
                    }
                }
                if !kit.logos.isEmpty {
                    HStack(spacing: Spacing.sm) {
                        ForEach(Array(kit.logos.prefix(4).enumerated()), id: \.offset) { _, logo in
                            AsyncImage(url: logo.url.flatMap(URL.init(string:))) { image in
                                image.resizable().scaledToFit()
                            } placeholder: {
                                Image(systemName: "seal").foregroundStyle(Palette.muted)
                            }
                            .frame(width: 56, height: 40)
                            .padding(Spacing.xs)
                            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .accessibilityLabel(logo.name ?? "Logo")
                        }
                    }
                }
                if let tone = kit.voice?.tone, !tone.isEmpty {
                    Text("Voice: \(tone)")
                        .font(.dsFootnote)
                        .foregroundStyle(Palette.muted)
                }
            }
        }
    }
}

// MARK: Account

struct AccountSheet: View {
    let session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var confirmSignOut = false
    @AppStorage(AppearancePreference.storageKey) private var appearance = AppearancePreference.dark.rawValue

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            SheetHeader(session.profile?.displayName ?? "Account", subtitle: session.profile?.email ?? session.user?.email) { dismiss() }
            VStack(alignment: .leading, spacing: Spacing.md) {
                if let plan = session.profile?.planName {
                    HStack {
                        Text("Plan").font(.dsCallout).foregroundStyle(Palette.muted)
                        Spacer()
                        DSBadge(plan, tone: .sun)
                    }
                }
                HStack {
                    Text("Sync").font(.dsCallout).foregroundStyle(Palette.muted)
                    Spacer()
                    DSBadge(session.isOnline ? "Online" : "Offline", tone: session.isOnline ? .success : .neutral)
                }
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text("Appearance").font(.dsCallout).foregroundStyle(Palette.muted)
                    DSSegmentedControl(
                        selection: $appearance,
                        options: AppearancePreference.allCases.map { ($0.rawValue, $0.title) }
                    )
                }
                Text("Your plan and its limits apply on every device you sign in on.")
                    .font(.dsFootnote)
                    .foregroundStyle(Palette.muted)
                DSDivider()
                DSButton("Sign out", systemImage: "rectangle.portrait.and.arrow.right", kind: .danger) {
                    confirmSignOut = true
                }
            }
            .padding(.horizontal, Spacing.gutter)
            Spacer()
        }
        .dsSheet()
        .presentationDetents([.medium, .large])
        .confirmationDialog("Sign out of Desyn?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                dismiss()
                Task { await session.signOut() }
            }
        } message: {
            Text("Designs cached on this \(DeviceName.current) are removed. Changes that haven't synced yet are lost.")
        }
    }
}
