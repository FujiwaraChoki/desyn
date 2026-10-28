import DesignSystem
import DesynEngine
import DesynKit
import EditorFeature
import Foundation
import Observation
import PanelKit
import SharedKit
import UIKit

/// Inserting into the open design: elements built locally, photos uploaded to the workspace (presigned S3 through
/// `assets.requestUpload` / `finalize`), stock photos imported by the server, library assets and Iconify icons.
/// Every insert is one transaction and selects what it added.
@MainActor
@Observable
public final class InsertModel {
    public let editor: EditorModel
    public let context: EditorContext
    /// Uploads / imports in flight (shown as a progress row).
    public private(set) var busy: [String] = []
    public var errorMessage: String?

    /// Offset for consecutive inserts so several photos do not stack exactly.
    @ObservationIgnored private var cascade = 0

    public init(editor: EditorModel, context: EditorContext) {
        self.editor = editor
        self.context = context
    }

    var api: DesynAPI { editor.session.api }

    // MARK: Placement

    var page: PageInfo? { editor.currentPage }

    /// Where the next element goes: the center of the visible page area, cascading for repeated inserts.
    func nextCenter() -> PagePoint {
        let base = editor.visibleCenter().map { PagePoint(x: $0.x, y: $0.y) }
            ?? PagePoint(x: (page?.width ?? 1080) / 2, y: (page?.height ?? 1080) / 2)
        let step = Double(cascade % 6) * max(12, (page.map { min($0.width, $0.height) } ?? 1080) * 0.03)
        cascade += 1
        return PagePoint(x: base.x + step, y: base.y + step)
    }

    func resetCascade() { cascade = 0 }

    /// A good size for an element: a share of the page's shorter side.
    func side(_ share: Double = 0.3) -> Double {
        guard let page else { return 240 }
        return max(24, (min(page.width, page.height) * share).rounded())
    }

    /// Readable color for things placed on the page (dark on light pages, light on dark).
    var inkColor: String {
        guard let pageId = page?.id, let hex = editor.lookupNode(pageId)?.background.first?.swatchHex, let rgba = RGBA(hex: hex) else {
            return "#111111"
        }
        return rgba.readableTextHex
    }

    // MARK: Elements

    /// Commits `nodes` (subtree roots first) onto the current page and selects the roots.
    @discardableResult
    func insert(_ nodes: [Node], label: String, extraOps: [Op] = []) async -> Bool {
        guard let page else { return false }
        guard editor.canEdit else {
            errorMessage = "This design is view only."
            return false
        }
        let roots = nodes.filter { $0.parent == page.id || $0.parent == nil }
        var ops = extraOps
        for root in roots {
            let subtree = [root] + nodes.filter { $0.id != root.id && isDescendant($0, of: root.id, in: nodes) }
            ops.append(.create(nodes: subtree, parent: page.id, index: nil))
        }
        let ok = await editor.apply(ops, label: label)
        if ok {
            editor.select(roots.map(\.id))
            Haptics.light()
        }
        return ok
    }

    private func isDescendant(_ node: Node, of rootId: String, in nodes: [Node]) -> Bool {
        var parent = node.parent
        while let current = parent {
            if current == rootId { return true }
            parent = nodes.first { $0.id == current }?.parent
        }
        return false
    }

    func insertShape(_ shape: ElementFactory.Shape) async {
        guard let page else { return }
        let node = ElementFactory.shape(shape, parent: page.id, center: nextCenter(), side: side(), color: shape == .line || shape == .arrow ? inkColor : "#ffb02e")
        await insert([node], label: "Add \(shape.title.lowercased())")
    }

    func insertText(_ preset: ElementFactory.TextPreset) async {
        guard let page else { return }
        await context.fonts.ensure(preset.fontFamily, weight: preset.fontWeight, italic: preset.italic, in: editor)
        let node = ElementFactory.text(preset, parent: page.id, center: nextCenter(), pageWidth: page.width, pageHeight: page.height, color: inkColor)
        if await insert([node], label: "Add \(preset.title.lowercased())") {
            editor.beginTextEditing(node.id, selectAll: true)
        }
    }

    func insertChart(_ kind: ElementFactory.ChartKind) async {
        guard context.require("charts"), let page else { return }
        let node = ElementFactory.chart(kind, parent: page.id, center: nextCenter(), width: side(0.6), textColor: inkColor)
        await insert([node], label: "Add chart")
    }

    func insertTable(rows: Int, cols: Int) async {
        guard context.require("tables"), let page else { return }
        let node = ElementFactory.table(rows: rows, cols: cols, parent: page.id, center: nextCenter(), width: side(0.7), textColor: "#111111", accent: "#ffd66b")
        await insert([node], label: "Add table")
    }

    func insertQR(_ text: String) async {
        guard context.require("qr"), let page else { return }
        let payload = ElementFactory.qrPayload(text)
        guard !payload.isEmpty else { return }
        let node = ElementFactory.qr(data: payload, parent: page.id, center: nextCenter(), side: side(0.25))
        await insert([node], label: "Add QR code")
    }

    func insertIcon(_ icon: IconifyClient.Icon, markup: String) async {
        guard let page else { return }
        let tinted = SVGMarkup.tinted(markup, hex: inkColor)
        let node = ElementFactory.svg(markup: tinted, name: icon.title.capitalized, parent: page.id, center: nextCenter(), side: side(0.2))
        await insert([node], label: "Add icon")
    }

    // MARK: Files

    private func track<T>(_ label: String, _ work: () async throws -> T) async -> T? {
        busy.append(label)
        defer { busy.removeAll { $0 == label } }
        do {
            errorMessage = nil
            return try await work()
        } catch {
            let mapped = DesynError(error)
            errorMessage = mapped.isTransient ? "Connect to the internet to add files." : mapped.message
            Haptics.error()
            return nil
        }
    }

    /// Uploads prepared image bytes to the workspace and places them.
    func upload(_ prepared: ImagePreparation.Prepared) async {
        _ = await track("Uploading \(prepared.name)") {
            let workspaceId = try await context.resolveWorkspaceId()
            let info = try await AssetUploader(api: api).upload(
                prepared.data,
                name: prepared.name,
                mime: prepared.mime,
                workspaceId: workspaceId,
                width: Double(prepared.pixelSize.width),
                height: Double(prepared.pixelSize.height)
            )
            await place(ref: info.assetRef, data: prepared.data, pixelWidth: info.width ?? Double(prepared.pixelSize.width), pixelHeight: info.height ?? Double(prepared.pixelSize.height), name: (prepared.name as NSString).deletingPathExtension)
        }
    }

    /// Places a library asset (uploads, AI results, stock, brand logos).
    func insertLibraryAsset(_ asset: LibraryAsset) async {
        _ = await track("Adding \(asset.displayName)") {
            var data: Data?
            if let url = asset.url.flatMap(URL.init(string:)) {
                let (bytes, response) = try await URLSession.shared.data(from: url)
                if (response as? HTTPURLResponse)?.statusCode ?? 200 < 300 { data = bytes }
            }
            await place(ref: asset.assetRef, data: data, pixelWidth: asset.width, pixelHeight: asset.height, name: asset.displayName)
        }
    }

    /// Downloads a stock photo, stores it in the workspace library (presigned upload) with its attribution, places
    /// it, and reports the use to the source (Unsplash's guidelines).
    func insertStock(_ photo: StockPhoto) async {
        _ = await track("Adding photo by \(photo.author)") {
            guard let url = URL(string: photo.url) else { throw DesynError.unexpected("The photo address is invalid.") }
            let (bytes, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true else {
                throw DesynError.server(code: "DOWNLOAD_FAILED", message: "The photo couldn't be downloaded. Try another one.")
            }
            let name = photo.description.isEmpty ? photo.credit : String(photo.description.prefix(60))
            guard let prepared = await Task.detached(priority: .userInitiated, operation: { ImagePreparation.prepare(data: bytes, fileName: name, type: nil) }).value else {
                throw DesynError.unexpected("The photo couldn't be read.")
            }
            let workspaceId = try await context.resolveWorkspaceId()
            let info = try await AssetUploader(api: api).upload(
                prepared.data,
                name: prepared.name,
                mime: prepared.mime,
                workspaceId: workspaceId,
                width: Double(prepared.pixelSize.width),
                height: Double(prepared.pixelSize.height)
            )
            var ref = info.assetRef
            ref.set("source", "stock")
            ref.set("attribution", .object(photo.attribution))
            await place(ref: ref, data: prepared.data, pixelWidth: info.width ?? Double(prepared.pixelSize.width), pixelHeight: info.height ?? Double(prepared.pixelSize.height), name: name)
            try? await api.trackStockUse(photo)
        }
    }

    /// Registers the asset with the engine and commits `asset` + `create` as one step.
    private func place(ref: AssetRef, data: Data?, pixelWidth: Double?, pixelHeight: Double?, name: String) async {
        guard let page else { return }
        await editor.registerAsset(ref, data: data)
        let node: Node
        if ref.kind == "svg" {
            let image = ElementFactory.image(assetId: ref.id, pixelWidth: pixelWidth, pixelHeight: pixelHeight, parent: page.id, center: nextCenter(), maxSide: side(0.4), name: name)
            var json = image.json
            json["type"] = "svg"
            json["role"] = "illustration"
            for key in ["fit", "cornerRadius", "strokes"] { json[key] = nil }
            node = Node(json: json)
        } else {
            node = ElementFactory.image(assetId: ref.id, pixelWidth: pixelWidth, pixelHeight: pixelHeight, parent: page.id, center: nextCenter(), maxSide: side(0.6), name: name)
        }
        await insert([node], label: ref.kind == "svg" ? "Add vector" : "Add image", extraOps: [.asset(set: [ref.id: ref], remove: [])])
    }
}
