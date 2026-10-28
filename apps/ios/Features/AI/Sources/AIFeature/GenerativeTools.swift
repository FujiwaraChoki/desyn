import DesignSystem
import DesynKit
import EditorFeature
import Foundation
import Observation
import PanelKit
import SharedKit
import SwiftUI

/// Generative media for the open design (`ai/media:*`): images and vectors from a prompt, and for a selected photo:
/// background removal, generative expand, upscale and mockups. Results land in the workspace library (with their
/// provenance) and on the canvas: new images are placed, edited photos are swapped in place.
@MainActor
@Observable
final class GenerativeToolsModel {
    enum Tool: String, CaseIterable, Identifiable {
        case image, vector, removeBackground, expand, upscale, mockup

        var id: String { rawValue }

        var title: String {
            switch self {
            case .image: "Image"
            case .vector: "Vector"
            case .removeBackground: "Remove background"
            case .expand: "Expand"
            case .upscale: "Upscale"
            case .mockup: "Mockup"
            }
        }

        var systemImage: String {
            switch self {
            case .image: "photo.badge.plus"
            case .vector: "scribble.variable"
            case .removeBackground: "person.crop.rectangle.badge.plus"
            case .expand: "arrow.up.left.and.arrow.down.right"
            case .upscale: "plus.magnifyingglass"
            case .mockup: "macbook.and.iphone"
            }
        }

        /// Tools that work on the selected photo.
        var needsImage: Bool { self == .removeBackground || self == .expand || self == .upscale }
    }

    enum Aspect: String, CaseIterable {
        case square, portrait, landscape, page

        var title: String { rawValue.capitalized }

        func size(page: (width: Double, height: Double)?) -> (Double, Double) {
            switch self {
            case .square: (1024, 1024)
            case .portrait: (832, 1216)
            case .landscape: (1216, 832)
            case .page:
                guard let page, page.width > 0, page.height > 0 else { return (1024, 1024) }
                let scale = 1216 / max(page.width, page.height)
                return ((page.width * scale).rounded(), (page.height * scale).rounded())
            }
        }
    }

    let editor: EditorModel
    let context: EditorContext

    var tool: Tool = .image
    var prompt = ""
    var style = "Photo"
    var aspect: Aspect = .square
    var withText = false
    var useBrand = false
    var count = 1
    var vectorKind = "illustration"
    var strokeOnly = false
    var upscaleFactor = 2.0
    var scene = "On a desk next to a coffee cup, soft morning light"

    private(set) var working = false
    private(set) var results: [GeneratedMedia] = []
    var errorMessage: String?

    static let styles = ["Photo", "Illustration", "3D render", "Watercolor", "Line art", "Flat", "Cinematic", "Minimal"]
    static let vectorKinds = [("illustration", "Illustration"), ("icon", "Icon"), ("logo", "Logo mark"), ("pattern", "Pattern"), ("sticker", "Sticker")]

    init(editor: EditorModel, context: EditorContext) {
        self.editor = editor
        self.context = context
    }

    var api: DesynAPI { editor.session.api }

    /// The selected photo, when exactly one image is selected.
    var selectedImage: Node? {
        guard editor.selectedNodes.count == 1, let node = editor.selectedNodes.first, node.type == .image else { return nil }
        return node
    }

    var canRun: Bool {
        guard editor.canEdit, !working else { return false }
        switch tool {
        case .image, .vector: return !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .removeBackground, .expand, .upscale: return selectedImage != nil
        case .mockup: return !scene.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    // MARK: Running

    func run() async {
        guard canRun else { return }
        working = true
        errorMessage = nil
        defer { working = false }
        do {
            let designId = editor.designId
            let pageSize = editor.currentPage.map { (width: $0.width, height: $0.height) }
            switch tool {
            case .image:
                let (w, h) = aspect.size(page: pageSize)
                let text = style == "Photo" ? prompt : "\(prompt). Style: \(style.lowercased())."
                let result = try await api.generateImage(prompt: text, designId: designId, width: w, height: h, style: style.lowercased(), withText: withText, useBrand: useBrand, count: count)
                results = result.assets + results
                if count == 1, let first = result.assets.first { await place(first) }
            case .vector:
                let result = try await api.generateSVG(prompt: prompt, designId: designId, kind: vectorKind, useBrand: useBrand, strokeOnly: strokeOnly)
                results = result.assets + results
                if let first = result.assets.first { await place(first) }
            case .removeBackground:
                guard let image = selectedImage else { return }
                let source = try await convexAssetId(for: image)
                let result = try await api.removeBackground(assetId: source, designId: designId)
                if let first = result.assets.first { await swap(image, with: first, label: "Remove background") }
            case .expand:
                guard let image = selectedImage else { return }
                let source = try await convexAssetId(for: image)
                let (w, h) = aspect.size(page: pageSize)
                let result = try await api.expandImage(assetId: source, width: w, height: h, prompt: prompt.isEmpty ? nil : prompt, designId: designId)
                if let first = result.assets.first { await swap(image, with: first, label: "Expand image", resize: true) }
            case .upscale:
                guard let image = selectedImage else { return }
                let source = try await convexAssetId(for: image)
                let result = try await api.upscaleImage(assetId: source, factor: upscaleFactor, designId: designId)
                if let first = result.assets.first { await swap(image, with: first, label: "Upscale image") }
            case .mockup:
                var source: String?
                if let image = selectedImage { source = try await convexAssetId(for: image) }
                let result = try await api.mockup(scene: scene, assetId: source, pageId: source == nil ? editor.currentPage?.id : nil, designId: designId)
                results = result.assets + results
                if let first = result.assets.first { await place(first) }
            }
            Haptics.success()
        } catch {
            errorMessage = AIDockModel.message(for: DesynError(error))
            Haptics.error()
        }
    }

    // MARK: Canvas

    /// The Convex asset id of a placed image: its bytes re-announced to the asset library (deduplicated by hash, so
    /// nothing uploads again when the workspace has them).
    private func convexAssetId(for node: Node) async throws -> String {
        guard let refId = node.assetId else { throw DesynError.unexpected("This layer has no image.") }
        guard let store = editor.session.store else { throw DesynError.unauthenticated }
        let ref = editor.knownAssets[refId]
        let repository = AssetRepository(api: api, store: store, designId: editor.designId, share: editor.route.share)
        guard let data = await repository.data(for: refId, ref: ref) else {
            throw DesynError.offline("The image isn't on this device yet.")
        }
        let workspaceId = try await context.resolveWorkspaceId()
        let info = try await AssetUploader(api: api).upload(
            data,
            name: ref?.name ?? node.name,
            mime: ref?.mime ?? "image/png",
            workspaceId: workspaceId,
            width: ref?.width,
            height: ref?.height
        )
        return info.id
    }

    /// The `AssetRef` and bytes of a generated file.
    private func resolve(_ media: GeneratedMedia) async throws -> (AssetRef, Data?) {
        let asset = try await api.libraryAsset(assetId: media.assetId)
        var data: Data?
        if let url = (media.url ?? asset.url).flatMap(URL.init(string:)) {
            data = try? await URLSession.shared.data(from: url).0
        }
        return (asset.assetRef, data)
    }

    /// Places a result on the current page, centered and fitted.
    func place(_ media: GeneratedMedia) async {
        guard let page = editor.currentPage else { return }
        do {
            let (ref, data) = try await resolve(media)
            await editor.registerAsset(ref, data: data)
            let center = editor.visibleCenter().map { PagePoint(x: $0.x, y: $0.y) } ?? PagePoint(x: page.width / 2, y: page.height / 2)
            var node = ElementFactory.image(
                assetId: ref.id,
                pixelWidth: media.width ?? ref.width,
                pixelHeight: media.height ?? ref.height,
                parent: page.id,
                center: center,
                maxSide: min(page.width, page.height) * (media.isSVG ? 0.4 : 0.7),
                name: media.isSVG ? "AI vector" : "AI image"
            )
            if media.isSVG {
                var json = node.json
                json["type"] = "svg"
                json["role"] = "illustration"
                for key in ["fit", "cornerRadius", "strokes"] { json[key] = nil }
                node = Node(json: json)
            }
            if await editor.apply([.asset(set: [ref.id: ref], remove: []), .create(nodes: [node], parent: page.id, index: nil)], label: media.isSVG ? "AI: add vector" : "AI: add image") {
                editor.select([node.id])
                context.sunrise([node.id])
            }
        } catch {
            errorMessage = DesynError(error).message
        }
    }

    /// Replaces the photo of `image` with the result, keeping position and styling; `resize` adapts the box to the
    /// result's aspect (expand).
    private func swap(_ image: Node, with media: GeneratedMedia, label: String, resize: Bool = false) async {
        do {
            let (ref, data) = try await resolve(media)
            await editor.registerAsset(ref, data: data)
            var set: [String: JSONValue] = ["assetId": .string(ref.id)]
            if resize, let w = media.width ?? ref.width, let h = media.height ?? ref.height, w > 0, h > 0 {
                let height = image.width * h / w
                set["height"] = .number(height.rounded())
                set["y"] = .number((image.y - (height - image.height) / 2).rounded())
            }
            if await editor.apply([.asset(set: [ref.id: ref], remove: []), .update(id: image.id, set: set, unset: ["crop"])], label: label) {
                context.sunrise([image.id])
            }
        } catch {
            errorMessage = DesynError(error).message
        }
    }
}

/// The generative tools panel.
public struct GenerativeToolsPanel: View {
    @State private var model: GenerativeToolsModel
    @Environment(\.dismiss) private var dismiss

    public init(editor: EditorModel, context: EditorContext) {
        _model = State(initialValue: GenerativeToolsModel(editor: editor, context: context))
    }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader("create with *ai*", subtitle: model.selectedImage != nil ? "A photo is selected" : nil) { dismiss() }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.sm) {
                    ForEach(GenerativeToolsModel.Tool.allCases) { tool in
                        ChipButton(tool.title, systemImage: tool.systemImage, isSelected: model.tool == tool) {
                            model.tool = tool
                        }
                    }
                }
                .padding(.horizontal, Spacing.gutter)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.xl) {
                    form
                    if let error = model.errorMessage {
                        InlineNotice(error, tone: .error, actionTitle: "Dismiss") { model.errorMessage = nil }
                    }
                    DSButton(model.working ? "Working…" : buttonTitle, kind: .primary, isLoading: model.working) {
                        Task { await model.run() }
                    }
                    .disabled(!model.canRun)
                    if model.working {
                        Text("Generating takes a few seconds. You can keep editing.")
                            .font(.dsFootnote)
                            .foregroundStyle(Palette.muted)
                    }
                    if !model.results.isEmpty {
                        results
                    }
                }
                .padding(Spacing.gutter)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .panelSheet([.medium, .large], interactiveUpThrough: .medium)
    }

    private var buttonTitle: String {
        switch model.tool {
        case .image: model.count > 1 ? "Generate \(model.count) images" : "Generate image"
        case .vector: "Generate vector"
        case .removeBackground: "Remove background"
        case .expand: "Expand photo"
        case .upscale: "Upscale \(Int(model.upscaleFactor))×"
        case .mockup: "Create mockup"
        }
    }

    @ViewBuilder private var form: some View {
        switch model.tool {
        case .image:
            promptField("Describe the image")
            PanelSection("Style") {
                WrapLayout(spacing: Spacing.sm) {
                    ForEach(GenerativeToolsModel.styles, id: \.self) { style in
                        ChipButton(style, isSelected: model.style == style) { model.style = style }
                    }
                }
            }
            aspectPicker
            PanelSection("Options") {
                PanelToggle("Text in the image", detail: "Uses a model that writes legible words.", isOn: model.withText) { model.withText = $0 }
                PanelToggle("Use brand colors", detail: "Follows the design's brand kit palette.", isOn: model.useBrand) { model.useBrand = $0 }
                Stepper("\(model.count) image\(model.count == 1 ? "" : "s")", value: Binding(get: { model.count }, set: { model.count = $0 }), in: 1...4)
                    .font(.dsCallout)
                    .tint(Palette.sun)
            }
        case .vector:
            promptField("Describe the vector")
            PanelSection("Kind") {
                WrapLayout(spacing: Spacing.sm) {
                    ForEach(GenerativeToolsModel.vectorKinds, id: \.0) { kind in
                        ChipButton(kind.1, isSelected: model.vectorKind == kind.0) { model.vectorKind = kind.0 }
                    }
                }
            }
            PanelSection("Options") {
                PanelToggle("Outline only", isOn: model.strokeOnly) { model.strokeOnly = $0 }
                PanelToggle("Use brand colors", isOn: model.useBrand) { model.useBrand = $0 }
            }
        case .removeBackground:
            imageRequirement("Cuts out the subject and keeps a transparent background. The original stays in your uploads.")
        case .expand:
            imageRequirement("Extends the photo beyond its edges with matching content.")
            aspectPicker
            promptField("What to add at the edges (optional)")
        case .upscale:
            imageRequirement("Adds detail and resolution for print and large screens.")
            DSSegmentedControl(selection: Binding(get: { model.upscaleFactor }, set: { model.upscaleFactor = $0 }), options: [(2.0, "2×"), (4.0, "4×")])
        case .mockup:
            Text(model.selectedImage == nil ? "Places this page into a photographed scene." : "Places the selected photo into a photographed scene.")
                .font(.dsCallout)
                .foregroundStyle(Palette.muted)
            PanelSection("Scene") {
                TextField("Scene", text: Binding(get: { model.scene }, set: { model.scene = $0 }), axis: .vertical)
                    .lineLimit(2...4)
                    .font(.dsBody)
                    .padding(Spacing.md)
                    .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                    .tint(Palette.sun)
                WrapLayout(spacing: Spacing.sm) {
                    ForEach(["Framed on a gallery wall", "Poster in a city street", "Phone in a hand", "Laptop on a desk", "Book on a table", "T-shirt on a model"], id: \.self) { idea in
                        ChipButton(idea) { model.scene = idea }
                    }
                }
            }
        }
    }

    private func promptField(_ placeholder: String) -> some View {
        TextField(placeholder, text: Binding(get: { model.prompt }, set: { model.prompt = $0 }), axis: .vertical)
            .lineLimit(2...6)
            .font(.dsBody)
            .foregroundStyle(Palette.foreground)
            .padding(Spacing.md)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.field, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
            .tint(Palette.sun)
    }

    private var aspectPicker: some View {
        PanelSection("Shape") {
            DSSegmentedControl(
                selection: Binding(get: { model.aspect }, set: { model.aspect = $0 }),
                options: GenerativeToolsModel.Aspect.allCases.map { ($0, $0.title) }
            )
        }
    }

    @ViewBuilder private func imageRequirement(_ text: String) -> some View {
        Text(text).font(.dsCallout).foregroundStyle(Palette.muted)
        if model.selectedImage == nil {
            InlineNotice("Select a photo on the canvas first.", tone: .info)
        }
    }

    private var results: some View {
        PanelSection("Results") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: Spacing.md)], spacing: Spacing.md) {
                ForEach(model.results) { media in
                    Button {
                        Task { await model.place(media) }
                    } label: {
                        RemoteImage(media.url, maxPixel: 400, contentMode: media.isSVG ? .fit : .fill)
                            .frame(minWidth: 0, maxWidth: .infinity)
                            .aspectRatio(CGFloat((media.width ?? 1) / max(1, media.height ?? 1)), contentMode: .fit)
                            .background(Palette.surface2)
                            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                            .overlay(alignment: .bottomTrailing) {
                                Image(systemName: "plus.circle.fill")
                                    .font(.system(size: 22))
                                    .foregroundStyle(Palette.onSun, Palette.sun)
                                    .padding(6)
                            }
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel("Place generated \(media.isSVG ? "vector" : "image")")
                }
            }
            Text("Saved to your uploads with how they were made.").font(.dsCaption).foregroundStyle(Palette.muted)
        }
    }
}
