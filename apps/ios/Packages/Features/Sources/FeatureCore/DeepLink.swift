import DesynKit
import Foundation

/// Links the app handles (universal links on the web app's domain and the `desyn://` scheme).
public enum DeepLink: Equatable, Sendable {
    /// A magic sign-in link: `https://app.desyn.app/api/auth/magic-link/verify?token=...&callbackURL=desyn://auth/magic`.
    case magicLink(token: String)
    /// The browser already used a magic link and bounced to `desyn://auth/magic` (the session belongs to the
    /// browser; the app finishes with the browser sign-in).
    case magicLinkUsedInBrowser(error: String?)
    /// `https://app.desyn.app/design/<designId>`.
    case design(id: String)
    /// `https://app.desyn.app/share/<token>`.
    case share(token: String)

    /// Parses `url` against the web app's host; nil for links the app does not handle.
    public init?(url: URL, appURL: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let query = Dictionary((components.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })

        if components.scheme == AppEnvironment.callbackScheme {
            // desyn://auth/magic[?error=...]
            if components.host == "auth", components.path == "/magic" {
                self = .magicLinkUsedInBrowser(error: query["error"])
                return
            }
            return nil
        }

        guard components.scheme == "https", components.host == appURL.host else { return nil }
        let parts = components.path.split(separator: "/").map(String.init)
        if parts == ["api", "auth", "magic-link", "verify"], let token = query["token"], !token.isEmpty {
            self = .magicLink(token: token)
        } else if parts.count == 2, parts[0] == "design", !parts[1].isEmpty {
            self = .design(id: parts[1])
        } else if parts.count == 2, parts[0] == "share", !parts[1].isEmpty {
            self = .share(token: parts[1])
        } else {
            return nil
        }
    }
}
