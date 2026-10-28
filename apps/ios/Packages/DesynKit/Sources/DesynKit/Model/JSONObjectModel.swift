import Foundation

/// A contract type stored as its JSON object, with typed accessors for the fields this client uses. Storing the
/// object (instead of only the typed fields) keeps unknown and optional keys exactly as they arrived, which the
/// document model requires for forward compatibility.
public protocol JSONObjectModel: Codable, Hashable, Sendable {
    var json: [String: JSONValue] { get set }
    init(json: [String: JSONValue])
}

public extension JSONObjectModel {
    /// Parses a JSON object text.
    init(jsonString: String) throws {
        guard case let .object(object) = try JSONValue.parse(jsonString) else {
            throw JSONValueError.invalid("expected a JSON object")
        }
        self.init(json: object)
    }

    /// The object as a `JSONValue`.
    var jsonValue: JSONValue { .object(json) }

    /// Deterministic JSON text (sorted keys).
    func serialized() -> String { jsonValue.serialized() }

    // MARK: Field helpers

    func string(_ key: String) -> String? { json[key]?.stringValue }
    func number(_ key: String) -> Double? { json[key]?.doubleValue }
    func bool(_ key: String) -> Bool? { json[key]?.boolValue }
    func object(_ key: String) -> [String: JSONValue]? { json[key]?.objectValue }

    /// Nested model (`nil` when missing or not an object).
    func model<M: JSONObjectModel>(_ key: String, as type: M.Type = M.self) -> M? {
        json[key]?.objectValue.map(M.init(json:))
    }

    /// Array of nested models (objects only; other entries are skipped).
    func models<M: JSONObjectModel>(_ key: String, as type: M.Type = M.self) -> [M] {
        (json[key]?.arrayValue ?? []).compactMap { $0.objectValue.map(M.init(json:)) }
    }

    /// Sets or removes (`nil`) a key.
    mutating func set(_ key: String, _ value: JSONValue?) {
        json[key] = value
    }

    mutating func setModels<M: JSONObjectModel>(_ key: String, _ values: [M]) {
        json[key] = .array(values.map(\.jsonValue))
    }
}

/// Coding helpers for `JSONObjectModel` conformers (each type forwards its `Codable` requirements here so the
/// wire format is the bare object, never a synthesized `{"json": ...}` wrapper).
public enum JSONObjectCoding {
    public static func decode(_ decoder: Decoder) throws -> [String: JSONValue] {
        let value = try JSONValue(from: decoder)
        guard case let .object(object) = value else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "expected an object"))
        }
        return object
    }

    public static func encode(_ object: [String: JSONValue], to encoder: Encoder) throws {
        try JSONValue.object(object).encode(to: encoder)
    }
}

/// `Color | ColorRef` (DOCUMENT_MODEL section 2): a hex color or a reference resolved by the engine.
public enum ColorValue: Hashable, Sendable {
    case hex(String)
    case variable(String)
    case style(String)

    public init?(_ value: JSONValue?) {
        switch value {
        case let .string(hex)?:
            self = .hex(hex)
        case let .object(object)?:
            if let name = object["$var"]?.stringValue {
                self = .variable(name)
            } else if let id = object["$style"]?.stringValue {
                self = .style(id)
            } else {
                return nil
            }
        default:
            return nil
        }
    }

    public var jsonValue: JSONValue {
        switch self {
        case let .hex(hex): .string(hex)
        case let .variable(name): ["$var": .string(name)]
        case let .style(id): ["$style": .string(id)]
        }
    }

    /// The literal hex, when this is not a reference.
    public var hex: String? {
        if case let .hex(value) = self { return value }
        return nil
    }
}

/// `number | [tl, tr, br, bl]`.
public enum CornerRadius: Hashable, Sendable {
    case uniform(Double)
    case corners(Double, Double, Double, Double)

    public init(_ value: JSONValue?) {
        if case let .array(values)? = value, values.count == 4 {
            let n = values.map { $0.doubleValue ?? 0 }
            self = .corners(n[0], n[1], n[2], n[3])
        } else {
            self = .uniform(value?.doubleValue ?? 0)
        }
    }

    public var jsonValue: JSONValue {
        switch self {
        case let .uniform(value): .number(value)
        case let .corners(tl, tr, br, bl): .array([.number(tl), .number(tr), .number(br), .number(bl)])
        }
    }

    /// The uniform radius (the largest corner for per-corner radii).
    public var maxValue: Double {
        switch self {
        case let .uniform(value): value
        case let .corners(tl, tr, br, bl): max(tl, tr, br, bl)
        }
    }
}
