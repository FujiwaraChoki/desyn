import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// HTTP client for Better Auth on the Convex site URL plus the native PKCE token exchange
/// (convex/accounts/nativeAuth.ts). The app never uses cookies: every call carries the session as a bearer
/// token, and the URL session neither stores nor sends cookies (a cookie would turn on Better Auth's browser
/// origin checks).
public final class AuthClient: Sendable {
    public let environment: AppEnvironment
    private let session: URLSession

    public init(environment: AppEnvironment, session: URLSession? = nil) {
        self.environment = environment
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieAcceptPolicy = .never
            configuration.httpShouldSetCookies = false
            configuration.httpCookieStorage = nil
            configuration.timeoutIntervalForRequest = 30
            self.session = URLSession(configuration: configuration)
        }
    }

    // MARK: Sign in / up

    /// Email + password sign-in. Throws `.server(code: "EMAIL_NOT_VERIFIED", ...)` until the address is verified.
    public func signIn(email: String, password: String) async throws -> StoredSession {
        let response: SignInResponse = try await post("api/auth/sign-in/email", body: [
            "email": .string(email), "password": .string(password), "rememberMe": true,
        ])
        guard let token = response.token else {
            throw DesynError.server(code: "EMAIL_NOT_VERIFIED", message: "Verify your email address, then sign in.")
        }
        return StoredSession(sessionToken: token, user: response.user.stored, expiresAt: nil)
    }

    /// Creates an account. Verification is required before the first sign-in; the email links back to the web
    /// app, which signs the browser in (the app then signs in with the password).
    public func signUp(name: String, email: String, password: String) async throws -> SignUpOutcome {
        let response: SignInResponse = try await post("api/auth/sign-up/email", body: [
            "name": .string(name), "email": .string(email), "password": .string(password),
            "callbackURL": .string(environment.appURL.absoluteString),
        ])
        if let token = response.token {
            return .signedIn(StoredSession(sessionToken: token, user: response.user.stored, expiresAt: nil))
        }
        return .verificationRequired(email: response.user.email)
    }

    /// Sends the verification email again.
    public func resendVerification(email: String) async throws {
        let _: JSONValue = try await post("api/auth/send-verification-email", body: [
            "email": .string(email), "callbackURL": .string(environment.appURL.absoluteString),
        ])
    }

    /// Emails a magic link. Its callback (`desyn://auth/magic`) marks it as an app link (universal link).
    public func sendMagicLink(email: String) async throws {
        let _: JSONValue = try await post("api/auth/sign-in/magic-link", body: [
            "email": .string(email), "callbackURL": .string(AppEnvironment.magicLinkCallback),
        ])
    }

    /// Verifies a magic-link token (from the universal link) and returns the new session. Without a callback URL
    /// Better Auth answers with JSON instead of redirecting.
    public func verifyMagicLink(token: String) async throws -> StoredSession {
        var components = URLComponents(url: endpoint("api/auth/magic-link/verify"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        // Errors answer with a redirect to `...?error=<CODE>`; read it instead of following it to a web page.
        let response: MagicVerifyResponse = try await send(request, followRedirects: false)
        return StoredSession(
            sessionToken: response.token,
            user: response.user.stored,
            expiresAt: response.session?.expiresAt.flatMap(Self.parseDate)
        )
    }

    /// Emails a password reset link that opens the web app's reset page.
    public func requestPasswordReset(email: String) async throws {
        let _: JSONValue = try await post("api/auth/request-password-reset", body: [
            "email": .string(email), "redirectTo": .string(environment.appURL.appendingPathComponent("reset").absoluteString),
        ])
    }

    /// Step 3 of the native flow: exchanges the authorization code for a session.
    public func exchangeNativeCode(code: String, verifier: String, deviceName: String) async throws -> StoredSession {
        let response: NativeTokenResponse = try await post("auth/native/token", body: [
            "code": .string(code), "codeVerifier": .string(verifier),
            "redirectUri": .string(AppEnvironment.nativeRedirectURI), "deviceName": .string(deviceName),
        ])
        return StoredSession(sessionToken: response.sessionToken, user: response.user.stored, expiresAt: response.expiresAt)
    }

    // MARK: Session

    /// A Convex JWT (15 minutes) for the session. Throws `.unauthenticated` once the session is revoked.
    public func convexToken(sessionToken: String) async throws -> String {
        var request = URLRequest(url: endpoint("api/auth/convex/token"))
        request.httpMethod = "GET"
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        let response: TokenResponse = try await send(request)
        return response.token
    }

    /// Whether the session is still valid (nil = revoked or expired).
    public func currentUser(sessionToken: String) async throws -> StoredSession.User? {
        var request = URLRequest(url: endpoint("api/auth/get-session"))
        request.httpMethod = "GET"
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        let response: SessionResponse? = try await send(request)
        return response?.user.stored
    }

    /// Signs the session out on the server (best effort; local state is cleared by the caller).
    public func signOut(sessionToken: String) async throws {
        var request = URLRequest(url: endpoint("api/auth/sign-out"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        let _: JSONValue = try await send(request)
    }

    /// Deletes the account and all its sessions (Better Auth `delete-user`; the server's delete hooks remove the
    /// account's data). Without `password` the session must be fresh (signed in within the last day); accounts
    /// without a password sign in again instead. Added by the ios features agent (in-app account deletion, App
    /// Store guideline 5.1.1(v)).
    public func deleteAccount(sessionToken: String, password: String?) async throws {
        var request = URLRequest(url: endpoint("api/auth/delete-user"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: JSONValue] = [:]
        if let password, !password.isEmpty { body["password"] = .string(password) }
        request.httpBody = Data(JSONValue.object(body).serialized().utf8)
        let _: JSONValue = try await send(request)
    }

    // MARK: HTTP

    func endpoint(_ path: String) -> URL {
        environment.convexSiteURL.appendingPathComponent(path)
    }

    private func post<T: Decodable>(_ path: String, body: [String: JSONValue]) async throws -> T {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(JSONValue.object(body).serialized().utf8)
        return try await send(request)
    }

    private func send<T: Decodable>(_ request: URLRequest, followRedirects: Bool = true) async throws -> T {
        var request = request
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request, delegate: followRedirects ? nil : NoRedirects())
        } catch {
            throw DesynError(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw DesynError.unexpected("No HTTP response.")
        }
        if (300..<400).contains(http.statusCode) {
            let location = http.value(forHTTPHeaderField: "Location").flatMap { URLComponents(string: $0) }
            let code = location?.queryItems?.first { $0.name == "error" }?.value ?? "INVALID_TOKEN"
            let body = Data(JSONValue.object(["code": .string(code)]).serialized().utf8)
            throw Self.error(status: 400, data: body, headers: http)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.error(status: http.statusCode, data: data, headers: http)
        }
        if T.self == JSONValue.self, data.isEmpty {
            return JSONValue.null as! T
        }
        do {
            return try JSONDecoder().decode(T.self, from: data.isEmpty ? Data("null".utf8) : data)
        } catch {
            throw DesynError.unexpected("The sign-in service sent an unexpected response.")
        }
    }

    /// Maps Better Auth / native token errors (`{ code, message }` or `{ error }`).
    static func error(status: Int, data: Data, headers: HTTPURLResponse) -> DesynError {
        let body = try? JSONValue.parse(data)
        let code = body?["code"]?.stringValue ?? body?["error"]?.stringValue
        let message = body?["message"]?.stringValue
        if status == 429 || code == "slow_down" {
            let retry = headers.value(forHTTPHeaderField: "X-Retry-After").flatMap(Double.init)
                ?? headers.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
            return .rateLimited(retryAfter: retry)
        }
        switch code {
        case "EMAIL_NOT_VERIFIED":
            return .server(code: "EMAIL_NOT_VERIFIED", message: "Verify your email address first. We sent you a link.")
        case "INVALID_EMAIL_OR_PASSWORD":
            return .server(code: "INVALID_CREDENTIALS", message: "That email and password don't match. Try again or use a magic link.")
        case "USER_ALREADY_EXISTS", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
            return .server(code: "USER_EXISTS", message: "An account with this email already exists. Sign in instead.")
        case "PASSWORD_TOO_SHORT":
            return .server(code: "PASSWORD_TOO_SHORT", message: "Use at least 8 characters for your password.")
        case "INVALID_PASSWORD":
            return .server(code: "INVALID_PASSWORD", message: "That password isn't right. Try again.")
        case "SESSION_EXPIRED":
            return .server(code: "SESSION_EXPIRED", message: "For your security, enter your password, or sign out and sign in again first.")
        case "CREDENTIAL_ACCOUNT_NOT_FOUND":
            return .server(code: "NO_PASSWORD", message: "This account has no password. Sign out, sign in again, then delete it right away.")
        case "INVALID_TOKEN", "EXPIRED_TOKEN", "invalid_grant":
            return .server(code: "INVALID_LINK", message: "This sign-in link expired or was already used. Request a new one.")
        default:
            break
        }
        if status == 401 { return .unauthenticated }
        if status == 403, let message { return .server(code: code ?? "FORBIDDEN", message: message) }
        if let message, !message.isEmpty { return .server(code: code ?? "HTTP_\(status)", message: message) }
        return status >= 500
            ? .server(code: "SERVER", message: "The sign-in service is unavailable. Try again in a moment.")
            : .server(code: "HTTP_\(status)", message: "The request was rejected (\(status)).")
    }

    static func parseDate(_ value: String) -> Double? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date.timeIntervalSince1970 * 1000 }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value).map { $0.timeIntervalSince1970 * 1000 }
    }
}

/// Stops URLSession from following redirects (the 3xx response is returned to the caller).
private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}

public enum SignUpOutcome: Sendable, Equatable {
    case signedIn(StoredSession)
    case verificationRequired(email: String)
}

// MARK: Wire shapes

struct AuthUser: Decodable {
    let id: String
    let email: String
    let name: String?
    let emailVerified: Bool?

    var stored: StoredSession.User {
        StoredSession.User(id: id, email: email, name: name, emailVerified: emailVerified ?? false)
    }
}

private struct SignInResponse: Decodable {
    let token: String?
    let user: AuthUser
}

private struct MagicVerifyResponse: Decodable {
    struct Session: Decodable {
        let expiresAt: String?
    }

    let token: String
    let user: AuthUser
    let session: Session?
}

private struct NativeTokenResponse: Decodable {
    let sessionToken: String
    let expiresAt: Double?
    let user: AuthUser
}

private struct TokenResponse: Decodable {
    let token: String
}

private struct SessionResponse: Decodable {
    let user: AuthUser
}
