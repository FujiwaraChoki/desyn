import CryptoKit
import Foundation

/// RFC 7636 PKCE pair for the native sign-in (convex/accounts/nativeAuth.ts).
public struct PKCE: Sendable, Equatable {
    /// 64 characters from the unreserved set (43...128 allowed).
    public let verifier: String
    /// `base64url(sha256(verifier))` without padding (43 characters).
    public let challenge: String
    /// Opaque CSRF state echoed back on the redirect.
    public let state: String

    public init() {
        self.init(verifier: PKCE.randomString(length: 64), state: PKCE.randomString(length: 32))
    }

    public init(verifier: String, state: String) {
        self.verifier = verifier
        self.state = state
        challenge = PKCE.challenge(for: verifier)
    }

    public static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    public static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Random string of unreserved characters (`[A-Za-z0-9-._~]`) from the system CSPRNG.
    static func randomString(length: Int) -> String {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        var rng = SystemRandomNumberGenerator()
        return String((0..<length).map { _ in alphabet[Int(rng.next(upperBound: UInt64(alphabet.count)))] })
    }
}

/// Lowercase hex SHA-256 (asset dedupe hashes for uploads).
public func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
