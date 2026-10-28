import DesignSystem
import DesynEngine
import DesynKit
import EditorFeature
import Foundation
import Observation
import PanelKit
import PDFKit
import SharedKit

/// The engine's format for a file format (MP4 never renders on the device; GIF is its closest local stand-in).
public enum ExportFormatMapping {
    public static func engineFormat(_ format: FileFormat) -> ExportFormat {
        switch format {
        case .png: .png
        case .jpeg: .jpeg
        case .webp: .webp
        case .svg: .svg
        case .pdf: .pdf
        case .pptx: .pptx
        case .gif, .mp4: .gif
        }
    }
}

/// Exports the open design. Raster, SVG, PDF, PowerPoint and GIF render on the device with the engine (offline,
/// nothing leaves the phone): missing image bytes and fonts are fetched first. MP4 renders on the server's worker
/// (`exports.request`), which is also the fallback when the device cannot get every asset.
@MainActor
@Observable
final class ExportModel {
    enum Pages: Hashable {
        case all, current, chosen
    }

    struct Output: Identifiable {
        let id = UUID()
        let files: [URL]
        let format: FileFormat
        let bytes: Int
        let renderedOnServer: Bool
        let warnings: [String]
    }

    let editor: EditorModel
    let context: EditorContext

    var plan = ExportPlan()
    var pages: Pages = .all
    var chosenPages: Set<String> = []
    private(set) var working = false
    private(set) var progress: String?
    private(set) var output: Output?
    var errorMessage: String?

    init(editor: EditorModel, context: EditorContext) {
        self.editor = editor
        self.context = context
    }

    var pageInfos: [PageInfo] { editor.pages }

    /// Page ids of the export (nil = all).
    var selectedPageIds: [String]? {
        switch pages {
        case .all: return nil
        case .current: return editor.currentPage.map { [$0.id] }
        case .chosen:
            let ids = pageInfos.map(\.id).filter { chosenPages.contains($0) }
            return ids.isEmpty ? nil : ids
        }
    }

    /// Size of the first exported page for the pixel hint.
    var referencePage: PageInfo? {
        if let ids = selectedPageIds, let first = ids.first { return pageInfos.first { $0.id == first } }
        return editor.currentPage ?? pageInfos.first
    }

    var canChoosePages: Bool { pageInfos.count > 1 && plan.format != .pptx }

    // MARK: Export

    /// Forgets the last export (and deletes its temporary files) to export again.
    func discardOutput() {
        if let output {
            for file in output.files { try? FileManager.default.removeItem(at: file) }
        }
        output = nil
    }

    func export() async {
        guard !working else { return }
        // The device renders on its own, so it checks the plan like the server does for its exports.
        if let missing = plan.requiredFeatures.first(where: { context.isLocked($0) }) {
            errorMessage = PlanFeatures.lockedMessage(missing)
            Haptics.error()
            return
        }
        working = true
        errorMessage = nil
        output = nil
        defer {
            working = false
            progress = nil
        }
        let page = referencePage
        let plan = self.plan.normalized(pageWidth: page?.width ?? 1080, pageHeight: page?.height ?? 1080)
        do {
            if plan.format.rendersOnServer {
                output = try await exportOnServer(plan)
            } else {
                do {
                    output = try await exportOnDevice(plan)
                } catch let error as MissingAssetsError {
                    // Some image bytes are not on the device: the server renders with every asset.
                    progress = "Rendering \(error.count) image\(error.count == 1 ? "" : "s") on the server"
                    output = try await exportOnServer(plan)
                } catch let deviceError as EngineError {
                    // The device could not render this format / page combination; the render worker can.
                    progress = "Rendering on the server"
                    do {
                        output = try await exportOnServer(plan)
                    } catch {
                        throw ExportFailure(errorDescription: "This export couldn't be made on this device (\(deviceError.message)) or on the server (\(DesynError(error).message)).")
                    }
                }
            }
            Haptics.success()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? DesynError(error).message
            Haptics.error()
        }
    }

    private struct MissingAssetsError: Error {
        let count: Int
    }

    private struct ExportFailure: LocalizedError {
        let errorDescription: String?
    }

    private var folder: URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("Exports", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func request(_ plan: ExportPlan, pages: ExportPages) -> ExportRequest {
        let background: ExportBackground = plan.transparent ? .transparent : .page
        var pdf: PdfExportOptions?
        if plan.format == .pdf {
            pdf = PdfExportOptions(bleed: plan.pdfBleed, cropMarks: plan.pdfCropMarks, cmyk: plan.pdfCMYK, flatten: plan.pdfFlatten, dpi: 300, title: editor.name)
        }
        return ExportRequest(
            format: Self.engineFormat(plan.format),
            pages: pages,
            scale: plan.format.isRaster || plan.format == .gif ? plan.scale : 1,
            quality: UInt8(plan.quality),
            background: background,
            pdf: pdf,
            fps: plan.gifFPS
        )
    }

    static func engineFormat(_ format: FileFormat) -> ExportFormat {
        ExportFormatMapping.engineFormat(format)
    }

    /// Loads image bytes and fonts the engine reported missing; throws when images stay missing.
    private func fillMissing(assets: [String], fonts: [String]) async throws {
        for family in Set(fonts) {
            progress = "Loading \(family)"
            await context.fonts.ensure(family, weight: 400, italic: false, in: editor)
        }
        guard !assets.isEmpty else { return }
        guard let store = editor.session.store else { throw MissingAssetsError(count: assets.count) }
        progress = "Downloading images"
        let repository = AssetRepository(api: editor.session.api, store: store, designId: editor.designId, share: editor.route.share)
        var stillMissing = 0
        for id in Set(assets) {
            let ref = editor.knownAssets[id]
            if let data = await repository.data(for: id, ref: ref), let ref {
                await editor.registerAsset(ref, data: data)
            } else {
                stillMissing += 1
            }
        }
        if stillMissing > 0 { throw MissingAssetsError(count: stillMissing) }
    }

    /// Runs `make` and retries once after loading what the engine reported missing.
    private func withAssets<T>(_ make: () async throws -> (T, [String], [String])) async throws -> T {
        let (first, assets, fonts) = try await make()
        guard !assets.isEmpty || !fonts.isEmpty else { return first }
        try await fillMissing(assets: assets, fonts: fonts)
        let (second, stillAssets, _) = try await make()
        if !stillAssets.isEmpty { throw MissingAssetsError(count: Set(stillAssets).count) }
        return second
    }

    private func exportOnDevice(_ plan: ExportPlan) async throws -> Output {
        progress = "Rendering"
        let engine = editor.designEngine
        let name = editor.name
        let ids = selectedPageIds
        let directory = folder
        var files: [URL] = []
        var warnings: [String] = []
        let allPages = pageInfos

        switch plan.format {
        case .pdf where ids != nil && (ids?.count ?? 0) > 1:
            // A subset of pages: one PDF per page, merged with PDFKit.
            let merged = PDFDocument()
            for id in ids ?? [] {
                let result = try await withAssets { () async throws -> (ExportResult, [String], [String]) in
                    let result = try await engine.export(self.request(plan, pages: .page(id: id)))
                    return (result, result.missingAssets, result.missingFonts)
                }
                warnings += result.warnings
                if let document = PDFDocument(data: result.bytes) {
                    for index in 0..<document.pageCount {
                        if let page = document.page(at: index) { merged.insert(page, at: merged.pageCount) }
                    }
                }
            }
            guard let data = merged.dataRepresentation() else { throw ExportFailure(errorDescription: "The PDF couldn't be assembled. Try exporting all pages.") }
            let url = directory.appendingPathComponent(ExportPlan.fileName(designName: name, page: nil, pageCount: 1, format: .pdf))
            try data.write(to: url)
            files = [url]
        case .pdf, .pptx, .gif:
            let pages: ExportPages = ids?.count == 1 ? .page(id: ids![0]) : .all
            let result = try await withAssets { () async throws -> (ExportResult, [String], [String]) in
                let result = try await engine.export(self.request(plan, pages: pages))
                return (result, result.missingAssets, result.missingFonts)
            }
            warnings += result.warnings
            let url = directory.appendingPathComponent(ExportPlan.fileName(designName: name, page: nil, pageCount: 1, format: plan.format))
            try result.bytes.write(to: url)
            files = [url]
        default:
            let wanted = ids ?? allPages.map(\.id)
            for (offset, id) in wanted.enumerated() {
                progress = wanted.count > 1 ? "Rendering page \(offset + 1) of \(wanted.count)" : "Rendering"
                let result = try await withAssets { () async throws -> (ExportResult, [String], [String]) in
                    let result = try await engine.export(self.request(plan, pages: .page(id: id)))
                    return (result, result.missingAssets, result.missingFonts)
                }
                warnings += result.warnings
                let number = (allPages.firstIndex { $0.id == id } ?? offset) + 1
                let url = directory.appendingPathComponent(ExportPlan.fileName(designName: name, page: number, pageCount: allPages.count, format: plan.format))
                try result.bytes.write(to: url)
                files.append(url)
            }
        }
        let bytes = files.reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        return Output(files: files, format: plan.format, bytes: bytes, renderedOnServer: false, warnings: Array(Set(warnings)))
    }

    private func exportOnServer(_ plan: ExportPlan) async throws -> Output {
        progress = "Rendering on the server"
        let api = editor.session.api
        let exportId = try await api.requestServerExport(
            designId: editor.designId,
            format: plan.format.rawValue,
            pageIds: selectedPageIds,
            scale: plan.format.isRaster ? plan.scale : nil,
            quality: plan.format.hasQuality ? plan.quality : nil,
            background: plan.transparent ? "transparent" : nil,
            pdf: plan.format == .pdf ? (plan.pdfBleed, plan.pdfCropMarks, plan.pdfCMYK) : nil,
            share: editor.route.share
        )
        var finished: ServerExport?
        for try await status in api.exportUpdates(exportId: exportId) {
            switch status.status {
            case "queued": progress = "Waiting for the renderer"
            case "rendering": progress = "Rendering on the server"
            default: break
            }
            if status.isFinished {
                finished = status
                break
            }
        }
        guard let finished, finished.status == "ready" else {
            throw ExportFailure(errorDescription: finished?.error ?? "The export didn't finish. Try again.")
        }
        progress = "Downloading"
        let directory = folder
        var files: [URL] = []
        for file in finished.files {
            guard let url = file.url.flatMap(URL.init(string:)) else { continue }
            let (temporary, response) = try await URLSession.shared.download(from: url)
            guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true else { continue }
            let target = directory.appendingPathComponent(file.fileName)
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: temporary, to: target)
            files.append(target)
        }
        guard !files.isEmpty else { throw ExportFailure(errorDescription: "The exported files couldn't be downloaded. Try again.") }
        let bytes = Int(finished.files.reduce(0) { $0 + ($1.bytes ?? 0) })
        return Output(files: files, format: plan.format, bytes: bytes, renderedOnServer: true, warnings: [])
    }
}
