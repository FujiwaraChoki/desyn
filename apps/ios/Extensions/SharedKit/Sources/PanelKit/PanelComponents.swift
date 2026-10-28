import DesignSystem
import SwiftUI
import UIKit

// Building blocks shared by the editor panels (inspector, insert, AI, export, share, comments, history): eyebrow
// sections, chips, tiles, numeric scrubbers and sheet chrome in the sun design system.

/// A titled group of controls (eyebrow label, optional trailing accessory).
public struct PanelSection<Content: View, Trailing: View>: View {
    private let title: String
    private let content: Content
    private let trailing: Trailing

    public init(_ title: String, @ViewBuilder trailing: () -> Trailing, @ViewBuilder content: () -> Content) {
        self.title = title
        self.trailing = trailing()
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).dsEyebrow()
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: Spacing.sm)
                trailing
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

public extension PanelSection where Trailing == EmptyView {
    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.init(title, trailing: { EmptyView() }, content: content)
    }
}

/// A selectable capsule.
public struct ChipButton: View {
    private let title: String
    private let systemImage: String?
    private let isSelected: Bool
    private let action: () -> Void

    public init(_ title: String, systemImage: String? = nil, isSelected: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.isSelected = isSelected
        self.action = action
    }

    public var body: some View {
        Button {
            Haptics.selection()
            action()
        } label: {
            HStack(spacing: 6) {
                if let systemImage {
                    Image(systemName: systemImage).imageScale(.small)
                }
                Text(title).lineLimit(1)
            }
            .font(DSFont.sans(14, weight: isSelected ? .semibold : .medium, relativeTo: .callout))
            .foregroundStyle(isSelected ? Palette.onSun : Palette.foreground)
            .padding(.horizontal, Spacing.md)
            .frame(minHeight: 36)
            .background(isSelected ? AnyShapeStyle(Palette.sun) : AnyShapeStyle(Palette.surface2), in: Capsule())
            .overlay(Capsule().strokeBorder(isSelected ? Color.clear : Palette.borderSubtle, lineWidth: 1))
            .frame(minHeight: Spacing.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// A square tile with an icon (or custom artwork) and a caption, for grids of things to insert.
public struct TileButton<Artwork: View>: View {
    private let title: String
    private let artwork: Artwork
    private let action: () -> Void

    public init(_ title: String, action: @escaping () -> Void, @ViewBuilder artwork: () -> Artwork) {
        self.title = title
        self.action = action
        self.artwork = artwork()
    }

    public var body: some View {
        Button(action: action) {
            VStack(spacing: Spacing.xs + 2) {
                artwork
                    .frame(maxWidth: .infinity)
                    .aspectRatio(1, contentMode: .fit)
                    .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                            .strokeBorder(Palette.borderSubtle, lineWidth: 1)
                    }
                Text(title)
                    .font(.dsFootnote)
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel(title)
    }
}

public extension TileButton where Artwork == TileSymbol {
    init(_ title: String, systemImage: String, tint: Color = Palette.foreground, action: @escaping () -> Void) {
        self.init(title, action: action) { TileSymbol(systemImage: systemImage, tint: tint) }
    }
}

/// An SF Symbol centered in a tile.
public struct TileSymbol: View {
    let systemImage: String
    let tint: Color

    public var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 26, weight: .regular))
            .foregroundStyle(tint)
    }
}

/// A numeric field whose label scrubs the value when dragged (DESIGN_SYSTEM: numeric scrubbers) and which accepts
/// typed values. `onChange(value, final)` previews while scrubbing and commits when the drag ends or a value is typed.
public struct ScrubField: View {
    private let label: String
    private let value: Double
    private let range: ClosedRange<Double>
    private let step: Double
    private let unit: String
    private let decimals: Int
    private let onChange: (Double, Bool) -> Void

    @State private var text = ""
    @State private var dragStart: Double?
    @FocusState private var focused: Bool

    public init(
        _ label: String,
        value: Double,
        in range: ClosedRange<Double>,
        step: Double = 1,
        unit: String = "",
        decimals: Int = 0,
        onChange: @escaping (Double, Bool) -> Void
    ) {
        self.label = label
        self.value = value
        self.range = range
        self.step = step
        self.unit = unit
        self.decimals = decimals
        self.onChange = onChange
    }

    public var body: some View {
        HStack(spacing: 6) {
            Text(label)
                .font(DSFont.sans(12, weight: .semibold, relativeTo: .caption))
                .foregroundStyle(dragStart == nil ? Palette.muted : Palette.sun)
                .frame(minWidth: 18, minHeight: Spacing.touchTarget)
                .contentShape(Rectangle())
                .gesture(scrub)
                .accessibilityHidden(true)
            TextField(label, text: $text)
                .font(.dsMono)
                .foregroundStyle(Palette.foreground)
                .keyboardType(range.lowerBound < 0 ? .numbersAndPunctuation : .decimalPad)
                .focused($focused)
                .submitLabel(.done)
                .onSubmit(commitText)
                .tint(Palette.sun)
            if !unit.isEmpty {
                Text(unit)
                    .font(.dsCaption)
                    .foregroundStyle(Palette.muted)
            }
        }
        .padding(.horizontal, Spacing.sm + 2)
        .frame(minHeight: Spacing.touchTarget)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                .strokeBorder(focused ? Palette.sun.opacity(0.6) : Palette.borderSubtle, lineWidth: focused ? 2 : 1)
        }
        .onAppear { text = format(value) }
        .onChange(of: value) { _, newValue in
            if !focused { text = format(newValue) }
        }
        .onChange(of: focused) { _, isFocused in
            if !isFocused { commitText() }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue("\(format(value)) \(unit)")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: onChange(clamp(value + step), true)
            case .decrement: onChange(clamp(value - step), true)
            @unknown default: break
            }
        }
    }

    private var scrub: some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { drag in
                if dragStart == nil {
                    dragStart = value
                    Haptics.prepare()
                }
                let raw = (dragStart ?? value) + Double(drag.translation.width) / 4 * step
                let stepped = (raw / step).rounded() * step
                let next = clamp(stepped)
                if next != value {
                    if next == range.lowerBound || next == range.upperBound { Haptics.snap() }
                    onChange(next, false)
                }
            }
            .onEnded { _ in
                dragStart = nil
                onChange(value, true)
            }
    }

    private func commitText() {
        let cleaned = text.replacingOccurrences(of: ",", with: ".").filter { $0.isNumber || $0 == "." || $0 == "-" }
        guard let parsed = Double(cleaned) else {
            text = format(value)
            return
        }
        let next = clamp(parsed)
        text = format(next)
        if next != value { onChange(next, true) }
    }

    private func clamp(_ v: Double) -> Double {
        min(range.upperBound, max(range.lowerBound, v))
    }

    private func format(_ v: Double) -> String {
        decimals == 0 ? String(Int(v.rounded())) : String(format: "%.\(decimals)f", v)
    }
}

/// A row of icon buttons where one is selected (alignment, case, decoration).
public struct IconSegments<Value: Hashable>: View {
    private let selection: Value?
    private let options: [(value: Value, systemImage: String, label: String)]
    private let onSelect: (Value) -> Void

    public init(selection: Value?, options: [(value: Value, systemImage: String, label: String)], onSelect: @escaping (Value) -> Void) {
        self.selection = selection
        self.options = options
        self.onSelect = onSelect
    }

    public var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let isSelected = option.value == selection
                Button {
                    Haptics.selection()
                    onSelect(option.value)
                } label: {
                    Image(systemName: option.systemImage)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(isSelected ? Palette.sun : Palette.foreground)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background {
                            if isSelected {
                                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.surface3)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.label)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
    }
}

/// A labeled switch in the sun tint.
public struct PanelToggle: View {
    private let title: String
    private let detail: String?
    private let isOn: Bool
    private let onChange: (Bool) -> Void

    public init(_ title: String, detail: String? = nil, isOn: Bool, onChange: @escaping (Bool) -> Void) {
        self.title = title
        self.detail = detail
        self.isOn = isOn
        self.onChange = onChange
    }

    public var body: some View {
        Toggle(isOn: Binding(get: { isOn }, set: { onChange($0) })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.dsCallout).foregroundStyle(Palette.foreground)
                if let detail {
                    Text(detail).font(.dsFootnote).foregroundStyle(Palette.muted)
                }
            }
        }
        .tint(Palette.sun)
        .frame(minHeight: Spacing.touchTarget)
    }
}

/// A calm inline message inside panels (errors say what to do next).
public struct InlineNotice: View {
    public enum Tone { case info, warning, error }

    private let text: String
    private let tone: Tone
    private let actionTitle: String?
    private let action: (() -> Void)?

    public init(_ text: String, tone: Tone = .info, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.text = text
        self.tone = tone
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: icon).foregroundStyle(color).padding(.top, 1)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(text)
                    .font(.dsCallout)
                    .foregroundStyle(Palette.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .font(DSFont.sans(14, weight: .semibold, relativeTo: .callout))
                        .foregroundStyle(Palette.sun)
                        .frame(minHeight: 32)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(Spacing.md)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(color.opacity(0.3), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private var icon: String {
        switch tone {
        case .info: "sun.max"
        case .warning: "exclamationmark.circle"
        case .error: "exclamationmark.triangle"
        }
    }

    private var color: Color {
        switch tone {
        case .info: Palette.sun
        case .warning: Palette.sun
        case .error: Palette.danger
        }
    }
}

/// Sheet chrome for editor panels: surface background, grabber, resizable detents, canvas stays interactive at the
/// smallest detent so changes are visible while editing.
public struct PanelSheetModifier: ViewModifier {
    let detents: Set<PresentationDetent>
    let interactiveUpThrough: PresentationDetent?

    public func body(content: Content) -> some View {
        let interaction: PresentationBackgroundInteraction = interactiveUpThrough.map { PresentationBackgroundInteraction.enabled(upThrough: $0) } ?? .disabled
        return content
            .dsSheet()
            .presentationDetents(detents)
            .presentationBackgroundInteraction(interaction)
            .presentationContentInteraction(.scrolls)
    }
}

public extension View {
    /// Resizable editor sheet (`detents`), keeping the canvas usable behind the smallest one.
    func panelSheet(_ detents: Set<PresentationDetent> = [.medium, .large], interactiveUpThrough: PresentationDetent? = .medium) -> some View {
        modifier(PanelSheetModifier(detents: detents, interactiveUpThrough: interactiveUpThrough))
    }
}

/// Glass circle button for the top bar and docks (matches `DSIconButton`, with a badge dot).
public struct GlassIconButton: View {
    private let systemImage: String
    private let label: String
    private let badge: Bool
    private let isActive: Bool
    private let action: () -> Void

    public init(_ systemImage: String, label: String, badge: Bool = false, isActive: Bool = false, action: @escaping () -> Void) {
        self.systemImage = systemImage
        self.label = label
        self.badge = badge
        self.isActive = isActive
        self.action = action
    }

    public var body: some View {
        DSIconButton(systemImage, label: label, isActive: isActive, action: action)
            .overlay(alignment: .topTrailing) {
                if badge {
                    Circle()
                        .fill(Palette.sun)
                        .frame(width: 8, height: 8)
                        .overlay(Circle().strokeBorder(Palette.surface1, lineWidth: 1.5))
                        .offset(x: -8, y: 8)
                        .accessibilityHidden(true)
                }
            }
    }
}
