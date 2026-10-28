import DesynKit
import Foundation
import SharedKit

/// A Convex transport that answers from canned JSON per function name and records every call (name + encoded args).
final class RecordingTransport: ConvexTransport, @unchecked Sendable {
    struct Call: Equatable {
        let name: String
        let args: String
    }

    private let lock = NSLock()
    private var responses: [String: String]
    private(set) var calls: [Call] = []

    init(responses: [String: String]) {
        self.responses = responses
    }

    private func answer<T: Decodable>(_ name: String, _ args: ConvexArgs) throws -> T {
        let encoded = (try? args.convexEncode()) ?? "{}"
        lock.lock()
        calls.append(Call(name: name, args: encoded))
        let json = responses[name]
        lock.unlock()
        guard let json else { throw DesynError.server(code: "NOT_FOUND", message: "no canned answer for \(name)") }
        return try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func subscribe<T: Decodable & Sendable>(_ name: String, args: ConvexArgs, as type: T.Type) -> AsyncThrowingStream<T, Error> {
        AsyncThrowingStream { continuation in
            do {
                let value: T = try self.answer(name, args)
                continuation.yield(value)
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
    }

    func mutation<T: Decodable & Sendable>(_ name: String, args: ConvexArgs, as type: T.Type) async throws -> T {
        try answer(name, args)
    }

    func action<T: Decodable & Sendable>(_ name: String, args: ConvexArgs, as type: T.Type) async throws -> T {
        try answer(name, args)
    }

    /// The JSON arguments of the last call to `name`, parsed.
    func lastArgs(_ name: String) -> JSONValue? {
        lock.lock()
        defer { lock.unlock() }
        guard let call = calls.last(where: { $0.name == name }) else { return nil }
        return try? JSONValue.parse(call.args)
    }
}

enum Fixtures {
    static let pageId = "pageaaaaaaaa"

    static func page(width: Double = 1080, height: Double = 1080, background: String = "#ffffff", children: [String] = []) -> Node {
        var json = NodeFactory.page(id: pageId, name: "Page 1", width: width, height: height, background: background).json
        json["children"] = .strings(children)
        return Node(json: json)
    }

    static func rect(_ id: String, x: Double = 0, y: Double = 0, w: Double = 100, h: Double = 100, color: String = "#ff6a1f", parent: String = pageId) -> Node {
        NodeFactory.rect(id: id, parent: parent, frame: PageRect(x: x, y: y, width: w, height: h), color: color)
    }

    static func text(_ id: String, text: String = "Hello", size: Double = 24, color: String = "#111111", role: String? = nil) -> Node {
        NodeFactory.text(id: id, parent: pageId, text: text, origin: PagePoint(x: 10, y: 10), fontSize: size, color: color, role: role)
    }
}
