import DesignSystem
import DesynKit
import EditorFeature
import FeatureCore
import PanelKit
import SharedKit
import SwiftUI

/// The font picker: every family of the curated catalog, each previewed in itself (downloaded on demand and
/// cached), searchable and filtered by category, with heading / body pairings.
struct FontPicker: View {
    let model: InspectorModel
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var category: FontFamily.Category?
    @State private var applying: String?
    @State private var error: String?

    private var currentFamily: String { model.textNodes.first?.textStyle?.fontFamily ?? "Inter" }

    private var families: [FontFamily] {
        FontFamily.catalog.filter { family in
            (category == nil || family.category == category) && family.matches(query)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader("choose a *font*", subtitle: "\(FontFamily.catalog.count) families · previews download as you scroll") { dismiss() }
            VStack(spacing: Spacing.sm) {
                DSTextField("", text: $query, prompt: "Search fonts or moods", kind: .search, submitLabel: .search)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Spacing.sm) {
                        ChipButton("All", isSelected: category == nil) { category = nil }
                        ForEach(FontFamily.Category.allCases, id: \.self) { item in
                            ChipButton(item.title, isSelected: category == item) { category = item }
                        }
                    }
                }
            }
            .padding(.horizontal, Spacing.gutter)
            .padding(.bottom, Spacing.sm)
            if let error {
                InlineNotice(error, tone: .error)
                    .padding(.horizontal, Spacing.gutter)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if query.isEmpty, category == nil {
                        pairings
                    }
                    ForEach(families) { family in
                        FontRow(family: family, isCurrent: family.family == currentFamily, isApplying: applying == family.family) {
                            choose(family)
                        }
                    }
                    if families.isEmpty {
                        Text("No font matches \u{201C}\(query)\u{201D}.")
                            .font(.dsCallout)
                            .foregroundStyle(Palette.muted)
                            .padding(Spacing.xl)
                    }
                }
                .padding(.bottom, Spacing.xxl)
            }
            .scrollDismissesKeyboard(.immediately)
        }
        .dsSheet()
        .presentationDetents([.large, .medium])
    }

    @ViewBuilder private var pairings: some View {
        let suggestions = Array(FontPairing.all.prefix(8))
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Pairings").dsEyebrow().padding(.horizontal, Spacing.gutter)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.md) {
                    ForEach(suggestions) { pairing in
                        PairingCard(pairing: pairing) {
                            applyPairing(pairing)
                        }
                    }
                }
                .padding(.horizontal, Spacing.gutter)
            }
            Text("All fonts").dsEyebrow().padding(.horizontal, Spacing.gutter).padding(.top, Spacing.md)
        }
        .padding(.vertical, Spacing.sm)
    }

    private func choose(_ family: FontFamily) {
        let weight = model.textNodes.first?.textStyle?.fontWeight ?? 400
        let italic = (model.textNodes.first?.textStyle?.isItalic ?? false) && family.italic
        let resolved = family.nearestWeight(weight)
        applying = family.family
        error = nil
        Task {
            let ok = await FontService.shared.ensure(family.family, weight: Double(resolved), italic: italic, in: model.editor)
            applying = nil
            guard ok else {
                error = "\(family.family) couldn't be downloaded. Check your connection and try again."
                return
            }
            model.edit("Change font", final: true) { NodeEditing.setFont(family: family.family, weight: Double(resolved), italic: italic, on: $0) }
            Haptics.success()
        }
    }

    /// Headings (the largest text, or headline roles) take the pairing's heading font, the rest its body font.
    private func applyPairing(_ pairing: FontPairing) {
        let texts = model.textNodes
        guard !texts.isEmpty else { return }
        applying = pairing.heading
        Task {
            let headingOK = await FontService.shared.ensure(pairing.heading, weight: Double(pairing.headingWeight), italic: false, in: model.editor)
            let bodyOK = await FontService.shared.ensure(pairing.body, weight: Double(pairing.bodyWeight), italic: false, in: model.editor)
            applying = nil
            guard headingOK, bodyOK else {
                error = "This pairing couldn't be downloaded. Check your connection and try again."
                return
            }
            let largest = texts.compactMap { $0.textStyle?.fontSize }.max() ?? 0
            model.edit("Apply font pairing", final: true) { nodes in
                nodes.filter { $0.type == .text }.flatMap { node -> [Op] in
                    let size = node.textStyle?.fontSize ?? 0
                    let isHeading = ["headline", "subhead", "slide-title", "hero"].contains(node.role ?? "") || (texts.count > 1 ? size >= largest : true)
                    return NodeEditing.setFont(
                        family: isHeading ? pairing.heading : pairing.body,
                        weight: Double(isHeading ? pairing.headingWeight : pairing.bodyWeight),
                        italic: nil,
                        on: [node]
                    )
                }
            }
            Haptics.success()
        }
    }
}

private struct FontRow: View {
    let family: FontFamily
    let isCurrent: Bool
    let isApplying: Bool
    let action: () -> Void

    private var fonts: FontService { FontService.shared }

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.md) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(family.family)
                        .font(fonts.previewFont(family.family, size: 22) ?? DSFont.sans(20, relativeTo: .title3))
                        .foregroundStyle(Palette.foreground)
                        .lineLimit(1)
                        .redacted(reason: preview == nil && fonts.loading.contains(family.family) ? .placeholder : [])
                    Text(detail)
                        .font(.dsCaption)
                        .foregroundStyle(Palette.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: Spacing.sm)
                if isApplying {
                    SunSpinner(size: 20)
                } else if isCurrent {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.sun)
                }
            }
            .padding(.horizontal, Spacing.gutter)
            .frame(minHeight: 60)
            .background(isCurrent ? Palette.sun.opacity(0.06) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(family.family)
        .accessibilityValue(isCurrent ? "Current font" : "")
        .task { await fonts.loadPreview(family.family) }
    }

    private var preview: Font? { fonts.previewFont(family.family, size: 22) }

    private var detail: String {
        var parts = [family.category.title]
        parts.append(family.variableWeights != nil ? "Variable" : "\(family.weights.count) weights")
        if family.isBundled { parts.append("On this \(DeviceName.current)") }
        if let tag = family.tags.first { parts.append(tag) }
        return parts.joined(separator: " · ")
    }
}

private struct PairingCard: View {
    let pairing: FontPairing
    let action: () -> Void
    private var fonts: FontService { FontService.shared }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(pairing.heading)
                    .font(fonts.previewFont(pairing.heading, size: 22, weight: pairing.headingWeight) ?? DSFont.serif(22))
                    .foregroundStyle(Palette.foreground)
                    .lineLimit(1)
                Text(pairing.body)
                    .font(fonts.previewFont(pairing.body, size: 14, weight: pairing.bodyWeight) ?? .dsCallout)
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                Text(pairing.moods.prefix(2).joined(separator: " · "))
                    .font(.dsCaption)
                    .foregroundStyle(Palette.sun)
            }
            .padding(Spacing.md)
            .frame(width: 180, alignment: .leading)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel("\(pairing.heading) with \(pairing.body)")
        .task {
            await fonts.loadPreview(pairing.heading)
            await fonts.loadPreview(pairing.body)
        }
    }
}
