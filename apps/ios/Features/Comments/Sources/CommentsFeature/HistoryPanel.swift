import CoreGraphics
import DesignSystem
import DesynKit
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI

/// Version history: save the current state under a name, browse named and automatic versions with a rendered
/// preview, restore one (the current state is saved first as "Before restoring"), rename or delete.
public struct HistoryPanel: View {
    private let editor: EditorModel
    @State private var versions: [DesignVersion] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var naming = false
    @State private var newName = ""
    @State private var saving = false
    @State private var preview: DesignVersion?
    @State private var renaming: DesignVersion?
    @State private var showAuto = true
    @Environment(\.dismiss) private var dismiss

    public init(editor: EditorModel) {
        self.editor = editor
    }

    private var shown: [DesignVersion] { versions.filter { showAuto || !$0.auto } }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader("version *history*", subtitle: loaded ? "\(versions.count) version\(versions.count == 1 ? "" : "s")" : nil) { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    if editor.canEdit {
                        DSButton("Save this version", systemImage: "bookmark", kind: .primary, isLoading: saving) {
                            newName = defaultName
                            naming = true
                        }
                    }
                    PanelToggle("Show automatic versions", detail: "Saved before restores and during long sessions.", isOn: showAuto) { showAuto = $0 }
                    if let error {
                        InlineNotice(error, tone: .error, actionTitle: "Dismiss") { self.error = nil }
                    }
                    if !loaded {
                        HStack { Spacer(); SunSpinner(size: 24); Spacer() }.padding(.vertical, Spacing.xl)
                    } else if shown.isEmpty {
                        Text("No versions yet. Save one before big changes to come back to it anytime.")
                            .font(.dsCallout)
                            .foregroundStyle(Palette.muted)
                    }
                    ForEach(shown) { version in
                        Button {
                            preview = version
                        } label: {
                            VersionRow(version: version)
                        }
                        .buttonStyle(.plain)
                        .disabled(!version.isReady)
                        .contextMenu {
                            if editor.canEdit {
                                Button { renaming = version; newName = version.name } label: { Label("Rename", systemImage: "pencil") }
                                Button(role: .destructive) { Task { await remove(version) } } label: { Label("Delete", systemImage: "trash") }
                            }
                        }
                    }
                }
                .padding(Spacing.gutter)
            }
        }
        .panelSheet([.medium, .large], interactiveUpThrough: nil)
        .task { await watch() }
        .sheet(item: $preview) { version in
            VersionPreview(editor: editor, version: version) { message in error = message }
        }
        .alert("Name this version", isPresented: $naming) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Save") { Task { await save() } }
        }
        .alert("Rename version", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Rename") {
                if let version = renaming { Task { await rename(version) } }
                renaming = nil
            }
        }
    }

    private var defaultName: String {
        "Version \(Date().formatted(date: .abbreviated, time: .shortened))"
    }

    private func watch() async {
        do {
            for try await value in editor.session.api.versionUpdates(designId: editor.designId, share: editor.route.share) {
                versions = value.sorted { $0.createdAt > $1.createdAt }
                loaded = true
            }
        } catch {
            loaded = true
            let mapped = DesynError(error)
            self.error = mapped.code == "FEATURE_UNAVAILABLE"
                ? "Version history isn't included in this workspace's plan."
                : (mapped.isTransient ? "You're offline. Versions load when you're back online." : mapped.message)
        }
    }

    private func save() async {
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        saving = true
        defer { saving = false }
        do {
            _ = try await editor.session.api.createVersion(designId: editor.designId, name: name)
            Haptics.success()
        } catch {
            let mapped = DesynError(error)
            self.error = mapped.code == "FEATURE_UNAVAILABLE" ? "Version history isn't included in this workspace's plan." : mapped.message
        }
    }

    private func rename(_ version: DesignVersion) async {
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        do {
            try await editor.session.api.renameVersion(versionId: version.id, name: name)
        } catch {
            self.error = DesynError(error).message
        }
    }

    private func remove(_ version: DesignVersion) async {
        do {
            try await editor.session.api.removeVersion(versionId: version.id)
            Haptics.light()
        } catch {
            self.error = DesynError(error).message
        }
    }
}

private struct VersionRow: View {
    let version: DesignVersion

    var body: some View {
        HStack(spacing: Spacing.md) {
            ZStack {
                Circle().fill(version.auto ? Palette.surface3 : Palette.sun.opacity(0.18)).frame(width: 36, height: 36)
                Image(systemName: version.auto ? "clock" : "bookmark.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(version.auto ? Palette.muted : Palette.sun)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(version.name).font(DSFont.sans(15, weight: .semibold, relativeTo: .subheadline)).foregroundStyle(Palette.foreground).lineLimit(1)
                Text(detail).font(.dsCaption).foregroundStyle(Palette.muted).lineLimit(1)
            }
            Spacer()
            switch version.status {
            case "pending": SunSpinner(size: 18)
            case "failed": Image(systemName: "exclamationmark.triangle").foregroundStyle(Palette.danger)
            default: Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.muted)
            }
        }
        .padding(Spacing.md)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        var parts = [version.createdDate.formatted(date: .abbreviated, time: .shortened)]
        if let by = version.createdByName { parts.append(by) }
        if let pages = version.pageCount { parts.append("\(Int(pages)) page\(pages == 1 ? "" : "s")") }
        if version.status == "failed" { parts.append(version.error ?? "Couldn't be saved") }
        return parts.joined(separator: " · ")
    }
}

/// A version rendered with the engine (first page, or any page), with restore.
private struct VersionPreview: View {
    let editor: EditorModel
    let version: DesignVersion
    let onError: (String) -> Void

    @State private var image: CGImage?
    @State private var pageCount = 1
    @State private var page = 0
    @State private var designJSON: String?
    @State private var loading = true
    @State private var restoring = false
    @State private var confirming = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(version.name, subtitle: version.createdDate.formatted(date: .complete, time: .shortened)) { dismiss() }
            ZStack {
                RoundedRectangle(cornerRadius: Radius.panel, style: .continuous).fill(Palette.canvas)
                if let image {
                    Image(decorative: image, scale: 1).resizable().scaledToFit().padding(Spacing.lg)
                        .shadow(color: .black.opacity(0.3), radius: 20, y: 10)
                } else if loading {
                    LoadingState("Rendering this version")
                } else {
                    Text("This version couldn't be shown.").font(.dsCallout).foregroundStyle(Palette.muted)
                }
            }
            .padding(.horizontal, Spacing.gutter)
            .frame(maxHeight: .infinity)
            if pageCount > 1 {
                HStack {
                    DSIconButton("chevron.left", label: "Previous page") { step(-1) }.disabled(page == 0)
                    Text("Page \(page + 1) of \(pageCount)").font(.dsFootnote).foregroundStyle(Palette.muted)
                    DSIconButton("chevron.right", label: "Next page") { step(1) }.disabled(page >= pageCount - 1)
                }
                .padding(.top, Spacing.sm)
            }
            if editor.canEdit {
                DSButton("Restore this version", systemImage: "arrow.uturn.backward.circle", kind: .primary, isLoading: restoring) {
                    confirming = true
                }
                .padding(Spacing.gutter)
            }
        }
        .dsSheet()
        .presentationDetents([.large])
        .task { await load() }
        .confirmationDialog("Restore \u{201C}\(version.name)\u{201D}?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Restore") { Task { await restore() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The design changes back for everyone. The current state is saved first as a version, so nothing is lost.")
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let content = try await editor.session.api.versionContent(versionId: version.id, share: editor.route.share)
            designJSON = content.design
            if let design = try? Design(jsonString: content.design) { pageCount = max(1, design.pages.count) }
            await render()
        } catch {
            onError(DesynError(error).message)
        }
    }

    private func step(_ delta: Int) {
        page = min(max(0, page + delta), pageCount - 1)
        Task { await render() }
    }

    /// Renders with the design's assets (bytes from the offline cache or signed URLs).
    private func render() async {
        guard let designJSON else { return }
        var assets: [String: Data] = [:]
        if let store = editor.session.store, let design = try? Design(jsonString: designJSON) {
            let repository = AssetRepository(api: editor.session.api, store: store, designId: editor.designId, share: editor.route.share)
            for (id, ref) in design.assets where ref.kind == "image" || ref.kind == "svg" {
                if let data = await repository.data(for: id, ref: ref) { assets[id] = data }
            }
        }
        image = await PreviewRenderer.shared.renderPage(designJSON: designJSON, pageIndex: page, width: 1200, assets: assets)
    }

    private func restore() async {
        restoring = true
        defer { restoring = false }
        do {
            _ = try await editor.session.api.restoreVersion(versionId: version.id)
            Haptics.success()
            editor.session.toasts.show("Restored \u{201C}\(version.name)\u{201D}.", tone: .success)
            dismiss()
        } catch {
            onError(DesynError(error).message)
        }
    }
}
