import SwiftUI

/// The mark's two crop corners (top left, bottom right) on the 48-unit grid shared with the web
/// SVG: `M6 17V6h11M31 42h11V31`.
struct CropCorners: Shape {
    func path(in rect: CGRect) -> Path {
        let u = min(rect.width, rect.height) / 48
        let o = CGPoint(x: rect.midX - 24 * u, y: rect.midY - 24 * u)
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: o.x + x * u, y: o.y + y * u) }
        var path = Path()
        path.move(to: p(6, 17)); path.addLine(to: p(6, 6)); path.addLine(to: p(17, 6))
        path.move(to: p(31, 42)); path.addLine(to: p(42, 42)); path.addLine(to: p(42, 31))
        return path
    }
}

/// The Desyn mark: two print crop corners around the sun.
public struct CropMark: View {
    private let size: CGFloat

    public init(size: CGFloat) {
        self.size = size
    }

    public var body: some View {
        ZStack {
            CropCorners()
                .stroke(Palette.foreground, style: StrokeStyle(lineWidth: max(1, size * 2.5 / 48), lineCap: .square))
            Circle()
                .fill(Palette.sun)
                .frame(width: size * 17 / 48, height: size * 17 / 48)
        }
        .frame(width: size, height: size)
    }
}

/// The brand: the crop mark next to lowercase "desyn" in Instrument Serif.
public struct SunMark: View {
    private let size: CGFloat
    private let showsWordmark: Bool

    public init(size: CGFloat = 28, showsWordmark: Bool = true) {
        self.size = size
        self.showsWordmark = showsWordmark
    }

    public var body: some View {
        HStack(alignment: .center, spacing: size * 0.28) {
            CropMark(size: size * 1.1)
            if showsWordmark {
                Text("desyn")
                    .font(DSFont.serif(size, relativeTo: .title))
                    .foregroundStyle(Palette.foreground)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Desyn")
    }
}

/// The mark at hero size for the welcome screen.
public struct SunHero: View {
    private let diameter: CGFloat

    public init(diameter: CGFloat = 180) {
        self.diameter = diameter
    }

    public var body: some View {
        CropMark(size: diameter)
            .accessibilityHidden(true)
    }
}
