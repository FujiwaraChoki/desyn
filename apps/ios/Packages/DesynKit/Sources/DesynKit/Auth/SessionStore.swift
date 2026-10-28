import Foundation

/// The signed-in Better Auth session of this device.
public struct StoredSession: Codable, Hashable, Sendable {
    public struct User: Codable, Hashable, Sendable {
        public let id: String
        public let email: String
        public let name: String?
        public let emailVerified: Bool

        public init(id: String, email: String, name: String?, emailVerified: Bool) {
            self.id = id
            self.email = email
            self.name = name
            self.emailVerified = emailVerified
        }
    }

    /// Bearer token for Better Auth (`Authorization: Bearer <token>`).
    public let sessionToken: String
    public let user: User
    /// Session expiry (ms epoch), when the server reported it.
    public let expiresAt: Double?

    public init(sessionToken: String, user: User, expiresAt: Double?) {
        self.sessionToken = sessionToken
        self.user = user
        self.expiresAt = expiresAt
    }
}

/// Secure storage for the session (Keychain on device; tests provide their own).
public protocol SecureStore: Sendable {
    func load() throws -> StoredSession?
    func save(_ session: StoredSession) throws
    func clear() throws
}
