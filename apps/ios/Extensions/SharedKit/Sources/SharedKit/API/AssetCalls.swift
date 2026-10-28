import DesynKit
import Foundation

/// `assets/assets:list|get` item (the workspace's library of uploads, AI results, stock photos and brand files).
public struct LibraryAsset: Decodable, Hashable, Sendable, Identifiable {
    public struct Attribution: Decodable, Hashable, Sendable {
        public let author: String?
        public let license: String?
        public let url: String?
    }

    public struct AIInfo: Decodable, Hashable, Sendable {
        public let provider: String
        public let model: String
        public let prompt: String
    }

    public let id: String
    public let refId: String
    public let workspaceId: String?
    /// `image` | `svg` | `font` | `video` | `audio` | `lottie` | `data`.
    public let kind: String
    public let name: String?
    public let mime: String
    public let bytes: Double
    public let width: Double?
    public let height: Double?
    public let hash: String?
    public let status: String?
    /// `upload` | `ai` | `stock` | `template` | `brand`.
    public let source: String?
    public let storageKey: String
    public let family: String?
    public let attribution: Attribution?
    public let ai: AIInfo?
    public let url: String?
    public let createdAt: Double?

    /// The `AssetRef` to put into a design with an `asset` op (never carries `url`).
    public var assetRef: AssetRef {
        var json: [String: JSONValue] = [
            "id": .string(refId),
            "kind": .string(kind),
            "mime": .string(mime),
            "storageKey": .string(storageKey),
            "bytes": .number(bytes),
            "source": .string(source ?? "upload"),
        ]
        if let width { json["width"] = .number(width) }
        if let height { json["height"] = .number(height) }
        if let hash { json["hash"] = .string(hash) }
        if let name { json["name"] = .string(name) }
        if let family { json["family"] = .string(family) }
        if let attribution {
            var value: [String: JSONValue] = [:]
            if let author = attribution.author { value["author"] = .string(author) }
            if let license = attribution.license { value["license"] = .string(license) }
            if let url = attribution.url { value["url"] = .string(url) }
            if !value.isEmpty { json["attribution"] = .object(value) }
        }
        return AssetRef(json: json)
    }

    public var displayName: String {
        if let name, !name.isEmpty { return name }
        return kind.capitalized
    }

    public var isImage: Bool { kind == "image" || kind == "svg" }
}

/// One stock photo (`stock/photos:search`; Unsplash / Pexels through the server's keys).
public struct StockPhoto: Decodable, Hashable, Sendable, Identifiable {
    /// `"<provider>:<id>"`.
    public let id: String
    /// `unsplash` | `pexels`.
    public let provider: String
    public let description: String
    public let width: Double
    public let height: Double
    /// Small preview.
    public let thumbUrl: String
    /// Full-size download (public CDN URL).
    public let url: String
    public let color: String?
    public let author: String
    public let authorUrl: String
    public let sourceUrl: String
    public let license: String
    /// Unsplash download tracking endpoint (reported through `stock/photos:track` when a photo is used).
    public let downloadLocation: String?

    /// "Photo by Ann Lee on Unsplash".
    public var credit: String {
        "Photo by \(author) on \(provider == "pexels" ? "Pexels" : "Unsplash")"
    }

    /// `AssetRef.attribution` for a placed photo.
    public var attribution: [String: JSONValue] {
        ["author": .string(author), "license": .string(license), "url": .string(sourceUrl)]
    }
}

/// `stock/photos:search`.
public struct StockSearchResult: Decodable, Sendable {
    public let photos: [StockPhoto]
    public let hasMore: Bool
}

public extension DesynAPI {
    /// One page of the workspace's assets, newest first (`kind` filters; `search` matches names).
    func libraryAssets(
        workspaceId: String,
        kind: String? = nil,
        search: String? = nil,
        cursor: String? = nil,
        pageSize: Int = 40
    ) async throws -> PaginatedResult<LibraryAsset> {
        var args: ConvexArgs = [
            "workspaceId": workspaceId,
            "paginationOpts": ["numItems": Double(pageSize), "cursor": cursor] as ConvexArgs,
        ]
        if let kind { args["kind"] = kind }
        if let search, !search.trimmingCharacters(in: .whitespaces).isEmpty {
            args["search"] = search.trimmingCharacters(in: .whitespaces)
        }
        return try await transport.query("assets/assets:list", args: args, as: PaginatedResult<LibraryAsset>.self)
    }

    func libraryAsset(assetId: String) async throws -> LibraryAsset {
        try await transport.query("assets/assets:get", args: ["assetId": assetId], as: LibraryAsset.self)
    }

    func renameAsset(assetId: String, name: String) async throws {
        _ = try await transport.mutation("assets/assets:rename", args: ["assetId": assetId, "name": name], as: JSONValue.self)
    }

    func deleteAsset(assetId: String) async throws {
        _ = try await transport.mutation("assets/assets:delete", args: ["assetId": assetId], as: JSONValue.self)
    }

    /// Stock photos from the server's Unsplash / Pexels keys (`orientation`: landscape | portrait | square; `page`
    /// 1...3). Throws `NOT_CONFIGURED` when the server has no stock key.
    func searchStock(query: String, orientation: String? = nil, count: Int = 24, page: Int = 1) async throws -> StockSearchResult {
        var args: ConvexArgs = ["query": query, "count": Double(count), "page": Double(page)]
        if let orientation { args["orientation"] = orientation }
        return try await transport.action("stock/photos:search", args: args, as: StockSearchResult.self)
    }

    /// Reports that a stock photo was used (Unsplash's API guidelines require it).
    func trackStockUse(_ photo: StockPhoto) async throws {
        var args: ConvexArgs = ["id": photo.id]
        if let location = photo.downloadLocation { args["downloadLocation"] = location }
        _ = try await transport.action("stock/photos:track", args: args, as: JSONValue.self)
    }
}
