import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Uploads a file to the workspace's asset library: `assets.requestUpload` (presigned PUT, plan checks, dedupe by
/// hash) -> PUT with exactly the signed headers -> `assets.finalize` (server-side type sniffing, dimensions, SVG
/// sanitizing) -> `assets.get` for the `AssetRef` to insert into a design.
public struct AssetUploader: Sendable {
    public let api: DesynAPI
    private let session: URLSession

    public init(api: DesynAPI, session: URLSession = .shared) {
        self.api = api
        self.session = session
    }

    public func upload(
        _ data: Data,
        name: String,
        mime: String,
        workspaceId: String,
        width: Double?,
        height: Double?
    ) async throws -> AssetInfo {
        let ticket = try await api.requestUpload(
            workspaceId: workspaceId,
            name: name,
            mime: mime,
            bytes: data.count,
            sha256: sha256Hex(data)
        )
        var assetId = ticket.assetId
        if let upload = ticket.upload {
            guard let url = URL(string: upload.url) else {
                throw DesynError.unexpected("The upload address is invalid.")
            }
            var request = URLRequest(url: url)
            request.httpMethod = upload.method
            for (header, value) in upload.headers {
                request.setValue(value, forHTTPHeaderField: header)
            }
            let response: URLResponse
            do {
                (_, response) = try await session.upload(for: request, from: data)
            } catch {
                throw DesynError(error)
            }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw DesynError.server(code: "UPLOAD_FAILED", message: "The upload was rejected. Try again.")
            }
            let finalized = try await api.finalizeUpload(assetId: ticket.assetId, width: width, height: height)
            assetId = finalized.assetId
        }
        return try await api.asset(assetId: assetId)
    }
}
