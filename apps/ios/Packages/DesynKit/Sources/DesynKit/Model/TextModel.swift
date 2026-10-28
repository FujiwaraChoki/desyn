import Foundation

/// `TextStyle` (full default style of a text node, or a partial override inside a run).
public struct TextStyle: JSONObjectModel {
    public var json: [String: JSONValue]

    public init(json: [String: JSONValue]) { self.json = json }
    public init(from decoder: Decoder) throws { json = try JSONObjectCoding.decode(decoder) }
    public func encode(to encoder: Encoder) throws { try JSONObjectCoding.encode(json, to: encoder) }

    /// The schema default (`defaultTextStyle()` in @desyn/schema) with overrides.
    public static func standard(
        fontFamily: String = "Inter",
        fontWeight: Double = 400,
        fontSize: Double = 24,
        color: String = "#111111"
    ) -> TextStyle {
        TextStyle(json: [
            "fontFamily": .string(fontFamily),
            "fontWeight": .number(fontWeight),
            "fontStyle": "normal",
            "fontSize": .number(fontSize),
            "fills": .array([Fill.solid(.hex(color)).jsonValue]),
            "letterSpacing": 0,
            "textCase": "none",
            "decoration": "none",
        ])
    }

    public var fontFamily: String? {
        get { string("fontFamily") }
        set { set("fontFamily", newValue.map(JSONValue.string)) }
    }

    public var fontWeight: Double? {
        get { number("fontWeight") }
        set { set("fontWeight", newValue.map(JSONValue.number)) }
    }

    public var fontSize: Double? {
        get { number("fontSize") }
        set { set("fontSize", newValue.map(JSONValue.number)) }
    }

    public var isItalic: Bool { string("fontStyle") == "italic" }

    public var fills: [Fill] {
        get { models("fills") }
        set { setModels("fills", newValue) }
    }

    /// The text color when the first fill is solid.
    public var colorHex: String? { fills.first?.swatchHex }
}

/// `ParagraphStyle`.
public struct ParagraphStyle: JSONObjectModel {
    public var json: [String: JSONValue]

    public init(json: [String: JSONValue]) { self.json = json }
    public init(from decoder: Decoder) throws { json = try JSONObjectCoding.decode(decoder) }
    public func encode(to encoder: Encoder) throws { try JSONObjectCoding.encode(json, to: encoder) }

    /// `defaultParagraph()` of @desyn/schema.
    public static func standard(align: String = "left") -> ParagraphStyle {
        ParagraphStyle(json: [
            "align": .string(align),
            "direction": "auto",
            "lineHeight": ["unit": "percent", "value": 120],
            "spacing": 0,
            "indent": 0,
            "list": "none",
        ])
    }

    /// `left` | `center` | `right` | `justify`.
    public var align: String {
        get { string("align") ?? "left" }
        set { set("align", .string(newValue)) }
    }
}

/// `TextRun`: a span of text with an optional partial style.
public struct TextRun: JSONObjectModel {
    public var json: [String: JSONValue]

    public init(json: [String: JSONValue]) { self.json = json }
    public init(from decoder: Decoder) throws { json = try JSONObjectCoding.decode(decoder) }
    public func encode(to encoder: Encoder) throws { try JSONObjectCoding.encode(json, to: encoder) }

    public init(text: String, style: [String: JSONValue]? = nil) {
        json = ["text": .string(text)]
        if let style, !style.isEmpty { json["style"] = .object(style) }
    }

    public var text: String {
        get { string("text") ?? "" }
        set { set("text", .string(newValue)) }
    }

    /// The partial style override (nil when the run uses the node style).
    public var style: [String: JSONValue]? { object("style") }

    /// Length in UTF-16 code units (the engine's and UIKit's text offsets).
    public var utf16Count: Int { text.utf16.count }
}
