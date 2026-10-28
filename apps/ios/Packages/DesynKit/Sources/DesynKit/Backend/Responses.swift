import Foundation

// Decodable shapes of the Convex functions the app calls (convex/accounts, convex/designs).
// Convex numbers arrive as JSON floats, so numeric fields are Double.

public struct AuthMethods: Decodable, Hashable, Sendable {
    public let emailPassword: Bool
    public let magicLink: Bool
    public let google: Bool
    public let github: Bool

    public init(emailPassword: Bool, magicLink: Bool, google: Bool, github: Bool) {
        self.emailPassword = emailPassword
        self.magicLink = magicLink
        self.google = google
        self.github = github
    }
}

/// `accounts/config:get`.
public struct BackendConfig: Decodable, Hashable, Sendable {
    public let edition: String
    public let appUrl: String?
    public let authMethods: AuthMethods
    public let billingEnabled: Bool
}

/// `accounts/profiles:me`.
public struct Profile: Codable, Hashable, Sendable {
    public let userId: String
    public let email: String
    public let name: String?
    public let image: String?
    public let emailVerified: Bool?
    public let edition: String?
    public let plan: String?
    public let planName: String?
    public let isAdmin: Bool?
    public let defaultWorkspaceId: String?
    public let provisioned: Bool?

    public var displayName: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        return email.split(separator: "@").first.map(String.init) ?? email
    }

    public var firstName: String {
        displayName.split(separator: " ").first.map(String.init) ?? displayName
    }
}

/// `accounts/profiles:ensure`.
public struct EnsureResult: Decodable, Hashable, Sendable {
    public let workspaceId: String
    public let created: Bool
}

/// `accounts/workspaces:list` item.
public struct Workspace: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// `personal` | `team`.
    public let kind: String
    public let role: String
    public let isDefault: Bool
}

/// `DesignSummary` (`designs/designs:list|get`).
public struct DesignSummary: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let key: String
    public let name: String
    public let kind: String
    public let workspaceId: String
    public let folderId: String?
    public let state: String?
    public let pageCount: Double
    public let width: Double
    public let height: Double
    public let thumbnailUrl: String?
    public let createdAt: Double
    public let updatedAt: Double
    /// `view` | `comment` | `edit` | `manage`.
    public let permission: String?
    /// Present for the "shared" filter: the link the user joined through.
    public let shareToken: String?

    public var designKind: DesignKind { DesignKind(rawValue: kind) }
    public var updatedDate: Date { Date(timeIntervalSince1970: updatedAt / 1000) }
    public var canEdit: Bool { permission == "edit" || permission == "manage" }
    public var aspectRatio: Double { height > 0 ? width / height : 1 }
}

/// Convex `PaginationResult<T>`.
public struct PaginatedResult<Item: Decodable & Sendable>: Decodable, Sendable {
    public let page: [Item]
    public let isDone: Bool
    public let continueCursor: String?
}

/// `accounts/folders:list` item.
public struct Folder: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let workspaceId: String
    public let parentId: String?
    public let name: String
    public let color: String?
    public let sort: Double?
}

/// `templates/templates:list|search` item.
public struct TemplateSummary: Codable, Hashable, Sendable, Identifiable {
    public struct Thumbnail: Codable, Hashable, Sendable {
        /// nil when the server cannot sign the file (no S3 configured, or the file was purged).
        public let url: String?
        public let width: Double
        public let height: Double
    }

    public let id: String
    public let slug: String
    public let title: String
    public let description: String?
    public let kind: String
    public let category: String?
    public let tags: [String]?
    public let premium: Bool
    public let pageCount: Double
    public let width: Double
    public let height: Double
    public let thumbnails: [Thumbnail]
    public let favorite: Bool?

    /// The thumbnail closest to `width` points wide (among those with a URL).
    public func thumbnail(near width: Double) -> Thumbnail? {
        thumbnails.filter { $0.url != nil }.min { abs($0.width - width) < abs($1.width - width) }
    }

    public var aspectRatio: Double { height > 0 ? width / height : 1 }
}

/// `brand/brandKits:list` item (fields the app shows).
public struct BrandKit: Codable, Hashable, Sendable, Identifiable {
    public struct BrandColor: Codable, Hashable, Sendable {
        public let id: String?
        public let name: String
        public let value: String
        public let role: String?
    }

    public struct Logo: Codable, Hashable, Sendable {
        public let name: String?
        public let variant: String?
        public let url: String?
        public let refId: String?
    }

    public struct FontSlot: Codable, Hashable, Sendable {
        public let family: String
        public let weight: Double?
        public let style: String?
    }

    public struct Fonts: Codable, Hashable, Sendable {
        public let heading: FontSlot?
        public let body: FontSlot?
        public let accent: FontSlot?
    }

    public struct Voice: Codable, Hashable, Sendable {
        public let tone: String?
        public let description: String?
    }

    public let id: String
    public let name: String
    public let colors: [BrandColor]
    public let logos: [Logo]
    public let fonts: Fonts
    public let voice: Voice?
    public let isDefault: Bool
}

/// `designs/designs:create`, `templates/templates:instantiate`.
public struct CreatedDesign: Decodable, Hashable, Sendable {
    public let designId: String
    public let key: String
}

/// `designs/designs:joinShare`.
public struct JoinedShare: Decodable, Hashable, Sendable {
    public let designId: String
    /// `view` | `comment` | `edit`.
    public let permission: String
}

/// Header of the first `designs/designs:load` page (`convex/lib/designs_wire.ts` `LoadHeader`).
public struct LoadHeader: Codable, Hashable, Sendable {
    public struct SnapshotRef: Codable, Hashable, Sendable {
        public let key: String
        public let seq: Double
    }

    public let designId: String
    public let key: String
    public let name: String
    public let kind: String
    public let workspaceId: String
    public let pageCount: Double
    /// JSON of `Design.assets`.
    public let assets: String
    /// JSON of `Design.styles`.
    public let styles: String
    /// JSON of `Design.meta`.
    public let meta: String
    public let brandKitId: String?
    public let permission: String
    public let snapshot: SnapshotRef?
}

/// One `designs/designs:load` page.
public struct LoadPage: Decodable, Sendable {
    public let header: LoadHeader?
    public let seq: Double
    /// JSON of each node.
    public let nodes: [String]
    public let cursor: String?
    public let isDone: Bool
}

/// `designs/designs:commit`.
public struct CommitResult: Decodable, Hashable, Sendable {
    public let seq: Double
    /// JSON of the applied ops.
    public let applied: String
    public let dropped: [OpDrop]
    public let duplicate: Bool
}

/// One `designs/designOps:since` entry.
public struct OpEntry: Decodable, Hashable, Sendable {
    public let seq: Double
    public let txId: String
    /// JSON of the accepted transaction (ops = the server-applied ops).
    public let tx: String
    public let source: String
    public let ts: Double
}

/// `designs/designOps:since`.
public struct OpsSince: Decodable, Sendable {
    public let ops: [OpEntry]
    public let hasMore: Bool
    /// Entries after `seq` were compacted: reload the design.
    public let gap: Bool
    public let latestSeq: Double
}

/// `assets/assets:designUrls`.
public struct AssetURLs: Decodable, Sendable {
    public let urls: [String: String]
    public let expiresAt: Double?
}

/// `assets/assets:requestUpload`.
public struct UploadTicket: Decodable, Sendable {
    public struct Upload: Decodable, Sendable {
        public let url: String
        public let method: String
        public let headers: [String: String]
        public let expiresAt: Double
    }

    public let assetId: String
    public let refId: String
    public let deduplicated: Bool
    public let upload: Upload?
}

/// `assets/assets:finalize`.
public struct FinalizedAsset: Decodable, Sendable {
    public let assetId: String
    public let refId: String
    public let deduplicated: Bool
}

/// `assets/assets:get`.
public struct AssetInfo: Decodable, Sendable {
    public let id: String
    public let refId: String
    public let kind: String
    public let name: String?
    public let mime: String
    public let bytes: Double
    public let width: Double?
    public let height: Double?
    public let hash: String?
    public let storageKey: String
    public let url: String?

    /// The `AssetRef` to put into a design with an `asset` op.
    public var assetRef: AssetRef {
        var json: [String: JSONValue] = [
            "id": .string(refId),
            "kind": .string(kind),
            "mime": .string(mime),
            "storageKey": .string(storageKey),
            "bytes": .number(bytes),
            "source": "upload",
        ]
        if let width { json["width"] = .number(width) }
        if let height { json["height"] = .number(height) }
        if let hash { json["hash"] = .string(hash) }
        if let name { json["name"] = .string(name) }
        return AssetRef(json: json)
    }
}
