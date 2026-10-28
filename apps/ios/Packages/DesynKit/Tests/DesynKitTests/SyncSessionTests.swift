import DesynKit
import XCTest

/// A minimal reference applier for tests: nodes are flat objects; `create`, `update` (LWW set / unset) and
/// `delete` apply with exact inverses, ops on missing nodes drop. Previews behave like the engine's: they sit on
/// top of the committed state, `apply` changes the committed state underneath and replays the preview.
@MainActor
final class MemoryApplier: DocumentApplier {
    var nodes: [String: [String: JSONValue]] = [:]
    private(set) var applyCount = 0
    /// Ops the next `relayout()` applies (derived geometry that changed now that "fonts arrived").
    var relayoutOps: [Op] = []
    private var previewTransaction: String?
    private var previewInverse: String?

    var hasPreview: Bool { previewTransaction != nil }

    func apply(transactionJSON: String, normalize: Bool) async throws -> AppliedChange {
        let preview = previewTransaction
        try takePreviewOff()
        let change = try applyCommitted(transactionJSON)
        if let preview { try putPreview(preview) }
        return change
    }

    func preview(transactionJSON: String) async throws {
        try takePreviewOff()
        try putPreview(transactionJSON)
    }

    func cancelPreview() async {
        try? takePreviewOff()
    }

    func relayout() async throws -> AppliedChange? {
        guard !relayoutOps.isEmpty else { return nil }
        let ops = relayoutOps
        relayoutOps = []
        let change = try await apply(transactionJSON: DesignTransaction(label: "Layout", ops: ops, source: .system).serialized(), normalize: false)
        return try Op.parseList(change.opsJSON).isEmpty ? nil : change
    }

    private func takePreviewOff() throws {
        guard let inverse = previewInverse else { return }
        previewTransaction = nil
        previewInverse = nil
        _ = try applyCommitted(inverse)
    }

    private func putPreview(_ transactionJSON: String) throws {
        previewInverse = try applyCommitted(transactionJSON).inverseJSON
        previewTransaction = transactionJSON
    }

    private func applyCommitted(_ transactionJSON: String) throws -> AppliedChange {
        applyCount += 1
        let tx = try DesignTransaction(jsonString: transactionJSON)
        var applied: [Op] = []
        var inverse: [Op] = []
        for op in tx.ops {
            switch op {
            case let .create(created, parent, _):
                guard let root = created.first, nodes[root.id] == nil else { continue }
                nodes[root.id] = root.json
                applied.append(.create(nodes: [root], parent: parent, index: nil))
                inverse.insert(.delete(id: root.id), at: 0)
            case let .update(id, set, unset):
                guard var node = nodes[id] else { continue }
                var restore: [String: JSONValue] = [:]
                var remove: [String] = []
                for (key, value) in set {
                    if let old = node[key] { restore[key] = old } else { remove.append(key) }
                    node[key] = value
                }
                for key in unset {
                    if let old = node[key] { restore[key] = old }
                    node[key] = nil
                }
                nodes[id] = node
                applied.append(op)
                inverse.insert(.update(id: id, set: restore, unset: remove.sorted()), at: 0)
            case let .delete(id):
                guard let node = nodes.removeValue(forKey: id) else { continue }
                applied.append(op)
                inverse.insert(.create(nodes: [Node(json: node)], parent: "p", index: nil), at: 0)
            default:
                continue
            }
        }
        let inverseTx = DesignTransaction(id: DesynID.new(), label: "Undo", ops: inverse, source: tx.source)
        return AppliedChange(opsJSON: Op.serialize(applied), inverseJSON: inverseTx.serialized())
    }

    func load(designJSON: String) async throws {
        guard case let .object(object) = try JSONValue.parse(designJSON) else { return }
        previewTransaction = nil
        previewInverse = nil
        nodes = object.compactMapValues(\.objectValue)
    }

    func snapshotJSON() async throws -> String {
        JSONValue.object(nodes.mapValues(JSONValue.object)).serialized()
    }

    func value(_ id: String, _ key: String) -> JSONValue? {
        nodes[id]?[key]
    }
}

/// A scripted server: commits get the next seq (optionally held until released, optionally rewriting the
/// applied ops or failing); `since` results are pushed by the test.
@MainActor
final class ScriptedBackend: SyncBackend {
    var seq = 0
    var committed: [String] = []
    var holdCommits = false
    var failure: DesynError?
    var rewriteApplied: ((String) -> String)?
    private var held: [CheckedContinuation<Void, Never>] = []
    private var continuation: AsyncThrowingStream<OpsSince, Error>.Continuation?
    private(set) var subscriptions: [Int] = []

    nonisolated func commit(designId: String, baseSeq: Int?, transactionJSON: String, share: ShareAccess?) async throws -> CommitResult {
        try await commitOnMain(transactionJSON)
    }

    private func commitOnMain(_ transactionJSON: String) async throws -> CommitResult {
        if holdCommits {
            await withCheckedContinuation { held.append($0) }
        }
        if let failure { throw failure }
        seq += 1
        committed.append(transactionJSON)
        let tx = try DesignTransaction(jsonString: transactionJSON)
        let ops = Op.serialize(tx.ops)
        return try JSONDecoder().decode(CommitResult.self, from: Data(JSONValue.object([
            "seq": .number(Double(seq)),
            "applied": .string(rewriteApplied?(ops) ?? ops),
            "dropped": [],
            "duplicate": false,
        ]).serialized().utf8))
    }

    var heldCount: Int { held.count }

    func releaseCommits() {
        let waiting = held
        held.removeAll()
        waiting.forEach { $0.resume() }
    }

    nonisolated func opsSince(designId: String, seq: Int, share: ShareAccess?) -> AsyncThrowingStream<OpsSince, Error> {
        let (stream, continuation) = AsyncThrowingStream.makeStream(of: OpsSince.self)
        Task { @MainActor in
            self.continuation = continuation
            self.subscriptions.append(seq)
        }
        return stream
    }

    /// Pushes a `since` result with the given transactions (seqs assigned in order after `after`).
    func push(after: Int, transactions: [String], gap: Bool = false) throws {
        let entries: [JSONValue] = try transactions.enumerated().map { index, json in
            let tx = try DesignTransaction(jsonString: json)
            return [
                "seq": .number(Double(after + index + 1)), "txId": .string(tx.id), "tx": .string(json),
                "source": "user", "ts": 0,
            ]
        }
        let result = try JSONDecoder().decode(OpsSince.self, from: Data(JSONValue.object([
            "ops": .array(entries), "hasMore": false, "gap": .bool(gap), "latestSeq": .number(Double(after + transactions.count)),
        ]).serialized().utf8))
        continuation?.yield(result)
    }
}

@MainActor
final class SyncSessionTests: XCTestCase {
    private var applier: MemoryApplier!
    private var backend: ScriptedBackend!

    override func setUp() async throws {
        applier = MemoryApplier()
        applier.nodes = ["rect": ["id": "rect", "x": 0, "fill": "#000000"]]
        backend = ScriptedBackend()
    }

    private func makeSession(seq: Int = 0) -> SyncSession {
        let session = SyncSession(designId: "d", share: nil, canEdit: true, confirmedSeq: seq, applier: applier, backend: backend)
        session.start()
        return session
    }

    private func waitUntil(_ condition: @escaping () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<400 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("condition not met in time", file: file, line: line)
    }

    private func remoteTx(_ ops: [Op]) -> String {
        DesignTransaction(label: "Remote", ops: ops).serialized()
    }

    func testLocalCommitIsAcknowledged() async throws {
        let session = makeSession()
        let local = try await session.commit(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 10], unset: [])]), label: "Move")
        XCTAssertNotNil(local)
        XCTAssertEqual(applier.value("rect", "x"), 10)
        await waitUntil { session.pending.isEmpty }
        XCTAssertEqual(session.confirmedSeq, 1)
        XCTAssertEqual(session.status, .synced)
        XCTAssertEqual(backend.committed.count, 1)
        // The undo ops restore the previous value.
        XCTAssertEqual(try Op.parseList(local!.undoOpsJSON), [.update(id: "rect", set: ["x": 0], unset: [])])
    }

    func testDroppedLocalOpsCreateNoTransaction() async throws {
        let session = makeSession()
        let local = try await session.commit(opsJSON: Op.serialize([.update(id: "missing", set: ["x": 1], unset: [])]), label: "Nothing")
        XCTAssertNil(local)
        XCTAssertTrue(session.pending.isEmpty)
    }

    func testRemoteTransactionRebasesPendingWork() async throws {
        backend.holdCommits = true
        let session = makeSession()
        try await session.commit(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 10], unset: [])]), label: "Move")
        await waitUntil { self.backend.subscriptions.count == 1 }
        // Another client changed the fill and (concurrently) x before our commit reached the server.
        try backend.push(after: 0, transactions: [remoteTx([.update(id: "rect", set: ["fill": "#ff0000", "x": 99], unset: [])])])
        await waitUntil { session.confirmedSeq == 1 }
        // Remote applied underneath, our pending x re-applied on top.
        XCTAssertEqual(applier.value("rect", "fill"), "#ff0000")
        XCTAssertEqual(applier.value("rect", "x"), 10)
        XCTAssertEqual(session.pending.count, 1)
        backend.seq = 1
        backend.releaseCommits()
        await waitUntil { session.pending.isEmpty }
        XCTAssertEqual(session.confirmedSeq, 2)
        XCTAssertEqual(applier.value("rect", "x"), 10)
    }

    func testRemoteTransactionsReportTheirInverse() async throws {
        let session = makeSession()
        var reported: [(id: String, inverse: [Op])] = []
        session.onRemoteApplied = { tx, inverseJSON in
            reported.append((tx.id, (try? DesignTransaction(jsonString: inverseJSON).ops) ?? []))
        }
        await waitUntil { self.backend.subscriptions.count == 1 }
        // Without pending work: applied directly.
        let first = remoteTx([.update(id: "rect", set: ["fill": "#ff0000"], unset: [])])
        try backend.push(after: 0, transactions: [first])
        await waitUntil { session.confirmedSeq == 1 }
        XCTAssertEqual(reported.count, 1)
        XCTAssertEqual(reported[0].id, try DesignTransaction(jsonString: first).id)
        XCTAssertEqual(reported[0].inverse, [.update(id: "rect", set: ["fill": "#000000"], unset: [])])
        // With pending work: the inverse is taken against the server state (pending rewound), and our own echo is
        // never reported.
        backend.holdCommits = true
        try await session.commit(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 10], unset: [])]), label: "Move")
        let second = remoteTx([.update(id: "rect", set: ["x": 50, "w": 3], unset: [])])
        try backend.push(after: 1, transactions: [second])
        await waitUntil { session.confirmedSeq == 2 }
        XCTAssertEqual(reported.count, 2)
        XCTAssertEqual(reported[1].inverse, [.update(id: "rect", set: ["x": 0], unset: ["w"])])
        XCTAssertEqual(applier.value("rect", "x"), 10, "pending work stays on top")
        let echo = session.pending[0].transactionJSON
        backend.seq = 2
        try backend.push(after: 2, transactions: [echo])
        await waitUntil { session.confirmedSeq == 3 }
        XCTAssertEqual(reported.count, 2)
        backend.releaseCommits()
    }

    func testServerRewriteReplacesLocalOps() async throws {
        backend.rewriteApplied = { _ in Op.serialize([.update(id: "rect", set: ["x": 7], unset: [])]) }
        let session = makeSession()
        try await session.commit(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 10], unset: [])]), label: "Move")
        await waitUntil { session.pending.isEmpty }
        XCTAssertEqual(applier.value("rect", "x"), 7, "the confirmed state follows the server's applied ops")
    }

    func testEchoBeforeCommitResultActsAsAck() async throws {
        backend.holdCommits = true
        let session = makeSession()
        try await session.commit(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 3], unset: [])]), label: "Move")
        await waitUntil { self.backend.subscriptions.count == 1 }
        let pendingJSON = session.pending[0].transactionJSON
        try backend.push(after: 0, transactions: [pendingJSON])
        await waitUntil { session.pending.isEmpty }
        XCTAssertEqual(session.confirmedSeq, 1)
        XCTAssertEqual(applier.value("rect", "x"), 3)
        backend.releaseCommits()
    }

    func testPermanentRejectionRollsBack() async throws {
        backend.failure = .server(code: "FORBIDDEN", message: "No.")
        let session = makeSession()
        var rejected: String?
        session.onRejected = { label, _ in rejected = label }
        try await session.commit(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 50], unset: [])]), label: "Move")
        await waitUntil { rejected != nil }
        XCTAssertEqual(rejected, "Move")
        XCTAssertTrue(session.pending.isEmpty)
        XCTAssertEqual(applier.value("rect", "x"), 0)
    }

    func testPreviewIsRevertedBeforeCommitting() async throws {
        backend.holdCommits = true
        let session = makeSession()
        try await session.setPreview(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 5], unset: [])]))
        XCTAssertTrue(session.hasPreview)
        XCTAssertEqual(applier.value("rect", "x"), 5)
        try await session.setPreview(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 6], unset: [])]))
        XCTAssertEqual(applier.value("rect", "x"), 6)
        try await session.clearPreview()
        XCTAssertEqual(applier.value("rect", "x"), 0)
        try await session.setPreview(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 8], unset: [])]))
        try await session.commit(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 9], unset: [])]), label: "Drag")
        XCTAssertFalse(session.hasPreview)
        XCTAssertEqual(applier.value("rect", "x"), 9)
        // The committed transaction holds only the final ops, and its inverse restores the pre-gesture state.
        let pending = try XCTUnwrap(session.pending.first)
        XCTAssertEqual(try DesignTransaction(jsonString: pending.transactionJSON).ops, [.update(id: "rect", set: ["x": 9], unset: [])])
        XCTAssertEqual(try DesignTransaction(jsonString: pending.inverseJSON).ops, [.update(id: "rect", set: ["x": 0], unset: [])])
        backend.releaseCommits()
    }

    func testOfflineCommitsRetryUntilOnline() async throws {
        backend.failure = .offline("down")
        let session = makeSession()
        try await session.commit(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 1], unset: [])]), label: "Move")
        await waitUntil { session.status == .offline }
        backend.failure = nil
        await waitUntil { session.pending.isEmpty }
        XCTAssertEqual(session.status, .synced)
    }

    func testCheckpointsCarryPendingWork() async throws {
        backend.holdCommits = true
        let session = SyncSession(designId: "d", share: nil, canEdit: true, confirmedSeq: 3, applier: applier, backend: backend)
        session.checkpointDelay = 0.01
        var checkpoint: SyncCheckpoint?
        session.onCheckpoint = { checkpoint = $0 }
        session.start()
        try await session.commit(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 4], unset: [])]), label: "Move")
        await waitUntil { checkpoint != nil }
        XCTAssertEqual(checkpoint?.confirmedSeq, 3)
        XCTAssertEqual(checkpoint?.pending.count, 1)
        XCTAssertTrue(checkpoint?.designJSON.contains("\"x\":4") ?? false)
        backend.releaseCommits()
    }

    func testPreviewStaysOnTopWhileRemoteTransactionsArrive() async throws {
        let session = makeSession()
        await waitUntil { self.backend.subscriptions.count == 1 }
        try await session.setPreview(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 5], unset: [])]))
        try backend.push(after: 0, transactions: [remoteTx([.update(id: "rect", set: ["fill": "#ff0000"], unset: [])])])
        await waitUntil { session.confirmedSeq == 1 }
        XCTAssertTrue(session.hasPreview)
        XCTAssertEqual(applier.value("rect", "x"), 5, "the gesture preview stays on screen")
        XCTAssertEqual(applier.value("rect", "fill"), "#ff0000")
        try await session.clearPreview()
        XCTAssertFalse(applier.hasPreview)
        XCTAssertEqual(applier.value("rect", "x"), 0, "the committed state never contained the preview")
        XCTAssertEqual(applier.value("rect", "fill"), "#ff0000")
    }

    func testRelayoutIsQueuedWithAnExactInverse() async throws {
        backend.holdCommits = true
        let session = makeSession()
        await waitUntil { self.backend.subscriptions.count == 1 }
        try await session.commit(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 10], unset: [])]), label: "Move")
        try await session.setPreview(opsJSON: Op.serialize([.update(id: "rect", set: ["x": 20], unset: [])]))
        applier.relayoutOps = [.update(id: "rect", set: ["height": 40], unset: [])]
        let moved = try await session.relayout()
        XCTAssertTrue(moved)
        XCTAssertTrue(session.hasPreview, "a relayout keeps the running gesture")
        XCTAssertEqual(applier.value("rect", "x"), 20)
        XCTAssertEqual(session.pending.count, 2)
        let layout = try DesignTransaction(jsonString: session.pending[1].transactionJSON)
        XCTAssertEqual(layout.source, .system)
        XCTAssertEqual(layout.ops, [.update(id: "rect", set: ["height": 40], unset: [])])
        XCTAssertEqual(try DesignTransaction(jsonString: session.pending[1].inverseJSON).ops, [.update(id: "rect", set: [:], unset: ["height"])])
        // A remote transaction rewinds both pending transactions exactly and replays them on top.
        try backend.push(after: 0, transactions: [remoteTx([.update(id: "rect", set: ["fill": "#00ff00"], unset: [])])])
        await waitUntil { session.confirmedSeq == 1 }
        try await session.clearPreview()
        XCTAssertEqual(applier.value("rect", "x"), 10)
        XCTAssertEqual(applier.value("rect", "height"), 40)
        XCTAssertEqual(applier.value("rect", "fill"), "#00ff00")
        // Nothing to do: no transaction.
        let again = try await session.relayout()
        XCTAssertFalse(again)
        XCTAssertEqual(session.pending.count, 2)
        backend.releaseCommits()
    }

    func testReadOnlySessionsRefuseEdits() async {
        let session = SyncSession(designId: "d", share: nil, canEdit: false, confirmedSeq: 0, applier: applier, backend: backend)
        XCTAssertEqual(session.status, .readOnly)
        do {
            try await session.commit(opsJSON: "[]", label: "x")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual((error as? DesynError)?.code, "FORBIDDEN")
        }
    }
}

/// Designs "open in an editor" during a flush test.
@MainActor
final class OpenDesigns {
    var ids: Set<String> = []
}

@MainActor
final class PendingFlushTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("desyn-flush-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func cached(_ id: String, seq: Int, pending: Int) -> CachedDesign {
        let transactions = (0..<pending).map { index in
            let tx = DesignTransaction(label: "Edit \(index)", ops: [.update(id: "rect", set: ["x": .number(Double(index))], unset: [])])
            return PendingTransaction(id: tx.id, transactionJSON: tx.serialized(), inverseJSON: "{}")
        }
        return CachedDesign(
            designId: id, key: "designaaaaaa", name: "D", kind: "custom", workspaceId: "w", permission: "edit",
            confirmedSeq: seq, designJSON: "{}", pending: transactions, share: nil
        )
    }

    func testSendsQueuedTransactionsInOrderAndSkipsOpenDesigns() async throws {
        let store = OfflineStore(userId: "u", baseDirectory: directory, cacheDirectory: directory)
        try store.saveDesign(cached("closed", seq: 0, pending: 2))
        try store.saveDesign(cached("open", seq: 0, pending: 1))
        let backend = ScriptedBackend()
        let report = await PendingFlush.run(store: store, backend: backend, skipping: ["open"])
        XCTAssertEqual(report, PendingFlush.Report(sent: 2, rejected: 0, interrupted: false))
        XCTAssertEqual(backend.committed.count, 2)
        XCTAssertEqual(try DesignTransaction(jsonString: backend.committed[0]).label, "Edit 0")
        XCTAssertEqual(store.loadDesign("closed")?.pending.count, 0)
        XCTAssertEqual(store.loadDesign("closed")?.confirmedSeq, 2)
        XCTAssertEqual(store.loadDesign("open")?.pending.count, 1)
    }

    func testRefusedOrRewrittenWorkMarksTheCacheForAServerCopy() async throws {
        let store = OfflineStore(userId: "u", baseDirectory: directory, cacheDirectory: directory)
        try store.saveDesign(cached("rewritten", seq: 0, pending: 1))
        let backend = ScriptedBackend()
        backend.rewriteApplied = { _ in "[]" }
        _ = await PendingFlush.run(store: store, backend: backend)
        let rewritten = try XCTUnwrap(store.loadDesign("rewritten"))
        XCTAssertTrue(rewritten.needsServerCopy, "the cached design shows ops the server dropped")
        XCTAssertEqual(rewritten.confirmedSeq, 0)

        try store.saveDesign(cached("refused", seq: 3, pending: 1))
        backend.failure = .server(code: "FORBIDDEN", message: "No.")
        _ = await PendingFlush.run(store: store, backend: backend)
        let refused = try XCTUnwrap(store.loadDesign("refused"))
        XCTAssertTrue(refused.pending.isEmpty)
        XCTAssertTrue(refused.needsServerCopy, "the refused edit is still in the cached design")

        try store.saveDesign(cached("clean", seq: 0, pending: 1))
        backend.failure = nil
        backend.rewriteApplied = nil
        backend.seq = 0
        _ = await PendingFlush.run(store: store, backend: backend)
        let clean = try XCTUnwrap(store.loadDesign("clean"))
        XCTAssertFalse(clean.needsServerCopy)
        XCTAssertEqual(clean.confirmedSeq, 1)
    }

    func testDesignOpenedDuringAFlushBelongsToItsEditor() async throws {
        let store = OfflineStore(userId: "u", baseDirectory: directory, cacheDirectory: directory)
        try store.saveDesign(cached("d", seq: 0, pending: 2))
        let backend = ScriptedBackend()
        backend.holdCommits = true
        let editor = OpenDesigns()
        let flush = Task { await PendingFlush.run(store: store, backend: backend, isOpen: { editor.ids.contains($0) }) }
        for _ in 0..<400 where backend.heldCount == 0 {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(backend.heldCount, 1)
        // The editor opens the design and checkpoints a newer state while the first commit is in flight.
        editor.ids.insert("d")
        var editorCopy = cached("d", seq: 0, pending: 3)
        editorCopy.designJSON = "{\"editor\":true}"
        try store.saveDesign(editorCopy)
        backend.releaseCommits()
        let report = await flush.value
        XCTAssertEqual(report.sent, 1)
        XCTAssertEqual(backend.committed.count, 1, "nothing else is sent for a design an editor owns")
        let stored = try XCTUnwrap(store.loadDesign("d"))
        XCTAssertEqual(stored.designJSON, editorCopy.designJSON, "the editor's checkpoint is never overwritten")
        XCTAssertEqual(stored.pending, editorCopy.pending)
    }

    func testCachesWrittenBeforeTheServerCopyFlagStillLoad() throws {
        let design = cached("d", seq: 4, pending: 1)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        guard case var .object(object) = try JSONValue.parse(encoder.encode(design)) else { return XCTFail("not an object") }
        object["needsServerCopy"] = nil
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let old = try decoder.decode(CachedDesign.self, from: Data(JSONValue.object(object).serialized().utf8))
        XCTAssertFalse(old.needsServerCopy)
        XCTAssertEqual(old.pending, design.pending)
        XCTAssertEqual(old.confirmedSeq, 4)
    }

    func testStopsWhenOfflineAndDropsRefusedWork() async throws {
        let store = OfflineStore(userId: "u", baseDirectory: directory, cacheDirectory: directory)
        try store.saveDesign(cached("d", seq: 5, pending: 2))
        let backend = ScriptedBackend()
        backend.failure = .offline("down")
        var report = await PendingFlush.run(store: store, backend: backend)
        XCTAssertTrue(report.interrupted)
        XCTAssertEqual(store.loadDesign("d")?.pending.count, 2)
        backend.failure = .server(code: "FORBIDDEN", message: "No.")
        report = await PendingFlush.run(store: store, backend: backend)
        XCTAssertEqual(report.rejected, 2)
        XCTAssertEqual(store.loadDesign("d")?.pending.count, 0)
    }
}
