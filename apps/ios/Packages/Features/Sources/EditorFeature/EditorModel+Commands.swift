import CoreGraphics
import DesignSystem
import DesynEngine
import DesynKit
import Foundation

/// Editing commands used by the canvas, the context menu, the tool dock and the inspector. Each user action is
/// one transaction (one undo step); continuous controls preview first and commit once at the end.
extension EditorModel {
    // MARK: Lookup

    func node(_ id: String) -> Node? {
        guard let json = try? engine.core.nodeJson(id: id) else { return nil }
        return try? Node(jsonString: json)
    }

    /// `id` and all of its descendants, parent first (the order `create` expects).
    func subtree(_ id: String) -> [Node] {
        guard let root = node(id) else { return [] }
        return [root] + root.children.flatMap { subtree($0) }
    }

    /// Selected ids without nodes whose ancestor is also selected.
    var topLevelSelection: [String] {
        let selected = Set(selection)
        return selection.filter { id in
            var parent = node(id)?.parent
            while let current = parent, current != Design.rootID {
                if selected.contains(current) { return false }
                parent = node(current)?.parent
            }
            return true
        }
    }

    // MARK: Inserting

    /// Places a shape: `frame` from a drag, or a default size at the center of the view.
    func insertShape(_ tool: Tool, frame: PageRect?) async {
        guard let page = currentPage else { return }
        let side = max(24, min(page.width, page.height) * 0.28)
        let box: PageRect
        if let frame {
            box = frame
        } else {
            let center = canvas?.visiblePageCenter() ?? DesignPoint(x: page.width / 2, y: page.height / 2)
            box = PageRect(x: center.x - side / 2, y: center.y - side / 2, width: side, height: side)
        }
        let node: Node
        switch tool {
        case .rect: node = NodeFactory.rect(parent: page.id, frame: box)
        case .ellipse: node = NodeFactory.ellipse(parent: page.id, frame: box)
        case .triangle: node = NodeFactory.polygon(parent: page.id, frame: box, sides: 3)
        case .line:
            node = NodeFactory.line(parent: page.id, from: PagePoint(x: box.x, y: box.midY), length: max(box.width, 24), color: NodeFactory.defaultTextColor)
        default:
            return
        }
        if await commit([.create(nodes: [node], parent: page.id, index: nil)], label: "Add \(tool.title.lowercased())") {
            select([node.id])
            self.tool = .select
            Haptics.light()
        }
    }

    /// Adds a heading at `point` and starts editing it.
    func insertText(at point: DesignPoint?) async {
        guard let page = currentPage else { return }
        let fontSize = (max(16, min(page.width, page.height) * 0.06)).rounded()
        let width = max(120, page.width * 0.5)
        let origin = point ?? canvas?.visiblePageCenter() ?? DesignPoint(x: page.width / 2, y: page.height / 2)
        let node = NodeFactory.text(
            parent: page.id,
            text: "Add a heading",
            origin: PagePoint(x: origin.x - width / 2, y: origin.y - fontSize * 0.6),
            width: width,
            fontSize: fontSize,
            fontWeight: 600,
            color: textColor(on: page.id),
            align: "center",
            name: "Heading",
            role: "headline"
        )
        if await commit([.create(nodes: [node], parent: page.id, index: nil)], label: "Add text") {
            tool = .select
            select([node.id])
            beginTextEditing(node.id, selectAll: true)
        }
    }

    /// Commits a pen stroke as a filled path.
    func insertInk(_ samples: [InkSample]) async {
        guard let page = currentPage, let outline = InkStroke.outline(samples, width: penWidth) else { return }
        let node = NodeFactory.path(parent: page.id, frame: outline.frame, d: outline.d, color: penColor, name: "Drawing")
        await commit([.create(nodes: [node], parent: page.id, index: nil)], label: "Draw")
    }

    /// Dark text on light pages, light text on dark pages.
    private func textColor(on pageId: String) -> String {
        guard let hex = node(pageId)?.background.first?.swatchHex, let rgba = HexColor.parse(hex) else {
            return NodeFactory.defaultTextColor
        }
        let luminance = 0.2126 * rgba.r + 0.7152 * rgba.g + 0.0722 * rgba.b
        return luminance < 0.5 ? "#ffffff" : NodeFactory.defaultTextColor
    }

    // MARK: Arrange

    public func deleteSelection() async {
        let ids = topLevelSelection
        guard !ids.isEmpty else { return }
        endTextEditing()
        if await commit(ids.map { Op.delete(id: $0) }, label: ids.count == 1 ? "Delete" : "Delete \(ids.count) layers") {
            clearSelection()
        }
    }

    public func duplicateSelection() async {
        var ops: [Op] = []
        var newIds: [String] = []
        for id in topLevelSelection {
            let nodes = subtree(id)
            guard let root = nodes.first, let parentId = root.parent, let parent = node(parentId) else { continue }
            let (clones, _) = NodeFactory.cloneSubtree(nodes, offset: PagePoint(x: 20, y: 20))
            let index = (parent.children.firstIndex(of: id) ?? parent.children.count - 1) + 1
            ops.append(.create(nodes: clones, parent: parentId, index: index))
            if let first = clones.first { newIds.append(first.id) }
        }
        guard !ops.isEmpty else { return }
        if await commit(ops, label: "Duplicate") {
            select(newIds)
        }
    }

    public enum Layering {
        case forward, backward, front, back
    }

    public func arrange(_ layering: Layering) async {
        var ops: [Op] = []
        for id in topLevelSelection {
            guard let current = node(id), let parentId = current.parent, let parent = node(parentId),
                  let index = parent.children.firstIndex(of: id)
            else { continue }
            let last = parent.children.count - 1
            let target: Int?
            switch layering {
            case .forward: target = index < last ? index + 1 : nil
            case .backward: target = index > 0 ? index - 1 : nil
            case .front: target = index < last ? last : nil
            case .back: target = index > 0 ? 0 : nil
            }
            if let target {
                ops.append(.move(id: id, parent: parentId, index: target))
            }
        }
        guard !ops.isEmpty else { return }
        let label: String
        switch layering {
        case .forward: label = "Bring forward"
        case .backward: label = "Send backward"
        case .front: label = "Bring to front"
        case .back: label = "Send to back"
        }
        await commit(ops, label: label)
    }

    public var selectionIsLocked: Bool {
        !selectedNodes.isEmpty && selectedNodes.allSatisfy(\.locked)
    }

    public func toggleLock() async {
        let lock = !selectionIsLocked
        let ops = selection.map { Op.update(id: $0, set: ["locked": .bool(lock)], unset: []) }
        guard !ops.isEmpty else { return }
        await commit(ops, label: lock ? "Lock" : "Unlock")
    }

    public enum PageAlignment: CaseIterable {
        case left, centerX, right, top, centerY, bottom

        public var title: String {
            switch self {
            case .left: "Align left"
            case .centerX: "Align centers"
            case .right: "Align right"
            case .top: "Align top"
            case .centerY: "Align middles"
            case .bottom: "Align bottom"
            }
        }

        public var systemImage: String {
            switch self {
            case .left: "align.horizontal.left"
            case .centerX: "align.horizontal.center"
            case .right: "align.horizontal.right"
            case .top: "align.vertical.top"
            case .centerY: "align.vertical.center"
            case .bottom: "align.vertical.bottom"
            }
        }
    }

    /// Aligns the selection's box to the page.
    public func align(_ alignment: PageAlignment) async {
        guard let page = currentPage, !selection.isEmpty,
              let bounds = try? await engine.selectionBounds(topLevelSelection)
        else { return }
        let box = bounds.aabb
        var dx = 0.0
        var dy = 0.0
        switch alignment {
        case .left: dx = -box.x
        case .centerX: dx = (page.width - box.width) / 2 - box.x
        case .right: dx = page.width - box.width - box.x
        case .top: dy = -box.y
        case .centerY: dy = (page.height - box.height) / 2 - box.y
        case .bottom: dy = page.height - box.height - box.y
        }
        guard abs(dx) > 0.001 || abs(dy) > 0.001 else { return }
        guard let ops = try? await engine.transformOps(for: topLevelSelection, from: bounds.obb, to: bounds.obb.offsetBy(dx: dx, dy: dy)) else { return }
        await commit(opsJSON: ops, label: alignment.title)
    }

    // MARK: Properties

    /// Applies a property change as a preview (`final == false`, while a slider moves) or a commit.
    private func edit(_ ops: [Op], label: String, final: Bool) async {
        guard !ops.isEmpty else { return }
        if final {
            await commit(ops, label: label)
        } else {
            await preview(opsJSON: Op.serialize(ops))
        }
    }

    public func setFillColor(_ hex: String, final: Bool) async {
        let ops: [Op] = selectedNodes.compactMap { node in
            if node.type == .text {
                var style = node.textStyle ?? TextStyle.standard()
                style.fills = [Fill.solid(.hex(hex))]
                return .patch(id: node.id, path: [.key("style"), .key("fills")], value: .array(style.fills.map(\.jsonValue)))
            }
            guard node.json["fills"] != nil else { return nil }
            var fills = node.fills
            if fills.isEmpty || fills[0].type != "solid" {
                fills = [Fill.solid(.hex(hex))] + fills.dropFirst()
            } else {
                fills[0].color = .hex(hex)
            }
            return .update(id: node.id, set: ["fills": .array(fills.map(\.jsonValue))], unset: [])
        }
        await edit(ops, label: "Change color", final: final)
    }

    public func setOpacity(_ value: Double, final: Bool) async {
        let ops = selection.map { Op.update(id: $0, set: ["opacity": .number(min(1, max(0, value)))], unset: []) }
        await edit(ops, label: "Change opacity", final: final)
    }

    public func setCornerRadius(_ value: Double, final: Bool) async {
        let ops: [Op] = selectedNodes.compactMap { node in
            guard node.json["cornerRadius"] != nil else { return nil }
            return .update(id: node.id, set: ["cornerRadius": .number(max(0, value.rounded()))], unset: [])
        }
        await edit(ops, label: "Change corner radius", final: final)
    }

    public func setFontSize(_ value: Double, final: Bool) async {
        let ops: [Op] = selectedNodes.filter { $0.type == .text }.map { node in
            .patch(id: node.id, path: [.key("style"), .key("fontSize")], value: .number(max(1, value.rounded())))
        }
        await edit(ops, label: "Change text size", final: final)
    }

    public func setFontWeight(_ value: Double) async {
        let ops: [Op] = selectedNodes.filter { $0.type == .text }.map { node in
            .patch(id: node.id, path: [.key("style"), .key("fontWeight")], value: .number(value))
        }
        await edit(ops, label: "Change weight", final: true)
    }

    public func setTextAlign(_ align: String) async {
        let ops: [Op] = selectedNodes.filter { $0.type == .text }.map { node in
            .patch(id: node.id, path: [.key("paragraph"), .key("align")], value: .string(align))
        }
        await edit(ops, label: "Align text", final: true)
    }

    // MARK: Pages

    public func addPage() async {
        guard let page = currentPage else { return }
        let unit = node(page.id)?.unit ?? .px
        let newPage = NodeFactory.page(name: "Page \(pages.count + 1)", width: page.width, height: page.height, unit: unit, bleed: page.bleed)
        if await commit([.create(nodes: [newPage], parent: Design.rootID, index: currentPageIndex + 1)], label: "Add page") {
            showPage(newPage.id)
        }
    }

    public func duplicatePage(_ id: String) async {
        let nodes = subtree(id)
        guard !nodes.isEmpty, let index = pages.firstIndex(where: { $0.id == id }) else { return }
        var (clones, _) = NodeFactory.cloneSubtree(nodes)
        if var root = clones.first {
            root.name = "\(root.name) copy"
            clones[0] = root
        }
        if await commit([.create(nodes: clones, parent: Design.rootID, index: index + 1)], label: "Duplicate page"), let first = clones.first {
            showPage(first.id)
        }
    }

    public func deletePage(_ id: String) async {
        guard pages.count > 1, let index = pages.firstIndex(where: { $0.id == id }) else {
            session.toasts.show("A design needs at least one page.")
            return
        }
        let neighbor = index > 0 ? pages[index - 1].id : pages[1].id
        if await commit([.delete(id: id)], label: "Delete page") {
            showPage(neighbor)
        }
    }

    public func movePage(_ id: String, by delta: Int) async {
        guard let index = pages.firstIndex(where: { $0.id == id }) else { return }
        let target = min(max(0, index + delta), pages.count - 1)
        guard target != index else { return }
        await commit([.move(id: id, parent: Design.rootID, index: target)], label: "Move page")
    }

    // MARK: Renaming

    public func rename(to newName: String) async {
        let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != name else { return }
        if await commit([.doc(set: ["name": .string(trimmed)], unset: [])], label: "Rename design") {
            name = trimmed
        }
    }
}
