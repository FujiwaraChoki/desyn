import DesignSystem
import DesynEngine
import DesynKit
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI

/// Arrange: align (to the page, or to each other for several layers), distribute, order, group / ungroup, flip,
/// lock, hide, duplicate, delete.
struct ArrangeSection: View {
    let model: InspectorModel
    @State private var message: String?

    private var editor: EditorModel { model.editor }
    private var ids: [String] { editor.topLevelSelectionIds }
    private var several: Bool { ids.count > 1 }

    private enum Edge: CaseIterable {
        case left, centerX, right, top, centerY, bottom

        var title: String {
            switch self {
            case .left: "Left"
            case .centerX: "Center"
            case .right: "Right"
            case .top: "Top"
            case .centerY: "Middle"
            case .bottom: "Bottom"
            }
        }

        var systemImage: String {
            switch self {
            case .left: "align.horizontal.left"
            case .centerX: "align.horizontal.center"
            case .right: "align.horizontal.right"
            case .top: "align.vertical.top"
            case .centerY: "align.vertical.center"
            case .bottom: "align.vertical.bottom"
            }
        }

        var pageAlignment: EditorModel.PageAlignment {
            switch self {
            case .left: .left
            case .centerX: .centerX
            case .right: .right
            case .top: .top
            case .centerY: .centerY
            case .bottom: .bottom
            }
        }

        var horizontal: Bool { self == .left || self == .centerX || self == .right }
        var fraction: Double {
            switch self {
            case .left, .top: 0
            case .centerX, .centerY: 0.5
            case .right, .bottom: 1
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            PanelSection(several ? "Align to each other" : "Align to page") {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Spacing.sm), count: 6), spacing: Spacing.sm) {
                    ForEach(Edge.allCases, id: \.self) { edge in
                        squareButton(edge.systemImage, label: "Align \(edge.title.lowercased())") { Task { await align(edge) } }
                    }
                }
                if ids.count >= 3 {
                    HStack(spacing: Spacing.sm) {
                        DSButton("Space horizontally", systemImage: "distribute.horizontal.center", kind: .secondary, size: .small) {
                            Task { await distribute(horizontal: true) }
                        }
                        DSButton("Space vertically", systemImage: "distribute.vertical.center", kind: .secondary, size: .small) {
                            Task { await distribute(horizontal: false) }
                        }
                    }
                }
            }
            PanelSection("Order") {
                HStack(spacing: Spacing.sm) {
                    squareButton("square.3.layers.3d.top.filled", label: "Bring to front") { Task { await editor.arrange(.front) } }
                    squareButton("square.2.layers.3d.top.filled", label: "Bring forward") { Task { await editor.arrange(.forward) } }
                    squareButton("square.2.layers.3d.bottom.filled", label: "Send backward") { Task { await editor.arrange(.backward) } }
                    squareButton("square.3.layers.3d.bottom.filled", label: "Send to back") { Task { await editor.arrange(.back) } }
                }
            }
            PanelSection("Layer") {
                HStack(spacing: Spacing.sm) {
                    squareButton("arrow.left.and.right.righttriangle.left.righttriangle.right", label: "Flip horizontally") { Task { await flip(x: true) } }
                    squareButton("arrow.up.and.down.righttriangle.up.righttriangle.down", label: "Flip vertically") { Task { await flip(x: false) } }
                    squareButton(editor.selectionIsLocked ? "lock.fill" : "lock.open", label: editor.selectionIsLocked ? "Unlock" : "Lock") {
                        Task { await editor.toggleLock() }
                    }
                    squareButton(allHidden ? "eye.slash" : "eye", label: allHidden ? "Show" : "Hide") {
                        let visible = allHidden
                        model.edit(visible ? "Show" : "Hide", final: true) { NodeEditing.setFlag("visible", visible, on: $0) }
                    }
                }
                HStack(spacing: Spacing.sm) {
                    if several {
                        DSButton("Group", systemImage: "square.on.square.dashed", kind: .secondary, size: .small) { group() }
                    }
                    if !several, model.first?.type == .group {
                        DSButton("Ungroup", systemImage: "square.on.square.squareshape.controlhandles", kind: .secondary, size: .small) { ungroup() }
                    }
                    DSButton("Duplicate", systemImage: "plus.square.on.square", kind: .secondary, size: .small) {
                        Task { await editor.duplicateSelection() }
                    }
                }
                DSButton("Delete", systemImage: "trash", kind: .danger, size: .small) {
                    Task { await editor.deleteSelection() }
                }
                if let message {
                    InlineNotice(message, tone: .warning)
                }
            }
        }
    }

    private var allHidden: Bool { !model.targets.isEmpty && model.targets.allSatisfy { !$0.visible } }

    private func squareButton(_ systemImage: String, label: String, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.light()
            action()
        } label: {
            Image(systemName: systemImage)
                .font(.system(size: 17))
                .frame(maxWidth: .infinity, minHeight: Spacing.touchTarget)
                .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                .foregroundStyle(Palette.foreground)
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel(label)
    }

    // MARK: Geometry (engine boxes in page space)

    private static func aabb(_ box: OrientedBox) -> DesignRect {
        let xs = box.corners.map(\.x)
        let ys = box.corners.map(\.y)
        let minX = xs.min() ?? 0, minY = ys.min() ?? 0
        return DesignRect(x: minX, y: minY, width: (xs.max() ?? 0) - minX, height: (ys.max() ?? 0) - minY)
    }

    /// Moves each node by its delta in one transaction.
    private func move(_ deltas: [String: (dx: Double, dy: Double)], label: String) async {
        var ops: [Op] = []
        for (id, delta) in deltas {
            guard let box = editor.pageBounds(of: id),
                  let json = try? await editor.designEngine.transformOps(for: [id], from: box, to: box.offsetBy(dx: delta.dx, dy: delta.dy)),
                  let parsed = try? Op.parseList(json)
            else { continue }
            ops += parsed
        }
        guard !ops.isEmpty else { return }
        await editor.apply(ops, label: label)
    }

    private func align(_ edge: Edge) async {
        guard several else {
            await editor.align(edge.pageAlignment)
            return
        }
        let boxes = ids.compactMap { id -> (id: String, start: Double, length: Double)? in
            guard let box = editor.pageBounds(of: id) else { return nil }
            let rect = Self.aabb(box)
            return edge.horizontal ? (id, rect.x, rect.width) : (id, rect.y, rect.height)
        }
        let deltas = Arrangement.align(boxes, edge: edge.fraction)
        let moves = deltas.mapValues { value -> (dx: Double, dy: Double) in edge.horizontal ? (dx: value, dy: 0) : (dx: 0, dy: value) }
        await move(moves, label: "Align \(edge.title.lowercased())")
    }

    private func distribute(horizontal: Bool) async {
        let boxes = ids.compactMap { id -> (id: String, start: Double, length: Double)? in
            guard let box = editor.pageBounds(of: id) else { return nil }
            let rect = Self.aabb(box)
            return horizontal ? (id, rect.x, rect.width) : (id, rect.y, rect.height)
        }
        let deltas = Arrangement.distribute(boxes)
        let moves = deltas.mapValues { value -> (dx: Double, dy: Double) in horizontal ? (dx: value, dy: 0) : (dx: 0, dy: value) }
        await move(moves, label: horizontal ? "Space horizontally" : "Space vertically")
    }

    private func flip(x: Bool) async {
        guard !ids.isEmpty, let bounds = try? await editor.designEngine.selectionBounds(ids),
              let json = try? await editor.designEngine.transformOps(for: ids, from: bounds.obb, to: bounds.obb, flipX: x, flipY: !x)
        else { return }
        await model.commit(x ? "Flip horizontally" : "Flip vertically", opsJSON: json)
    }

    private func group() {
        let nodes = ids.compactMap(editor.lookupNode)
        guard let parentId = nodes.first?.parent, let parent = editor.lookupNode(parentId) else { return }
        do {
            let (ops, groupId) = try Arrangement.group(nodes, parent: parent)
            message = nil
            Task {
                if await editor.apply(ops, label: "Group") { editor.select([groupId]) }
            }
        } catch {
            message = error.localizedDescription
        }
    }

    private func ungroup() {
        guard let group = model.first, let parentId = group.parent, let parent = editor.lookupNode(parentId) else { return }
        let children = group.children.compactMap(editor.lookupNode)
        do {
            let ops = try Arrangement.ungroup(group, children: children, parent: parent)
            message = nil
            Task {
                if await editor.apply(ops, label: "Ungroup") { editor.select(children.map(\.id)) }
            }
        } catch {
            message = error.localizedDescription
        }
    }
}
