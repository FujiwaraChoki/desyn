import Foundation

/// A design assembled from `designs.load` pages.
public struct LoadedDesign: Sendable {
    public let header: LoadHeader
    public let design: Design
    /// Seq to subscribe from (the lowest page seq).
    public let seq: Int
    /// False when the pages were read at different seqs (replaying the log converges anyway).
    public let consistent: Bool

    public var permission: String { header.permission }
    public var canEdit: Bool { header.permission == "edit" || header.permission == "manage" }
}

/// `assembleDesign` of `convex/lib/designs_wire.ts`, in Swift.
public enum DesignAssembler {
    public static func assemble(_ pages: [LoadPage]) throws -> LoadedDesign {
        guard let header = pages.first?.header else {
            throw DesynError.unexpected("The design header is missing.")
        }
        var nodes: [String: Node] = [:]
        var seq = Int.max
        var maxSeq = 0
        for page in pages {
            seq = min(seq, Int(page.seq))
            maxSeq = max(maxSeq, Int(page.seq))
            for json in page.nodes {
                let node = try Node(jsonString: json)
                nodes[node.id] = node
            }
        }
        let assets = try parseObject(header.assets).compactMapValues { $0.objectValue.map(AssetRef.init(json:)) }
        let styles = DesignStyles(json: try parseObject(header.styles))
        let meta = try parseObject(header.meta)
        let design = Design(
            id: header.key,
            name: header.name,
            kind: DesignKind(rawValue: header.kind),
            nodes: nodes,
            assets: assets,
            styles: styles,
            brandKitId: header.brandKitId,
            meta: meta
        )
        let start = seq == Int.max ? 0 : seq
        return LoadedDesign(header: header, design: design, seq: start, consistent: start == maxSeq)
    }

    private static func parseObject(_ json: String) throws -> [String: JSONValue] {
        guard case let .object(object) = try JSONValue.parse(json) else { return [:] }
        return object
    }
}

public extension DesynAPI {
    /// Loads every page of a design (`designs.load` returns nodes in chunks).
    func loadDesign(designId: String, share: ShareAccess?) async throws -> LoadedDesign {
        var pages: [LoadPage] = []
        var cursor: String?
        repeat {
            let page = try await loadPage(designId: designId, cursor: cursor, share: share)
            pages.append(page)
            if page.isDone { break }
            guard let next = page.cursor, next != cursor else { break }
            cursor = next
        } while true
        return try DesignAssembler.assemble(pages)
    }
}
