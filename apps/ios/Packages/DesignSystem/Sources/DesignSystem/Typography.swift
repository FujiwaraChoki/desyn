import CoreText
import SwiftUI
import UIKit

/// Bundled typefaces (docs/DESIGN_SYSTEM.md section 2): Instrument Serif for display (one weight; hierarchy comes
/// from size, color and italics), Instrument Sans (variable 400-600) for UI, JetBrains Mono for ids and numbers.
/// All sizes scale with Dynamic Type relative to a text style.
public enum DSFont {
    public static let serifRegular = "InstrumentSerif-Regular"
    public static let serifItalic = "InstrumentSerif-Italic"
    public static let sansFamily = "Instrument Sans"
    public static let monoFamily = "JetBrains Mono"

    private static let files = [
        "InstrumentSerif-Regular", "InstrumentSerif-Italic", "InstrumentSans-VF", "InstrumentSans-Italic-VF",
        "JetBrainsMono-VF",
    ]
    nonisolated(unsafe) private static var registered = false
    private static let lock = NSLock()

    /// Registers the bundled fonts with Core Text for this process. Idempotent; call once at launch.
    public static func registerFonts() {
        lock.lock()
        defer { lock.unlock() }
        guard !registered else { return }
        registered = true
        for name in files {
            guard let url = Bundle.module.url(forResource: name, withExtension: "ttf", subdirectory: "Fonts") else {
                assertionFailure("missing bundled font \(name).ttf")
                continue
            }
            var error: Unmanaged<CFError>?
            if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                // Already registered (e.g. by a previous test host launch) is not a problem.
                error?.release()
            }
        }
    }

    /// Instrument Serif at `size` points, scaled with `textStyle`.
    public static func serif(_ size: CGFloat, italic: Bool = false, relativeTo textStyle: Font.TextStyle = .title) -> Font {
        .custom(italic ? serifItalic : serifRegular, size: size, relativeTo: textStyle)
    }

    /// Instrument Sans at `size` points and `weight` (400-600 are designed; others snap to the nearest).
    public static func sans(
        _ size: CGFloat,
        weight: Font.Weight = .regular,
        relativeTo textStyle: Font.TextStyle = .body
    ) -> Font {
        .custom(sansFamily, size: size, relativeTo: textStyle).weight(weight)
    }

    /// JetBrains Mono at `size` points.
    public static func mono(_ size: CGFloat, relativeTo textStyle: Font.TextStyle = .body) -> Font {
        .custom(monoFamily, size: size, relativeTo: textStyle)
    }

    /// UIKit Instrument Sans (Dynamic Type scaled), for UIKit chrome on the canvas.
    public static func uiSans(_ size: CGFloat, weight: UIFont.Weight = .regular, textStyle: UIFont.TextStyle = .body) -> UIFont {
        let descriptor = UIFontDescriptor(fontAttributes: [
            .family: sansFamily,
            .traits: [UIFontDescriptor.TraitKey.weight: weight.rawValue],
        ])
        let font = UIFont(descriptor: descriptor, size: size)
        return UIFontMetrics(forTextStyle: textStyle).scaledFont(for: font)
    }

    /// UIKit JetBrains Mono (measurement labels on the canvas).
    public static func uiMono(_ size: CGFloat) -> UIFont {
        UIFont(name: "JetBrainsMono-Regular", size: size) ?? .monospacedDigitSystemFont(ofSize: size, weight: .regular)
    }
}

/// The app type scale: 11 / 12 / 13 / 14 / 16 / 20 sans, 28+ serif.
public extension Font {
    /// 34 pt serif: screen titles.
    static let dsLargeTitle = DSFont.serif(34, relativeTo: .largeTitle)
    /// 28 pt serif: section titles, dialog titles, empty states.
    static let dsTitle = DSFont.serif(28, relativeTo: .title)
    /// 22 pt serif: card titles in empty states and sheets.
    static let dsTitle2 = DSFont.serif(22, relativeTo: .title2)
    /// 20 pt sans medium.
    static let dsHeadline = DSFont.sans(20, weight: .medium, relativeTo: .headline)
    /// 16 pt sans.
    static let dsBody = DSFont.sans(16, relativeTo: .body)
    /// 16 pt sans semibold (buttons).
    static let dsButton = DSFont.sans(16, weight: .semibold, relativeTo: .body)
    /// 14 pt sans.
    static let dsCallout = DSFont.sans(14, relativeTo: .callout)
    /// 13 pt sans.
    static let dsSubheadline = DSFont.sans(13, relativeTo: .subheadline)
    /// 12 pt sans.
    static let dsFootnote = DSFont.sans(12, relativeTo: .footnote)
    /// 11 pt sans.
    static let dsCaption = DSFont.sans(11, relativeTo: .caption)
    /// 12 pt sans semibold (labels / eyebrows).
    static let dsLabel = DSFont.sans(12, weight: .semibold, relativeTo: .caption)
    /// 13 pt mono.
    static let dsMono = DSFont.mono(13, relativeTo: .footnote)
}

public extension View {
    /// Eyebrow label style: small, sentence case, muted.
    func dsEyebrow() -> some View {
        font(.dsLabel)
            .foregroundStyle(Palette.muted)
    }
}

/// Serif headline text where words wrapped in `*asterisks*` are set in italic sun (the brand's one italic word):
/// `SerifHeadline("design at the speed of *light*.")`.
public struct SerifHeadline: View {
    private let markup: String
    private let size: CGFloat
    private let textStyle: Font.TextStyle

    public init(_ markup: String, size: CGFloat = 34, relativeTo textStyle: Font.TextStyle = .largeTitle) {
        self.markup = markup
        self.size = size
        self.textStyle = textStyle
    }

    public var body: some View {
        Text(Self.attributed(markup, size: size, textStyle: textStyle))
            .foregroundStyle(Palette.foreground)
            .accessibilityAddTraits(.isHeader)
    }

    /// Splits `markup` on `*` and styles odd segments as italic sun.
    static func attributed(_ markup: String, size: CGFloat, textStyle: Font.TextStyle) -> AttributedString {
        var result = AttributedString()
        for (index, part) in markup.split(separator: "*", omittingEmptySubsequences: false).enumerated() {
            guard !part.isEmpty else { continue }
            var segment = AttributedString(String(part))
            let emphasized = index % 2 == 1
            segment.font = DSFont.serif(size, italic: emphasized, relativeTo: textStyle)
            if emphasized {
                segment.foregroundColor = Palette.sun
            }
            result.append(segment)
        }
        return result
    }
}
