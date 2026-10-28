import Combine
import Foundation

/// convex-swift implementation with the Desyn auth provider.
public final class ConvexTransportClient: ConvexTransport, @unchecked Sendable {
    public let client: ConvexClientWithAuth<ConvexAuth>
    /// Mutations and actions fail with `.offline` after this long (the Rust client waits for a connection
    /// otherwise); commits are idempotent on the transaction id, so retrying is safe.
    public var callTimeout: Duration = .seconds(25)

    public init(deploymentURL: URL, authProvider: DesynAuthProvider) {
        client = ConvexClientWithAuth(deploymentUrl: deploymentURL.absoluteString, authProvider: authProvider)
    }

    public func subscribe<T: Decodable & Sendable>(_ name: String, args: ConvexArgs, as type: T.Type) -> AsyncThrowingStream<T, Error> {
        let publisher = client.subscribe(to: name, with: args, yielding: T.self)
        return AsyncThrowingStream { continuation in
            let cancellable = publisher.sink(
                receiveCompletion: { completion in
                    if case let .failure(error) = completion {
                        continuation.finish(throwing: DesynError(error))
                    } else {
                        continuation.finish()
                    }
                },
                receiveValue: { value in
                    continuation.yield(value)
                }
            )
            let box = CancellableBox(cancellable)
            continuation.onTermination = { _ in box.cancel() }
        }
    }

    public func mutation<T: Decodable & Sendable>(_ name: String, args: ConvexArgs, as type: T.Type) async throws -> T {
        let client = self.client
        let call = UncheckedArgs(args)
        do {
            return try await withTimeout(callTimeout) {
                let value: T = try await client.mutation(name, with: call.args)
                return value
            }
        } catch {
            throw DesynError(error)
        }
    }

    public func action<T: Decodable & Sendable>(_ name: String, args: ConvexArgs, as type: T.Type) async throws -> T {
        let client = self.client
        let call = UncheckedArgs(args)
        do {
            return try await withTimeout(.seconds(120)) {
                let value: T = try await client.action(name, with: call.args)
                return value
            }
        } catch {
            throw DesynError(error)
        }
    }

    /// Connection state of the Convex websocket.
    public func connectionStates() -> AsyncStream<Bool> {
        let publisher = client.watchWebSocketState()
        return AsyncStream { continuation in
            let cancellable = publisher.sink { state in
                switch state {
                case .connected: continuation.yield(true)
                case .connecting: continuation.yield(false)
                }
            }
            let box = CancellableBox(cancellable)
            continuation.onTermination = { _ in box.cancel() }
        }
    }
}

/// Sendable holder so `onTermination` can cancel a Combine subscription.
private final class CancellableBox: @unchecked Sendable {
    private let lock = NSLock()
    private var cancellable: AnyCancellable?

    init(_ cancellable: AnyCancellable) {
        self.cancellable = cancellable
    }

    func cancel() {
        lock.lock()
        let current = cancellable
        cancellable = nil
        lock.unlock()
        current?.cancel()
    }
}

/// Function arguments are value types built by the caller and never mutated afterwards.
private struct UncheckedArgs: @unchecked Sendable {
    let args: ConvexArgs
    init(_ args: ConvexArgs) { self.args = args }
}
