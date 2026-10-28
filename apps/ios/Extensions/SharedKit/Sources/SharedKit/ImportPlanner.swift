import DesynKit
import Foundation

/// Builds the Design JSON for files imported from other apps (share extension): one page per photo or PDF page,
/// each holding the uploaded image as a full-bleed layer. The design is created with `designs.importDesign`.
public enum ImportPlanner {
    /// One uploaded image to place on its own page.
    public struct Item: Sendable {
        public let asset: AssetRef
        /// Pixel size of the uploaded image.
        public let pixelWidth: Double
        public let pixelHeight: Double
        /// Page size in design px when it is known (PDF pages: points x 96 / 72); nil sizes the page from pixels.
        public let pageWidth: Double?
        public let pageHeight: Double?
        public let name: String

        public init(asset: AssetRef, pixelWidth: Double, pixelHeight: Double, pageWidth: Double? = nil, pageHeight: Double? = nil, name: String) {
            self.asset = asset
            self.pixelWidth = pixelWidth
            self.pixelHeight = pixelHeight
            self.pageWidth = pageWidth
            self.pageHeight = pageHeight
            self.name = name
        }
    }

    /// Longest page side for photos (their pixels can be much larger; pages stay a workable size).
    public static let photoLongestSide: Double = 1920

    /// Page size for an item: the PDF page size, else the photo's aspect at `photoLongestSide` (smaller photos keep
    /// their pixel size).
    public static func pageSize(for item: Item) -> (width: Double, height: Double) {
        if let w = item.pageWidth, let h = item.pageHeight, w > 0, h > 0 {
            return (w.rounded(), h.rounded())
        }
        let w = max(1, item.pixelWidth)
        let h = max(1, item.pixelHeight)
        let scale = min(1, photoLongestSide / max(w, h))
        return (max(1, (w * scale).rounded()), max(1, (h * scale).rounded()))
    }

    /// The design kind for the import: documents for PDFs, social posts for square photos, posters for portrait,
    /// presentations for 16:9-ish landscape, custom otherwise.
    public static func kind(for items: [Item], isPDF: Bool) -> DesignKind {
        if isPDF { return DesignKind(rawValue: items.count > 1 ? "document" : "poster") }
        guard let first = items.first else { return .custom }
        let size = pageSize(for: first)
        let ratio = size.width / size.height
        if abs(ratio - 1) < 0.02 { return .socialPost }
        if ratio > 1.6, ratio < 1.9 { return .presentation }
        if ratio < 0.6 { return .story }
        return .custom
    }

    /// Complete Design JSON (schema 1) for `items`.
    public static func design(name: String, items: [Item], isPDF: Bool, now: Date = Date()) -> Design {
        var nodes: [String: Node] = [:]
        var pageIds: [String] = []
        var assets: [String: AssetRef] = [:]
        for (index, item) in items.enumerated() {
            let size = pageSize(for: item)
            let page = NodeFactory.page(
                name: items.count > 1 ? "Page \(index + 1)" : "Page 1",
                width: size.width,
                height: size.height,
                unit: isPDF ? .pt : .px
            )
            var image = NodeFactory.image(
                parent: page.id,
                assetId: item.asset.id,
                frame: PageRect(x: 0, y: 0, width: size.width, height: size.height),
                name: item.name
            )
            image.set("role", isPDF ? "background" : "photo")
            var pageJSON = page.json
            pageJSON["children"] = .array([.string(image.id)])
            nodes[page.id] = Node(json: pageJSON)
            nodes[image.id] = image
            pageIds.append(page.id)
            var ref = item.asset
            ref.set("url", nil)
            assets[ref.id] = ref
        }
        let root = Node(json: [
            "id": .string(Design.rootID),
            "type": "root",
            "name": "Root",
            "parent": .null,
            "x": 0, "y": 0, "width": 0, "height": 0, "rotation": 0,
            "opacity": 1, "blend": "normal", "visible": true, "locked": false, "effects": [],
            "children": .strings(pageIds),
        ])
        nodes[Design.rootID] = root
        let stamp = (now.timeIntervalSince1970 * 1000).rounded()
        return Design(
            id: DesynID.new(),
            name: name,
            kind: kind(for: items, isPDF: isPDF),
            nodes: nodes,
            assets: assets,
            meta: ["createdAt": .number(stamp), "updatedAt": .number(stamp), "importedFrom": "ios-share"]
        )
    }

    /// A design name from a file name ("Holiday photo.jpeg" -> "Holiday photo").
    public static func name(fromFileName fileName: String?, fallback: String) -> String {
        guard let fileName, !fileName.isEmpty else { return fallback }
        let base = (fileName as NSString).deletingPathExtension.trimmingCharacters(in: .whitespacesAndNewlines)
        return base.isEmpty ? fallback : String(base.prefix(120))
    }
}
