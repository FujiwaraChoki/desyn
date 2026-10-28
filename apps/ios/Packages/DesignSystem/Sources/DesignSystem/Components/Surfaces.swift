import SwiftUI

/// Glass for floating bars, menus and popovers over the canvas: material blur with the surface at 72% and a
/// subtle border (`backdrop-filter: blur(20px) saturate(1.2)` on the web).
public struct GlassBackground: ViewModifier {
    let cornerRadius: CGFloat

    public func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay {
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                            .fill(Palette.surface1.opacity(0.72))
                    }
            }
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(Palette.borderSubtle, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .shadow(color: .black.opacity(0.25), radius: 24, x: 0, y: 12)
    }
}

public extension View {
    /// Glass panel background (floating toolbars, docks, menus).
    func dsGlass(cornerRadius: CGFloat = Radius.panel) -> some View {
        modifier(GlassBackground(cornerRadius: cornerRadius))
    }
}

/// A horizontal glass bar for floating toolbars.
public struct GlassBar<Content: View>: View {
    private let content: Content
    private let cornerRadius: CGFloat

    public init(cornerRadius: CGFloat = Radius.pill, @ViewBuilder content: () -> Content) {
        self.content = content()
        self.cornerRadius = cornerRadius
    }

    public var body: some View {
        HStack(spacing: Spacing.xs) {
            content
        }
        .padding(.horizontal, Spacing.xs + 2)
        .padding(.vertical, Spacing.xs)
        .dsGlass(cornerRadius: min(cornerRadius, 30))
    }
}

/// A card: surface-1, 1 pt subtle border, 10 pt radius.
public struct DSCard<Content: View>: View {
    private let content: Content
    private let padding: CGFloat
    private let highlighted: Bool

    public init(padding: CGFloat = Spacing.lg, highlighted: Bool = false, @ViewBuilder content: () -> Content) {
        self.content = content()
        self.padding = padding
        self.highlighted = highlighted
    }

    public var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface1, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(highlighted ? Palette.sun.opacity(0.6) : Palette.borderSubtle, lineWidth: 1)
            }
            .dsGlow(highlighted, radius: 16)
    }
}

/// Sheet chrome: surface background, panel radius, visible grabber. Apply inside the sheet content.
public struct DSSheetModifier: ViewModifier {
    public func body(content: Content) -> some View {
        content
            .presentationBackground(Palette.surface1)
            .presentationCornerRadius(Radius.sheet)
            .presentationDragIndicator(.visible)
    }
}

public extension View {
    func dsSheet() -> some View {
        modifier(DSSheetModifier())
    }
}

/// Sheet / dialog header: serif title, optional subtitle and a close button.
public struct SheetHeader: View {
    private let title: String
    private let subtitle: String?
    private let onClose: (() -> Void)?

    public init(_ title: String, subtitle: String? = nil, onClose: (() -> Void)? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.onClose = onClose
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                SerifHeadline(title, size: 28, relativeTo: .title)
                if let subtitle {
                    Text(subtitle)
                        .font(.dsCallout)
                        .foregroundStyle(Palette.muted)
                }
            }
            Spacer(minLength: Spacing.md)
            if let onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Palette.muted)
                        .frame(width: 32, height: 32)
                        .background(Palette.surface2, in: Circle())
                        .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel("Close")
            }
        }
        .padding(.horizontal, Spacing.gutter)
        .padding(.top, Spacing.xl)
        .padding(.bottom, Spacing.md)
    }
}

/// A thin divider in the subtle border color.
public struct DSDivider: View {
    public init() {}

    public var body: some View {
        Rectangle()
            .fill(Palette.borderSubtle)
            .frame(height: 1)
            .accessibilityHidden(true)
    }
}
