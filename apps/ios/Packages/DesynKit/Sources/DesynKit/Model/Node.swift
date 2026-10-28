import Foundation

/// A node of any type (DOCUMENT_MODEL section 3). Common `BaseNode` fields and the type-specific fields the app
/// edits are typed; everything else stays in `json` untouched.
public struct Node: JSONObjectModel, Identifiable {
    public var json: [String: JSONValue]

    public init(json: [String: JSONValue]) { self.json = json }
    public init(from decoder: Decoder) throws { json = try JSONObjectCoding.decode(decoder) }
    public func encode(to encoder: Encoder) throws { try JSONObjectCoding.encode(json, to: encoder) }

    // MARK: BaseNode

    public var id: String { string("id") ?? "" }

    /// Raw `type` string.
    public var typeName: String { string("type") ?? "" }

    /// Known type, or nil for types from a newer schema.
    public var type: NodeType? { NodeType(rawValue: typeName) }

    public var name: String {
        get { string("name") ?? "" }
        set { set("name", .string(newValue)) }
    }

    public var parent: String? { string("parent") }

    public var x: Double {
        get { number("x") ?? 0 }
        set { set("x", .number(newValue)) }
    }

    public var y: Double {
        get { number("y") ?? 0 }
        set { set("y", .number(newValue)) }
    }

    public var width: Double {
        get { number("width") ?? 0 }
        set { set("width", .number(max(0, newValue))) }
    }

    public var height: Double {
        get { number("height") ?? 0 }
        set { set("height", .number(max(0, newValue))) }
    }

    /// Degrees clockwise about the center.
    public var rotation: Double {
        get { number("rotation") ?? 0 }
        set { set("rotation", .number(newValue)) }
    }

    public var opacity: Double {
        get { number("opacity") ?? 1 }
        set { set("opacity", .number(min(1, max(0, newValue)))) }
    }

    public var blend: String { string("blend") ?? "normal" }

    public var visible: Bool {
        get { bool("visible") ?? true }
        set { set("visible", .bool(newValue)) }
    }

    public var locked: Bool {
        get { bool("locked") ?? false }
        set { set("locked", .bool(newValue)) }
    }

    public var role: String? { string("role") }
    public var effects: [Effect] { models("effects") }

    // MARK: Containers

    /// Ordered children (back to front), empty for leaf nodes.
    public var children: [String] {
        (json["children"]?.arrayValue ?? []).compactMap(\.stringValue)
    }

    public var isContainer: Bool { json["children"] != nil || (type?.isContainer ?? false) }

    // MARK: Shaped

    public var fills: [Fill] {
        get { models("fills") }
        set { setModels("fills", newValue) }
    }

    public var strokes: [Stroke] {
        get { models("strokes") }
        set { setModels("strokes", newValue) }
    }

    public var cornerRadius: CornerRadius { CornerRadius(json["cornerRadius"]) }

    /// Page background fills.
    public var background: [Fill] { models("background") }

    // MARK: Text

    public var runs: [TextRun] {
        get { models("runs") }
        set { setModels("runs", newValue) }
    }

    /// The concatenated text of all runs.
    public var text: String { runs.map(\.text).joined() }

    public var textStyle: TextStyle? { model("style") }
    public var paragraph: ParagraphStyle? { model("paragraph") }

    // MARK: Media

    public var assetId: String? { string("assetId") }

    // MARK: Pages

    public var unit: PageUnit { PageUnit(rawValue: string("unit") ?? "px") ?? .px }
    public var bleed: Double { number("bleed") ?? 0 }

    /// A short label for lists ("Rectangle", "Hello world").
    public var displayName: String {
        if type == .text {
            let text = self.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return String(text.prefix(40)) }
        }
        return name.isEmpty ? typeName.capitalized : name
    }
}
