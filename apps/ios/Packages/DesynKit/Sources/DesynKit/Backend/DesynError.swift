@_exported import ConvexMobile
import Foundation

/// Errors surfaced to the UI. `message` is always a sentence that says what to do next.
public enum DesynError: Error, Equatable, LocalizedError, Sendable {
    /// A `ConvexError` / Better Auth error with a machine code (`NOT_FOUND`, `LIMIT_REACHED`, `EMAIL_NOT_VERIFIED`, ...).
    case server(code: String, message: String)
    /// No connection or a timeout; the operation can be retried.
    case offline(String)
    /// The session is gone (signed out elsewhere, revoked, expired).
    case unauthenticated
    /// Rate limited; retry after the given seconds.
    case rateLimited(retryAfter: Double?)
    /// Anything else (bugs, unexpected payloads).
    case unexpected(String)

    public var errorDescription: String? { message }

    public var message: String {
        switch self {
        case let .server(_, message): message
        case .offline: "You're offline. Changes are kept on this device and sync when you're back."
        case .unauthenticated: "Your session ended. Sign in again to continue."
        case let .rateLimited(retryAfter):
            if let retryAfter, retryAfter > 0 {
                "Too many attempts. Try again in \(Int(retryAfter.rounded(.up))) seconds."
            } else {
                "Too many attempts. Wait a moment and try again."
            }
        case let .unexpected(detail): "Something went wrong. \(detail)"
        }
    }

    /// Machine code for server errors.
    public var code: String? {
        if case let .server(code, _) = self { return code }
        return nil
    }

    /// Worth retrying automatically (sync queue).
    public var isTransient: Bool {
        switch self {
        case .offline, .rateLimited: true
        case let .server(code, _): code == "INTERNAL" || code == "SERVER"
        case .unauthenticated, .unexpected: false
        }
    }

    /// Maps any error from the Convex client, URLSession or decoding.
    public init(_ error: Error) {
        if let error = error as? DesynError {
            self = error
            return
        }
        if let client = error as? ClientError {
            switch client {
            case let .ConvexError(data):
                self = DesynError.fromConvexData(data)
            case let .ServerError(msg):
                if msg.localizedCaseInsensitiveContains("unauthenticated") || msg.localizedCaseInsensitiveContains("not authenticated") {
                    self = .unauthenticated
                } else {
                    self = .server(code: "SERVER", message: DesynError.cleanServerMessage(msg))
                }
            case let .InternalError(msg):
                self = .offline(msg)
            }
            return
        }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            self = .offline(nsError.localizedDescription)
            return
        }
        if error is DecodingError {
            self = .unexpected("The server sent a response this version can't read. Update the app if this keeps happening.")
            return
        }
        self = .unexpected(error.localizedDescription)
    }

    /// `ConvexError` data: `{ code, message, ... }` (convex/lib/errors.ts).
    static func fromConvexData(_ data: String) -> DesynError {
        guard let value = try? JSONValue.parse(data) else {
            return .server(code: "SERVER", message: data)
        }
        if let message = value.stringValue {
            return .server(code: "SERVER", message: message)
        }
        let code = value["code"]?.stringValue ?? "SERVER"
        let message = value["message"]?.stringValue ?? "The request failed."
        switch code {
        case "UNAUTHENTICATED": return .unauthenticated
        case "RATE_LIMITED": return .rateLimited(retryAfter: value["retryAfterMs"]?.doubleValue.map { $0 / 1000 })
        default: return .server(code: code, message: message)
        }
    }

    /// Convex server errors read "[Request ID: ...] Server Error ... Uncaught Error: <message>"; keep the message.
    static func cleanServerMessage(_ raw: String) -> String {
        if let range = raw.range(of: "Uncaught Error: ") {
            let rest = raw[range.upperBound...]
            return String(rest.split(separator: "\n").first ?? rest)
        }
        return "The server could not complete the request. Try again."
    }
}
