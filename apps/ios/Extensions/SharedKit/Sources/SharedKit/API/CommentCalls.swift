import DesynKit
import Foundation

/// An author or mention target.
public struct CommentPerson: Decodable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let image: String?

    public init(id: String, name: String, image: String?) {
        self.id = id
        self.name = name
        self.image = image
    }

    /// Up to two initials.
    public var initials: String {
        let parts = name.split(whereSeparator: { $0 == " " || $0 == "@" || $0 == "." }).prefix(2)
        let letters = parts.compactMap(\.first).map { String($0).uppercased() }.joined()
        return letters.isEmpty ? "?" : letters
    }
}

/// A reply inside a thread.
public struct CommentReply: Decodable, Hashable, Sendable, Identifiable {
    public let id: String
    public let threadId: String?
    public let body: String
    public let deleted: Bool
    public let author: CommentPerson
    public let mentions: [String]
    public let createdAt: Double
    public let editedAt: Double?

    public var createdDate: Date { Date(timeIntervalSince1970: createdAt / 1000) }
}

/// `collab/comments:list` item: a thread root with its replies and its anchor on the canvas.
public struct CommentThread: Decodable, Hashable, Sendable, Identifiable {
    public let id: String
    public let body: String
    public let deleted: Bool
    public let author: CommentPerson
    public let mentions: [String]
    public let createdAt: Double
    public let editedAt: Double?
    /// Layer the thread is attached to.
    public let nodeId: String?
    public let pageId: String?
    /// Page coordinates of the pin.
    public let x: Double?
    public let y: Double?
    public let resolved: Bool
    public let resolvedBy: CommentPerson?
    public let resolvedAt: Double?
    public let lastActivityAt: Double
    public let replies: [CommentReply]

    public var createdDate: Date { Date(timeIntervalSince1970: createdAt / 1000) }
    public var lastActivityDate: Date { Date(timeIntervalSince1970: lastActivityAt / 1000) }
    public var hasPin: Bool { x != nil && y != nil }
}

/// `collab/comments:mentionable` item.
public struct MentionableMember: Decodable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let image: String?
    public let role: String

    public init(id: String, name: String, image: String?, role: String) {
        self.id = id
        self.name = name
        self.image = image
        self.role = role
    }
}

public extension DesynAPI {
    /// Threads of a design, most recent activity first (live).
    func commentUpdates(designId: String, includeResolved: Bool, share: ShareAccess? = nil) -> AsyncThrowingStream<[CommentThread], Error> {
        var args: ConvexArgs = ["designId": designId, "includeResolved": includeResolved]
        if let share { args["share"] = share.argument }
        return transport.subscribe("collab/comments:list", args: args, as: [CommentThread].self)
    }

    func mentionableMembers(designId: String) async throws -> [MentionableMember] {
        try await transport.query("collab/comments:mentionable", args: ["designId": designId], as: [MentionableMember].self)
    }

    /// Starts a thread, optionally pinned to a page point and a layer. Returns the thread id.
    func createComment(
        designId: String,
        body: String,
        nodeId: String? = nil,
        pageId: String? = nil,
        point: PagePoint? = nil,
        mentions: [String] = [],
        share: ShareAccess? = nil
    ) async throws -> String {
        var args: ConvexArgs = ["designId": designId, "body": body]
        if let nodeId { args["nodeId"] = nodeId }
        if let pageId { args["pageId"] = pageId }
        if let point {
            args["x"] = point.x
            args["y"] = point.y
        }
        if !mentions.isEmpty { args["mentions"] = mentions.map { $0 as ConvexEncodable? } }
        if let share { args["share"] = share.argument }
        return try await transport.mutation("collab/comments:create", args: args, as: String.self)
    }

    func replyToComment(threadId: String, body: String, mentions: [String] = [], share: ShareAccess? = nil) async throws -> String {
        var args: ConvexArgs = ["threadId": threadId, "body": body]
        if !mentions.isEmpty { args["mentions"] = mentions.map { $0 as ConvexEncodable? } }
        if let share { args["share"] = share.argument }
        return try await transport.mutation("collab/comments:reply", args: args, as: String.self)
    }

    /// Edits a comment's text. `mentions` replaces the mentioned members (newly mentioned ones are emailed); nil
    /// keeps the existing ones (when the members are unknown, e.g. on a share link).
    func editComment(commentId: String, body: String, mentions: [String]? = nil, share: ShareAccess? = nil) async throws {
        var args: ConvexArgs = ["commentId": commentId, "body": body]
        if let mentions { args["mentions"] = mentions.map { $0 as ConvexEncodable? } }
        if let share { args["share"] = share.argument }
        _ = try await transport.mutation("collab/comments:edit", args: args, as: JSONValue.self)
    }

    func deleteComment(commentId: String, share: ShareAccess? = nil) async throws {
        var args: ConvexArgs = ["commentId": commentId]
        if let share { args["share"] = share.argument }
        _ = try await transport.mutation("collab/comments:delete", args: args, as: JSONValue.self)
    }

    func resolveThread(threadId: String, resolved: Bool, share: ShareAccess? = nil) async throws {
        var args: ConvexArgs = ["threadId": threadId, "resolved": resolved]
        if let share { args["share"] = share.argument }
        _ = try await transport.mutation("collab/comments:resolve", args: args, as: JSONValue.self)
    }
}

/// Mentions typed as `@Name` in a comment body, resolved against the mentionable members (longest names first so
/// "@Ann Lee" wins over "@Ann").
public enum CommentMentions {
    public static func resolve(in body: String, members: [MentionableMember]) -> [String] {
        let lowered = body.lowercased()
        var ids: [String] = []
        for member in members.sorted(by: { $0.name.count > $1.name.count }) where !member.name.isEmpty {
            if lowered.contains("@" + member.name.lowercased()), !ids.contains(member.id) {
                ids.append(member.id)
            }
        }
        return ids
    }

    /// The `@query` being typed at the end of `body` (nil when the last word is not a mention).
    public static func activeQuery(in body: String) -> String? {
        guard let at = body.lastIndex(of: "@") else { return nil }
        let before = body[..<at]
        if let last = before.last, !last.isWhitespace { return nil }
        let query = body[body.index(after: at)...]
        if query.contains("\n") || query.count > 32 { return nil }
        return String(query)
    }

    /// `body` with the active `@query` replaced by `@Name `.
    public static func complete(_ body: String, with member: MentionableMember) -> String {
        guard let at = body.lastIndex(of: "@") else { return body }
        return String(body[..<at]) + "@" + member.name + " "
    }
}
