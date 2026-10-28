import SwiftUI

/// Button variants (docs/DESIGN_SYSTEM.md section 5).
public enum DSButtonKind: Sendable {
    /// Sun fill, near-black text, glow.
    case primary
    /// Surface-2 fill with a 1 pt border.
    case secondary
    /// Text only.
    case ghost
    /// Destructive.
    case danger
}

public enum DSButtonSize: Sendable {
    case small, regular, large

    var height: CGFloat {
        switch self {
        case .small: 36
        case .regular: Spacing.touchTarget
        case .large: 52
        }
    }

    var font: Font {
        switch self {
        case .small: DSFont.sans(14, weight: .semibold, relativeTo: .callout)
        case .regular: .dsButton
        case .large: DSFont.sans(17, weight: .semibold, relativeTo: .body)
        }
    }

    var horizontalPadding: CGFloat {
        switch self {
        case .small: Spacing.md
        case .regular: Spacing.lg
        case .large: Spacing.xl
        }
    }
}

/// The Desyn button style. Full-width when the label is given `.frame(maxWidth: .infinity)`.
public struct DSButtonStyle: ButtonStyle {
    let kind: DSButtonKind
    let size: DSButtonSize

    public init(_ kind: DSButtonKind = .primary, size: DSButtonSize = .regular) {
        self.kind = kind
        self.size = size
    }

    public func makeBody(configuration: Configuration) -> some View {
        StyledButton(configuration: configuration, kind: kind, size: size)
    }

    private struct StyledButton: View {
        let configuration: Configuration
        let kind: DSButtonKind
        let size: DSButtonSize
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .font(size.font)
                .lineLimit(1)
                .padding(.horizontal, size.horizontalPadding)
                .frame(minHeight: size.height)
                .foregroundStyle(foreground)
                .background(background)
                .overlay(border)
                .clipShape(RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                .dsGlow(kind == .primary && isEnabled && !configuration.isPressed, radius: 14)
                .opacity(isEnabled ? 1 : 0.45)
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
                .animation(Motion.quick, value: configuration.isPressed)
                .contentShape(RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
        }

        private var foreground: Color {
            switch kind {
            case .primary: Palette.onSun
            case .secondary: Palette.foreground
            case .ghost: Palette.sun
            case .danger: Palette.danger
            }
        }

        @ViewBuilder private var background: some View {
            switch kind {
            case .primary:
                Palette.sun.overlay(Color.black.opacity(configuration.isPressed ? 0.12 : 0))
            case .secondary:
                configuration.isPressed ? Palette.surface3 : Palette.surface2
            case .ghost:
                configuration.isPressed ? Palette.surface2 : Color.clear
            case .danger:
                Palette.danger.opacity(configuration.isPressed ? 0.2 : 0.12)
            }
        }

        @ViewBuilder private var border: some View {
            switch kind {
            case .secondary:
                RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                    .strokeBorder(Palette.border, lineWidth: 1)
            case .danger:
                RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                    .strokeBorder(Palette.danger.opacity(0.4), lineWidth: 1)
            case .primary, .ghost:
                EmptyView()
            }
        }
    }
}

public extension ButtonStyle where Self == DSButtonStyle {
    static var dsPrimary: DSButtonStyle { DSButtonStyle(.primary) }
    static var dsSecondary: DSButtonStyle { DSButtonStyle(.secondary) }
    static var dsGhost: DSButtonStyle { DSButtonStyle(.ghost) }
    static var dsDanger: DSButtonStyle { DSButtonStyle(.danger) }
}

/// A full-width button with an optional icon and a sun spinner while `isLoading`.
public struct DSButton: View {
    private let title: String
    private let systemImage: String?
    private let kind: DSButtonKind
    private let size: DSButtonSize
    private let isLoading: Bool
    private let action: () -> Void

    public init(
        _ title: String,
        systemImage: String? = nil,
        kind: DSButtonKind = .primary,
        size: DSButtonSize = .regular,
        isLoading: Bool = false,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.kind = kind
        self.size = size
        self.isLoading = isLoading
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.sm) {
                if isLoading {
                    SunSpinner(size: 18, tint: kind == .primary ? Palette.onSun : Palette.sun)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .imageScale(.medium)
                }
                Text(title)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(DSButtonStyle(kind, size: size))
        .disabled(isLoading)
        .accessibilityLabel(title)
        .accessibilityValue(isLoading ? Text("In progress") : Text(""))
    }
}

/// A round 44 pt icon button on a glass or surface background (toolbars over the canvas).
public struct DSIconButton: View {
    private let systemImage: String
    private let label: String
    private let isActive: Bool
    private let size: CGFloat
    private let action: () -> Void

    public init(_ systemImage: String, label: String, isActive: Bool = false, size: CGFloat = Spacing.touchTarget, action: @escaping () -> Void) {
        self.systemImage = systemImage
        self.label = label
        self.isActive = isActive
        self.size = size
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.4, weight: .medium))
                .frame(width: size, height: size)
                .foregroundStyle(isActive ? Palette.onSun : Palette.foreground)
                .background {
                    Circle().fill(isActive ? AnyShapeStyle(Palette.sun) : AnyShapeStyle(Color.clear))
                }
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .dsGlow(isActive, radius: 10)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

/// Scale-on-press feedback without other styling.
public struct PressScaleStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(Motion.quick, value: configuration.isPressed)
    }
}
