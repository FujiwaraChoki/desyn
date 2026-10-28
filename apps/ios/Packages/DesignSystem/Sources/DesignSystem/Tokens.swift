import SwiftUI

/// 8 pt grid with 4 pt half steps (docs/DESIGN_SYSTEM.md section 3).
public enum Spacing {
    public static let xxs: CGFloat = 2
    public static let xs: CGFloat = 4
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
    public static let xl: CGFloat = 24
    public static let xxl: CGFloat = 32
    public static let xxxl: CGFloat = 48
    /// Screen side margins.
    public static let gutter: CGFloat = 20
    /// Minimum touch target (Apple HIG, DESIGN_SYSTEM section 8).
    public static let touchTarget: CGFloat = 44
}

/// Corner radii: controls, cards, panels / dialogs, pills.
public enum Radius {
    public static let control: CGFloat = 6
    public static let field: CGFloat = 10
    public static let card: CGFloat = 10
    public static let panel: CGFloat = 14
    public static let sheet: CGFloat = 20
    public static let pill: CGFloat = 999
}

/// Motion tokens (section 4). Use `Motion.animation(_:reduced:)` to honor Reduce Motion.
public enum Motion {
    /// `cubic-bezier(.16, 1, .3, 1)`.
    public static func easeOut(_ duration: Double = 0.5) -> Animation {
        .timingCurve(0.16, 1, 0.3, 1, duration: duration)
    }

    /// `cubic-bezier(.65, 0, .35, 1)`.
    public static func easeInOut(_ duration: Double = 0.4) -> Animation {
        .timingCurve(0.65, 0, 0.35, 1, duration: duration)
    }

    /// Panel spring (stiffness 300, damping 30).
    public static let panel = Animation.interpolatingSpring(stiffness: 300, damping: 30)
    /// Hover / press feedback.
    public static let quick = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.2)
    /// Entrance stagger between items.
    public static let stagger: Double = 0.08

    /// `animation`, or a short cross-fade when Reduce Motion is on.
    public static func animation(_ animation: Animation, reduced: Bool) -> Animation {
        reduced ? .linear(duration: 0.15) : animation
    }
}

/// Elevation is light, not shadow: borders plus a soft sun glow on primary actions and active selection.
public extension View {
    /// `--shadow-glow`: a soft sun glow (primary buttons, active selection).
    func dsGlow(_ active: Bool = true, radius: CGFloat = 18) -> some View {
        shadow(color: active ? Palette.sun.opacity(0.35) : .clear, radius: radius, x: 0, y: 0)
    }

    /// `--shadow-card`: `0 20px 60px -40px rgb(sun / .4)`.
    func dsCardShadow() -> some View {
        shadow(color: Palette.sun.opacity(0.18), radius: 30, x: 0, y: 20)
    }
}
