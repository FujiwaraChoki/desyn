import DesynKit
import XCTest
import SharedKit

final class ArrangementTests: XCTestCase {
    func testRotatedParentBounds() {
        var rect = Fixtures.rect("rectaaaaaaaa", x: 0, y: 0, w: 100, h: 50)
        rect.rotation = 90
        let bounds = Arrangement.parentBounds(of: rect)
        XCTAssertEqual(bounds.x, 25, accuracy: 1e-9)
        XCTAssertEqual(bounds.y, -25, accuracy: 1e-9)
        XCTAssertEqual(bounds.width, 50, accuracy: 1e-9)
        XCTAssertEqual(bounds.height, 100, accuracy: 1e-9)
    }

    func testGroupWrapsSiblingsRelativeToTheirBounds() throws {
        let a = Fixtures.rect("aaaaaaaaaaaa", x: 100, y: 200, w: 50, h: 50)
        let b = Fixtures.rect("bbbbbbbbbbbb", x: 300, y: 260, w: 40, h: 20)
        let c = Fixtures.rect("cccccccccccc", x: 0, y: 0, w: 10, h: 10)
        let page = Fixtures.page(children: [a.id, c.id, b.id])
        let (ops, groupId) = try Arrangement.group([b, a], parent: page)
        guard case let .create(nodes, parent, index) = ops.first, let group = nodes.first else { return XCTFail() }
        XCTAssertEqual(group.id, groupId)
        XCTAssertEqual(parent, page.id)
        XCTAssertEqual(index, 3)
        XCTAssertEqual(group.x, 100)
        XCTAssertEqual(group.y, 200)
        XCTAssertEqual(group.width, 240)
        XCTAssertEqual(group.height, 80)
        // Members keep back-to-front order: a first, then b.
        XCTAssertEqual(ops[1], .move(id: a.id, parent: groupId, index: nil))
        XCTAssertEqual(ops[2], .update(id: a.id, set: ["x": 0, "y": 0], unset: []))
        XCTAssertEqual(ops[3], .move(id: b.id, parent: groupId, index: nil))
        XCTAssertEqual(ops[4], .update(id: b.id, set: ["x": 200, "y": 60], unset: []))
    }

    func testGroupValidation() {
        let a = Fixtures.rect("aaaaaaaaaaaa")
        let page = Fixtures.page(children: [a.id])
        XCTAssertThrowsError(try Arrangement.group([a], parent: page)) { XCTAssertEqual($0 as? Arrangement.GroupError, .needsTwoLayers) }
        let other = Fixtures.rect("bbbbbbbbbbbb", parent: "elsewhereaaa")
        XCTAssertThrowsError(try Arrangement.group([a, other], parent: page)) { XCTAssertEqual($0 as? Arrangement.GroupError, .differentParents) }
    }

    func testUngroupRestoresPagePositionsAndComposesRotation() throws {
        let child = Fixtures.rect("childaaaaaaa", x: 0, y: 0, w: 20, h: 20, parent: "groupaaaaaaa")
        var group = Node(json: [
            "id": "groupaaaaaaa", "type": "group", "name": "Group", "parent": .string(Fixtures.pageId),
            "x": 100, "y": 100, "width": 100, "height": 100, "rotation": 180, "opacity": 0.5, "blend": "normal",
            "visible": true, "locked": false, "effects": [], "children": ["childaaaaaaa"], "clip": false,
        ])
        let page = Fixtures.page(children: ["otheraaaaaaa", group.id])
        let ops = try Arrangement.ungroup(group, children: [child], parent: page)
        XCTAssertEqual(ops.count, 3)
        XCTAssertEqual(ops[0], .move(id: child.id, parent: page.id, index: 2))
        guard case let .update(_, set, _) = ops[1] else { return XCTFail() }
        // The child's top-left square (center 110,110) turns 180 degrees about the group center (150,150): 190,190.
        XCTAssertEqual(set["x"]?.doubleValue ?? 0, 180, accuracy: 1e-9)
        XCTAssertEqual(set["y"]?.doubleValue ?? 0, 180, accuracy: 1e-9)
        XCTAssertEqual(set["rotation"], 180)
        XCTAssertEqual(set["opacity"], 0.5)
        XCTAssertEqual(ops[2], .delete(id: group.id))
        group.set("flipX", true)
        XCTAssertThrowsError(try Arrangement.ungroup(group, children: [child], parent: page))
    }

    func testDistributeAndAlign() {
        let deltas = Arrangement.distribute([("a", 0, 10), ("c", 90, 10), ("b", 20, 10)])
        XCTAssertEqual(deltas.count, 1)
        XCTAssertEqual(deltas["b"] ?? 0, 25, accuracy: 1e-9)
        XCTAssertTrue(Arrangement.distribute([("a", 0, 10), ("b", 20, 10)]).isEmpty)
        let aligned = Arrangement.align([("a", 0, 10), ("b", 40, 20)], edge: 0.5)
        XCTAssertEqual(aligned["a"] ?? 0, 25, accuracy: 1e-9)
        XCTAssertEqual(aligned["b"] ?? 0, -20, accuracy: 1e-9)
    }

    func testNormalizedDegrees() {
        XCTAssertEqual(Arrangement.normalizedDegrees(270), -90)
        XCTAssertEqual(Arrangement.normalizedDegrees(-180), 180)
        XCTAssertEqual(Arrangement.normalizedDegrees(540), 180)
    }
}
