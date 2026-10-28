import DesynEngine
import DesynKit
import EditorFeature
import XCTest

/// The Swift model layer against the real Rust engine: designs built with `NodeFactory`, ops built with `Op`,
/// text edits from `TextRuns` and ink from `InkStroke` must all be valid contract JSON for the engine.
final class EngineContractTests: XCTestCase {
    private let pageId = "pageaaaaaaaa"

    private func makeDesign(extra: [Node] = []) -> Design {
        let page = NodeFactory.page(id: pageId, name: "Page 1", width: 1080, height: 1080)
        var pageJSON = page.json
        pageJSON["children"] = .strings(extra.map(\.id))
        let root = Node(json: [
            "id": "root", "type": "root", "name": "Root", "parent": .null, "children": [.string(pageId)],
            "x": 0, "y": 0, "width": 0, "height": 0, "rotation": 0, "opacity": 1, "blend": "normal",
            "visible": true, "locked": false, "effects": [],
        ])
        var nodes: [String: Node] = ["root": root, pageId: Node(json: pageJSON)]
        for node in extra { nodes[node.id] = node }
        return Design(id: "designaaaaaa", name: "Contract", kind: .socialPost, nodes: nodes)
    }

    private func tx(_ ops: [Op], label: String = "Test") -> String {
        DesignTransaction(label: label, ops: ops).serialized()
    }

    func testFactoryDesignLoadsWithoutViolations() async throws {
        let rect = NodeFactory.rect(parent: pageId, frame: PageRect(x: 100, y: 100, width: 300, height: 200), color: "#ffb02e")
        let text = NodeFactory.text(parent: pageId, text: "Hello", origin: PagePoint(x: 100, y: 400), fontSize: 48)
        let engine = DesynEngine()
        let result = try await engine.load(designJSON: makeDesign(extra: [rect, text]).serialized(), normalize: true)
        XCTAssertEqual(result.pages.map(\.id), [pageId])
        XCTAssertEqual(result.violations, [])
        // The engine's snapshot parses back into the Swift model.
        let snapshot = try Design(jsonString: try await engine.snapshot())
        XCTAssertEqual(snapshot.nodes[rect.id]?.fills.first?.swatchHex, "#ffb02e")
        XCTAssertEqual(snapshot.nodes[text.id]?.text, "Hello")
    }

    func testOpsFromSwiftApplyAndInvert() async throws {
        let rect = NodeFactory.rect(parent: pageId, frame: PageRect(x: 0, y: 0, width: 100, height: 100))
        let engine = DesynEngine()
        try await engine.load(designJSON: makeDesign(extra: [rect]).serialized(), normalize: false)
        let outcome = try await engine.apply(transactionJSON: tx([
            .update(id: rect.id, set: ["opacity": 0.5, "name": "Card"], unset: []),
            .patch(id: rect.id, path: [.key("fills"), .index(0), .key("color")], value: "#ff6a1f"),
        ]), normalize: true)
        XCTAssertTrue(outcome.dropped.isEmpty)
        XCTAssertFalse(try Op.parseList(outcome.appliedJson).isEmpty)
        let updatedJSON = try await engine.nodeJSON(rect.id)
        let updated = try Node(jsonString: XCTUnwrap(updatedJSON))
        XCTAssertEqual(updated.opacity, 0.5)
        XCTAssertEqual(updated.fills.first?.swatchHex, "#ff6a1f")
        // The inverse restores the original node.
        try await engine.apply(transactionJSON: outcome.inverseJson, normalize: false)
        let restoredJSON = try await engine.nodeJSON(rect.id)
        let restored = try Node(jsonString: XCTUnwrap(restoredJSON))
        XCTAssertEqual(restored.opacity, 1)
        XCTAssertEqual(restored.name, "Rectangle")
    }

    func testTextEditsMatchEngineOffsets() async throws {
        let text = NodeFactory.text(parent: pageId, text: "Hello 😀", origin: PagePoint(x: 10, y: 10))
        let engine = DesynEngine()
        try await engine.load(designJSON: makeDesign(extra: [text]).serialized(), normalize: true)
        let before = try await engine.textLayout(text.id)
        XCTAssertEqual(Int(before.length), TextRuns.length(of: text.runs))
        let runs = TextRuns.replace(in: text.runs, range: 5..<5, with: ",")
        try await engine.apply(transactionJSON: tx([.update(id: text.id, set: ["runs": .array(runs.map(\.jsonValue))], unset: [])]), normalize: true)
        let after = try await engine.textLayout(text.id)
        XCTAssertEqual(after.text, "Hello, 😀")
        XCTAssertEqual(Int(after.length), TextRuns.length(of: runs))
    }

    func testInkStrokeBecomesARenderablePath() async throws {
        let samples = (0...30).map { InkSample(x: 200 + Double($0) * 10, y: 500 + sin(Double($0) / 4) * 40, pressure: 0.6) }
        let outline = try XCTUnwrap(InkStroke.outline(samples, width: 16))
        let path = NodeFactory.path(parent: pageId, frame: outline.frame, d: outline.d, color: "#111111")
        let engine = DesynEngine()
        try await engine.load(designJSON: makeDesign().serialized(), normalize: false)
        let outcome = try await engine.apply(transactionJSON: tx([.create(nodes: [path], parent: pageId, index: nil)]), normalize: true)
        XCTAssertTrue(outcome.dropped.isEmpty)
        let frame = try await engine.renderPage(PageImageRequest(pageId: pageId, scale: 0.25))
        // A dark pixel where the stroke passes (page (350, 500) at scale 0.25).
        let x = 350 / 4
        let y = Int((500 + sin(15.0 / 4) * 40) / 4)
        let offset = y * Int(frame.stride) + x * 4
        let red = frame.pixels[frame.pixels.startIndex + offset]
        XCTAssertLessThan(red, 80, "the stroke is drawn")
    }

    @MainActor
    func testSyncSessionDrivesTheRealEngine() async throws {
        let rect = NodeFactory.rect(parent: pageId, frame: PageRect(x: 0, y: 0, width: 100, height: 100))
        let engine = DesynEngine()
        try await engine.load(designJSON: makeDesign(extra: [rect]).serialized(), normalize: false)
        let applier = EngineDocument(engine: engine)
        let backend = ScriptedBackend()
        backend.holdCommits = true
        let session = SyncSession(designId: "d", share: nil, canEdit: true, confirmedSeq: 0, applier: applier, backend: backend)
        session.start()
        let local = try await session.commit(opsJSON: Op.serialize([.update(id: rect.id, set: ["x": 40], unset: [])]), label: "Move")
        XCTAssertNotNil(local)
        // A remote edit of another property arrives before our commit is acknowledged.
        for _ in 0..<200 where backend.subscriptions.isEmpty {
            try await Task.sleep(for: .milliseconds(5))
        }
        try backend.push(after: 0, transactions: [tx([.update(id: rect.id, set: ["opacity": 0.25], unset: [])])])
        for _ in 0..<200 where session.confirmedSeq < 1 {
            try await Task.sleep(for: .milliseconds(5))
        }
        let nodeJSON = try await engine.nodeJSON(rect.id)
        let node = try Node(jsonString: XCTUnwrap(nodeJSON))
        XCTAssertEqual(node.x, 40, "pending local change re-applied on top")
        XCTAssertEqual(node.opacity, 0.25, "remote change applied underneath")
        // Undo ops from the session restore x through the engine.
        try await session.commit(opsJSON: XCTUnwrap(local).undoOpsJSON, label: "Undo", normalize: false)
        let undoneJSON = try await engine.nodeJSON(rect.id)
        let undone = try Node(jsonString: XCTUnwrap(undoneJSON))
        XCTAssertEqual(undone.x, 0)
        backend.releaseCommits()
        session.stop()
    }
}
