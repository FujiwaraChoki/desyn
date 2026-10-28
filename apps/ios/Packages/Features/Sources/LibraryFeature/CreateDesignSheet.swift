import DesignSystem
import DesynKit
import FeatureCore
import SwiftUI

/// "Create a design": every page preset of @desyn/schema grouped by category, searchable, plus a custom size.
struct CreateDesignSheet: View {
    let model: LibraryModel
    let onCreated: (DesignRoute) -> Void

    @State private var query = ""
    @State private var creating: String?
    @State private var customWidth = "1080"
    @State private var customHeight = "1080"
    @State private var customUnit: PageUnit = .px
    @Environment(\.dismiss) private var dismiss

    private let columns = [GridItem(.adaptive(minimum: 104, maximum: 160), spacing: Spacing.md, alignment: .top)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                SheetHeader("create a *design*.", subtitle: "Pick a size. You can resize later.") { dismiss() }
                    .padding(.horizontal, -Spacing.gutter)
                DSTextField("", text: $query, prompt: "Search sizes (story, A4, YouTube...)", kind: .search, submitLabel: .search)
                if query.isEmpty {
                    customSize
                }
                ForEach(PagePreset.grouped(matching: query), id: \.category) { group in
                    VStack(alignment: .leading, spacing: Spacing.md) {
                        Label(group.category.label, systemImage: group.category.systemImage)
                            .labelStyle(.titleAndIcon)
                            .dsEyebrow()
                        LazyVGrid(columns: columns, alignment: .leading, spacing: Spacing.md) {
                            ForEach(group.presets) { preset in
                                PresetTile(preset: preset, isCreating: creating == preset.id) {
                                    create(preset)
                                }
                                .disabled(creating != nil)
                            }
                        }
                    }
                }
                if PagePreset.grouped(matching: query).isEmpty {
                    EmptyStateView("no size *matches*.", message: "Try a platform or a paper size, or set a custom size.", systemImage: "rectangle.dashed")
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, Spacing.gutter)
            .padding(.bottom, Spacing.xxxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .dsSheet()
        .presentationDetents([.large])
    }

    private var customSize: some View {
        DSCard {
            VStack(alignment: .leading, spacing: Spacing.md) {
                Text("Custom size").font(.dsHeadline).foregroundStyle(Palette.foreground)
                HStack(spacing: Spacing.sm) {
                    DSTextField("Width", text: $customWidth, kind: .number)
                    Image(systemName: "xmark").foregroundStyle(Palette.muted).padding(.top, 22)
                    DSTextField("Height", text: $customHeight, kind: .number)
                }
                Picker("Unit", selection: $customUnit) {
                    ForEach(PageUnit.allCases, id: \.self) { unit in
                        Text(unit.rawValue).tag(unit)
                    }
                }
                .pickerStyle(.segmented)
                DSButton("Create custom design", systemImage: "plus", isLoading: creating == "custom") {
                    createCustom()
                }
                .disabled(creating != nil || customSizeValue == nil)
            }
        }
    }

    private var customSizeValue: (Double, Double)? {
        guard let width = Double(customWidth.replacingOccurrences(of: ",", with: ".")),
              let height = Double(customHeight.replacingOccurrences(of: ",", with: ".")),
              width > 0, height > 0
        else { return nil }
        return (width, height)
    }

    private func create(_ preset: PagePreset) {
        creating = preset.id
        Task {
            let route = await model.create(preset: preset)
            creating = nil
            if let route { onCreated(route) }
        }
    }

    private func createCustom() {
        guard let size = customSizeValue else { return }
        creating = "custom"
        Task {
            let route = await model.createCustom(width: size.0, height: size.1, unit: customUnit)
            creating = nil
            if let route { onCreated(route) }
        }
    }
}

/// A preset as a little page in its real proportions.
private struct PresetTile: View {
    let preset: PagePreset
    let isCreating: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: Spacing.sm) {
                ZStack {
                    RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                        .fill(Palette.surface1)
                    proportionalPage
                    if isCreating {
                        SunSpinner(size: 24)
                    }
                }
                .frame(height: 96)
                .overlay {
                    RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1)
                }
                VStack(spacing: 2) {
                    Text(preset.label)
                        .font(DSFont.sans(13, weight: .medium, relativeTo: .footnote))
                        .foregroundStyle(Palette.foreground)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                    Text(preset.sizeLabel)
                        .font(.dsCaption)
                        .foregroundStyle(Palette.muted)
                }
            }
        }
        .buttonStyle(CardPressStyle())
        .accessibilityLabel("\(preset.label), \(preset.sizeLabel)")
    }

    private var proportionalPage: some View {
        let maxSide: CGFloat = 64
        let ratio = CGFloat(preset.aspectRatio)
        let width = ratio >= 1 ? maxSide : maxSide * ratio
        let height = ratio >= 1 ? maxSide / ratio : maxSide
        return RoundedRectangle(cornerRadius: 3, style: .continuous)
            .fill(LinearGradient(colors: [Palette.sunHi.opacity(0.9), Palette.sun], startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: max(8, width), height: max(8, height))
            .shadow(color: Palette.sun.opacity(0.35), radius: 8)
            .overlay {
                Image(systemName: preset.kind.systemImage)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Palette.onSun.opacity(0.7))
            }
    }
}
