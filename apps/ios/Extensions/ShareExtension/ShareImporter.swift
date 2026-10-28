import AppGroupKit
import DesynKit
import Foundation
import ImageIO
import Observation
import PDFKit
import SharedKit
import UIKit
import UniformTypeIdentifiers
import WidgetKit

/// Imports photos and PDFs shared from other apps into a new Desyn design: each photo or PDF page becomes a page with
/// the image as a layer. Uses the app's signed-in session (shared keychain group), uploads through presigned S3
/// (`assets.requestUpload` / `finalize`) and creates the design with `designs.importDesign`.
@MainActor
@Observable
final class ShareImporter {
    enum Phase: Equatable {
        case reading
        case ready
        case importing(done: Int, total: Int)
        case finished(name: String)
        case failed(String)
        case signedOut
        case empty
    }

    struct Source: Identifiable {
        let id = UUID()
        let preview: UIImage
        /// Image bytes ready to upload (JPEG / PNG / SVG).
        let data: Data
        let mime: String
        let pixelSize: CGSize
        /// Design px for PDF pages.
        let pageSize: CGSize?
        let name: String
    }

    private(set) var phase: Phase = .reading
    private(set) var sources: [Source] = []
    private(set) var isPDF = false
    var designName = ""
    /// PDFs longer than this import their first pages only (memory of share extensions is limited).
    static let maxPages = 30

    private let environment = AppEnvironment.from(bundle: .main)

    // MARK: Reading

    func read(_ items: [NSExtensionItem]) async {
        phase = .reading
        let providers = items.flatMap { $0.attachments ?? [] }
        var collected: [Source] = []
        var firstName: String?
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
                if let data = await loadData(provider, type: .pdf) {
                    isPDF = true
                    firstName = firstName ?? provider.suggestedName
                    collected += renderPDF(data, name: provider.suggestedName ?? "Document")
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                if let data = await loadData(provider, type: .image), let source = Self.prepareImage(data, name: provider.suggestedName ?? "Photo") {
                    firstName = firstName ?? provider.suggestedName
                    collected.append(source)
                }
            }
            if collected.count >= Self.maxPages { break }
        }
        sources = Array(collected.prefix(Self.maxPages))
        designName = ImportPlanner.name(fromFileName: firstName, fallback: isPDF ? "Imported document" : "Imported photo")
        phase = sources.isEmpty ? .empty : .ready
    }

    private func loadData(_ provider: NSItemProvider, type: UTType) async -> Data? {
        await withCheckedContinuation { continuation in
            _ = provider.loadDataRepresentation(for: type) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }

    /// Downsamples to 4096 px (ImageIO, never the full bitmap) and encodes JPEG, or PNG with transparency.
    static func prepareImage(_ data: Data, name: String) -> Source? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: 4096,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let alpha = image.alphaInfo
        let hasAlpha = alpha == .first || alpha == .last || alpha == .premultipliedFirst || alpha == .premultipliedLast
        let ui = UIImage(cgImage: image)
        let base = (name as NSString).deletingPathExtension
        let encoded: (Data, String, String)?
        if hasAlpha, let png = ui.pngData() {
            encoded = (png, "image/png", "\(base).png")
        } else if let jpeg = ui.jpegData(compressionQuality: 0.88) {
            encoded = (jpeg, "image/jpeg", "\(base).jpg")
        } else {
            encoded = nil
        }
        guard let encoded else { return nil }
        let (bytes, mime, fileName) = encoded
        let preview = Self.thumbnail(ui, maxSide: 360)
        return Source(preview: preview, data: bytes, mime: mime, pixelSize: CGSize(width: image.width, height: image.height), pageSize: nil, name: fileName)
    }

    /// Renders PDF pages to images (longest side 2400 px) with their page size in design px (points x 96 / 72).
    private func renderPDF(_ data: Data, name: String) -> [Source] {
        guard let document = PDFDocument(data: data) else { return [] }
        var result: [Source] = []
        let base = (name as NSString).deletingPathExtension
        for index in 0..<min(document.pageCount, Self.maxPages) {
            guard let page = document.page(at: index) else { continue }
            let bounds = page.bounds(for: .mediaBox)
            guard bounds.width > 0, bounds.height > 0 else { continue }
            let scale = 2400 / max(bounds.width, bounds.height)
            let size = CGSize(width: (bounds.width * scale).rounded(), height: (bounds.height * scale).rounded())
            let image = page.thumbnail(of: size, for: .mediaBox)
            guard let jpeg = image.jpegData(compressionQuality: 0.9) else { continue }
            result.append(Source(
                preview: Self.thumbnail(image, maxSide: 360),
                data: jpeg,
                mime: "image/jpeg",
                pixelSize: CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale),
                pageSize: CGSize(width: (bounds.width * 96 / 72).rounded(), height: (bounds.height * 96 / 72).rounded()),
                name: "\(base) page \(index + 1).jpg"
            ))
        }
        return result
    }

    static func thumbnail(_ image: UIImage, maxSide: CGFloat) -> UIImage {
        let factor = min(1, maxSide / max(image.size.width, image.size.height, 1))
        let size = CGSize(width: image.size.width * factor, height: image.size.height * factor)
        return UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    // MARK: Importing

    func importDesign() async {
        guard !sources.isEmpty else { return }
        let store = KeychainSessionStore()
        guard (try? store.load()) != nil else {
            phase = .signedOut
            return
        }
        phase = .importing(done: 0, total: sources.count)
        let auth = AuthClient(environment: environment)
        let provider = DesynAuthProvider(auth: auth, store: store)
        let transport = ConvexTransportClient(deploymentURL: environment.convexURL, authProvider: provider)
        switch await transport.client.loginFromCache() {
        case .success:
            break
        case let .failure(error):
            let mapped = DesynError(error)
            phase = mapped == .unauthenticated ? .signedOut : .failed(mapped.isTransient ? "You're offline. Try again when you're connected." : mapped.message)
            return
        }
        let api = DesynAPI(transport: transport)
        do {
            let workspaceId = try await defaultWorkspace(api)
            let uploader = AssetUploader(api: api)
            var items: [ImportPlanner.Item] = []
            for (index, source) in sources.enumerated() {
                let info = try await uploader.upload(
                    source.data,
                    name: source.name,
                    mime: source.mime,
                    workspaceId: workspaceId,
                    width: Double(source.pixelSize.width),
                    height: Double(source.pixelSize.height)
                )
                items.append(ImportPlanner.Item(
                    asset: info.assetRef,
                    pixelWidth: info.width ?? Double(source.pixelSize.width),
                    pixelHeight: info.height ?? Double(source.pixelSize.height),
                    pageWidth: source.pageSize.map { Double($0.width) },
                    pageHeight: source.pageSize.map { Double($0.height) },
                    name: (source.name as NSString).deletingPathExtension
                ))
                phase = .importing(done: index + 1, total: sources.count)
            }
            let name = designName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Imported design" : designName
            let design = ImportPlanner.design(name: name, items: items, isPDF: isPDF)
            let created = try await api.importDesign(workspaceId: workspaceId, designJSON: design.serialized(), name: name)
            announce(created.designId, name: name, design: design)
            await transport.client.logout()
            phase = .finished(name: name)
        } catch {
            let mapped = DesynError(error)
            phase = .failed(mapped.isTransient ? "You're offline. Try again when you're connected." : mapped.message)
        }
    }

    private func defaultWorkspace(_ api: DesynAPI) async throws -> String {
        if let id = try await api.me()?.defaultWorkspaceId { return id }
        let workspaces = try await api.workspaces()
        guard let id = workspaces.first(where: \.isDefault)?.id ?? workspaces.first?.id else {
            throw DesynError.server(code: "NOT_FOUND", message: "Open Desyn once to finish setting up your account.")
        }
        return id
    }

    /// Puts the new design at the top of the widget's recent list right away.
    private func announce(_ designId: String, name: String, design: Design) {
        let store = RecentDesignsStore.shared()
        let previous = store.load()
        let now = Date()
        var thumbnail: String?
        if let preview = sources.first?.preview.jpegData(compressionQuality: 0.82) {
            let file = RecentDesignsStore.thumbnailFileName(designId: designId, version: now)
            if (try? store.writeThumbnail(preview, file: file)) != nil { thumbnail = file }
        }
        let firstPage = design.pages.first
        let entry = RecentDesign(
            id: designId,
            name: name,
            kind: design.kind.rawValue,
            kindLabel: design.kind.label,
            width: firstPage?.width ?? 0,
            height: firstPage?.height ?? 0,
            pageCount: design.pages.count,
            updatedAt: now,
            thumbnailFile: thumbnail
        )
        let designs = [entry] + (previous?.designs ?? []).filter { $0.id != designId }.prefix(7)
        try? store.save(RecentDesignsSnapshot(ownerName: previous?.ownerName, signedIn: true, designs: Array(designs), appURL: environment.appURL))
        WidgetCenter.shared.reloadAllTimelines()
    }
}
