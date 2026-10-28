import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Prepares images for upload off the main thread: downsampled to at most 4096 px with ImageIO (never decoding the
/// full image), orientation applied, JPEG for opaque photos and PNG when there is transparency. SVG files pass
/// through unchanged (the server sanitizes them).
enum ImagePreparation {
    struct Prepared: Sendable {
        let data: Data
        let mime: String
        let name: String
        let pixelSize: CGSize
    }

    static let maxSide: CGFloat = 4096

    /// Prepares raw file bytes (photos library, Files, share extension). `fileName` names the asset.
    static func prepare(data: Data, fileName: String?, type: UTType?) -> Prepared? {
        let baseName = (fileName as NSString?)?.deletingPathExtension ?? "Photo \(Int(Date().timeIntervalSince1970))"
        if type?.conforms(to: .svg) == true || fileName?.lowercased().hasSuffix(".svg") == true {
            guard let text = String(data: data, encoding: .utf8), text.contains("<svg") else { return nil }
            let size = svgSize(text) ?? CGSize(width: 512, height: 512)
            return Prepared(data: data, mime: "image/svg+xml", name: "\(baseName).svg", pixelSize: size)
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        else { return nil }
        let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0
        let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
        let longest = max(width, height)
        guard longest > 0 else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: min(longest, maxSide),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return encode(image, name: baseName)
    }

    /// Prepares a camera capture.
    static func prepare(_ image: UIImage) -> Prepared? {
        let renderer = UIGraphicsImageRenderer(size: fittedSize(image.size, scale: image.scale), format: {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            return format
        }())
        let rendered = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: renderer.format.bounds.size)) }
        guard let cgImage = rendered.cgImage else { return nil }
        return encode(cgImage, name: "Camera \(Int(Date().timeIntervalSince1970))")
    }

    static func fittedSize(_ size: CGSize, scale: CGFloat) -> CGSize {
        let pixels = CGSize(width: size.width * scale, height: size.height * scale)
        let factor = min(1, maxSide / max(pixels.width, pixels.height, 1))
        return CGSize(width: (pixels.width * factor).rounded(), height: (pixels.height * factor).rounded())
    }

    private static func encode(_ image: CGImage, name: String) -> Prepared? {
        let alpha = image.alphaInfo
        let hasAlpha = alpha == .first || alpha == .last || alpha == .premultipliedFirst || alpha == .premultipliedLast
        let size = CGSize(width: image.width, height: image.height)
        let ui = UIImage(cgImage: image)
        if hasAlpha, let png = ui.pngData() {
            return Prepared(data: png, mime: "image/png", name: "\(name).png", pixelSize: size)
        }
        guard let jpeg = ui.jpegData(compressionQuality: 0.88) else { return nil }
        return Prepared(data: jpeg, mime: "image/jpeg", name: "\(name).jpg", pixelSize: size)
    }

    /// width / height of an SVG from its viewBox or attributes.
    private static func svgSize(_ markup: String) -> CGSize? {
        guard let open = markup.range(of: "<svg"), let close = markup[open.upperBound...].firstIndex(of: ">") else { return nil }
        let tag = String(markup[open.upperBound..<close])
        func attribute(_ name: String) -> String? {
            guard let range = tag.range(of: "\(name)=\"") else { return nil }
            let rest = tag[range.upperBound...]
            return rest.firstIndex(of: "\"").map { String(rest[..<$0]) }
        }
        if let viewBox = attribute("viewBox") {
            let parts = viewBox.split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
            if parts.count == 4, parts[2] > 0, parts[3] > 0 { return CGSize(width: parts[2], height: parts[3]) }
        }
        func number(_ value: String?) -> Double? {
            guard let value else { return nil }
            return Double(value.prefix { character in character.isNumber || character == "." })
        }
        if let w = number(attribute("width")), let h = number(attribute("height")), w > 0, h > 0 {
            return CGSize(width: w, height: h)
        }
        return nil
    }
}
