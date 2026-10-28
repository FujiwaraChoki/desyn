import SwiftUI

/// The atmospheric background: soft blurred sun orbs drifting over the page background on 15-30 s loops.
/// Static with Reduce Motion. Place it behind content with `.background { OrbsBackground() }`.
public struct OrbsBackground: View {
    private let intensity: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    /// `intensity` scales the orb opacity (1 = DESIGN_SYSTEM's 22-30%).
    public init(intensity: Double = 1) {
        self.intensity = intensity
    }

    private struct Orb {
        let color: Color
        let size: CGFloat
        let anchor: UnitPoint
        let period: Double
        let drift: CGSize
        let opacity: Double
    }

    private var orbs: [Orb] {
        [
            Orb(color: Palette.sun, size: 1.1, anchor: UnitPoint(x: 0.85, y: 0.08), period: 22, drift: CGSize(width: 40, height: 30), opacity: 0.30),
            Orb(color: Palette.sunLo, size: 0.9, anchor: UnitPoint(x: 0.1, y: 0.55), period: 28, drift: CGSize(width: 50, height: -35), opacity: 0.22),
            Orb(color: Palette.sunHi, size: 0.7, anchor: UnitPoint(x: 0.7, y: 0.95), period: 17, drift: CGSize(width: -30, height: 25), opacity: 0.24),
        ]
    }

    public var body: some View {
        GeometryReader { proxy in
            TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
                let t = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
                ZStack {
                    Palette.background
                    ForEach(Array(orbs.enumerated()), id: \.offset) { _, orb in
                        let base = max(proxy.size.width, proxy.size.height) * orb.size * 0.6
                        let phase = t / orb.period * 2 * .pi
                        Circle()
                            .fill(orb.color)
                            .frame(width: base, height: base)
                            .opacity(orb.opacity * intensity * (colorScheme == .light ? 0.55 : 1))
                            .blur(radius: base * 0.28)
                            .position(
                                x: proxy.size.width * orb.anchor.x + CGFloat(sin(phase)) * orb.drift.width,
                                y: proxy.size.height * orb.anchor.y + CGFloat(cos(phase * 0.8)) * orb.drift.height
                            )
                    }
                }
                .drawingGroup()
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}
