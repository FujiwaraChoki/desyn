import DesignSystem
import DesynKit
import FeatureCore
import SwiftUI

enum DesignAction {
    case rename, duplicate, trash
    /// Move into a folder (nil = out of every folder).
    case move(folderId: String?)
}

/// Adaptive grid of design cards (2 columns on iPhone, more on iPad).
struct DesignGrid: View {
    let designs: [DesignSummary]
    let store: OfflineStore?
    /// Folders of the current workspace ("Move to folder" targets).
    var folders: [Folder] = []
    let onOpen: (DesignRoute) -> Void
    let onAction: (DesignAction, DesignSummary) -> Void

    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let columns = [GridItem(.adaptive(minimum: 156, maximum: 260), spacing: Spacing.lg, alignment: .top)]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: Spacing.xl) {
            ForEach(Array(designs.enumerated()), id: \.element.id) { index, design in
                Button {
                    Haptics.light()
                    onOpen(DesignRoute(summary: design))
                } label: {
                    DesignCard(design: design, store: store)
                }
                .buttonStyle(CardPressStyle())
                .contextMenu {
                    Button { onOpen(DesignRoute(summary: design)) } label: { Label("Open", systemImage: "arrow.up.right") }
                    if design.canEdit {
                        Button { onAction(.rename, design) } label: { Label("Rename", systemImage: "pencil") }
                        Button { onAction(.duplicate, design) } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
                        if design.shareToken == nil, !folders.isEmpty || design.folderId != nil {
                            moveMenu(for: design)
                        }
                        Divider()
                        Button(role: .destructive) { onAction(.trash, design) } label: { Label("Move to trash", systemImage: "trash") }
                    }
                }
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared || reduceMotion ? 0 : 14)
                .animation(
                    Motion.animation(Motion.easeOut(0.6), reduced: reduceMotion).delay(Double(min(index, 10)) * Motion.stagger),
                    value: appeared
                )
            }
        }
        .onAppear { appeared = true }
    }

    /// Folder targets in tree order, indented by depth (the current folder is marked).
    private func moveMenu(for design: DesignSummary) -> some View {
        Menu {
            if design.folderId != nil {
                Button { onAction(.move(folderId: nil), design) } label: { Label("Out of folders", systemImage: "tray") }
            }
            ForEach(FolderTree.flattened(folders), id: \.folder.id) { entry in
                Button {
                    onAction(.move(folderId: entry.folder.id), design)
                } label: {
                    if entry.folder.id == design.folderId {
                        Label(entry.title, systemImage: "checkmark")
                    } else {
                        Text(entry.title)
                    }
                }
                .disabled(entry.folder.id == design.folderId)
            }
        } label: {
            Label("Move to folder", systemImage: "folder")
        }
    }
}

/// Folder lists in tree order.
enum FolderTree {
    struct Entry {
        let folder: Folder
        let depth: Int
        /// The name, indented by depth for menus.
        var title: String { String(repeating: "    ", count: depth) + folder.name }
    }

    /// Depth-first, siblings in server order (by `sort`, then name); orphans (parent not visible) are roots.
    static func flattened(_ folders: [Folder]) -> [Entry] {
        let ids = Set(folders.map(\.id))
        var children: [String: [Folder]] = [:]
        var roots: [Folder] = []
        for folder in folders {
            if let parent = folder.parentId, ids.contains(parent) {
                children[parent, default: []].append(folder)
            } else {
                roots.append(folder)
            }
        }
        var result: [Entry] = []
        var visited: Set<String> = []
        func visit(_ folder: Folder, depth: Int) {
            guard visited.insert(folder.id).inserted else { return }
            result.append(Entry(folder: folder, depth: depth))
            for child in children[folder.id] ?? [] { visit(child, depth: depth + 1) }
        }
        roots.forEach { visit($0, depth: 0) }
        return result
    }
}

/// Thumbnail, name, kind and last edit.
struct DesignCard: View {
    let design: DesignSummary
    let store: OfflineStore?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            ThumbnailView(
                url: design.thumbnailUrl,
                cacheKey: "\(design.id)-\(Int(design.updatedAt))",
                aspectRatio: design.aspectRatio,
                placeholderSymbol: design.designKind.systemImage,
                store: store
            )
            .frame(maxWidth: .infinity)
            .background(Palette.surface1)
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(Palette.borderSubtle, lineWidth: 1)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(design.name.isEmpty ? "Untitled" : design.name)
                    .font(DSFont.sans(15, weight: .medium, relativeTo: .subheadline))
                    .foregroundStyle(Palette.foreground)
                    .lineLimit(1)
                HStack(spacing: Spacing.xs) {
                    Text(design.designKind.label)
                    Text("·")
                    Text(RelativeDate.string(for: design.updatedDate))
                    if design.permission == "view" {
                        Image(systemName: "eye")
                            .accessibilityLabel("View only")
                    }
                }
                .font(.dsFootnote)
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the design")
    }
}

/// Subtle press feedback for cards.
struct CardPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .brightness(configuration.isPressed ? -0.03 : 0)
            .animation(Motion.quick, value: configuration.isPressed)
    }
}
