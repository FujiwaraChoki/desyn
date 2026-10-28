import Foundation

/// sRGB color math for the color picker, brand mapping and contrast hints. Components are 0...1.
public struct RGBA: Equatable, Hashable, Sendable {
    public var r: Double
    public var g: Double
    public var b: Double
    public var a: Double

    public init(r: Double, g: Double, b: Double, a: Double = 1) {
        self.r = r
        self.g = g
        self.b = b
        self.a = a
    }

    /// Parses `#rgb`, `#rrggbb` or `#rrggbbaa` (leading `#` optional).
    public init?(hex: String) {
        var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("#") { value.removeFirst() }
        guard value.allSatisfy(\.isHexDigit) else { return nil }
        if value.count == 3 { value = value.map { "\($0)\($0)" }.joined() }
        guard value.count == 6 || value.count == 8, let number = UInt64(value, radix: 16) else { return nil }
        let alpha = value.count == 8
        r = Double((number >> (alpha ? 24 : 16)) & 0xFF) / 255
        g = Double((number >> (alpha ? 16 : 8)) & 0xFF) / 255
        b = Double((number >> (alpha ? 8 : 0)) & 0xFF) / 255
        a = alpha ? Double(number & 0xFF) / 255 : 1
    }

    /// `#rrggbb`, or `#rrggbbaa` when not opaque (lowercase, the document model's `Color`).
    public var hex: String {
        func byte(_ c: Double) -> Int { Int((min(1, max(0, c)) * 255).rounded()) }
        let base = String(format: "#%02x%02x%02x", byte(r), byte(g), byte(b))
        return byte(a) >= 255 ? base : base + String(format: "%02x", byte(a))
    }

    /// `#rrggbb` without alpha.
    public var opaqueHex: String { RGBA(r: r, g: g, b: b, a: 1).hex }

    /// WCAG relative luminance.
    public var luminance: Double {
        func channel(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }

    /// WCAG contrast ratio (1...21) against `other`.
    public func contrast(with other: RGBA) -> Double {
        let l1 = luminance, l2 = other.luminance
        return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }

    /// Readable text color on this background (near-black or white).
    public var readableTextHex: String {
        contrast(with: RGBA(r: 1, g: 1, b: 1)) >= contrast(with: RGBA(r: 0.067, g: 0.067, b: 0.067)) ? "#ffffff" : "#111111"
    }

    /// Hue (degrees 0..<360), saturation and value (0...1).
    public var hsv: HSV {
        let maxC = max(r, g, b), minC = min(r, g, b)
        let delta = maxC - minC
        var hue = 0.0
        if delta > 0 {
            if maxC == r {
                hue = 60 * ((g - b) / delta).truncatingRemainder(dividingBy: 6)
            } else if maxC == g {
                hue = 60 * ((b - r) / delta + 2)
            } else {
                hue = 60 * ((r - g) / delta + 4)
            }
        }
        if hue < 0 { hue += 360 }
        return HSV(h: hue, s: maxC == 0 ? 0 : delta / maxC, v: maxC, a: a)
    }

    /// Linear interpolation (gradient previews).
    public func mixed(with other: RGBA, _ t: Double) -> RGBA {
        RGBA(r: r + (other.r - r) * t, g: g + (other.g - g) * t, b: b + (other.b - b) * t, a: a + (other.a - a) * t)
    }
}

/// Hue / saturation / value color (the picker's area and hue track).
public struct HSV: Equatable, Hashable, Sendable {
    public var h: Double
    public var s: Double
    public var v: Double
    public var a: Double

    public init(h: Double, s: Double, v: Double, a: Double = 1) {
        self.h = h
        self.s = s
        self.v = v
        self.a = a
    }

    public var rgba: RGBA {
        let hue = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        let c = v * s
        let x = c * (1 - abs((hue / 60).truncatingRemainder(dividingBy: 2) - 1))
        let m = v - c
        let (r, g, b): (Double, Double, Double)
        switch hue {
        case 0..<60: (r, g, b) = (c, x, 0)
        case 60..<120: (r, g, b) = (x, c, 0)
        case 120..<180: (r, g, b) = (0, c, x)
        case 180..<240: (r, g, b) = (0, x, c)
        case 240..<300: (r, g, b) = (x, 0, c)
        default: (r, g, b) = (c, 0, x)
        }
        return RGBA(r: r + m, g: g + m, b: b + m, a: a)
    }
}

/// Recently used colors (picker history), most recent first, without duplicates.
public struct RecentColors: Equatable, Sendable {
    public private(set) var colors: [String]
    public let limit: Int

    public init(colors: [String] = [], limit: Int = 12) {
        self.limit = limit
        self.colors = Array(colors.prefix(limit))
    }

    public mutating func add(_ hex: String) {
        let normalized = hex.lowercased()
        colors.removeAll { $0 == normalized }
        colors.insert(normalized, at: 0)
        if colors.count > limit { colors.removeLast(colors.count - limit) }
    }
}
