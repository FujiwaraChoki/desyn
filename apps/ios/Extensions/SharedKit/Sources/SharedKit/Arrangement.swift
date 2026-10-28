import DesynKit
import Foundation

/// Grouping, ungrouping and distribution math (node boxes are relative to the parent, rotated about their center).
public enum Arrangement {
    /// Axis-aligned bounds of a node's rotated box in its parent's space.
    public static func parentBounds(of node: Node) -> PageRect {
        let w = node.width
        let h = node.height
        let cx = node.x + w / 2
        let cy = node.y + h / 2
        let radians = node.rotation * .pi / 180
        let cosA = abs(cos(radians))
        let sinA = abs(sin(radians))
        let bw = w * cosA + h * sinA
        let bh = w * sinA + h * cosA
        return PageRect(x: cx - bw / 2, y: cy - bh / 2, width: bw, height: bh)
    }

    public static func union(_ rects: [PageRect]) -> PageRect? {
        guard let first = rects.first else { return nil }
        var minX = first.x, minY = first.y, maxX = first.x + first.width, maxY = first.y + first.height
        for rect in rects.dropFirst() {
            minX = min(minX, rect.x)
            minY = min(minY, rect.y)
            maxX = max(maxX, rect.x + rect.width)
            maxY = max(maxY, rect.y + rect.height)
        }
        return PageRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    public enum GroupError: Error, Equatable, LocalizedError {
        case needsTwoLayers
        case differentParents
        case containsPages
        case rotatedGroup

        public var errorDescription: String? {
            switch self {
            case .needsTwoLayers: "Select at least two layers to group."
            case .differentParents: "Select layers that sit in the same frame or group."
            case .containsPages: "Pages can't be grouped."
            case .rotatedGroup: "Straighten or unflip this group before ungrouping it."
            }
        }
    }

    /// Ops that wrap `nodes` (siblings) in a new group placed where the topmost of them was. Returns the ops and the
    /// new group's id. `parent` is the shared parent node.
    public static func group(_ nodes: [Node], parent: Node, name: String = "Group") throws -> (ops: [Op], groupId: String) {
        guard nodes.count >= 2 else { throw GroupError.needsTwoLayers }
        guard !nodes.contains(where: { $0.type == .page || $0.type == .root }) else { throw GroupError.containsPages }
        guard nodes.allSatisfy({ $0.parent == parent.id }) else { throw GroupError.differentParents }
        let order = parent.children
        let sorted = nodes.sorted { (order.firstIndex(of: $0.id) ?? 0) < (order.firstIndex(of: $1.id) ?? 0) }
        guard let bounds = union(sorted.map(parentBounds(of:))) else { throw GroupError.needsTwoLayers }
        let topIndex = sorted.compactMap { order.firstIndex(of: $0.id) }.max() ?? (order.count - 1)
        let groupId = DesynID.new()
        let group = Node(json: [
            "id": .string(groupId),
            "type": "group",
            "name": .string(name),
            "parent": .string(parent.id),
            "x": .number(bounds.x),
            "y": .number(bounds.y),
            "width": .number(bounds.width),
            "height": .number(bounds.height),
            "rotation": 0,
            "opacity": 1,
            "blend": "normal",
            "visible": true,
            "locked": false,
            "effects": [],
            "children": [],
            "clip": false,
        ])
        // The group takes the topmost member's slot: insert it right above it (members leave the list afterwards).
        var ops: [Op] = [.create(nodes: [group], parent: parent.id, index: topIndex + 1)]
        for node in sorted {
            ops.append(.move(id: node.id, parent: groupId, index: nil))
            ops.append(.update(id: node.id, set: ["x": .number(node.x - bounds.x), "y": .number(node.y - bounds.y)], unset: []))
        }
        return (ops, groupId)
    }

    /// Ops that move a group's children to the group's parent (keeping their place on the page) and delete it.
    public static func ungroup(_ group: Node, children: [Node], parent: Node) throws -> [Op] {
        guard group.type == .group else { return [] }
        if group.bool("flipX") == true || group.bool("flipY") == true { throw GroupError.rotatedGroup }
        guard let groupIndex = parent.children.firstIndex(of: group.id) else { return [] }
        let theta = group.rotation * .pi / 180
        let gcx = group.x + group.width / 2
        let gcy = group.y + group.height / 2
        var ops: [Op] = []
        for (offset, child) in children.enumerated() {
            // Child center in the parent's space: group origin + local center, rotated about the group center.
            let localX = group.x + child.x + child.width / 2
            let localY = group.y + child.y + child.height / 2
            let dx = localX - gcx
            let dy = localY - gcy
            let cx = gcx + dx * cos(theta) - dy * sin(theta)
            let cy = gcy + dx * sin(theta) + dy * cos(theta)
            var set: [String: JSONValue] = [
                "x": .number(cx - child.width / 2),
                "y": .number(cy - child.height / 2),
            ]
            if group.rotation != 0 {
                set["rotation"] = .number(normalizedDegrees(child.rotation + group.rotation))
            }
            if group.opacity < 1 {
                set["opacity"] = .number(child.opacity * group.opacity)
            }
            // Children keep their back-to-front order where the group was.
            ops.append(.move(id: child.id, parent: parent.id, index: groupIndex + offset + 1))
            ops.append(.update(id: child.id, set: set, unset: []))
        }
        ops.append(.delete(id: group.id))
        return ops
    }

    /// -180 < degrees <= 180.
    public static func normalizedDegrees(_ value: Double) -> Double {
        var degrees = value.truncatingRemainder(dividingBy: 360)
        if degrees > 180 { degrees -= 360 }
        if degrees <= -180 { degrees += 360 }
        return degrees
    }

    /// Offsets that space boxes evenly along an axis, keeping the first and last in place. Boxes are (id, start,
    /// length) along the axis; returns id -> delta for the boxes that move.
    public static func distribute(_ boxes: [(id: String, start: Double, length: Double)]) -> [String: Double] {
        guard boxes.count >= 3 else { return [:] }
        let sorted = boxes.sorted { $0.start < $1.start }
        let first = sorted.first!
        let last = sorted.last!
        let span = (last.start + last.length) - first.start
        let total = sorted.reduce(0) { $0 + $1.length }
        let gap = (span - total) / Double(sorted.count - 1)
        var cursor = first.start + first.length + gap
        var deltas: [String: Double] = [:]
        for box in sorted.dropFirst().dropLast() {
            let delta = cursor - box.start
            if abs(delta) > 0.001 { deltas[box.id] = delta }
            cursor += box.length + gap
        }
        return deltas
    }

    /// Alignment of boxes to their common bounds: id -> delta along the axis. `edge` is 0 (start), 0.5 (center) or
    /// 1 (end).
    public static func align(_ boxes: [(id: String, start: Double, length: Double)], edge: Double) -> [String: Double] {
        guard boxes.count >= 2 else { return [:] }
        let minStart = boxes.map(\.start).min() ?? 0
        let maxEnd = boxes.map { $0.start + $0.length }.max() ?? 0
        var deltas: [String: Double] = [:]
        for box in boxes {
            let target = minStart + (maxEnd - minStart - box.length) * edge
            let delta = target - box.start
            if abs(delta) > 0.001 { deltas[box.id] = delta }
        }
        return deltas
    }
}
