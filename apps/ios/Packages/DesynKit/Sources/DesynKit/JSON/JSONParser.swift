import Foundation

/// A strict RFC 8259 parser producing `JSONValue` (no Foundation bridging, so booleans and numbers never mix and
/// the result is identical on every platform). Nesting is limited to 512 levels.
struct JSONParser {
    private let bytes: [UInt8]
    private var index = 0
    private var depth = 0

    init(bytes: [UInt8]) {
        self.bytes = bytes
    }

    mutating func parseDocument() throws -> JSONValue {
        skipWhitespace()
        let value = try parseValue()
        skipWhitespace()
        guard index == bytes.count else { throw fail("unexpected trailing characters") }
        return value
    }

    private func fail(_ message: String) -> JSONValueError {
        .invalid("\(message) at offset \(index)")
    }

    private mutating func skipWhitespace() {
        while index < bytes.count, bytes[index] == 0x20 || bytes[index] == 0x0A || bytes[index] == 0x0D || bytes[index] == 0x09 {
            index += 1
        }
    }

    private mutating func parseValue() throws -> JSONValue {
        guard index < bytes.count else { throw fail("unexpected end of input") }
        switch bytes[index] {
        case UInt8(ascii: "{"): return try parseObject()
        case UInt8(ascii: "["): return try parseArray()
        case UInt8(ascii: "\""): return .string(try parseString())
        case UInt8(ascii: "t"): try expect("true"); return .bool(true)
        case UInt8(ascii: "f"): try expect("false"); return .bool(false)
        case UInt8(ascii: "n"): try expect("null"); return .null
        case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return .number(try parseNumber())
        default: throw fail("unexpected character")
        }
    }

    private mutating func expect(_ literal: String) throws {
        for byte in literal.utf8 {
            guard index < bytes.count, bytes[index] == byte else { throw fail("invalid literal") }
            index += 1
        }
    }

    private mutating func enter() throws {
        depth += 1
        guard depth <= 512 else { throw fail("nesting too deep") }
    }

    private mutating func parseObject() throws -> JSONValue {
        try enter()
        defer { depth -= 1 }
        index += 1
        var object: [String: JSONValue] = [:]
        skipWhitespace()
        if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
            index += 1
            return .object(object)
        }
        while true {
            skipWhitespace()
            guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else { throw fail("expected a key") }
            let key = try parseString()
            skipWhitespace()
            guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { throw fail("expected ':'") }
            index += 1
            skipWhitespace()
            object[key] = try parseValue()
            skipWhitespace()
            guard index < bytes.count else { throw fail("unterminated object") }
            if bytes[index] == UInt8(ascii: ",") {
                index += 1
            } else if bytes[index] == UInt8(ascii: "}") {
                index += 1
                return .object(object)
            } else {
                throw fail("expected ',' or '}'")
            }
        }
    }

    private mutating func parseArray() throws -> JSONValue {
        try enter()
        defer { depth -= 1 }
        index += 1
        var array: [JSONValue] = []
        skipWhitespace()
        if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
            index += 1
            return .array(array)
        }
        while true {
            skipWhitespace()
            array.append(try parseValue())
            skipWhitespace()
            guard index < bytes.count else { throw fail("unterminated array") }
            if bytes[index] == UInt8(ascii: ",") {
                index += 1
            } else if bytes[index] == UInt8(ascii: "]") {
                index += 1
                return .array(array)
            } else {
                throw fail("expected ',' or ']'")
            }
        }
    }

    private mutating func parseString() throws -> String {
        index += 1 // opening quote
        var scalars = String.UnicodeScalarView()
        var runStart = index
        var buffer: [UInt8] = []
        func flush(_ end: Int) {
            if end > runStart { buffer.append(contentsOf: bytes[runStart..<end]) }
        }
        while index < bytes.count {
            let byte = bytes[index]
            if byte == UInt8(ascii: "\"") {
                flush(index)
                index += 1
                scalars.append(contentsOf: String(decoding: buffer, as: UTF8.self).unicodeScalars)
                return String(scalars)
            }
            if byte < 0x20 { throw fail("control character in string") }
            if byte == UInt8(ascii: "\\") {
                flush(index)
                scalars.append(contentsOf: String(decoding: buffer, as: UTF8.self).unicodeScalars)
                buffer.removeAll(keepingCapacity: true)
                index += 1
                guard index < bytes.count else { throw fail("unterminated escape") }
                let escape = bytes[index]
                index += 1
                switch escape {
                case UInt8(ascii: "\""): scalars.append("\"")
                case UInt8(ascii: "\\"): scalars.append("\\")
                case UInt8(ascii: "/"): scalars.append("/")
                case UInt8(ascii: "b"): scalars.append("\u{08}")
                case UInt8(ascii: "f"): scalars.append("\u{0C}")
                case UInt8(ascii: "n"): scalars.append("\n")
                case UInt8(ascii: "r"): scalars.append("\r")
                case UInt8(ascii: "t"): scalars.append("\t")
                case UInt8(ascii: "u"):
                    var code = try parseHex4()
                    if (0xD800...0xDBFF).contains(code) {
                        // Surrogate pair: a low surrogate must follow.
                        if index + 1 < bytes.count, bytes[index] == UInt8(ascii: "\\"), bytes[index + 1] == UInt8(ascii: "u") {
                            index += 2
                            let low = try parseHex4()
                            if (0xDC00...0xDFFF).contains(low) {
                                code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
                            } else {
                                scalars.append("\u{FFFD}")
                                code = low
                            }
                        } else {
                            code = 0xFFFD
                        }
                    }
                    scalars.append(Unicode.Scalar(code) ?? "\u{FFFD}")
                default:
                    throw fail("invalid escape")
                }
                runStart = index
                continue
            }
            index += 1
        }
        throw fail("unterminated string")
    }

    private mutating func parseHex4() throws -> UInt32 {
        guard index + 4 <= bytes.count else { throw fail("short unicode escape") }
        var value: UInt32 = 0
        for _ in 0..<4 {
            let byte = bytes[index]
            let digit: UInt32
            switch byte {
            case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt32(byte - UInt8(ascii: "0"))
            case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt32(byte - UInt8(ascii: "a") + 10)
            case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt32(byte - UInt8(ascii: "A") + 10)
            default: throw fail("invalid unicode escape")
            }
            value = value * 16 + digit
            index += 1
        }
        return value
    }

    private mutating func parseNumber() throws -> Double {
        let start = index
        if bytes[index] == UInt8(ascii: "-") { index += 1 }
        guard index < bytes.count else { throw fail("invalid number") }
        if bytes[index] == UInt8(ascii: "0") {
            index += 1
        } else if (UInt8(ascii: "1")...UInt8(ascii: "9")).contains(bytes[index]) {
            while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
        } else {
            throw fail("invalid number")
        }
        if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
            index += 1
            let digits = index
            while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
            guard index > digits else { throw fail("invalid fraction") }
        }
        if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
            index += 1
            if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") { index += 1 }
            let digits = index
            while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
            guard index > digits else { throw fail("invalid exponent") }
        }
        let text = String(decoding: bytes[start..<index], as: UTF8.self)
        guard let value = Double(text) else { throw fail("invalid number") }
        return value
    }
}
