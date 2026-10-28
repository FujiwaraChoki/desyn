import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Icon search through the public Iconify API (no key), the same sets the web editor and the AI use: Lucide,
/// Tabler and Phosphor (`packages/ai/src/search/icons.ts`).
public struct IconifyClient: Sendable {
    public static let defaultSets = ["lucide", "tabler", "ph"]

    public struct Icon: Hashable, Sendable, Identifiable {
        /// `prefix:name`, e.g. `lucide:sun`.
        public let id: String
        public let collection: String
        public let name: String

        public init?(id: String) {
            let parts = id.split(separator: ":", maxSplits: 1).map(String.init)
            guard parts.count == 2, IconifyClient.isSlug(parts[0]), IconifyClient.isSlug(parts[1]) else { return nil }
            self.id = id
            collection = parts[0]
            self.name = parts[1]
        }

        /// "arrow right".
        public var title: String { name.replacingOccurrences(of: "-", with: " ") }
    }

    public let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL = URL(string: "https://api.iconify.design")!, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    static func isSlug(_ value: String) -> Bool {
        !value.isEmpty && value.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }

    /// `GET /search?query=&limit=&prefixes=`.
    public func searchURL(_ query: String, sets: [String] = defaultSets, limit: Int = 96) -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent("search"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "query", value: query),
            URLQueryItem(name: "limit", value: String(max(32, min(999, limit)))),
            URLQueryItem(name: "prefixes", value: sets.joined(separator: ",")),
        ]
        return components.url!
    }

    /// `GET /<set>/<name>.svg[?color=]`.
    public func svgURL(_ icon: Icon, color: String? = nil) -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent(icon.collection).appendingPathComponent("\(icon.name).svg"), resolvingAgainstBaseURL: false)!
        if let color { components.queryItems = [URLQueryItem(name: "color", value: color)] }
        return components.url!
    }

    /// Parses a search response (`{ "icons": ["lucide:sun", ...] }`).
    public static func parseSearch(_ data: Data, limit: Int) -> [Icon] {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ids = object["icons"] as? [String]
        else { return [] }
        return Array(ids.compactMap(Icon.init(id:)).prefix(limit))
    }

    public func search(_ query: String, sets: [String] = defaultSets, limit: Int = 96) async throws -> [Icon] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        let (data, response) = try await session.data(from: searchURL(trimmed, sets: sets, limit: limit))
        guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false else {
            throw URLError(.badServerResponse)
        }
        return Self.parseSearch(data, limit: limit)
    }

    /// SVG markup of an icon tinted with `color` (`currentColor` replaced by the server).
    public func svg(_ icon: Icon, color: String? = nil) async throws -> String {
        let (data, response) = try await session.data(from: svgURL(icon, color: color))
        guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false,
              let markup = String(data: data, encoding: .utf8), SVGMarkup.isPlausiblySafe(markup)
        else { throw URLError(.cannotDecodeContentData) }
        return markup
    }

    /// Curated starting points for the icon grid before the person searches.
    public static let featuredQueries = ["arrow", "star", "heart", "check", "sun", "sparkle", "phone", "mail", "map pin", "calendar", "music", "camera"]
}
