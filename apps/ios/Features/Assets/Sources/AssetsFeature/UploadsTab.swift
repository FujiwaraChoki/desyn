import DesignSystem
import DesynKit
import PanelKit
import SharedKit
import SwiftUI

/// The workspace's library: uploads, AI results, stock photos and brand files, newest first, searchable. Tap to
/// place; long-press to rename or delete (bytes stay while any design still uses them).
struct UploadsTab: View {
    let model: InsertModel

    @State private var assets: [LibraryAsset] = []
    @State private var cursor: String?
    @State private var isDone = false
    @State private var loading = false
    @State private var query = ""
    @State private var error: String?
    @State private var renaming: LibraryAsset?
    @State private var newName = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                DSTextField("", text: $query, prompt: "Search your uploads", kind: .search, submitLabel: .search) {
                    Task { await reload() }
                }
                if let error {
                    InlineNotice(error, tone: .error, actionTitle: "Try again") { Task { await reload() } }
                }
                if assets.isEmpty, !loading, error == nil {
                    VStack(spacing: Spacing.sm) {
                        Image(systemName: "tray").font(.system(size: 28, weight: .light)).foregroundStyle(Palette.sun)
                        Text(query.isEmpty ? "Photos you upload and images the AI makes appear here." : "Nothing matches \u{201C}\(query)\u{201D}.")
                            .font(.dsCallout)
                            .foregroundStyle(Palette.muted)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Spacing.xxl)
                }
                TileGrid(minimum: 104) {
                    ForEach(assets) { asset in
                        Button {
                            Task { await model.insertLibraryAsset(asset) }
                        } label: {
                            RemoteImage(asset.url, maxPixel: 360, contentMode: asset.kind == "svg" ? .fit : .fill)
                                .frame(minWidth: 0, maxWidth: .infinity)
                                .aspectRatio(1, contentMode: .fill)
                                .background(Palette.surface2)
                                .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                                .overlay(alignment: .topTrailing) { badge(asset) }
                        }
                        .buttonStyle(PressScaleStyle())
                        .accessibilityLabel(asset.displayName)
                        .contextMenu {
                            Button { renaming = asset; newName = asset.displayName } label: { Label("Rename", systemImage: "pencil") }
                            Button(role: .destructive) { Task { await delete(asset) } } label: { Label("Delete", systemImage: "trash") }
                        }
                        .task {
                            if asset.id == assets.last?.id { await loadMore() }
                        }
                    }
                }
                if loading {
                    HStack { Spacer(); SunSpinner(size: 22); Spacer() }.padding(.vertical, Spacing.md)
                }
            }
            .padding(Spacing.gutter)
        }
        .scrollDismissesKeyboard(.interactively)
        .task { await reload() }
        .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Rename") {
                if let asset = renaming { Task { await rename(asset, to: newName) } }
                renaming = nil
            }
        }
    }

    @ViewBuilder private func badge(_ asset: LibraryAsset) -> some View {
        switch asset.source ?? "" {
        case "ai":
            Text("AI").font(.caption2.weight(.bold)).foregroundStyle(Palette.onSun)
                .padding(.horizontal, 6).padding(.vertical, 3).background(Palette.sunGradient, in: Capsule()).padding(6)
                .accessibilityLabel("Made with AI")
        case "stock":
            Image(systemName: "camera.aperture").font(.caption2.weight(.bold)).foregroundStyle(.white)
                .padding(5).background(.black.opacity(0.45), in: Circle()).padding(6)
                .accessibilityLabel("Stock photo")
        default:
            EmptyView()
        }
    }

    private func page(after cursor: String?) async throws -> PaginatedResult<LibraryAsset> {
        let workspaceId = try await model.context.resolveWorkspaceId()
        return try await model.api.libraryAssets(workspaceId: workspaceId, kind: nil, search: query, cursor: cursor, pageSize: 36)
    }

    private func reload() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let result = try await page(after: nil)
            assets = result.page.filter(\.isImage)
            cursor = result.continueCursor
            isDone = result.isDone
        } catch {
            let mapped = DesynError(error)
            self.error = mapped.isTransient ? "You're offline. Your uploads appear when you're back online." : mapped.message
        }
    }

    private func loadMore() async {
        guard !isDone, !loading, let cursor else { return }
        loading = true
        defer { loading = false }
        if let result = try? await page(after: cursor) {
            assets += result.page.filter(\.isImage)
            self.cursor = result.continueCursor
            isDone = result.isDone
        }
    }

    private func rename(_ asset: LibraryAsset, to name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            try await model.api.renameAsset(assetId: asset.id, name: trimmed)
            await reload()
        } catch {
            model.errorMessage = DesynError(error).message
        }
    }

    private func delete(_ asset: LibraryAsset) async {
        do {
            try await model.api.deleteAsset(assetId: asset.id)
            assets.removeAll { $0.id == asset.id }
            Haptics.light()
        } catch {
            model.errorMessage = DesynError(error).message
        }
    }
}
