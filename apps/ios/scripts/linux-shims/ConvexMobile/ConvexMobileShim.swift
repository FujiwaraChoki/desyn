// Linux-only stand-in for the slice of convex-swift 0.8.1's API that DesynKit's platform-neutral files use
// (scripts/linux-check.sh). Never shipped: the app links the real ConvexMobile package.
import Foundation

public protocol ConvexEncodable {
    func convexEncode() throws -> String
}

extension String: ConvexEncodable {
    public func convexEncode() throws -> String { String(decoding: try JSONEncoder().encode(self), as: UTF8.self) }
}

extension Double: ConvexEncodable {
    public func convexEncode() throws -> String { String(decoding: try JSONEncoder().encode(self), as: UTF8.self) }
}

extension Bool: ConvexEncodable {
    public func convexEncode() throws -> String { self ? "true" : "false" }
}

extension [String: ConvexEncodable?]: ConvexEncodable {
    public func convexEncode() throws -> String {
        let pairs = try keys.sorted().map { key in "\"\(key)\":\(try self[key]??.convexEncode() ?? "null")" }
        return "{\(pairs.joined(separator: ","))}"
    }
}

extension [ConvexEncodable?]: ConvexEncodable {
    public func convexEncode() throws -> String {
        "[\(try map { try $0?.convexEncode() ?? "null" }.joined(separator: ","))]"
    }
}

public enum ClientError: Error {
    case InternalError(msg: String)
    case ConvexError(data: String)
    case ServerError(msg: String)
}

public protocol AuthProvider<T> {
    associatedtype T
    func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> T
    func logout() async throws
    func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> T
    func extractIdToken(from authResult: T) -> String
}
