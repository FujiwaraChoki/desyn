import CoreGraphics
import DesynEngine
import DesynKit
import Foundation

/// Renders previews with the same Rust engine as the canvas (icons, element tiles, version snapshots), on its own
/// engine instance so the open design is never touched. Many small items render as one sheet and are cut apart, so
/// a grid of 60 icons costs one render.
public actor PreviewRenderer {
    public static let shared = PreviewRenderer()

    private let engine = DesynEngine(bundledFonts: true, assetBudgetMB: 96)

    /// Renders `nodes` (any parent / position) each centered in a `cell` x `cell` square of a sheet and returns
    /// node id -> image at `scale` device pixels per design px. `background` nil keeps cells transparent.
    public func renderTiles(_ nodes: [Node], cell: Double, scale: Double, background: String? = nil) async -> [String: CGImage] {
        guard !nodes.isEmpty else { return [:] }
        let columns = max(1, Int(Double(nodes.count).squareRoot().rounded(.up)))
        let rows = (nodes.count + columns - 1) / columns
        let pageId = "previewsheet"
        var placed: [String: Node] = [:]
        var order: [String] = []
        for (index, node) in nodes.enumerated() {
            var copy = node
            let column = index % columns
            let row = index / columns
            let fit = min(1, (cell * 0.8) / max(1, max(node.width, node.height)))
            let w = node.width * fit
            let h = node.height * fit
            copy.set("parent", .string(pageId))
            copy.set("x", .number(Double(column) * cell + (cell - w) / 2))
            copy.set("y", .number(Double(row) * cell + (cell - h) / 2))
            copy.set("width", .number(w))
            copy.set("height", .number(h))
            copy.set("rotation", .number(0))
            placed[copy.id] = copy
            order.append(copy.id)
        }
        let width = Double(columns) * cell
        let height = Double(rows) * cell
        guard let image = await renderSheet(pageId: pageId, nodes: placed, order: order, width: width, height: height, scale: scale, background: background) else { return [:] }
        var tiles: [String: CGImage] = [:]
        let pixelCell = cell * scale
        for (index, id) in order.enumerated() {
            let rect = CGRect(
                x: Double(index % columns) * pixelCell,
                y: Double(index / columns) * pixelCell,
                width: pixelCell,
                height: pixelCell
            ).integral
            if let tile = image.cropping(to: rect) { tiles[id] = tile }
        }
        return tiles
    }

    /// Renders page `pageIndex` of a design (JSON) at `width` pixels wide, with `assets` bytes by asset id.
    public func renderPage(designJSON: String, pageIndex: Int = 0, width: Double, assets: [String: Data] = [:]) async -> CGImage? {
        do {
            _ = try await engine.load(designJSON: designJSON, normalize: true)
            for (id, data) in assets {
                await engine.setAsset(id, data: data)
            }
            let pages = try await engine.pages()
            guard pages.indices.contains(pageIndex) else { return nil }
            let page = pages[pageIndex]
            let scale = min(4, width / max(1, page.width))
            let frame = try await engine.renderPage(PageImageRequest(pageId: page.id, scale: scale))
            return frame.makeCGImage()
        } catch {
            return nil
        }
    }

    private func renderSheet(pageId: String, nodes: [String: Node], order: [String], width: Double, height: Double, scale: Double, background: String?) async -> CGImage? {
        var all = nodes
        var page = NodeFactory.page(id: pageId, name: "Preview", width: width, height: height, background: background ?? "#ffffff")
        page.set("children", .strings(order))
        if background == nil { page.set("background", .array([])) }
        all[pageId] = page
        all[Design.rootID] = Node(json: [
            "id": .string(Design.rootID), "type": "root", "name": "Root", "parent": .null,
            "x": 0, "y": 0, "width": 0, "height": 0, "rotation": 0, "opacity": 1, "blend": "normal",
            "visible": true, "locked": false, "effects": [], "children": .strings([pageId]),
        ])
        let design = Design(id: "previewdsign", name: "Preview", kind: .custom, nodes: all)
        do {
            _ = try await engine.load(designJSON: design.serialized(), normalize: true)
            let frame = try await engine.renderPage(PageImageRequest(pageId: pageId, scale: scale, transparent: background == nil))
            return frame.makeCGImage()
        } catch {
            return nil
        }
    }
}
