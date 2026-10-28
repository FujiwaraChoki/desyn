import Foundation

/// Sends transactions that were made offline in designs that are not open any more, so they reach the server
/// even if the user never reopens them. Commits are idempotent on the transaction id, so a transaction that the
/// server already has is answered from its log.
///
/// The cached design keeps showing the edited state. When every flushed transaction got the next seq and was
/// applied exactly as sent, the cache is still "server state at `confirmedSeq` + remaining pending" and the
/// confirmed seq advances. Otherwise (the server refused a transaction for good, rewrote its ops, or other
/// commits came in between) the cache is marked `needsServerCopy`, so the next open replaces it with the server
/// copy instead of keeping a refused edit on screen forever.
///
/// An editor that opens the design while a commit is in flight owns the cache from then on: the flush stops for
/// that design and never overwrites the editor's checkpoints (the editor re-sends the transaction; the server
/// answers it from its log).
public enum PendingFlush {
    public struct Report: Equatable, Sendable {
        /// Transactions the server accepted.
        public var sent = 0
        /// Transactions the server refused for good (dropped from the queue).
        public var rejected = 0
        /// Stopped early because the connection failed (retry later).
        public var interrupted = false

        public init(sent: Int = 0, rejected: Int = 0, interrupted: Bool = false) {
            self.sent = sent
            self.rejected = rejected
            self.interrupted = interrupted
        }
    }

    /// Flushes every cached design with pending work except `open` (designs an editor currently syncs).
    @MainActor
    public static func run(store: OfflineStore, backend: SyncBackend, skipping open: Set<String> = []) async -> Report {
        await run(store: store, backend: backend, isOpen: { open.contains($0) })
    }

    /// Flushes every cached design with pending work; `isOpen` is asked again after every network call, so a
    /// design opened in an editor meanwhile is left alone.
    @MainActor
    public static func run(store: OfflineStore, backend: SyncBackend, isOpen: @MainActor (String) -> Bool) async -> Report {
        var report = Report()
        for designId in store.designsWithPendingChanges() {
            while !isOpen(designId), let cached = store.loadDesign(designId), let next = cached.pending.first {
                do {
                    let result = try await backend.commit(
                        designId: designId,
                        baseSeq: cached.confirmedSeq,
                        transactionJSON: next.transactionJSON,
                        share: cached.share
                    )
                    report.sent += 1
                    guard !isOpen(designId), var latest = store.loadDesign(designId) else { break }
                    latest.pending.removeAll { $0.id == next.id }
                    let seq = Int(result.seq)
                    if seq <= latest.confirmedSeq {
                        // Already part of the confirmed state (a replay of an earlier, interrupted flush).
                    } else if seq == latest.confirmedSeq + 1, !latest.needsServerCopy, sameOps(next.transactionJSON, applied: result.applied) {
                        latest.confirmedSeq = seq
                    } else {
                        latest.needsServerCopy = true
                    }
                    try? store.saveDesign(latest)
                } catch {
                    let mapped = DesynError(error)
                    if mapped.isTransient || mapped == .unauthenticated {
                        report.interrupted = true
                        return report
                    }
                    report.rejected += 1
                    guard !isOpen(designId), var latest = store.loadDesign(designId) else { break }
                    latest.pending.removeAll { $0.id == next.id }
                    // The refused edit is still in the cached design: the next open takes the server copy.
                    latest.needsServerCopy = true
                    try? store.saveDesign(latest)
                }
            }
        }
        return report
    }

    /// Whether the server applied the transaction's ops unchanged.
    static func sameOps(_ transactionJSON: String, applied: String) -> Bool {
        guard let sent = try? DesignTransaction(jsonString: transactionJSON).ops,
              let server = try? Op.parseList(applied)
        else { return false }
        return sent == server
    }
}
