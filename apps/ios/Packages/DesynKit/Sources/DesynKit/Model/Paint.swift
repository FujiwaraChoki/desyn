import Foundation

/// `Fill` (DOCUMENT_MODEL section 3): solid, linear, radial, conic or image paint.
public struct Fill: JSONObjectModel {
    public var json: [String: JSONValue]

    public init(json: [String: JSONValue]) { self.json = json }
    public init(from decoder: Decoder) throws { json = try JSONObjectCoding.decode(decoder) }
    public func encode(to encoder: Encoder) throws { try JSONObjectCoding.encode(json, to: encoder) }

    /// A solid fill (`opacity` omitted when 1).
    public static func solid(_ color: ColorValue, opacity: Double? = nil) -> Fill {
        var json: [String: JSONValue] = ["type": "solid", "color": color.jsonValue]
        if let opacity, opacity < 1 { json["opacity"] = .number(opacity) }
        return Fill(json: json)
    }

    /// A linear gradient at `angle` degrees.
    public static func linear(angle: Double, stops: [GradientStop]) -> Fill {
        Fill(json: ["type": "linear", "angle": .number(angle), "stops": .array(stops.map(\.jsonValue))])
    }

    /// `solid` | `linear` | `radial` | `conic` | `image`.
    public var type: String { string("type") ?? "solid" }

    /// Color of a solid fill.
    public var color: ColorValue? {
        get { ColorValue(json["color"]) }
        set { set("color", newValue?.jsonValue) }
    }

    public var opacity: Double {
        get { number("opacity") ?? 1 }
        set { set("opacity", newValue >= 1 ? nil : .number(max(0, newValue))) }
    }

    public var visible: Bool { bool("visible") ?? true }

    /// Gradient stops (linear / radial / conic).
    public var stops: [GradientStop] { models("stops") }

    /// Asset of an image fill.
    public var assetId: String? { string("assetId") }

    /// The representative color for swatches: the solid color or the first stop.
    public var swatchHex: String? {
        if let hex = color?.hex { return hex }
        return stops.first?.color?.hex
    }
}

/// Gradient `Stop`.
public struct GradientStop: JSONObjectModel {
    public var json: [String: JSONValue]

    public init(json: [String: JSONValue]) { self.json = json }
    public init(from decoder: Decoder) throws { json = try JSONObjectCoding.decode(decoder) }
    public func encode(to encoder: Encoder) throws { try JSONObjectCoding.encode(json, to: encoder) }

    public init(pos: Double, color: ColorValue) {
        json = ["pos": .number(pos), "color": color.jsonValue]
    }

    public var pos: Double { number("pos") ?? 0 }
    public var color: ColorValue? { ColorValue(json["color"]) }
}

/// `Stroke`.
public struct Stroke: JSONObjectModel {
    public var json: [String: JSONValue]

    public init(json: [String: JSONValue]) { self.json = json }
    public init(from decoder: Decoder) throws { json = try JSONObjectCoding.decode(decoder) }
    public func encode(to encoder: Encoder) throws { try JSONObjectCoding.encode(json, to: encoder) }

    /// A stroke with schema defaults (`center`, `butt`, `miter`).
    public init(color: ColorValue, width: Double, align: String = "center", cap: String = "butt", join: String = "miter") {
        json = [
            "fills": .array([Fill.solid(color).jsonValue]),
            "width": .number(width),
            "align": .string(align),
            "cap": .string(cap),
            "join": .string(join),
        ]
    }

    public var fills: [Fill] { models("fills") }

    public var width: Double {
        get { number("width") ?? 0 }
        set { set("width", .number(max(0, newValue))) }
    }

    public var align: String { string("align") ?? "center" }
    public var visible: Bool { bool("visible") ?? true }
}

/// `Effect` (drop / inner shadow, blurs, noise, glow).
public struct Effect: JSONObjectModel {
    public var json: [String: JSONValue]

    public init(json: [String: JSONValue]) { self.json = json }
    public init(from decoder: Decoder) throws { json = try JSONObjectCoding.decode(decoder) }
    public func encode(to encoder: Encoder) throws { try JSONObjectCoding.encode(json, to: encoder) }

    public static func dropShadow(x: Double = 0, y: Double = 8, blur: Double = 24, spread: Double = 0, color: String = "#00000040") -> Effect {
        Effect(json: [
            "type": "dropShadow", "x": .number(x), "y": .number(y), "blur": .number(blur), "spread": .number(spread),
            "color": .string(color),
        ])
    }

    public var type: String { string("type") ?? "" }
    public var visible: Bool { bool("visible") ?? true }
}
