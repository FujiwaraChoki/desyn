import Foundation

/// Backend endpoints of this build. Read from Info.plist keys `DesynConvexURL`, `DesynConvexSiteURL` and
/// `DesynAppURL`, which the Xcode build fills from `Config/*.xcconfig` (generated from deploy/env/public.env;
/// a git-ignored `Config/Local.xcconfig` may point a debug build at a local Convex deployment).
public struct AppEnvironment: Sendable, Equatable {
    /// Convex deployment (`https://<name>.convex.cloud`): queries, mutations, websocket.
    public let convexURL: URL
    /// Convex HTTP actions (`https://<name>.convex.site`): Better Auth and the native token exchange.
    public let convexSiteURL: URL
    /// The web app (`https://app.desyn.app`): native sign-in page, magic links, password reset.
    public let appURL: URL

    public init(convexURL: URL, convexSiteURL: URL, appURL: URL) {
        self.convexURL = convexURL
        self.convexSiteURL = convexSiteURL
        self.appURL = appURL
    }

    /// Hosted production (deploy/env/public.env), used when Info.plist has no override.
    public static let production = AppEnvironment(
        convexURL: URL(string: "https://opulent-alpaca-530.eu-west-1.convex.cloud")!,
        convexSiteURL: URL(string: "https://opulent-alpaca-530.eu-west-1.convex.site")!,
        appURL: URL(string: "https://app.desyn.app")!
    )

    /// The endpoints in `bundle`'s Info.plist, falling back to production for missing or empty keys.
    public static func from(bundle: Bundle) -> AppEnvironment {
        func url(_ key: String, fallback: URL) -> URL {
            guard let raw = bundle.object(forInfoDictionaryKey: key) as? String,
                  !raw.isEmpty, !raw.contains("$("),
                  let url = URL(string: raw), url.scheme != nil
            else { return fallback }
            return url
        }
        return AppEnvironment(
            convexURL: url("DesynConvexURL", fallback: production.convexURL),
            convexSiteURL: url("DesynConvexSiteURL", fallback: production.convexSiteURL),
            appURL: url("DesynAppURL", fallback: production.appURL)
        )
    }

    /// Native sign-in redirect (`desyn://auth/callback`, allowed by `convex/accounts/nativeAuth.ts`).
    public static let nativeRedirectURI = "desyn://auth/callback"
    /// Magic-link callback: a trusted origin for Better Auth; the universal link carries it so the app claims only
    /// the links it requested.
    public static let magicLinkCallback = "desyn://auth/magic"
    public static let callbackScheme = "desyn"

    /// `${APP_URL}/native/authorize?...` for the PKCE flow.
    public func nativeAuthorizeURL(pkce: PKCE) -> URL {
        var components = URLComponents(url: appURL.appendingPathComponent("native/authorize"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "client", value: "ios"),
            URLQueryItem(name: "redirect_uri", value: Self.nativeRedirectURI),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: pkce.state),
        ]
        return components.url!
    }
}
