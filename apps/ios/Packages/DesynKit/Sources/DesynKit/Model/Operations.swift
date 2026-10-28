import Foundation

/// A path segment of `patch` / `styles` ops: object key or array index.
public enum PathSegment: Hashable, Sendable {
    case key(String)
    case index(Int)

    public var jsonValue: JSONValue {
        switch self {
        case let .key(key): .string(key)
        case let .index(index): .number(Double(index))
        }
    }

    init?(_ value: JSONValue) {
        if let key = value.stringValue {
            self = .key(key)
        } else if let index = value.intValue {
            self = .index(index)
        } else {
            return nil
        }
    }
}

/// `Op` (DOCUMENT_MODEL section 5). Ops of an unknown kind round-trip through `.unknown`.
public enum Op: Hashable, Sendable {
    case create(nodes: [Node], parent: String, index: Int?)
    case update(id: String, set: [String: JSONValue], unset: [String])
    case patch(id: String, path: [PathSegment], value: JSONValue)
    case delete(id: String)
    case move(id: String, parent: String, index: Int?)
    case asset(set: [String: AssetRef], remove: [String])
    case styles(path: [PathSegment], value: JSONValue)
    case doc(set: [String: JSONValue], unset: [String])
    case unknown(JSONValue)

    public var jsonValue: JSONValue {
        switch self {
        case let .create(nodes, parent, index):
            var object: [String: JSONValue] = [
                "op": "create", "nodes": .array(nodes.map(\.jsonValue)), "parent": .string(parent),
            ]
            if let index { object["index"] = .int(index) }
            return .object(object)
        case let .update(id, set, unset):
            var object: [String: JSONValue] = ["op": "update", "id": .string(id)]
            if !set.isEmpty { object["set"] = .object(set) }
            if !unset.isEmpty { object["unset"] = .strings(unset) }
            return .object(object)
        case let .patch(id, path, value):
            return ["op": "patch", "id": .string(id), "path": .array(path.map(\.jsonValue)), "value": value]
        case let .delete(id):
            return ["op": "delete", "id": .string(id)]
        case let .move(id, parent, index):
            var object: [String: JSONValue] = ["op": "move", "id": .string(id), "parent": .string(parent)]
            if let index { object["index"] = .int(index) }
            return .object(object)
        case let .asset(set, remove):
            var object: [String: JSONValue] = ["op": "asset"]
            if !set.isEmpty { object["set"] = .object(set.mapValues(\.jsonValue)) }
            if !remove.isEmpty { object["remove"] = .strings(remove) }
            return .object(object)
        case let .styles(path, value):
            return ["op": "styles", "path": .array(path.map(\.jsonValue)), "value": value]
        case let .doc(set, unset):
            var object: [String: JSONValue] = ["op": "doc", "set": .object(set)]
            if !unset.isEmpty { object["unset"] = .strings(unset) }
            return .object(object)
        case let .unknown(value):
            return value
        }
    }

    public init(json value: JSONValue) {
        guard let object = value.objectValue, let kind = object["op"]?.stringValue else {
            self = .unknown(value)
            return
        }
        func strings(_ key: String) -> [String] { (object[key]?.arrayValue ?? []).compactMap(\.stringValue) }
        func path(_ key: String) -> [PathSegment]? {
            guard let array = object[key]?.arrayValue else { return nil }
            let segments = array.compactMap(PathSegment.init)
            return segments.count == array.count ? segments : nil
        }
        switch kind {
        case "create":
            guard let parent = object["parent"]?.stringValue, let nodes = object["nodes"]?.arrayValue else { break }
            self = .create(
                nodes: nodes.compactMap { $0.objectValue.map(Node.init(json:)) },
                parent: parent,
                index: object["index"]?.intValue
            )
            return
        case "update":
            guard let id = object["id"]?.stringValue else { break }
            self = .update(id: id, set: object["set"]?.objectValue ?? [:], unset: strings("unset"))
            return
        case "patch":
            guard let id = object["id"]?.stringValue, let segments = path("path") else { break }
            self = .patch(id: id, path: segments, value: object["value"] ?? .null)
            return
        case "delete":
            guard let id = object["id"]?.stringValue else { break }
            self = .delete(id: id)
            return
        case "move":
            guard let id = object["id"]?.stringValue, let parent = object["parent"]?.stringValue else { break }
            self = .move(id: id, parent: parent, index: object["index"]?.intValue)
            return
        case "asset":
            let set = (object["set"]?.objectValue ?? [:]).compactMapValues { $0.objectValue.map(AssetRef.init(json:)) }
            self = .asset(set: set, remove: strings("remove"))
            return
        case "styles":
            guard let segments = path("path") else { break }
            self = .styles(path: segments, value: object["value"] ?? .null)
            return
        case "doc":
            self = .doc(set: object["set"]?.objectValue ?? [:], unset: strings("unset"))
            return
        default:
            break
        }
        self = .unknown(value)
    }

    /// The node the op targets (for selection bookkeeping and "AI is editing" markers).
    public var targetID: String? {
        switch self {
        case let .create(nodes, _, _): nodes.first?.id
        case let .update(id, _, _), let .patch(id, _, _), let .delete(id), let .move(id, _, _): id
        case .asset, .styles, .doc, .unknown: nil
        }
    }

    /// JSON text of an op list.
    public static func serialize(_ ops: [Op]) -> String {
        JSONValue.array(ops.map(\.jsonValue)).serialized()
    }

    /// Parses a JSON `Op[]`.
    public static func parseList(_ json: String) throws -> [Op] {
        guard case let .array(values) = try JSONValue.parse(json) else {
            throw JSONValueError.invalid("ops must be an array")
        }
        return values.map(Op.init(json:))
    }
}

/// `Transaction` (DOCUMENT_MODEL section 5): the unit of undo, sync and history. (Named `DesignTransaction` so it
/// never collides with SwiftUI's `Transaction`.)
public struct DesignTransaction: Hashable, Sendable, Identifiable {
    /// `Transaction.source`.
    public enum Source: String, Codable, Sendable, CaseIterable {
        case user, ai, workflow, `import`, template, system
    }

    public var id: String
    public var label: String
    public var ops: [Op]
    public var source: Source
    /// `{ userId?, runId?, agent? }`.
    public var actor: [String: JSONValue]?
    /// ms since the epoch.
    public var ts: Double
    /// Unknown keys (kept for round trips).
    public var extra: [String: JSONValue]

    public init(
        id: String = DesynID.new(),
        label: String,
        ops: [Op],
        source: Source = .user,
        actor: [String: JSONValue]? = nil,
        ts: Double = (Date().timeIntervalSince1970 * 1000).rounded(),
        extra: [String: JSONValue] = [:]
    ) {
        self.id = id
        self.label = label
        self.ops = ops
        self.source = source
        self.actor = actor
        self.ts = ts
        self.extra = extra
    }

    private static let knownKeys: Set<String> = ["id", "label", "ops", "source", "actor", "ts"]

    public init(json value: JSONValue) throws {
        guard let object = value.objectValue, let id = object["id"]?.stringValue else {
            throw JSONValueError.invalid("transaction without id")
        }
        self.id = id
        label = object["label"]?.stringValue ?? ""
        ops = (object["ops"]?.arrayValue ?? []).map(Op.init(json:))
        source = Source(rawValue: object["source"]?.stringValue ?? "user") ?? .user
        actor = object["actor"]?.objectValue
        ts = object["ts"]?.doubleValue ?? 0
        extra = object.filter { !Self.knownKeys.contains($0.key) }
    }

    public init(jsonString: String) throws {
        try self.init(json: JSONValue.parse(jsonString))
    }

    public var jsonValue: JSONValue {
        var object = extra
        object["id"] = .string(id)
        object["label"] = .string(label)
        object["ops"] = .array(ops.map(\.jsonValue))
        object["source"] = .string(source.rawValue)
        object["ts"] = .number(ts)
        if let actor { object["actor"] = .object(actor) }
        return .object(object)
    }

    public func serialized() -> String { jsonValue.serialized() }

    /// `actor.runId` (AI / workflow runs group into one undo step).
    public var runID: String? { actor?["runId"]?.stringValue }
}

/// A dropped op reported by `designs.commit` (named `OpDrop` so it never collides with the engine's `DroppedOp`).
public struct OpDrop: Codable, Hashable, Sendable {
    public let index: Int
    /// `invalid-op | missing-node | missing-parent | not-container | cycle | duplicate-id | immutable-field |
    /// invalid-node | root-protected | page-nesting | invalid-path | invalid-value`.
    public let reason: String

    public init(index: Int, reason: String) {
        self.index = index
        self.reason = reason
    }
}

/// Client-generated ids: 12 characters of `[a-z0-9]` from the system CSPRNG (same format as `newId()`).
public enum DesynID {
    static let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")

    public static func new() -> String {
        var rng = SystemRandomNumberGenerator()
        return String((0..<12).map { _ in alphabet[Int(rng.next(upperBound: UInt64(alphabet.count)))] })
    }

    /// `^[a-z0-9]{12}$` or `root`.
    public static func isValid(_ id: String) -> Bool {
        if id == Design.rootID { return true }
        return id.count == 12 && id.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) }
    }
}
