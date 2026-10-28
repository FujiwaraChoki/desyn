import CoreGraphics
import DesignSystem
import DesynKit
import PanelKit
import SharedKit
import SwiftUI

/// Icons from Lucide, Tabler and Phosphor through the public Iconify API. The grid is rendered by the engine in one
/// pass (the same renderer that draws them on the page), so previews match the result exactly.
struct IconsTab: View {
    let model: InsertModel

    @State private var query = ""
    @State private var icons: [IconifyClient.Icon] = []
    @State private var previews: [String: CGImage] = [:]
    @State private var loading = false
    @State private var error: String?
    @State private var iconSet: String?
    @Environment(\.colorScheme) private var colorScheme

    private let client = IconifyClient()

    private var sets: [String] { iconSet.map { [$0] } ?? IconifyClient.defaultSets }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                DSTextField("", text: $query, prompt: "Search icons", kind: .search, submitLabel: .search) {
                    Task { await search(query) }
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Spacing.sm) {
                        ChipButton("All sets", isSelected: iconSet == nil) { choose(nil) }
                        ChipButton("Lucide", isSelected: iconSet == "lucide") { choose("lucide") }
                        ChipButton("Tabler", isSelected: iconSet == "tabler") { choose("tabler") }
                        ChipButton("Phosphor", isSelected: iconSet == "ph") { choose("ph") }
                    }
                }
                if query.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Spacing.sm) {
                            ForEach(IconifyClient.featuredQueries, id: \.self) { suggestion in
                                ChipButton(suggestion.capitalized) {
                                    query = suggestion
                                    Task { await search(suggestion) }
                                }
                            }
                        }
                    }
                }
                if let error {
                    InlineNotice(error, tone: .error, actionTitle: "Try again") { Task { await search(query.isEmpty ? "sparkle" : query) } }
                } else if loading, icons.isEmpty {
                    HStack { Spacer(); SunSpinner(size: 26); Spacer() }.padding(.vertical, Spacing.xl)
                } else if icons.isEmpty {
                    Text("No icons match \u{201C}\(query)\u{201D}. Try a simpler word.")
                        .font(.dsCallout)
                        .foregroundStyle(Palette.muted)
                } else {
                    TileGrid(minimum: 64) {
                        ForEach(icons) { icon in
                            Button {
                                Task { await insert(icon) }
                            } label: {
                                ZStack {
                                    RoundedRectangle(cornerRadius: Radius.card, style: .continuous).fill(Palette.surface2)
                                    if let image = previews[icon.id] {
                                        Image(decorative: image, scale: 2).resizable().scaledToFit().padding(Spacing.sm)
                                    } else {
                                        ShimmerPlaceholder().clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                                    }
                                }
                                .aspectRatio(1, contentMode: .fit)
                            }
                            .buttonStyle(PressScaleStyle())
                            .accessibilityLabel("\(icon.title) icon")
                        }
                    }
                    Text("Icons by Lucide (ISC), Tabler (MIT) and Phosphor (MIT) via Iconify.")
                        .font(.dsCaption)
                        .foregroundStyle(Palette.muted)
                }
            }
            .padding(Spacing.gutter)
        }
        .scrollDismissesKeyboard(.interactively)
        .task { if icons.isEmpty { await search("sparkle") } }
    }

    private func choose(_ value: String?) {
        iconSet = value
        Task { await search(query.isEmpty ? "sparkle" : query) }
    }

    private func search(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        loading = true
        error = nil
        defer { loading = false }
        do {
            let found = try await client.search(trimmed, sets: sets, limit: 64)
            icons = found
            previews = [:]
            await renderPreviews(found)
        } catch {
            self.error = "Icons couldn't load. Check your connection and try again."
        }
    }

    /// Fetches the markup (cached) and renders every icon in one engine pass.
    private func renderPreviews(_ icons: [IconifyClient.Icon]) async {
        let tint = colorScheme == .dark ? "#ededed" : "#171717"
        var nodes: [Node] = []
        let client = self.client
        await withTaskGroup(of: (String, String?).self) { group in
            for icon in icons {
                group.addTask {
                    (icon.id, await IconMarkupCache.shared.markup(for: icon, client: client))
                }
            }
            for await (id, markup) in group {
                guard let markup else { continue }
                var node = ElementFactory.svg(markup: SVGMarkup.tinted(markup, hex: tint), name: id, parent: "previewsheet", center: PagePoint(x: 0, y: 0), side: 48)
                node.set("id", .string(Self.nodeId(for: id)))
                nodes.append(node)
            }
        }
        let tiles = await PreviewRenderer.shared.renderTiles(nodes, cell: 64, scale: 2)
        var byIcon: [String: CGImage] = [:]
        for icon in icons {
            if let image = tiles[Self.nodeId(for: icon.id)] { byIcon[icon.id] = image }
        }
        previews = byIcon
    }

    static func nodeId(for iconId: String) -> String {
        IconPreviewID.nodeId(for: iconId)
    }

    private func insert(_ icon: IconifyClient.Icon) async {
        guard let markup = await IconMarkupCache.shared.markup(for: icon, client: client) else {
            model.errorMessage = "That icon couldn't load. Try again."
            return
        }
        await model.insertIcon(icon, markup: markup)
    }
}

/// Stable preview node ids for icons.
public enum IconPreviewID {
    /// A stable 12-character node id for an icon id (engine ids are `[a-z0-9]{12}`).
    public static func nodeId(for iconId: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in iconId.utf8 {
            hash = (hash ^ UInt64(byte)) &* 0x0100_0000_01b3
        }
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        var id = ""
        for _ in 0..<12 {
            id.append(alphabet[Int(hash % 36)])
            hash /= 36
            if hash == 0 { hash = 0x9e37_79b9_7f4a_7c15 }
        }
        return id
    }
}

/// SVG markup of icons fetched this session.
actor IconMarkupCache {
    static let shared = IconMarkupCache()
    private var markup: [String: String] = [:]

    func markup(for icon: IconifyClient.Icon, client: IconifyClient) async -> String? {
        if let cached = markup[icon.id] { return cached }
        guard let fetched = try? await client.svg(icon) else { return nil }
        markup[icon.id] = fetched
        return fetched
    }
}
