import DesynKit
import Foundation

// Typed calls for designs, versions and share links (convex/designs). Numbers cross the
// Convex boundary as float64, so numeric fields are Double and arguments are sent as Double.

/// `designs/designs:get`.
public struct DesignDetail: Decodable, Hashable, Sendable {
    public let id: String
    public let key: String
    public let name: String
    public let kind: String
    public let workspaceId: String
    public let folderId: String?
    public let ownerId: String?
    public let state: String?
    public let pageCount: Double
    public let width: Double
    public let height: Double
    public let thumbnailUrl: String?
    public let shareCount: Double?
    public let createdAt: Double
    public let updatedAt: Double
    /// `view` | `comment` | `edit` | `manage`.
    public let permission: String?
    /// `member` | `share`.
    public let via: String?

    /// Editors, managers and comment-link holders can comment.
    public var canComment: Bool { permission == "comment" || permission == "edit" || permission == "manage" }
}

/// `designs/designs:importDesign`.
public struct ImportedDesign: Decodable, Hashable, Sendable {
    public let designId: String
    public let key: String
    /// Number of validation warnings (`validateDesign`); the design was still created.
    public let warnings: Double?
    /// True when a large design is still being built by a background action.
    public let pending: Bool?
}

/// `designs/versions:list` item.
public struct DesignVersion: Decodable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let seq: Double
    /// `pending` | `ready` | `failed`.
    public let status: String
    /// Automatic versions ("Before restoring", periodic snapshots).
    public let auto: Bool
    public let pageCount: Double?
    public let createdBy: String?
    public let createdByName: String?
    public let createdAt: Double
    public let error: String?

    public var createdDate: Date { Date(timeIntervalSince1970: createdAt / 1000) }
    public var isReady: Bool { status == "ready" }
}

/// `designs/versions:get` (the design at that version, JSON).
public struct VersionContent: Decodable, Sendable {
    public let design: String
    public let name: String
}

/// `designs/designs:setShare`.
public struct ShareLinkResult: Decodable, Hashable, Sendable {
    public let shareId: String
    public let token: String
    public let url: String
}

/// `designs/designs:listShares` item.
public struct DesignShareLink: Decodable, Hashable, Sendable, Identifiable {
    public let id: String
    public let token: String
    public let url: String
    /// `view` | `comment` | `edit`.
    public let permission: String
    public let hasPassword: Bool
    public let expiresAt: Double?
    public let expired: Bool
    public let label: String?
    public let createdBy: String?
    public let createdAt: Double
    public let lastUsedAt: Double?

    public var expiryDate: Date? { expiresAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

/// `{ seq }` answers (rename, restore).
public struct SeqResult: Decodable, Hashable, Sendable {
    public let seq: Double
}

public extension DesynAPI {
    // MARK: Designs

    func design(designId: String, share: ShareAccess? = nil) async throws -> DesignDetail {
        var args: ConvexArgs = ["designId": designId]
        if let share { args["share"] = share.argument }
        return try await transport.query("designs/designs:get", args: args, as: DesignDetail.self)
    }

    /// Creates a design from complete Design JSON (imports: photos and PDFs from the share extension).
    func importDesign(workspaceId: String, designJSON: String, name: String? = nil, folderId: String? = nil) async throws -> ImportedDesign {
        var args: ConvexArgs = ["workspaceId": workspaceId, "design": designJSON]
        if let name { args["name"] = name }
        if let folderId { args["folderId"] = folderId }
        return try await transport.mutation("designs/designs:importDesign", args: args, as: ImportedDesign.self)
    }

    // MARK: Versions

    /// Named and automatic versions, newest first (live).
    func versionUpdates(designId: String, share: ShareAccess? = nil) -> AsyncThrowingStream<[DesignVersion], Error> {
        var args: ConvexArgs = ["designId": designId]
        if let share { args["share"] = share.argument }
        return transport.subscribe("designs/versions:list", args: args, as: [DesignVersion].self)
    }

    /// Saves the current state as a named version; returns its id.
    func createVersion(designId: String, name: String) async throws -> String {
        try await transport.mutation("designs/versions:create", args: ["designId": designId, "name": name], as: String.self)
    }

    func renameVersion(versionId: String, name: String) async throws {
        _ = try await transport.mutation("designs/versions:rename", args: ["versionId": versionId, "name": name], as: JSONValue.self)
    }

    func removeVersion(versionId: String) async throws {
        _ = try await transport.mutation("designs/versions:remove", args: ["versionId": versionId], as: JSONValue.self)
    }

    /// Restores a version (an automatic "Before restoring" version is saved first). Collaborators see the change live.
    func restoreVersion(versionId: String) async throws -> SeqResult {
        try await transport.action("designs/versions:restore", args: ["versionId": versionId], as: SeqResult.self)
    }

    /// The design at a version (for the preview).
    func versionContent(versionId: String, share: ShareAccess? = nil) async throws -> VersionContent {
        var args: ConvexArgs = ["versionId": versionId]
        if let share { args["share"] = share.argument }
        return try await transport.action("designs/versions:get", args: args, as: VersionContent.self)
    }

    // MARK: Share links

    /// Share links of a design (live; managers only).
    func shareLinkUpdates(designId: String) -> AsyncThrowingStream<[DesignShareLink], Error> {
        transport.subscribe("designs/designs:listShares", args: ["designId": designId], as: [DesignShareLink].self)
    }

    /// Creates a link, or updates `shareId`. `password: .some(nil)` removes a password, `expiresAt: .some(nil)` the
    /// expiry; nil leaves them unchanged.
    func setShareLink(
        designId: String,
        shareId: String? = nil,
        permission: String,
        password: String?? = nil,
        expiresAt: Date?? = nil,
        label: String? = nil
    ) async throws -> ShareLinkResult {
        var args: ConvexArgs = ["designId": designId, "permission": permission]
        if let shareId { args["shareId"] = shareId }
        // `.some(nil)` sends null (clears); a missing key leaves the value unchanged.
        if let password { args["password"] = .some(password.map { $0 as ConvexEncodable }) }
        if let expiresAt {
            args["expiresAt"] = .some(expiresAt.map { ($0.timeIntervalSince1970 * 1000).rounded() as ConvexEncodable })
        }
        if let label { args["label"] = label }
        return try await transport.mutation("designs/designs:setShare", args: args, as: ShareLinkResult.self)
    }

    func revokeShareLink(shareId: String) async throws {
        _ = try await transport.mutation("designs/designs:revokeShare", args: ["shareId": shareId], as: JSONValue.self)
    }
}

public extension ShareAccess {
    /// `share` argument of design functions (`{ token, password? }`).
    var argument: ConvexEncodable {
        var value: ConvexArgs = ["token": token]
        if let password { value["password"] = password }
        return value
    }
}
