import Foundation
import Observation

/// Result of applying a transaction to the working copy.
public struct AppliedChange: Sendable, Equatable {
    /// The ops that took effect in normal form (JSON `Op[]`): what gets committed.
    public let opsJSON: String
    /// Transaction (JSON) restoring the previous state exactly; apply it without normalizing.
    public let inverseJSON: String

    public init(opsJSON: String, inverseJSON: String) {
        self.opsJSON = opsJSON
        self.inverseJSON = inverseJSON
    }
}

/// The client's working copy of a design (the Rust engine in the app).
///
/// The working copy has a committed state plus an optional preview on top (the engine's `preview` /
/// `cancel_preview`): `apply` changes the committed state and keeps the preview on top, so gesture math that
/// reads the committed state (`transform_selection`) never compounds a previous preview step.
@MainActor
public protocol DocumentApplier: AnyObject {
    /// Applies a transaction (JSON) to the committed state. `normalize` recomputes derived geometry (local
    /// edits); remote transactions and inverses are applied verbatim. An active preview stays on top.
    func apply(transactionJSON: String, normalize: Bool) async throws -> AppliedChange
    /// Shows a transaction (JSON) on top of the committed state without committing it (normalized); replaces
    /// the previous preview.
    func preview(transactionJSON: String) async throws
    /// Removes the preview (the committed state shows again).
    func cancelPreview() async
    /// Recomputes the derived geometry of the committed state (text boxes, auto-layout, groups), e.g. after
    /// fonts arrived. Returns the change (forward ops + inverse transaction), or nil when nothing moved.
    func relayout() async throws -> AppliedChange?
    /// Replaces the working copy (reload after a sync gap).
    func load(designJSON: String) async throws
    /// The current design as JSON (offline cache).
    func snapshotJSON() async throws -> String
}

/// The two Convex functions sync needs (`DesynAPI` implements them).
public protocol SyncBackend: AnyObject, Sendable {
    func commit(designId: String, baseSeq: Int?, transactionJSON: String, share: ShareAccess?) async throws -> CommitResult
    func opsSince(designId: String, seq: Int, share: ShareAccess?) -> AsyncThrowingStream<OpsSince, Error>
}

extension DesynAPI: SyncBackend {}

/// A local edit that went into history; keeps what undo needs.
public struct LocalCommit: Sendable, Equatable {
    public let transactionID: String
    public let label: String
    /// Ops that undo this edit (JSON `Op[]`, apply without normalizing).
    public let undoOpsJSON: String
}

/// Saved state for the offline cache.
public struct SyncCheckpoint: Sendable, Equatable {
    public let confirmedSeq: Int
    public let designJSON: String
    public let pending: [PendingTransaction]
}

/// The sync client of DOCUMENT_MODEL section 6 for one open design.
///
/// The working copy shows `confirmed + pending (+ preview)`. Local transactions apply immediately and queue for
/// `designs.commit` (one in flight, idempotent on the transaction id, retried with backoff while offline).
/// Remote transactions from `designOps.since` are applied by rewinding the preview and pending transactions
/// (their inverses), applying the remote ops, and re-applying pending on top; a pending transaction whose echo
/// (or immediate ack at `seq + 1`) arrives moves into the confirmed state, rebasing when the server's applied
/// ops differ from the local ones. Every state change runs through one serial queue so engine calls never
/// interleave.
@MainActor
@Observable
public final class SyncSession {
    public enum Status: Equatable, Sendable {
        /// Everything is on the server.
        case synced
        /// Local changes are being sent.
        case syncing
        /// No connection; changes wait on this device.
        case offline
        /// The design is view-only for this user.
        case readOnly
        /// The session ended or the server keeps refusing; changes wait on this device.
        case paused(String)
    }

    public let designId: String
    public let share: ShareAccess?
    public let canEdit: Bool

    public private(set) var status: Status
    public private(set) var confirmedSeq: Int
    public private(set) var pending: [PendingTransaction]
    /// True while a gesture preview is applied on top of everything.
    public private(set) var hasPreview = false

    /// A remote transaction changed the design (refresh selection, pages, inspector).
    @ObservationIgnored public var onRemoteChange: ((DesignTransaction) -> Void)?
    /// A remote transaction was applied, with the transaction (JSON) that reverts it against the state it applied
    /// to. Lets the editor turn a server AI run's transactions into one undo step (DOCUMENT_MODEL section 6:
    /// transactions with the same `actor.runId` group into one undo step). Added by the ios features agent.
    @ObservationIgnored public var onRemoteApplied: ((DesignTransaction, String) -> Void)?
    /// The server rejected a local change for good (it was rolled back).
    @ObservationIgnored public var onRejected: ((String, DesynError) -> Void)?
    /// The log has a gap (compaction): load the design again and call `reload(designJSON:seq:)`.
    @ObservationIgnored public var onReloadNeeded: (() -> Void)?
    /// Persist a checkpoint (debounced, after every change).
    @ObservationIgnored public var onCheckpoint: ((SyncCheckpoint) -> Void)?

    @ObservationIgnored private let applier: DocumentApplier
    @ObservationIgnored private let backend: SyncBackend
    @ObservationIgnored private var tail: Task<Void, Never>?
    @ObservationIgnored private var previewOpsJSON: String?
    @ObservationIgnored private var subscription: Task<Void, Never>?
    @ObservationIgnored private var sender: Task<Void, Never>?
    @ObservationIgnored private var awaitingEcho: Set<String> = []
    @ObservationIgnored private var inFlight: String?
    @ObservationIgnored private var retryDelay: Double = 1
    @ObservationIgnored private var online = true
    @ObservationIgnored private var checkpointTask: Task<Void, Never>?
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var pausedReason: String?
    /// Seconds between the last change and the checkpoint.
    @ObservationIgnored public var checkpointDelay: Double = 1.5

    public init(
        designId: String,
        share: ShareAccess?,
        canEdit: Bool,
        confirmedSeq: Int,
        pending: [PendingTransaction] = [],
        applier: DocumentApplier,
        backend: SyncBackend
    ) {
        self.designId = designId
        self.share = share
        self.canEdit = canEdit
        self.confirmedSeq = confirmedSeq
        self.pending = pending
        self.applier = applier
        self.backend = backend
        status = canEdit ? (pending.isEmpty ? .synced : .syncing) : .readOnly
    }

    // MARK: Lifecycle

    /// Starts listening for remote transactions and sending pending ones.
    public func start() {
        stopped = false
        subscribe()
        pump()
    }

    /// Stops all network activity (the design is closing). Pending transactions stay in the last checkpoint.
    public func stop() {
        stopped = true
        subscription?.cancel()
        subscription = nil
        sender?.cancel()
        sender = nil
        flushCheckpoint()
    }

    /// Connectivity changed (Convex websocket state).
    public func setOnline(_ isOnline: Bool) {
        guard isOnline != online else { return }
        online = isOnline
        if isOnline {
            retryDelay = 1
            updateStatus()
            pump()
        } else if canEdit {
            status = .offline
        }
    }

    /// Resumes sending after the user signed in again.
    public func resume() {
        retryDelay = 1
        pausedReason = nil
        updateStatus()
        subscribe()
        pump()
    }

    // MARK: Local edits

    /// Applies ops locally and queues them for the server. Returns nil when every op was dropped (nothing changed).
    @discardableResult
    public func commit(
        opsJSON: String,
        label: String,
        source: DesignTransaction.Source = .user,
        normalize: Bool = true
    ) async throws -> LocalCommit? {
        guard canEdit else {
            throw DesynError.server(code: "FORBIDDEN", message: "You can view this design but not edit it.")
        }
        return try await serial {
            try await self.revertPreview()
            return try await self.applyLocal(opsJSON: opsJSON, label: label, source: source, normalize: normalize)
        }
    }

    /// Shows ops as a live preview (dragging, typing) without committing; replaces the previous preview.
    public func setPreview(opsJSON: String) async throws {
        guard canEdit else { return }
        try await serial {
            try await self.showPreview(opsJSON)
        }
    }

    /// Removes the preview (gesture cancelled).
    public func clearPreview() async throws {
        try await serial {
            try await self.revertPreview()
        }
    }

    /// Replaces the preview by a real transaction with `opsJSON` (the gesture's final ops).
    @discardableResult
    public func commitPreview(opsJSON: String, label: String) async throws -> LocalCommit? {
        try await commit(opsJSON: opsJSON, label: label)
    }

    /// Recomputes derived geometry with the fonts the working copy has now (after font bytes arrived) and
    /// queues the result as one `system` transaction (not an undo step). Runs in order with every other change,
    /// so the inverse is exact and rebasing stays correct. Returns true when something moved.
    @discardableResult
    public func relayout(label: String = "Layout") async throws -> Bool {
        try await serial {
            guard let change = try await self.applier.relayout() else { return false }
            let ops = try Op.parseList(change.opsJSON)
            guard !ops.isEmpty, self.canEdit else { return !ops.isEmpty }
            let tx = DesignTransaction(label: label, ops: ops, source: .system)
            self.pending.append(PendingTransaction(id: tx.id, transactionJSON: tx.serialized(), inverseJSON: change.inverseJSON))
            self.updateStatus()
            self.scheduleCheckpoint()
            self.pump()
            return true
        }
    }

    // MARK: Reload

    /// Replaces the working copy with a freshly loaded design at `seq` and re-applies pending transactions
    /// (after `onReloadNeeded`).
    public func reload(designJSON: String, seq: Int) async throws {
        try await serial {
            self.previewOpsJSON = nil
            self.hasPreview = false
            try await self.applier.load(designJSON: designJSON)
            self.confirmedSeq = seq
            self.awaitingEcho.removeAll()
            try await self.reapplyPending(from: 0)
            self.scheduleCheckpoint()
        }
        subscribe()
        pump()
    }

    // MARK: Serial queue

    /// Runs `operation` after every previously queued one (FIFO on the main actor).
    private func serial<T: Sendable>(_ operation: @escaping @MainActor () async throws -> T) async throws -> T {
        let previous = tail
        let task = Task { @MainActor () async throws -> T in
            await previous?.value
            return try await operation()
        }
        tail = Task { @MainActor in _ = try? await task.value }
        return try await task.value
    }

    // MARK: Applying

    private func applyLocal(opsJSON: String, label: String, source: DesignTransaction.Source, normalize: Bool) async throws -> LocalCommit? {
        var tx = try DesignTransaction(label: label, ops: Op.parseList(opsJSON), source: source)
        let change = try await applier.apply(transactionJSON: tx.serialized(), normalize: normalize)
        let applied = try Op.parseList(change.opsJSON)
        guard !applied.isEmpty else { return nil }
        tx.ops = applied
        pending.append(PendingTransaction(id: tx.id, transactionJSON: tx.serialized(), inverseJSON: change.inverseJSON))
        updateStatus()
        scheduleCheckpoint()
        pump()
        let undoOps = try DesignTransaction(jsonString: change.inverseJSON).ops
        return LocalCommit(transactionID: tx.id, label: label, undoOpsJSON: Op.serialize(undoOps))
    }

    /// Takes the preview off the working copy (rebases run on the committed state alone).
    private func revertPreview() async throws {
        guard previewOpsJSON != nil else { return }
        previewOpsJSON = nil
        hasPreview = false
        await applier.cancelPreview()
    }

    private func showPreview(_ opsJSON: String) async throws {
        let tx = try DesignTransaction(id: DesynID.new(), label: "Preview", ops: Op.parseList(opsJSON)).serialized()
        try await applier.preview(transactionJSON: tx)
        previewOpsJSON = opsJSON
        hasPreview = true
    }

    /// Puts the preview back after a rebase (replayed in full on the new committed state).
    private func restorePreview(_ opsJSON: String?) async throws {
        guard let opsJSON else { return }
        try await showPreview(opsJSON)
    }

    /// Undoes pending transactions from the newest down to index `from` (the preview must be reverted first).
    private func rewindPending(to index: Int) async throws {
        var i = pending.count - 1
        while i >= index {
            _ = try await applier.apply(transactionJSON: pending[i].inverseJSON, normalize: false)
            i -= 1
        }
    }

    /// Applies pending transactions from `index` on, refreshing their ops and inverses. Transactions whose ops
    /// all drop now stay queued with empty ops (the server records them; nothing changes).
    private func reapplyPending(from index: Int) async throws {
        guard index < pending.count else { return }
        for i in index..<pending.count {
            var tx = try DesignTransaction(jsonString: pending[i].transactionJSON)
            let change = try await applier.apply(transactionJSON: tx.serialized(), normalize: true)
            // Keep the original ops for transactions already sent: the server applies what it received.
            if pending[i].id != inFlight && !awaitingEcho.contains(pending[i].id) {
                tx.ops = try Op.parseList(change.opsJSON)
            }
            pending[i].transactionJSON = tx.serialized()
            pending[i].inverseJSON = change.inverseJSON
        }
    }

    /// Integrates one accepted server transaction (`seq == confirmedSeq + 1`).
    private func integrate(seq: Int, transactionJSON: String) async throws {
        let remote = try DesignTransaction(jsonString: transactionJSON)
        let ownIndex = pending.firstIndex { $0.id == remote.id }
        let preview = previewOpsJSON

        if let ownIndex, ownIndex == 0, try sameOps(pending[0].transactionJSON, remote) {
            // Our oldest transaction, applied by the server exactly as we applied it: already in the working copy.
            pending.removeFirst()
        } else if pending.isEmpty && preview == nil {
            let change = try await applier.apply(transactionJSON: transactionJSON, normalize: false)
            onRemoteChange?(remote)
            onRemoteApplied?(remote, change.inverseJSON)
        } else {
            try await revertPreview()
            try await rewindPending(to: 0)
            var inverseJSON: String?
            if !remote.ops.isEmpty {
                inverseJSON = try await applier.apply(transactionJSON: remote.serialized(), normalize: false).inverseJSON
            }
            if let ownIndex {
                pending.remove(at: ownIndex)
            }
            try await reapplyPending(from: 0)
            try await restorePreview(preview)
            if ownIndex == nil {
                onRemoteChange?(remote)
                if let inverseJSON { onRemoteApplied?(remote, inverseJSON) }
            }
        }
        awaitingEcho.remove(remote.id)
        confirmedSeq = seq
        updateStatus()
        scheduleCheckpoint()
    }

    private func sameOps(_ localJSON: String, _ remote: DesignTransaction) throws -> Bool {
        try DesignTransaction(jsonString: localJSON).ops == remote.ops
    }

    // MARK: Remote transactions

    private func subscribe() {
        subscription?.cancel()
        let from = confirmedSeq
        subscription = Task { [weak self] in
            guard let self else { return }
            var failures = 0
            var since = from
            while !Task.isCancelled, !self.stopped {
                do {
                    var resubscribe = false
                    for try await result in self.backend.opsSince(designId: self.designId, seq: since, share: self.share) {
                        if Task.isCancelled { return }
                        failures = 0
                        resubscribe = try await self.receive(result, subscribedAt: since)
                        if resubscribe { break }
                    }
                    if Task.isCancelled { return }
                    if !resubscribe {
                        // The stream ended on its own (client reset): subscribe again, without spinning.
                        try? await Task.sleep(for: .seconds(1))
                    }
                    since = self.confirmedSeq
                } catch {
                    if Task.isCancelled { return }
                    let mapped = DesynError(error)
                    if mapped == .unauthenticated {
                        self.pause(mapped.message)
                        return
                    }
                    if case .server(code: "NOT_FOUND", _) = mapped {
                        self.pause("This design is no longer available.")
                        return
                    }
                    failures += 1
                    try? await Task.sleep(for: .seconds(min(30, pow(2, Double(min(failures, 5))))))
                    since = self.confirmedSeq
                }
            }
        }
    }

    /// Handles a `designOps.since` result; returns true when the subscription should move to the new seq.
    private func receive(_ result: OpsSince, subscribedAt since: Int) async throws -> Bool {
        if result.gap {
            onReloadNeeded?()
            return false
        }
        let entries = result.ops.sorted { $0.seq < $1.seq }
        try await serial {
            for entry in entries {
                let seq = Int(entry.seq)
                guard seq > self.confirmedSeq else { continue }
                guard seq == self.confirmedSeq + 1 else {
                    // A hole in the log we were given: reload rather than guess.
                    self.onReloadNeeded?()
                    return
                }
                try await self.integrate(seq: seq, transactionJSON: entry.tx)
            }
        }
        return result.hasMore || confirmedSeq - since >= 100
    }

    // MARK: Sending

    /// Starts the send loop when there is something to send.
    private func pump() {
        guard canEdit, !stopped, sender == nil, online else { return }
        guard pending.contains(where: { !awaitingEcho.contains($0.id) }) else { return }
        sender = Task { [weak self] in
            await self?.sendLoop()
            self?.sender = nil
            // Something may have been queued while the loop was finishing.
            if let self, self.pending.contains(where: { !self.awaitingEcho.contains($0.id) }), self.online, !self.stopped {
                self.pump()
            }
        }
    }

    private func sendLoop() async {
        while !Task.isCancelled, !stopped, online {
            guard let next = pending.first(where: { !awaitingEcho.contains($0.id) }) else { return }
            inFlight = next.id
            do {
                let result = try await backend.commit(
                    designId: designId,
                    baseSeq: confirmedSeq,
                    transactionJSON: next.transactionJSON,
                    share: share
                )
                inFlight = nil
                retryDelay = 1
                try await acknowledge(id: next.id, result: result)
            } catch {
                inFlight = nil
                let mapped = DesynError(error)
                if mapped == .unauthenticated {
                    pause(mapped.message)
                    return
                }
                if mapped.isTransient {
                    status = .offline
                    try? await Task.sleep(for: .seconds(retryDelay))
                    retryDelay = min(30, retryDelay * 2)
                    continue
                }
                await reject(id: next.id, error: mapped)
            }
        }
    }

    /// `designs.commit` answered: integrate right away when it is the next seq, else wait for the echo.
    private func acknowledge(id: String, result: CommitResult) async throws {
        let seq = Int(result.seq)
        try await serial {
            guard self.pending.contains(where: { $0.id == id }) else { return }
            if seq == self.confirmedSeq + 1, self.pending.first?.id == id {
                var tx = try DesignTransaction(jsonString: self.pending[0].transactionJSON)
                tx.ops = try Op.parseList(result.applied)
                try await self.integrate(seq: seq, transactionJSON: tx.serialized())
            } else if seq > self.confirmedSeq {
                self.awaitingEcho.insert(id)
            } else {
                // Duplicate of a transaction already confirmed (replay after a reconnect).
                self.pending.removeAll { $0.id == id }
            }
            self.updateStatus()
        }
    }

    /// Rolls back a transaction the server refused for good.
    private func reject(id: String, error: DesynError) async {
        do {
            try await serial {
                guard let index = self.pending.firstIndex(where: { $0.id == id }) else { return }
                let label = (try? DesignTransaction(jsonString: self.pending[index].transactionJSON).label) ?? "Change"
                let preview = self.previewOpsJSON
                try await self.revertPreview()
                try await self.rewindPending(to: index)
                self.pending.remove(at: index)
                try await self.reapplyPending(from: index)
                try await self.restorePreview(preview)
                self.updateStatus()
                self.scheduleCheckpoint()
                self.onRejected?(label, error)
            }
        } catch {
            pause(DesynError(error).message)
        }
    }

    private func pause(_ reason: String) {
        pausedReason = reason
        updateStatus()
    }

    private func updateStatus() {
        guard canEdit else {
            status = .readOnly
            return
        }
        if let pausedReason {
            status = .paused(pausedReason)
        } else if !online {
            status = .offline
        } else {
            status = pending.isEmpty ? .synced : .syncing
        }
    }

    // MARK: Checkpoints

    private func scheduleCheckpoint() {
        guard onCheckpoint != nil else { return }
        checkpointTask?.cancel()
        let delay = checkpointDelay
        checkpointTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.writeCheckpoint()
        }
    }

    private func flushCheckpoint() {
        guard checkpointTask != nil else { return }
        checkpointTask?.cancel()
        checkpointTask = nil
        Task { [weak self] in await self?.writeCheckpoint() }
    }

    private func writeCheckpoint() async {
        // The cached design must not contain a preview (it is not a transaction): wait for the gesture to end.
        if previewOpsJSON != nil {
            scheduleCheckpoint()
            return
        }
        let checkpoint: SyncCheckpoint? = try? await serial { @MainActor () async throws -> SyncCheckpoint? in
            guard self.previewOpsJSON == nil else { return nil }
            let json = try await self.applier.snapshotJSON()
            return SyncCheckpoint(confirmedSeq: self.confirmedSeq, designJSON: json, pending: self.pending)
        }
        if let checkpoint {
            onCheckpoint?(checkpoint)
        } else if previewOpsJSON != nil {
            scheduleCheckpoint()
        }
    }
}
