import SwiftUI

/// A small rounded badge.
public struct DSBadge: View {
    public enum Tone: Sendable { case neutral, sun, success, danger, info }

    private let text: String
    private let tone: Tone

    public init(_ text: String, tone: Tone = .neutral) {
        self.text = text
        self.tone = tone
    }

    public var body: some View {
        Text(text)
            .font(DSFont.sans(11, weight: .semibold, relativeTo: .caption2))
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, 3)
            .foregroundStyle(foreground)
            .background(background, in: Capsule())
    }

    private var foreground: Color {
        switch tone {
        case .neutral: Palette.muted
        case .sun: Palette.sun
        case .success: Palette.success
        case .danger: Palette.danger
        case .info: Palette.info
        }
    }

    private var background: Color {
        switch tone {
        case .neutral: Palette.surface3
        case .sun: Palette.sun.opacity(0.15)
        case .success: Palette.success.opacity(0.15)
        case .danger: Palette.danger.opacity(0.15)
        case .info: Palette.info.opacity(0.15)
        }
    }
}

/// The "Pro" pill: sun gradient, near-black text.
public struct ProPill: View {
    public init() {}

    public var body: some View {
        Text("Pro")
            .font(DSFont.sans(11, weight: .semibold, relativeTo: .caption2))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .foregroundStyle(Palette.onSun)
            .background(Palette.sunGradient, in: Capsule())
            .accessibilityLabel("Pro")
    }
}

/// A segmented control with a sliding sun-tinted thumb.
public struct DSSegmentedControl<Value: Hashable>: View {
    @Binding private var selection: Value
    private let options: [(value: Value, title: String)]
    @Namespace private var thumb

    public init(selection: Binding<Value>, options: [(value: Value, title: String)]) {
        _selection = selection
        self.options = options
    }

    public var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let isSelected = option.value == selection
                Button {
                    guard option.value != selection else { return }
                    Haptics.selection()
                    withAnimation(Motion.panel) { selection = option.value }
                } label: {
                    Text(option.title)
                        .font(DSFont.sans(14, weight: isSelected ? .semibold : .medium, relativeTo: .callout))
                        .foregroundStyle(isSelected ? Palette.foreground : Palette.muted)
                        .lineLimit(1)
                        .padding(.horizontal, Spacing.md)
                        .frame(maxWidth: .infinity, minHeight: 36)
                        .background {
                            if isSelected {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(Palette.surface3)
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                                            .strokeBorder(Palette.sun.opacity(0.35), lineWidth: 1)
                                    }
                                    .matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(Palette.borderSubtle, lineWidth: 1)
        }
    }
}

/// Horizontally scrolling tabs (library sections) with an underline in the sun.
public struct DSTabStrip<Value: Hashable>: View {
    @Binding private var selection: Value
    private let tabs: [(value: Value, title: String, systemImage: String)]
    @Namespace private var underline

    public init(selection: Binding<Value>, tabs: [(value: Value, title: String, systemImage: String)]) {
        _selection = selection
        self.tabs = tabs
    }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Spacing.xl) {
                ForEach(Array(tabs.enumerated()), id: \.offset) { _, tab in
                    let isSelected = tab.value == selection
                    Button {
                        guard !isSelected else { return }
                        Haptics.selection()
                        withAnimation(Motion.panel) { selection = tab.value }
                    } label: {
                        VStack(spacing: 6) {
                            Label(tab.title, systemImage: tab.systemImage)
                                .labelStyle(.titleOnly)
                                .font(DSFont.sans(15, weight: isSelected ? .semibold : .medium, relativeTo: .subheadline))
                                .foregroundStyle(isSelected ? Palette.foreground : Palette.muted)
                            ZStack {
                                Capsule().fill(Color.clear).frame(height: 2)
                                if isSelected {
                                    Capsule()
                                        .fill(Palette.sun)
                                        .frame(height: 2)
                                        .matchedGeometryEffect(id: "underline", in: underline)
                                }
                            }
                        }
                        .frame(minHeight: Spacing.touchTarget)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
            }
            .padding(.horizontal, Spacing.gutter)
        }
    }
}

/// A labeled slider with a sun track and a mono value readout.
public struct DSSlider: View {
    private let label: String
    @Binding private var value: Double
    private let range: ClosedRange<Double>
    private let format: (Double) -> String
    private let onEditingChanged: (Bool) -> Void

    public init(
        _ label: String,
        value: Binding<Double>,
        in range: ClosedRange<Double>,
        format: @escaping (Double) -> String = { String(format: "%.0f", $0) },
        onEditingChanged: @escaping (Bool) -> Void = { _ in }
    ) {
        self.label = label
        _value = value
        self.range = range
        self.format = format
        self.onEditingChanged = onEditingChanged
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack {
                Text(label)
                    .font(.dsSubheadline)
                    .foregroundStyle(Palette.muted)
                Spacer()
                Text(format(value))
                    .font(.dsMono)
                    .foregroundStyle(Palette.foreground)
                    .monospacedDigit()
            }
            Slider(value: $value, in: range, onEditingChanged: onEditingChanged)
                .tint(Palette.sun)
                .accessibilityLabel(label)
                .accessibilityValue(format(value))
        }
    }
}
