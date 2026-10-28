import DesignSystem
import DesynKit
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI

/// Brand kits of the design's workspace: browse colors, fonts and logos; apply a color or font to the selection,
/// place a logo, restyle the page with the kit, or ask the AI to match the brand.
public struct BrandPanel: View {
    @State private var insert: InsertModel
    @State private var kits: [BrandKitDetail] = []
    @State private var selectedId: String?
    @State private var loading = true
    @State private var error: String?
    @State private var applying = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    public init(editor: EditorModel, context: EditorContext) {
        _insert = State(initialValue: InsertModel(editor: editor, context: context))
    }

    private var editor: EditorModel { insert.editor }
    private var kit: BrandKitDetail? { kits.first { $0.id == selectedId } ?? kits.first }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader("your *brand*", subtitle: kit.map { "\($0.name)\($0.isDefault ? " · default" : "")" }) { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.xl) {
                    if loading {
                        LoadingState("Gathering brand kits").frame(height: 200)
                    } else if let error {
                        InlineNotice(error, tone: .error, actionTitle: "Try again") { Task { await load() } }
                    } else if let kit {
                        if kits.count > 1 {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: Spacing.sm) {
                                    ForEach(kits) { item in
                                        ChipButton(item.name, isSelected: item.id == kit.id) { selectedId = item.id }
                                    }
                                }
                            }
                        }
                        actions(kit)
                        colors(kit)
                        fonts(kit)
                        logos(kit)
                        if let error = insert.errorMessage {
                            InlineNotice(error, tone: .error)
                        }
                    } else {
                        EmptyStateView(
                            "no brand *yet*.",
                            message: "Create a brand kit with your colors, fonts and logos on the web. It shows up here on every device.",
                            systemImage: "seal",
                            actionTitle: "Open brand kits",
                            action: { openURL(editor.session.environment.appURL.appendingPathComponent("brand")) }
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.top, Spacing.xl)
                    }
                }
                .padding(Spacing.gutter)
            }
        }
        .panelSheet([.medium, .large], interactiveUpThrough: .medium)
        .task { await load() }
    }

    private func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let workspaceId = try await insert.context.resolveWorkspaceId()
            kits = try await editor.session.api.brandKitDetails(workspaceId: workspaceId)
        } catch {
            let mapped = DesynError(error)
            self.error = mapped.isTransient ? "You're offline. Brand kits load when you're back online." : mapped.message
        }
    }

    // MARK: Sections

    private func actions(_ kit: BrandKitDetail) -> some View {
        VStack(spacing: Spacing.sm) {
            DSButton("Apply to this page", systemImage: "wand.and.rays", kind: .primary, isLoading: applying) {
                Task { await applyKit(kit) }
            }
            DSButton("Match my brand with AI", kind: .secondary) {
                insert.context.openAIDock(prompt: (
                    "Make this design match the \u{201C}\(kit.name)\u{201D} brand kit: its colors, fonts, logo and voice. Keep the layout and copy that already work.",
                    .edit
                ))
            }
        }
    }

    private func colors(_ kit: BrandKitDetail) -> some View {
        PanelSection("Colors") {
            if kit.colors.isEmpty {
                Text("This kit has no colors yet.").font(.dsFootnote).foregroundStyle(Palette.muted)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 64), spacing: Spacing.md)], spacing: Spacing.md) {
                ForEach(Array(kit.colors.enumerated()), id: \.offset) { _, color in
                    Button {
                        applyColor(color.value)
                    } label: {
                        VStack(spacing: Spacing.xs) {
                            Circle()
                                .fill(Color(hex: color.value))
                                .frame(width: 48, height: 48)
                                .overlay(Circle().strokeBorder(Palette.border, lineWidth: 1))
                            Text(color.name).font(.dsCaption).foregroundStyle(Palette.foreground).lineLimit(1)
                            Text(color.role?.capitalized ?? color.value.uppercased()).font(DSFont.mono(10)).foregroundStyle(Palette.muted).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel("\(color.name), \(color.value)")
                    .accessibilityHint(editor.selection.isEmpty ? "Colors the page background" : "Colors the selection")
                }
            }
        }
    }

    private struct NamedSlot: Identifiable {
        let title: String
        let slot: BrandKitDetail.FontSlot
        var id: String { title }
    }

    private func fonts(_ kit: BrandKitDetail) -> some View {
        let slots = [("Heading", kit.fonts.heading), ("Body", kit.fonts.body), ("Accent", kit.fonts.accent)]
            .compactMap { pair in pair.1.map { NamedSlot(title: pair.0, slot: $0) } }
        return PanelSection("Fonts") {
            ForEach(slots) { item in
                Button {
                    Task { await applyFont(item.slot) }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.slot.family)
                                .font(FontService.shared.previewFont(item.slot.family, size: 22, weight: Int(item.slot.weight ?? 400)) ?? DSFont.sans(20))
                                .foregroundStyle(Palette.foreground)
                            Text("\(item.title) · \(FontFamily.weightName(Int(item.slot.weight ?? 400)))").font(.dsCaption).foregroundStyle(Palette.muted)
                        }
                        Spacer()
                        Image(systemName: "textformat").foregroundStyle(Palette.sun)
                    }
                    .padding(Spacing.md)
                    .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityHint("Applies to the selected text")
                .task { await FontService.shared.loadPreview(item.slot.family) }
            }
            if slots.isEmpty {
                Text("This kit has no fonts yet.").font(.dsFootnote).foregroundStyle(Palette.muted)
            }
        }
    }

    private func logos(_ kit: BrandKitDetail) -> some View {
        PanelSection("Logos") {
            if kit.logos.isEmpty {
                Text("This kit has no logos yet.").font(.dsFootnote).foregroundStyle(Palette.muted)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: Spacing.md)], spacing: Spacing.md) {
                ForEach(Array(kit.logos.enumerated()), id: \.offset) { _, logo in
                    Button {
                        Task { await placeLogo(logo) }
                    } label: {
                        RemoteImage(logo.url, maxPixel: 320, contentMode: .fit)
                            .padding(Spacing.md)
                            .frame(maxWidth: .infinity)
                            .aspectRatio(1, contentMode: .fit)
                            .background(CheckerPattern().opacity(0.25))
                            .background(Palette.surface2)
                            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel(logo.name ?? "Logo")
                }
            }
        }
    }

    // MARK: Actions

    private func applyColor(_ hex: String) {
        let targets: [Node] = editor.selectedNodes.isEmpty
            ? (editor.currentPage.flatMap { editor.lookupNode($0.id) }.map { [$0] } ?? [])
            : editor.selectedNodes
        let ops = NodeEditing.setSolidColor(hex, on: targets)
        guard !ops.isEmpty else { return }
        Task { await editor.apply(ops, label: "Apply brand color") }
    }

    private func applyFont(_ slot: BrandKitDetail.FontSlot) async {
        let texts = editor.selectedNodes.filter { $0.type == .text }
        guard !texts.isEmpty else {
            insert.errorMessage = "Select some text first, then tap a brand font."
            return
        }
        guard await loadFont(slot) else {
            insert.errorMessage = "\(slot.family) couldn't be loaded. Check your connection and try again."
            return
        }
        let ops = NodeEditing.setFont(family: slot.family, weight: slot.weight, italic: slot.style.map { $0 == "italic" }, on: texts)
        insert.errorMessage = nil
        await editor.apply(ops, label: "Apply brand font")
    }

    /// Custom brand fonts come from their asset URL; catalog families from Google Fonts.
    private func loadFont(_ slot: BrandKitDetail.FontSlot) async -> Bool {
        if let url = slot.url.flatMap(URL.init(string:)) {
            guard let result = try? await URLSession.shared.data(from: url) else { return false }
            return await editor.registerFont(result.0, family: slot.family)
        }
        return await FontService.shared.ensure(slot.family, weight: slot.weight ?? 400, italic: slot.style == "italic", in: editor)
    }

    private func placeLogo(_ logo: BrandKitDetail.Logo) async {
        guard let assetId = logo.assetId else { return }
        do {
            let asset = try await editor.session.api.libraryAsset(assetId: assetId)
            await insert.insertLibraryAsset(asset)
        } catch {
            insert.errorMessage = DesynError(error).message
        }
    }

    private func applyKit(_ kit: BrandKitDetail) async {
        guard let page = editor.currentPage, let pageNode = editor.lookupNode(page.id) else { return }
        applying = true
        defer { applying = false }
        for slot in [kit.fonts.heading, kit.fonts.body].compactMap({ $0 }) {
            _ = await loadFont(slot)
        }
        let nodes = editor.lookupSubtree(page.id)
        var styleColors: [(id: String, name: String, value: String)] = []
        if let json = try? await editor.designSnapshotJSON(), let design = try? Design(jsonString: json) {
            styleColors = design.styles.colors
        }
        let result = BrandApplier.apply(kit, page: pageNode, nodes: nodes, existingStyleColors: styleColors, brandKitId: kit.id)
        if await editor.apply(result.ops, label: "Apply \(kit.name)") {
            editor.session.toasts.show("Applied \(kit.name): \(result.recolored) colors, \(result.refonted) fonts.", tone: .success)
            insert.context.sunrise(nodes.map(\.id))
        }
    }
}

/// A light checker behind logos (transparent marks stay visible on dark sheets).
private struct CheckerPattern: View {
    var body: some View {
        Canvas { context, size in
            let cell: CGFloat = 8
            for row in 0..<Int((size.height / cell).rounded(.up)) {
                for column in 0..<Int((size.width / cell).rounded(.up)) where (row + column).isMultiple(of: 2) {
                    context.fill(Path(CGRect(x: CGFloat(column) * cell, y: CGFloat(row) * cell, width: cell, height: cell)), with: .color(.white.opacity(0.5)))
                }
            }
        }
        .accessibilityHidden(true)
    }
}
