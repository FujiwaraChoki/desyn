import Foundation

/// What convex-swift's `ConvexClientWithAuth` holds while signed in.
public struct ConvexAuth: Sendable, Equatable {
    public let session: StoredSession
    /// Convex JWT from `/api/auth/convex/token` (15 minutes).
    public let jwt: String
}

/// `AuthProvider` for convex-swift backed by the Better Auth session in the keychain: every login fetches a fresh
/// Convex JWT with the bearer session token, and a timer pushes a new JWT a minute before the current one
/// expires. When the server rejects the session the provider pushes `nil` (signs the client out) and calls
/// `onSessionEnded`.
public final class DesynAuthProvider: AuthProvider, @unchecked Sendable {
    public typealias T = ConvexAuth

    private let auth: AuthClient
    private let store: SecureStore
    private let lock = NSLock()
    private var refreshTask: Task<Void, Never>?
    /// Called (on an arbitrary thread) when the session is no longer valid.
    public var onSessionEnded: (@Sendable () -> Void)?

    public init(auth: AuthClient, store: SecureStore) {
        self.auth = auth
        self.store = store
    }

    public func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> ConvexAuth {
        try await loginFromCache(onIdToken: onIdToken)
    }

    public func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> ConvexAuth {
        guard let session = try store.load() else {
            throw DesynError.unauthenticated
        }
        let jwt: String
        do {
            jwt = try await auth.convexToken(sessionToken: session.sessionToken)
        } catch let error as DesynError where error == .unauthenticated {
            endSession(onIdToken: onIdToken)
            throw error
        }
        scheduleRefresh(jwt: jwt, sessionToken: session.sessionToken, onIdToken: onIdToken)
        return ConvexAuth(session: session, jwt: jwt)
    }

    public func logout() async throws {
        cancelRefresh()
    }

    public func extractIdToken(from authResult: ConvexAuth) -> String {
        authResult.jwt
    }

    // MARK: Refresh

    private func scheduleRefresh(jwt: String, sessionToken: String, onIdToken: @Sendable @escaping (String?) -> Void) {
        let delay = Self.refreshDelay(jwt: jwt, now: Date())
        let task = Task { [weak self] in
            var token = jwt
            var wait = delay
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(wait))
                guard !Task.isCancelled, let self else { return }
                do {
                    token = try await self.auth.convexToken(sessionToken: sessionToken)
                    onIdToken(token)
                    wait = Self.refreshDelay(jwt: token, now: Date())
                } catch let error as DesynError where error == .unauthenticated {
                    self.endSession(onIdToken: onIdToken)
                    return
                } catch {
                    // Offline: try again soon; the current token keeps working until it expires.
                    wait = 20
                }
            }
        }
        lock.lock()
        refreshTask?.cancel()
        refreshTask = task
        lock.unlock()
    }

    private func cancelRefresh() {
        lock.lock()
        refreshTask?.cancel()
        refreshTask = nil
        lock.unlock()
    }

    private func endSession(onIdToken: @Sendable @escaping (String?) -> Void) {
        cancelRefresh()
        onIdToken(nil)
        onSessionEnded?()
    }

    /// Seconds until a minute before `exp` (at least 15 s; 10 minutes when the token has no readable `exp`).
    public static func refreshDelay(jwt: String, now: Date) -> Double {
        guard let exp = expiry(of: jwt) else { return 600 }
        return max(15, exp.timeIntervalSince(now) - 60)
    }

    /// The `exp` claim of a JWT (no signature check: the server verifies tokens, the client only schedules).
    public static func expiry(of jwt: String) -> Date? {
        let parts = jwt.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload += "=" }
        guard let data = Data(base64Encoded: payload), let claims = try? JSONValue.parse(data),
              let exp = claims["exp"]?.doubleValue
        else { return nil }
        return Date(timeIntervalSince1970: exp)
    }
}
