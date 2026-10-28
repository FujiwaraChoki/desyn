import Foundation

/// Arguments of a Convex function (convex-swift encodes them; omit a key to leave an optional argument unset,
/// never pass `nil` for it: Convex `v.optional` rejects `null`).
public typealias ConvexArgs = [String: ConvexEncodable?]

/// What the app needs from a Convex client. `ConvexTransportClient` implements it with convex-swift; tests use
/// in-process implementations.
public protocol ConvexTransport: AnyObject, Sendable {
    /// A live query: yields the current value and every change until the stream is cancelled.
    func subscribe<T: Decodable & Sendable>(_ name: String, args: ConvexArgs, as type: T.Type) -> AsyncThrowingStream<T, Error>
    func mutation<T: Decodable & Sendable>(_ name: String, args: ConvexArgs, as type: T.Type) async throws -> T
    func action<T: Decodable & Sendable>(_ name: String, args: ConvexArgs, as type: T.Type) async throws -> T
}

public extension ConvexTransport {
    /// One-shot query: the first value of a subscription.
    func query<T: Decodable & Sendable>(_ name: String, args: ConvexArgs, as type: T.Type, timeout: Duration = .seconds(30)) async throws -> T {
        try await withTimeout(timeout) {
            for try await value in self.subscribe(name, args: args, as: T.self) {
                return value
            }
            throw DesynError.offline("The query ended without a result.")
        }
    }
}

/// Runs `operation`, failing with `DesynError.offline` after `timeout`.
public func withTimeout<T: Sendable>(_ timeout: Duration, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(for: timeout)
            throw DesynError.offline("The request timed out.")
        }
        defer { group.cancelAll() }
        guard let result = try await group.next() else {
            throw DesynError.offline("The request was cancelled.")
        }
        return result
    }
}
