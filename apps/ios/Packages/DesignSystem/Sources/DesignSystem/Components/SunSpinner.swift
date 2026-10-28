import SwiftUI

/// The loading indicator: a small luminous sun disc with slowly rotating rays. With Reduce Motion the rays stay
/// still and the disc breathes gently instead.
public struct SunSpinner: View {
    private let size: CGFloat
    private let tint: Color?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(size: CGFloat = 28, tint: Color? = nil) {
        self.size = size
        self.tint = tint
    }

    public var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            Canvas { gc, canvasSize in
                draw(in: &gc, size: canvasSize, time: t)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel("Loading")
        .accessibilityAddTraits(.updatesFrequently)
    }

    private func draw(in gc: inout GraphicsContext, size canvas: CGSize, time: TimeInterval) {
        let center = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
        let radius = min(canvas.width, canvas.height) / 2
        let rayCount = 10
        let rotation = reduceMotion ? 0 : (time.truncatingRemainder(dividingBy: 6) / 6) * 2 * .pi
        let breathe = reduceMotion ? 0.92 + 0.08 * sin(time * 2) : 1
        let color = tint ?? Palette.sun

        // Rays: tapered capsules, each fading with its phase so the corona seems to turn.
        for i in 0..<rayCount {
            let angle = rotation + Double(i) / Double(rayCount) * 2 * .pi
            let phase = (sin(time * 3 + Double(i) * 0.9) + 1) / 2
            let inner = radius * 0.62
            let outer = radius * (reduceMotion ? 0.92 : 0.82 + 0.16 * phase)
            var ray = Path()
            ray.move(to: CGPoint(x: center.x + cos(angle) * inner, y: center.y + sin(angle) * inner))
            ray.addLine(to: CGPoint(x: center.x + cos(angle) * outer, y: center.y + sin(angle) * outer))
            gc.stroke(
                ray,
                with: .color(color.opacity(reduceMotion ? 0.6 : 0.35 + 0.5 * phase)),
                style: StrokeStyle(lineWidth: max(1.5, radius * 0.11), lineCap: .round)
            )
        }

        // Disc with a hot center.
        let discRadius = radius * 0.46 * breathe
        let disc = Path(ellipseIn: CGRect(
            x: center.x - discRadius, y: center.y - discRadius, width: discRadius * 2, height: discRadius * 2
        ))
        if tint == nil {
            gc.fill(disc, with: .radialGradient(
                Gradient(colors: [Palette.sunHi, Palette.sun, Palette.sunLo]),
                center: CGPoint(x: center.x - discRadius * 0.3, y: center.y - discRadius * 0.3),
                startRadius: 0,
                endRadius: discRadius * 1.4
            ))
        } else {
            gc.fill(disc, with: .color(color))
        }
    }
}

/// A full-area loading state: spinner plus an optional calm sentence.
public struct LoadingState: View {
    private let message: String?

    public init(_ message: String? = nil) {
        self.message = message
    }

    public var body: some View {
        VStack(spacing: Spacing.md) {
            SunSpinner(size: 36)
            if let message {
                Text(message)
                    .font(.dsCallout)
                    .foregroundStyle(Palette.muted)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
