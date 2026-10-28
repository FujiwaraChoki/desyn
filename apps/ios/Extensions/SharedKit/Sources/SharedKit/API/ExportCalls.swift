import DesynKit
import Foundation

/// `exports/exports:status`: a server-rendered export (the render worker), used for formats the device cannot
/// produce (MP4) and as the fallback when a local export misses assets.
public struct ServerExport: Decodable, Hashable, Sendable, Identifiable {
    public struct File: Decodable, Hashable, Sendable {
        public let pageId: String?
        public let fileName: String
        public let contentType: String
        public let bytes: Double?
        public let url: String?
    }

    public let id: String
    public let designId: String
    public let format: String
    /// `queued | rendering | ready | failed | expired`.
    public let status: String
    public let files: [File]
    public let error: String?
    public let attempts: Double?
    public let createdAt: Double
    public let finishedAt: Double?
    public let expiresAt: Double?

    public var isFinished: Bool { status == "ready" || status == "failed" || status == "expired" }
}

public extension DesynAPI {
    /// Queues a server export; follow it with `exportUpdates`.
    func requestServerExport(
        designId: String,
        format: String,
        pageIds: [String]?,
        scale: Double?,
        quality: Double?,
        background: String?,
        pdf: (bleed: Bool, cropMarks: Bool, cmyk: Bool)?,
        share: ShareAccess? = nil
    ) async throws -> String {
        var args: ConvexArgs = ["designId": designId, "format": format]
        if let pageIds {
            args["pages"] = pageIds.map { $0 as ConvexEncodable? }
        } else {
            args["pages"] = "all"
        }
        if let scale { args["scale"] = scale }
        if let quality { args["quality"] = quality.rounded() }
        if let background { args["background"] = background }
        if let pdf {
            args["pdf"] = ["bleed": pdf.bleed, "cropMarks": pdf.cropMarks, "cmyk": pdf.cmyk] as ConvexArgs
        }
        if let share { args["share"] = share.argument }
        return try await transport.mutation("exports/exports:request", args: args, as: String.self)
    }

    /// Status of an export (live until it is ready, failed or expired).
    func exportUpdates(exportId: String) -> AsyncThrowingStream<ServerExport, Error> {
        transport.subscribe("exports/exports:status", args: ["exportId": exportId], as: ServerExport.self)
    }
}
