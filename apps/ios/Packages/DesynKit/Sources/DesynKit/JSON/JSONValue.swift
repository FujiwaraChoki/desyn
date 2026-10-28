import Foundation

/// Any JSON value. Design content is carried as `JSONValue` so keys this client does not know survive a round
/// trip untouched (DOCUMENT_MODEL: "Unknown keys are preserved").
///
/// Serialization (`serialized()`) is deterministic: object keys sorted, integral numbers without a fraction
/// (`6`, not `6.0`, so integer fields in the Rust engine accept them), other numbers in their shortest
/// round-trip form, `-0` written as `0`, and strings escaped per RFC 8259.
public enum JSONValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    // MARK: Accessors

    public var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    public var doubleValue: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    public var intValue: Int? {
        guard case let .number(value) = self, value.isFinite, value.rounded() == value,
              abs(value) < 9_007_199_254_740_992
        else { return nil }
        return Int(value)
    }

    public var boolValue: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case let .array(value) = self { return value }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case let .object(value) = self { return value }
        return nil
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    /// Member of an object (nil for other values or missing keys).
    public subscript(key: String) -> JSONValue? {
        get { objectValue?[key] }
        set {
            guard case var .object(object) = self else { return }
            object[key] = newValue
            self = .object(object)
        }
    }

    /// Element of an array (nil when out of range or not an array).
    public subscript(index: Int) -> JSONValue? {
        guard case let .array(array) = self, array.indices.contains(index) else { return nil }
        return array[index]
    }

    // MARK: Parsing

    /// Parses JSON text. Throws `JSONValueError.invalid` for malformed input.
    public static func parse(_ text: String) throws -> JSONValue {
        try parse(Data(text.utf8))
    }

    /// Parses JSON bytes (RFC 8259; top-level scalars allowed).
    public static func parse(_ data: Data) throws -> JSONValue {
        var parser = JSONParser(bytes: [UInt8](data))
        return try parser.parseDocument()
    }

    // MARK: Serialization

    /// Deterministic compact JSON text.
    public func serialized() -> String {
        var out = ""
        write(to: &out)
        return out
    }

    private func write(to out: inout String) {
        switch self {
        case .null:
            out += "null"
        case let .bool(value):
            out += value ? "true" : "false"
        case let .number(value):
            out += JSONValue.format(number: value)
        case let .string(value):
            JSONValue.writeString(value, to: &out)
        case let .array(values):
            out += "["
            for (index, value) in values.enumerated() {
                if index > 0 { out += "," }
                value.write(to: &out)
            }
            out += "]"
        case let .object(object):
            out += "{"
            for (index, key) in object.keys.sorted().enumerated() {
                if index > 0 { out += "," }
                JSONValue.writeString(key, to: &out)
                out += ":"
                object[key]!.write(to: &out)
            }
            out += "}"
        }
    }

    /// JSON number text: integral values without a fraction, `-0` as `0`, non-finite values as `null`
    /// (JSON has no NaN / infinity).
    public static func format(number value: Double) -> String {
        guard value.isFinite else { return "null" }
        if value == 0 { return "0" }
        if value.rounded() == value, abs(value) < 1e15 {
            return String(Int64(value))
        }
        // Swift's description is the shortest representation that round-trips.
        return "\(value)"
    }

    private static func writeString(_ value: String, to out: inout String) {
        out += "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }

    // MARK: Typed bridging

    /// Decodes a `Decodable` from this value.
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(serialized().utf8))
    }

    /// Encodes an `Encodable` into a value.
    public static func encode<T: Encodable>(_ value: T) throws -> JSONValue {
        try parse(JSONEncoder().encode(value))
    }
}

public enum JSONValueError: Error, Equatable, LocalizedError {
    case invalid(String)

    public var errorDescription: String? {
        switch self {
        case let .invalid(detail): "Invalid JSON: \(detail)"
        }
    }
}

// MARK: Codable (so typed responses can embed raw JSON)

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "not a JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }
}

// MARK: Literals

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
    ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }

    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        var object: [String: JSONValue] = [:]
        for (key, value) in elements {
            object[key] = value
        }
        self = .object(object)
    }
}

public extension JSONValue {
    /// `.number` from any binary integer.
    static func int<I: BinaryInteger>(_ value: I) -> JSONValue { .number(Double(value)) }
    /// `.array` of strings.
    static func strings(_ values: [String]) -> JSONValue { .array(values.map(JSONValue.string)) }
}
