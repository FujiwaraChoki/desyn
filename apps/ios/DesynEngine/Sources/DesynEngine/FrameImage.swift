import CoreGraphics
import Foundation

/// Engine pixels are premultiplied RGBA8 in byte order R, G, B, A, sRGB encoded.
enum EnginePixels {
    static var bitmapInfo: CGBitmapInfo {
        CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue).union(.byteOrder32Big)
    }

    static var colorSpace: CGColorSpace {
        CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    }

    /// A `CGImage` over `data` (rows `bytesPerRow` apart); the image keeps `data` alive.
    static func image(data: Data, width: Int, height: Int, bytesPerRow: Int) -> CGImage? {
        guard width > 0, height > 0, data.count >= bytesPerRow * (height - 1) + width * 4,
              let provider = CGDataProvider(data: data as CFData)
        else { return nil }
        return CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo,
            provider: provider,
            decode: nil,
            shouldInterpolate: true,
            intent: .defaultIntent
        )
    }
}

public extension RenderedFrame {
    /// The frame as a `CGImage` (shares the pixel data; no conversion).
    func makeCGImage() -> CGImage? {
        EnginePixels.image(data: pixels, width: Int(width), height: Int(height), bytesPerRow: Int(stride))
    }
}

public extension FrameBuffer {
    /// A `CGImage` of the buffer's current content (copied, so later renders do not change it).
    func makeCGImage() -> CGImage? {
        let data = withPixels { Data($0) }
        return EnginePixels.image(data: data, width: width, height: height, bytesPerRow: bytesPerRow)
    }
}
