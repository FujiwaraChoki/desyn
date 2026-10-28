import SwiftUI
import UIKit

/// Desyn colors (docs/DESIGN_SYSTEM.md section 1). Every color has a designed dark and light value; the app is
/// dark-first. The sun is brightened on dark (a light source on a dark sky) and darkened on light for contrast.
public enum Palette {
    // MARK: Accent

    /// The sun: `#FFB02E` on dark, `#D27400` on light.
    public static let sun = Color(uiColor: UIPalette.sun)
    /// Gradient highlight `#FFD66B`.
    public static let sunHi = Color(uiColor: UIPalette.sunHi)
    /// Gradient low (ember) `#FF6A1F`.
    public static let sunLo = Color(uiColor: UIPalette.sunLo)
    /// Text and icons on a sun fill (near-black in both modes; >= 4.5:1 on either sun).
    public static let onSun = Color(uiColor: UIPalette.onSun)

    // MARK: Neutrals

    public static let background = Color(uiColor: UIPalette.background)
    public static let foreground = Color(uiColor: UIPalette.foreground)
    /// Secondary text (>= 4.5:1 on the background and every surface).
    public static let muted = Color(uiColor: UIPalette.muted)
    /// Panels.
    public static let surface1 = Color(uiColor: UIPalette.surface1)
    /// Raised surfaces and inputs.
    public static let surface2 = Color(uiColor: UIPalette.surface2)
    /// Hover / pressed surfaces.
    public static let surface3 = Color(uiColor: UIPalette.surface3)
    /// Foreground at 10%.
    public static let borderSubtle = Color(uiColor: UIPalette.borderSubtle)
    /// Foreground at 20%.
    public static let border = Color(uiColor: UIPalette.border)
    /// Foreground at 40%.
    public static let borderStrong = Color(uiColor: UIPalette.borderStrong)
    /// The editor canvas behind the page.
    public static let canvas = Color(uiColor: UIPalette.canvas)

    // MARK: Status

    public static let success = Color(uiColor: UIPalette.success)
    public static let warning = sun
    public static let danger = Color(uiColor: UIPalette.danger)
    public static let info = Color(uiColor: UIPalette.info)

    // MARK: Gradients

    /// `linear-gradient(135deg, SUN-HI, SUN, SUN-LO)`.
    public static let sunGradient = LinearGradient(
        colors: [sunHi, sun, sunLo],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    /// Warm-first chart and category palette (cool counter-color last).
    public static let categorical: [Color] = [
        "FFB02E", "FF6A1F", "FFD66B", "C4451C", "8A5A00", "E8E1D3", "7A7468", "5AA9FF",
    ].map { Color(hex: $0) }
}

/// UIKit versions of the palette (canvas overlays, Metal clear colors, UIKit controls).
public enum UIPalette {
    public static let sun = UIColor.dynamic(dark: "FFB02E", light: "D27400")
    public static let sunHi = UIColor.dynamic(dark: "FFD66B", light: "E89A1F")
    public static let sunLo = UIColor.dynamic(dark: "FF6A1F", light: "C4451C")
    public static let onSun = UIColor.dynamic(dark: "0A0A0A", light: "0A0A0A")
    public static let background = UIColor.dynamic(dark: "0A0A0A", light: "FFFFFF")
    public static let foreground = UIColor.dynamic(dark: "EDEDED", light: "171717")
    public static let muted = UIColor.dynamic(dark: "918E89", light: "66625C")
    public static let surface1 = UIColor.dynamic(dark: "111111", light: "FAF8F4")
    public static let surface2 = UIColor.dynamic(dark: "171717", light: "F3EFE7")
    public static let surface3 = UIColor.dynamic(dark: "1F1F1F", light: "EAE4D8")
    public static let borderSubtle = UIColor.dynamic(dark: "EDEDED1A", light: "1717171A")
    public static let border = UIColor.dynamic(dark: "EDEDED33", light: "17171733")
    public static let borderStrong = UIColor.dynamic(dark: "EDEDED66", light: "17171766")
    public static let canvas = UIColor.dynamic(dark: "0E0E0E", light: "ECE8DF")
    public static let canvasDot = UIColor.dynamic(dark: "FFFFFF14", light: "1717171A")
    public static let success = UIColor.dynamic(dark: "4ADE80", light: "15803D")
    public static let danger = UIColor.dynamic(dark: "FF5C5C", light: "C62828")
    public static let info = UIColor.dynamic(dark: "7AB8FF", light: "1D5FBF")
    /// Selection outlines and handles on the canvas (the sun in both modes).
    public static let selection = sun
    /// Snap guides: the ember so they read against selection outlines.
    public static let guide = UIColor.dynamic(dark: "FF6A1F", light: "C4451C")
}

public extension UIColor {
    /// A color from `RRGGBB` or `RRGGBBAA` hex (with or without `#`). Invalid input is opaque black.
    convenience init(hex: String) {
        let rgba = HexColor.parse(hex) ?? (0, 0, 0, 1)
        self.init(red: rgba.r, green: rgba.g, blue: rgba.b, alpha: rgba.a)
    }

    /// A trait-dependent color with designed dark and light values.
    static func dynamic(dark: String, light: String) -> UIColor {
        let darkColor = UIColor(hex: dark)
        let lightColor = UIColor(hex: light)
        return UIColor { traits in traits.userInterfaceStyle == .light ? lightColor : darkColor }
    }

    /// `#rrggbb` (or `#rrggbbaa` when not opaque), lowercase, in sRGB.
    var hexString: String {
        var r: CGFloat = 0
        var g: CGFloat = 0
        var b: CGFloat = 0
        var a: CGFloat = 0
        guard getRed(&r, green: &g, blue: &b, alpha: &a) else { return "#000000" }
        return HexColor.format(r: r, g: g, b: b, a: a)
    }
}

public extension Color {
    /// A color from `RRGGBB` / `RRGGBBAA` / `RGB` hex (with or without `#`).
    init(hex: String) {
        self.init(uiColor: UIColor(hex: hex))
    }
}

/// Hex color parsing shared by the palette and the inspector.
public enum HexColor {
    /// Components 0...1 of `RGB`, `RRGGBB` or `RRGGBBAA` (leading `#` optional), or nil.
    public static func parse(_ value: String) -> (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat)? {
        var hex = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if hex.hasPrefix("#") { hex.removeFirst() }
        guard hex.allSatisfy(\.isHexDigit) else { return nil }
        if hex.count == 3 {
            hex = hex.map { "\($0)\($0)" }.joined()
        }
        guard hex.count == 6 || hex.count == 8, let value = UInt64(hex, radix: 16) else { return nil }
        let hasAlpha = hex.count == 8
        let r = CGFloat((value >> (hasAlpha ? 24 : 16)) & 0xFF) / 255
        let g = CGFloat((value >> (hasAlpha ? 16 : 8)) & 0xFF) / 255
        let b = CGFloat((value >> (hasAlpha ? 8 : 0)) & 0xFF) / 255
        let a = hasAlpha ? CGFloat(value & 0xFF) / 255 : 1
        return (r, g, b, a)
    }

    /// `#rrggbb`, or `#rrggbbaa` when `a < 1`.
    public static func format(r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat = 1) -> String {
        func byte(_ c: CGFloat) -> Int { Int((min(1, max(0, c)) * 255).rounded()) }
        let base = String(format: "#%02x%02x%02x", byte(r), byte(g), byte(b))
        return byte(a) >= 255 ? base : base + String(format: "%02x", byte(a))
    }
}
