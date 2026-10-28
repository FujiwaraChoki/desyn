import DesynEngine
import DesynKit
import EditorFeature
import XCTest

/// `SyncSession` + the editor's `EngineDocument` on the real Rust engine: the gesture flow of the canvas
/// (`transformOps` against the committed state, previews on top), remote transactions arriving mid-gesture and
/// relayouts after fonts arrive.
@MainActor
final class EngineSyncTests: XCTestCase {
    private let pageId = "pageaaaaaaaa"

    private func design(_ nodes: [Node]) -> Design {
        let page = NodeFactory.page(id: pageId, name: "Page 1", width: 1080, height: 1080)
        var pageJSON = page.json
        pageJSON["children"] = .strings(nodes.map(\.id))
        let root = Node(json: [
            "id": "root", "type": "root", "name": "Root", "parent": .null, "children": [.string(pageId)],
            "x": 0, "y": 0, "width": 0, "height": 0, "rotation": 0, "opacity": 1, "blend": "normal",
            "visible": true, "locked": false, "effects": [],
        ])
        var map: [String: Node] = ["root": root, pageId: Node(json: pageJSON)]
        for node in nodes { map[node.id] = node }
        return Design(id: "designaaaaaa", name: "Sync", kind: .socialPost, nodes: map)
    }

    private func open(_ nodes: [Node], backend: ScriptedBackend) async throws -> (DesynEngine, SyncSession) {
        let engine = DesynEngine()
        try await engine.load(designJSON: design(nodes).serialized(), normalize: false)
        let session = SyncSession(
            designId: "d", share: nil, canEdit: true, confirmedSeq: 0,
            applier: EngineDocument(engine: engine), backend: backend
        )
        session.start()
        for _ in 0..<200 where backend.subscriptions.isEmpty {
            try await Task.sleep(for: .milliseconds(5))
        }
        return (engine, session)
    }

    private func node(_ engine: DesynEngine, _ id: String) async throws -> Node {
        let json = try await engine.nodeJSON(id)
        return try Node(jsonString: XCTUnwrap(json))
    }

    /// The canvas previews `transformOps(from: start, to: target)` on every drag step. Each step must place the
    /// layer relative to where the gesture started, never on top of the previous step's preview.
    func testDragStepsDoNotCompound() async throws {
        let rect = NodeFactory.rect(parent: pageId, frame: PageRect(x: 100, y: 100, width: 200, height: 100))
        let backend = ScriptedBackend()
        backend.holdCommits = true
        let (engine, session) = try await open([rect], backend: backend)
        let bounds = try await engine.selectionBounds([rect.id])
        let start = try XCTUnwrap(bounds).obb

        for dx in [10.0, 25.0, 60.0] {
            let ops = try await engine.transformOps(for: [rect.id], from: start, to: start.offsetBy(dx: dx, dy: dx / 2))
            try await session.setPreview(opsJSON: ops)
            let moved = try await node(engine, rect.id)
            XCTAssertEqual(moved.x, 100 + dx, accuracy: 0.001, "step to +\(dx)")
            XCTAssertEqual(moved.y, 100 + dx / 2, accuracy: 0.001)
        }
        // Resizing too: the second step is not scaled on top of the first.
        for width in [260.0, 300.0] {
            var target = start
            target.width = width
            let ops = try await engine.transformOps(for: [rect.id], from: start, to: target)
            try await session.setPreview(opsJSON: ops)
            let resized = try await node(engine, rect.id)
            XCTAssertEqual(resized.width, width, accuracy: 0.001)
            XCTAssertEqual(resized.x, 100, accuracy: 0.001)
        }

        let final = try await engine.transformOps(for: [rect.id], from: start, to: start.offsetBy(dx: 40, dy: 0))
        let local = try await session.commit(opsJSON: final, label: "Move")
        XCTAssertFalse(session.hasPreview)
        let committed = try await node(engine, rect.id)
        XCTAssertEqual(committed.x, 140, accuracy: 0.001)
        XCTAssertEqual(committed.width, 200, accuracy: 0.001)
        // One transaction for the whole gesture, undoing back to the start.
        XCTAssertEqual(session.pending.count, 1)
        try await session.commit(opsJSON: XCTUnwrap(local).undoOpsJSON, label: "Undo", normalize: false)
        let undone = try await node(engine, rect.id)
        XCTAssertEqual(undone.x, 100, accuracy: 0.001)
        backend.releaseCommits()
        session.stop()
    }

    /// A collaborator's transaction lands while a drag is in progress: it applies underneath and the drag keeps
    /// showing; cancelling the gesture shows the remote change on the untouched layer.
    func testRemoteTransactionDuringADrag() async throws {
        let rect = NodeFactory.rect(parent: pageId, frame: PageRect(x: 0, y: 0, width: 100, height: 100))
        let backend = ScriptedBackend()
        let (engine, session) = try await open([rect], backend: backend)
        let bounds = try await engine.selectionBounds([rect.id])
        let start = try XCTUnwrap(bounds).obb
        let ops = try await engine.transformOps(for: [rect.id], from: start, to: start.offsetBy(dx: 50, dy: 0))
        try await session.setPreview(opsJSON: ops)

        let remote = DesignTransaction(label: "Fade", ops: [.update(id: rect.id, set: ["opacity": 0.5], unset: [])])
        try backend.push(after: 0, transactions: [remote.serialized()])
        for _ in 0..<200 where session.confirmedSeq < 1 {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(session.confirmedSeq, 1)
        let during = try await node(engine, rect.id)
        XCTAssertEqual(during.x, 50, accuracy: 0.001, "the drag preview stays on top")
        XCTAssertEqual(during.opacity, 0.5, "the remote change applied underneath")
        let hasPreview = await engine.hasPreview
        XCTAssertTrue(hasPreview)

        try await session.clearPreview()
        let after = try await node(engine, rect.id)
        XCTAssertEqual(after.x, 0, accuracy: 0.001)
        XCTAssertEqual(after.opacity, 0.5)
        XCTAssertTrue(session.pending.isEmpty)
        session.stop()
    }

    /// Fonts arrived (or the design was saved by a client without a shaper): the relayout is one `system`
    /// transaction whose inverse restores the stored geometry exactly, queued in order with local edits.
    func testRelayoutIsQueuedLikeAnyOtherChange() async throws {
        var text = NodeFactory.text(parent: pageId, text: "A heading that wraps over several lines in a narrow box", origin: PagePoint(x: 10, y: 10), width: 120, fontSize: 32)
        text.json["height"] = 1
        let backend = ScriptedBackend()
        backend.holdCommits = true
        let (engine, session) = try await open([text], backend: backend)

        let moved = try await session.relayout()
        XCTAssertTrue(moved)
        let laidOut = try await node(engine, text.id)
        XCTAssertGreaterThan(laidOut.height, 60, "several lines of 32 px text")
        let pending = try XCTUnwrap(session.pending.first)
        XCTAssertEqual(try DesignTransaction(jsonString: pending.transactionJSON).source, .system)

        // The inverse restores the stored height (what a rebase rewinds to).
        _ = try await engine.apply(transactionJSON: pending.inverseJSON, normalize: false)
        let restored = try await node(engine, text.id)
        XCTAssertEqual(restored.height, 1)

        let again = try await session.relayout()
        XCTAssertTrue(again, "after the rewind the box is stale again")
        let unchanged = try await session.relayout()
        XCTAssertFalse(unchanged, "nothing left to lay out")
        backend.releaseCommits()
        session.stop()
    }
}
