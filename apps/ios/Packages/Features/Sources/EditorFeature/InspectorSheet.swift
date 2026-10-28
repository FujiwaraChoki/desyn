import DesignSystem
import DesynEngine
import DesynKit
import SwiftUI

/// Style and arrange controls for the selection. Sliders and the color picker preview live and commit one
/// transaction when the change settles.
struct InspectorSheet: View {
    let model: EditorModel
    @Environment(\.dismiss) private var dismiss

    @State private var color: Color = .white
    @State private var opacity: Double = 1
    @State private var cornerRadius: Double = 0
    @State private var fontSize: Double = 24
    @State private var pendingCommit: Task<Void, Never>?
    @State private var loadedFor: [String] = []

    private var node: Node? { model.selectedNodes.first }
    private var isText: Bool { node?.type == .text }
    private var hasFill: Bool {
        guard let node else { return false }
        return isText || node.json["fills"] != nil
    }

    private var hasCorners: Bool { node?.json["cornerRadius"] != nil }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                SheetHeader(title, subtitle: subtitle) { dismiss() }
                    .padding(.horizontal, -Spacing.gutter)
                if node == nil {
                    Text("Select a layer to edit its style.")
                        .font(.dsBody)
                        .foregroundStyle(Palette.muted)
                } else {
                    if hasFill { colorSection }
                    appearanceSection
                    if isText { textSection }
                    arrangeSection
                }
            }
            .padding(.horizontal, Spacing.gutter)
            .padding(.bottom, Spacing.xxl)
        }
        .dsSheet()
        .presentationDetents([.medium, .large])
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        .onAppear(perform: load)
        .onChange(of: model.selection) { _, _ in load() }
    }

    private var title: String {
        switch model.selectedNodes.count {
        case 0: "style"
        case 1: (node?.displayName ?? "layer").lowercased()
        default: "\(model.selectedNodes.count) *layers*"
        }
    }

    private var subtitle: String? {
        guard let node, model.selectedNodes.count == 1 else { return nil }
        return "\(node.typeName.capitalized) · \(Int(node.width.rounded())) × \(Int(node.height.rounded()))"
    }

    private func load() {
        guard let node, loadedFor != model.selection else { return }
        loadedFor = model.selection
        let hex = isText ? node.textStyle?.colorHex : node.fills.first?.swatchHex
        color = Color(hex: hex ?? "#d9d9d9")
        opacity = node.opacity
        cornerRadius = node.cornerRadius.maxValue
        fontSize = node.textStyle?.fontSize ?? 24
    }

    // MARK: Sections

    private var colorSection: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("Color").dsEyebrow()
            HStack(spacing: Spacing.md) {
                ColorPicker("Color", selection: Binding(get: { color }, set: { colorChanged($0) }), supportsOpacity: false)
                    .labelsHidden()
                    .frame(width: 44, height: 44)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Spacing.sm) {
                        ForEach(swatches, id: \.self) { hex in
                            Button {
                                colorChanged(Color(hex: hex))
                            } label: {
                                Circle()
                                    .fill(Color(hex: hex))
                                    .frame(width: 32, height: 32)
                                    .overlay(Circle().strokeBorder(Palette.border, lineWidth: 1))
                                    .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(hex)
                        }
                    }
                }
            }
        }
    }

    /// The document's named colors (`Design.styles.colors`) first, then the warm palette.
    private var swatches: [String] {
        var result: [String] = []
        for hex in model.styleColors + ["#ffffff", "#111111", "#ffb02e", "#ff6a1f", "#ffd66b", "#c4451c", "#8a5a00", "#e8e1d3", "#7a7468", "#5aa9ff"] where !result.contains(hex) {
            result.append(hex)
        }
        return result
    }

    private var appearanceSection: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("Appearance").dsEyebrow()
            DSSlider("Opacity", value: live($opacity) { value, final in await model.setOpacity(value, final: final) }, in: 0...1, format: { "\(Int(($0 * 100).rounded()))%" }) { editing in
                if !editing { settle { await model.setOpacity(opacity, final: true) } }
            }
            if hasCorners {
                DSSlider("Corner radius", value: live($cornerRadius) { value, final in await model.setCornerRadius(value, final: final) }, in: 0...max(1, min(node?.width ?? 100, node?.height ?? 100) / 2), format: { "\(Int($0)) px" }) { editing in
                    if !editing { settle { await model.setCornerRadius(cornerRadius, final: true) } }
                }
            }
        }
    }

    private var textSection: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("Text").dsEyebrow()
            DSSlider("Size", value: live($fontSize) { value, final in await model.setFontSize(value, final: final) }, in: 6...400, format: { "\(Int($0)) px" }) { editing in
                if !editing { settle { await model.setFontSize(fontSize, final: true) } }
            }
            DSSegmentedControl(
                selection: Binding(
                    get: { node?.textStyle?.fontWeight ?? 400 },
                    set: { value in Task { await model.setFontWeight(value) } }
                ),
                options: [(400.0, "Regular"), (500.0, "Medium"), (600.0, "Semibold"), (700.0, "Bold")]
            )
            DSSegmentedControl(
                selection: Binding(
                    get: { node?.paragraph?.align ?? "left" },
                    set: { value in Task { await model.setTextAlign(value) } }
                ),
                options: [("left", "Left"), ("center", "Center"), ("right", "Right"), ("justify", "Justify")]
            )
        }
    }

    private var arrangeSection: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("Arrange").dsEyebrow()
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Spacing.sm), count: 6), spacing: Spacing.sm) {
                ForEach(EditorModel.PageAlignment.allCases, id: \.self) { alignment in
                    Button {
                        Task { await model.align(alignment) }
                    } label: {
                        Image(systemName: alignment.systemImage)
                            .font(.system(size: 17))
                            .frame(maxWidth: .infinity, minHeight: Spacing.touchTarget)
                            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                            .foregroundStyle(Palette.foreground)
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel(alignment.title)
                }
            }
            HStack(spacing: Spacing.sm) {
                DSButton("Front", systemImage: "square.3.layers.3d.top.filled", kind: .secondary, size: .small) { Task { await model.arrange(.front) } }
                DSButton("Back", systemImage: "square.3.layers.3d.bottom.filled", kind: .secondary, size: .small) { Task { await model.arrange(.back) } }
            }
            HStack(spacing: Spacing.sm) {
                DSButton("Duplicate", systemImage: "plus.square.on.square", kind: .secondary, size: .small) { Task { await model.duplicateSelection() } }
                DSButton("Delete", systemImage: "trash", kind: .danger, size: .small) {
                    dismiss()
                    Task { await model.deleteSelection() }
                }
            }
        }
    }

    // MARK: Live edits

    /// A binding that previews every user change and commits once the value settles (600 ms without changes),
    /// so a preview never outlives the interaction (also for VoiceOver adjustments without editing events).
    private func live(_ value: Binding<Double>, apply: @escaping @MainActor (Double, Bool) async -> Void) -> Binding<Double> {
        Binding(
            get: { value.wrappedValue },
            set: { newValue in
                value.wrappedValue = newValue
                Task { await apply(newValue, false) }
                schedule { await apply(newValue, true) }
            }
        )
    }

    private func colorChanged(_ newValue: Color) {
        color = newValue
        let hex = UIColor(newValue).hexString
        guard hex.count == 7 || hex.count == 9 else { return }
        let opaque = String(hex.prefix(7))
        Task { await model.setFillColor(opaque, final: false) }
        schedule { await model.setFillColor(opaque, final: true) }
    }

    /// Commits after a pause in changes.
    private func schedule(_ commit: @escaping @MainActor () async -> Void) {
        pendingCommit?.cancel()
        pendingCommit = Task {
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await commit()
        }
    }

    /// Commits now (slider released).
    private func settle(_ commit: @escaping @MainActor () async -> Void) {
        pendingCommit?.cancel()
        pendingCommit = nil
        Task { await commit() }
    }
}
