import DesynEngine
import DesynKit
import Foundation

/// The Rust engine as the sync client's working copy (`DocumentApplier`). Previews use the engine's own preview
/// layer, so `transformOps` (computed against the committed state) never compounds a previous gesture step and
/// remote transactions slide in under a running gesture. Public so the engine-backed tests can drive it.
@MainActor
public final class EngineDocument: DocumentApplier {
    public let engine: DesynEngine
    /// Called after every change to the working copy (render, refresh pages and selection).
    public var onChange: (() -> Void)?

    public init(engine: DesynEngine) {
        self.engine = engine
    }

    public func apply(transactionJSON: String, normalize: Bool) async throws -> AppliedChange {
        let outcome = try await engine.apply(transactionJSON: transactionJSON, normalize: normalize)
        onChange?()
        return AppliedChange(opsJSON: outcome.appliedJson, inverseJSON: outcome.inverseJson)
    }

    public func preview(transactionJSON: String) async throws {
        try await engine.preview(transactionJSON: transactionJSON, normalize: true)
        onChange?()
    }

    public func cancelPreview() async {
        if await engine.cancelPreview() {
            onChange?()
        }
    }

    public func relayout() async throws -> AppliedChange? {
        let outcome = try await engine.relayout()
        let ops = try Op.parseList(outcome.opsJson)
        guard !ops.isEmpty else { return nil }
        let inverse = DesignTransaction(label: "Undo layout", ops: try Op.parseList(outcome.inverseOpsJson), source: .system)
        onChange?()
        return AppliedChange(opsJSON: outcome.opsJson, inverseJSON: inverse.serialized())
    }

    public func load(designJSON: String) async throws {
        _ = try await engine.load(designJSON: designJSON, normalize: false)
        onChange?()
    }

    public func snapshotJSON() async throws -> String {
        try await engine.snapshot(canonical: false)
    }
}
