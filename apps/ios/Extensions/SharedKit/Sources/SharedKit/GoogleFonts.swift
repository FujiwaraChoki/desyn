import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Google Fonts on demand (CSS2 API), as the engine's other hosts do (`crates/desyn-text/src/font/google.rs`,
/// `packages/engine/src/fonts.ts`): resolve a family / weight / style to font file URLs, download them and keep
/// them in a disk cache so designs keep rendering offline. A non-browser user agent makes Google answer with TrueType
/// files, which both Core Text (previews) and the engine read.
public struct GoogleFontsClient: Sendable {
    public static let endpoint = URL(string: "https://fonts.googleapis.com/css2")!
    static let userAgent = "desyn-ios/1"

    public let cacheDirectory: URL
    private let session: URLSession

    public init(cacheDirectory: URL, session: URLSession = .shared) {
        self.cacheDirectory = cacheDirectory
        self.session = session
    }

    /// `https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700` (`display=swap` omitted: no
    /// browser reads this CSS).
    public static func cssURL(family: String, weight: Int, italic: Bool) -> URL {
        let encoded = family.trimmingCharacters(in: .whitespaces)
            .addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: " -_.")))!
            .replacingOccurrences(of: " ", with: "+")
        let axis = italic ? ":ital,wght@1,\(weight)" : ":wght@\(weight)"
        // Build by hand: URLComponents would percent-encode the `+` and `@` Google expects literally.
        return URL(string: "\(endpoint.absoluteString)?family=\(encoded)\(axis)")!
    }

    /// `url(...)` sources of the `@font-face` rules, in order, without duplicates.
    public static func fontURLs(inCSS css: String) -> [URL] {
        var urls: [URL] = []
        var rest = css[...]
        while let start = rest.range(of: "url(") {
            let after = rest[start.upperBound...]
            guard let end = after.firstIndex(of: ")") else { break }
            var raw = after[..<end].trimmingCharacters(in: .whitespaces)
            if raw.hasPrefix("'") || raw.hasPrefix("\"") { raw.removeFirst() }
            if raw.hasSuffix("'") || raw.hasSuffix("\"") { raw.removeLast() }
            if let url = URL(string: raw), url.scheme == "https", !urls.contains(url) { urls.append(url) }
            rest = after[after.index(after: end)...]
        }
        return urls
    }

    /// Cache file of a family / weight / style.
    public func cacheURL(family: String, weight: Int, italic: Bool) -> URL {
        let safe = family.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? String($0) : "_" }.joined()
        return cacheDirectory.appendingPathComponent("\(safe)-\(weight)\(italic ? "i" : "").ttf")
    }

    /// Font bytes from the cache (offline) or Google; nil when the family does not exist there.
    public func fontData(family: String, weight: Int, italic: Bool) async throws -> Data? {
        let cached = cacheURL(family: family, weight: weight, italic: italic)
        if let data = try? Data(contentsOf: cached), !data.isEmpty { return data }
        var request = URLRequest(url: Self.cssURL(family: family, weight: weight, italic: italic))
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        let (cssData, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        // 400: unknown family or an axis value the family does not have.
        if http.statusCode == 400 || http.statusCode == 404 { return nil }
        guard (200..<300).contains(http.statusCode), let css = String(data: cssData, encoding: .utf8) else {
            throw URLError(.badServerResponse)
        }
        // Several files appear when Google splits a family by script; the first is the Latin face the UI needs, the
        // engine gets the full set through its own font requests.
        guard let fontURL = Self.fontURLs(inCSS: css).first else { return nil }
        let (data, fontResponse) = try await session.data(from: fontURL)
        guard (fontResponse as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false, data.count > 64 else {
            throw URLError(.badServerResponse)
        }
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
        try? data.write(to: cached, options: .atomic)
        return data
    }
}
