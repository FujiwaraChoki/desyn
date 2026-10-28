import Foundation

/// Export formats and options of the export sheet. Raster, SVG, PDF, PPTX and GIF render on the device with the
/// engine (works offline, nothing leaves the phone); MP4 renders on the server (`exports.request`), as does any
/// format when the device is missing assets.
public enum FileFormat: String, CaseIterable, Sendable, Identifiable {
    case png, jpeg, webp, svg, pdf, pptx, gif, mp4

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .png: "PNG"
        case .jpeg: "JPG"
        case .webp: "WebP"
        case .svg: "SVG"
        case .pdf: "PDF"
        case .pptx: "PowerPoint"
        case .gif: "GIF"
        case .mp4: "MP4 video"
        }
    }

    public var detail: String {
        switch self {
        case .png: "Sharp image, transparency"
        case .jpeg: "Small photo file"
        case .webp: "Small, modern image"
        case .svg: "Scalable vector"
        case .pdf: "Print and documents"
        case .pptx: "Editable slides"
        case .gif: "Short animation"
        case .mp4: "Animated video"
        }
    }

    public var systemImage: String {
        switch self {
        case .png, .jpeg, .webp: "photo"
        case .svg: "point.topleft.down.to.point.bottomright.curvepath"
        case .pdf: "doc.richtext"
        case .pptx: "rectangle.on.rectangle.angled"
        case .gif: "photo.stack"
        case .mp4: "film"
        }
    }

    public var fileExtension: String {
        switch self {
        case .jpeg: "jpg"
        default: rawValue
        }
    }

    /// Raster formats take a scale; JPEG / WebP take a quality.
    public var isRaster: Bool { self == .png || self == .jpeg || self == .webp }
    public var hasQuality: Bool { self == .jpeg || self == .webp }
    public var supportsTransparency: Bool { self == .png || self == .webp || self == .svg || self == .gif }
    /// One file holds every page (others export one file per page).
    public var isMultiPageFile: Bool { self == .pdf || self == .pptx || self == .gif || self == .mp4 }
    public var rendersOnServer: Bool { self == .mp4 }
    /// The plan feature this format needs (config/plans.json; the server checks the same key for its exports).
    public var requiredFeature: String {
        switch self {
        case .png: "export.png"
        case .jpeg: "export.jpg"
        case .webp: "export.webp"
        case .svg: "export.svg"
        case .pdf: "export.pdf"
        case .pptx: "export.pptx"
        case .gif, .mp4: "export.video"
        }
    }

    /// Can be saved to the Photos library.
    public var isPhotoLibraryCompatible: Bool { self == .png || self == .jpeg || self == .gif || self == .mp4 }
}

/// Everything the export sheet collects.
public struct ExportPlan: Equatable, Sendable {
    public var format: FileFormat = .png
    /// Device pixels per design px for raster output.
    public var scale: Double = 2
    /// 1...100.
    public var quality: Double = 90
    public var transparent = false
    /// nil = every page.
    public var pageIds: [String]?
    public var pdfBleed = false
    public var pdfCropMarks = false
    public var pdfFlatten = false
    public var pdfCMYK = false
    public var gifFPS: Double = 15

    public init() {}

    public static let scales: [Double] = [0.5, 1, 2, 3, 4]

    /// Pixel size of a page at the current scale (for the "1080 x 1080 px" hint).
    public func pixelSize(width: Double, height: Double) -> (width: Int, height: Int) {
        (Int((width * scale).rounded()), Int((height * scale).rounded()))
    }

    /// Largest scale that keeps a page under the engine's 64 MP render budget.
    public static func maxScale(width: Double, height: Double) -> Double {
        let pixels = max(1, width * height)
        return max(0.1, min(8, (64_000_000 / pixels).squareRoot()))
    }

    /// Bleed, crop marks or CMYK (plan feature `export.pdfPrint`).
    public var usesPrintOptions: Bool { format == .pdf && (pdfBleed || pdfCropMarks || pdfCMYK) }

    /// Plan features this export needs.
    public var requiredFeatures: [String] {
        usesPrintOptions ? [format.requiredFeature, "export.pdfPrint"] : [format.requiredFeature]
    }

    /// Validated plan: scale clamped for the page, transparency only where the format has it.
    public func normalized(pageWidth: Double, pageHeight: Double) -> ExportPlan {
        var plan = self
        plan.scale = min(max(0.1, scale), Self.maxScale(width: pageWidth, height: pageHeight))
        plan.quality = min(100, max(1, quality.rounded()))
        if !format.supportsTransparency { plan.transparent = false }
        plan.gifFPS = min(30, max(5, gifFPS.rounded()))
        return plan
    }

    /// File name for the design (and page number when each page is its own file).
    public static func fileName(designName: String, page: Int?, pageCount: Int, format: FileFormat) -> String {
        let cleaned = designName
            .components(separatedBy: CharacterSet(charactersIn: "/\\:?%*|\"<>\n\r\t"))
            .joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let base = cleaned.isEmpty ? "Desyn design" : String(cleaned.prefix(80))
        if let page, pageCount > 1, !format.isMultiPageFile {
            return "\(base) - \(page).\(format.fileExtension)"
        }
        return "\(base).\(format.fileExtension)"
    }
}
