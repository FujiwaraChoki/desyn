import SwiftUI

/// Empty states: a quiet sun glyph, a serif headline (one italic sun word in `*asterisks*`), one sentence and
/// one clear action.
public struct EmptyStateView: View {
    private let title: String
    private let message: String
    private let systemImage: String
    private let actionTitle: String?
    private let action: (() -> Void)?

    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        _ title: String,
        message: String,
        systemImage: String = "sun.max",
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.title = title
        self.message = message
        self.systemImage = systemImage
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        VStack(spacing: Spacing.lg) {
            ZStack {
                Circle()
                    .fill(Palette.sun.opacity(0.16))
                    .frame(width: 112, height: 112)
                    .blur(radius: 24)
                Circle()
                    .strokeBorder(Palette.sun.opacity(0.35), lineWidth: 1)
                    .frame(width: 76, height: 76)
                Image(systemName: systemImage)
                    .font(.system(size: 28, weight: .light))
                    .foregroundStyle(Palette.sun)
            }
            .accessibilityHidden(true)
            VStack(spacing: Spacing.sm) {
                SerifHeadline(title, size: 28, relativeTo: .title)
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(.dsCallout)
                    .foregroundStyle(Palette.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(DSButtonStyle(.primary))
                    .padding(.top, Spacing.xs)
            }
        }
        .padding(.horizontal, Spacing.xxl)
        .frame(maxWidth: 420)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared || reduceMotion ? 0 : 12)
        .onAppear {
            withAnimation(Motion.animation(Motion.easeOut(0.7), reduced: reduceMotion)) {
                appeared = true
            }
        }
    }
}
