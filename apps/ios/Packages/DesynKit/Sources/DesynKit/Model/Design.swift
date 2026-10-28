import Foundation

/// `AssetRef` (images, svg, fonts, video, audio).
public struct AssetRef: JSONObjectModel, Identifiable {
    public var json: [String: JSONValue]

    public init(json: [String: JSONValue]) { self.json = json }
    public init(from decoder: Decoder) throws { json = try JSONObjectCoding.decode(decoder) }
    public func encode(to encoder: Encoder) throws { try JSONObjectCoding.encode(json, to: encoder) }

    public var id: String { string("id") ?? "" }
    /// `image` | `svg` | `font` | `video` | `audio` | `lottie` | `data`.
    public var kind: String { string("kind") ?? "data" }
    public var mime: String { string("mime") ?? "application/octet-stream" }
    public var storageKey: String? { string("storageKey") }
    /// Client-side resolved URL (never persisted by Convex).
    public var url: String? { string("url") }
    public var hash: String? { string("hash") }
    public var width: Double? { number("width") }
    public var height: Double? { number("height") }
    public var family: String? { string("family") }
    public var name: String? { string("name") }
}

/// `DesignStyles`: named colors, text and effect styles and variables.
public struct DesignStyles: JSONObjectModel {
    public var json: [String: JSONValue]

    public init(json: [String: JSONValue]) { self.json = json }
    public init(from decoder: Decoder) throws { json = try JSONObjectCoding.decode(decoder) }
    public func encode(to encoder: Encoder) throws { try JSONObjectCoding.encode(json, to: encoder) }

    /// `{ colors: {}, text: {}, effects: {}, variables: {} }`.
    public static var empty: DesignStyles {
        DesignStyles(json: ["colors": [:], "text": [:], "effects": [:], "variables": [:]])
    }

    /// Named color swatches (name, hex) in name order.
    public var colors: [(id: String, name: String, value: String)] {
        let entries = object("colors") ?? [:]
        var result: [(id: String, name: String, value: String)] = []
        for (id, value) in entries {
            guard let name = value["name"]?.stringValue, let hex = value["value"]?.stringValue else { continue }
            result.append((id: id, name: name, value: hex))
        }
        return result.sorted { $0.name < $1.name }
    }
}

/// A design (DOCUMENT_MODEL section 2): a flat node map under `nodes["root"]`, assets, styles and metadata.
public struct Design: Codable, Hashable, Sendable {
    public static let rootID = "root"

    public var schema: Int
    public var id: String
    public var name: String
    public var kind: DesignKind
    public var nodes: [String: Node]
    public var assets: [String: AssetRef]
    public var styles: DesignStyles
    public var brandKitId: String?
    public var meta: [String: JSONValue]
    /// Top-level keys this client does not know (kept for round trips).
    public var extra: [String: JSONValue]

    public init(
        id: String,
        name: String,
        kind: DesignKind,
        nodes: [String: Node],
        assets: [String: AssetRef] = [:],
        styles: DesignStyles = .empty,
        brandKitId: String? = nil,
        meta: [String: JSONValue] = [:],
        extra: [String: JSONValue] = [:]
    ) {
        schema = 1
        self.id = id
        self.name = name
        self.kind = kind
        self.nodes = nodes
        self.assets = assets
        self.styles = styles
        self.brandKitId = brandKitId
        self.meta = meta
        self.extra = extra
    }

    private static let knownKeys: Set<String> = ["schema", "id", "name", "kind", "nodes", "assets", "styles", "brandKitId", "meta"]

    public init(json object: [String: JSONValue]) throws {
        guard let id = object["id"]?.stringValue else { throw JSONValueError.invalid("design without id") }
        guard let nodes = object["nodes"]?.objectValue else { throw JSONValueError.invalid("design without nodes") }
        schema = object["schema"]?.intValue ?? 1
        self.id = id
        name = object["name"]?.stringValue ?? "Untitled"
        kind = DesignKind(rawValue: object["kind"]?.stringValue ?? "custom")
        self.nodes = nodes.compactMapValues { $0.objectValue.map(Node.init(json:)) }
        assets = (object["assets"]?.objectValue ?? [:]).compactMapValues { $0.objectValue.map(AssetRef.init(json:)) }
        styles = object["styles"]?.objectValue.map(DesignStyles.init(json:)) ?? .empty
        brandKitId = object["brandKitId"]?.stringValue
        meta = object["meta"]?.objectValue ?? [:]
        extra = object.filter { !Self.knownKeys.contains($0.key) }
    }

    public init(jsonString: String) throws {
        guard case let .object(object) = try JSONValue.parse(jsonString) else {
            throw JSONValueError.invalid("design must be an object")
        }
        try self.init(json: object)
    }

    public init(from decoder: Decoder) throws {
        try self.init(json: JSONObjectCoding.decode(decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try jsonValue.encode(to: encoder)
    }

    public var jsonValue: JSONValue {
        var object = extra
        object["schema"] = .number(Double(schema))
        object["id"] = .string(id)
        object["name"] = .string(name)
        object["kind"] = .string(kind.rawValue)
        object["nodes"] = .object(nodes.mapValues(\.jsonValue))
        object["assets"] = .object(assets.mapValues(\.jsonValue))
        object["styles"] = styles.jsonValue
        object["meta"] = .object(meta)
        if let brandKitId { object["brandKitId"] = .string(brandKitId) }
        return .object(object)
    }

    /// Deterministic JSON text (the engine's `load(designJSON:)` input).
    public func serialized() -> String { jsonValue.serialized() }

    // MARK: Tree

    public var root: Node? { nodes[Self.rootID] }

    /// Pages in order.
    public var pages: [Node] {
        (root?.children ?? []).compactMap { nodes[$0] }
    }

    /// Children of `id` in back-to-front order.
    public func children(of id: String) -> [Node] {
        (nodes[id]?.children ?? []).compactMap { nodes[$0] }
    }

    /// The page containing `id` (the node itself when it is a page).
    public func page(containing id: String) -> Node? {
        var current = nodes[id]
        while let node = current {
            if node.type == .page { return node }
            guard let parent = node.parent else { return nil }
            current = nodes[parent]
        }
        return nil
    }

    /// `id` and all of its descendants (depth-first, parent first).
    public func subtree(_ id: String) -> [Node] {
        guard let node = nodes[id] else { return [] }
        return [node] + node.children.flatMap { subtree($0) }
    }
}
