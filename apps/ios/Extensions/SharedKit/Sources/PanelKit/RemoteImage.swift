import DesignSystem
import Foundation
import ImageIO
import SwiftUI
import UIKit

/// Downloads and decodes images for panels (stock thumbnails, library assets, AI previews, avatars) with a memory
/// cache and the shared URL cache, downsampled to the size they are shown at.
@MainActor
public final class RemoteImageLoader {
    public static let shared = RemoteImageLoader()

    private let cache = NSCache<NSString, UIImage>()
    private let session: URLSession
    private var running: [String: Task<UIImage?, Never>] = [:]

    private init() {
        cache.totalCostLimit = 96 * 1024 * 1024
        let configuration = URLSessionConfiguration.default
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        configuration.urlCache = URLCache(memoryCapacity: 16 * 1024 * 1024, diskCapacity: 256 * 1024 * 1024)
        configuration.httpMaximumConnectionsPerHost = 6
        session = URLSession(configuration: configuration)
    }

    public func cached(_ url: URL, maxPixel: CGFloat) -> UIImage? {
        cache.object(forKey: Self.key(url, maxPixel))
    }

    /// The image at `url`, at most `maxPixel` pixels on its longest side.
    public func image(_ url: URL, maxPixel: CGFloat) async -> UIImage? {
        let key = Self.key(url, maxPixel)
        if let hit = cache.object(forKey: key) { return hit }
        if let task = running[key as String] { return await task.value }
        let session = self.session
        let task = Task<UIImage?, Never> {
            guard let result = try? await session.data(from: url) else { return nil }
            let (data, response) = result
            guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true else { return nil }
            return await Task.detached(priority: .utility) { Self.downsample(data, maxPixel: maxPixel) }.value
        }
        running[key as String] = task
        let image = await task.value
        running[key as String] = nil
        if let image {
            cache.setObject(image, forKey: key, cost: Int(image.size.width * image.size.height * image.scale * image.scale * 4))
        }
        return image
    }

    private static func key(_ url: URL, _ maxPixel: CGFloat) -> NSString {
        "\(Int(maxPixel))|\(url.absoluteString)" as NSString
    }

    /// ImageIO thumbnail decoding (never decodes the full image into memory).
    nonisolated static func downsample(_ data: Data, maxPixel: CGFloat) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixel),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return UIImage(data: data)
        }
        return UIImage(cgImage: image)
    }
}

/// An image from a URL with a shimmer placeholder in surface tones.
public struct RemoteImage: View {
    private let url: URL?
    private let maxPixel: CGFloat
    private let contentMode: ContentMode

    @State private var image: UIImage?
    @State private var failed = false

    public init(_ url: URL?, maxPixel: CGFloat = 600, contentMode: ContentMode = .fill) {
        self.url = url
        self.maxPixel = maxPixel
        self.contentMode = contentMode
    }

    public init(_ string: String?, maxPixel: CGFloat = 600, contentMode: ContentMode = .fill) {
        self.init(string.flatMap(URL.init(string:)), maxPixel: maxPixel, contentMode: contentMode)
    }

    public var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
                    .transition(.opacity)
            } else if failed {
                Palette.surface2.overlay {
                    Image(systemName: "photo")
                        .foregroundStyle(Palette.muted)
                }
            } else {
                ShimmerPlaceholder()
            }
        }
        .task(id: url) {
            guard let url else {
                failed = true
                return
            }
            if let hit = RemoteImageLoader.shared.cached(url, maxPixel: maxPixel) {
                image = hit
                return
            }
            let loaded = await RemoteImageLoader.shared.image(url, maxPixel: maxPixel)
            withAnimation(Motion.easeOut(0.3)) {
                image = loaded
                failed = loaded == nil
            }
        }
    }
}

/// Skeleton shimmer in surface tones (honors Reduce Motion).
public struct ShimmerPlaceholder: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init() {}

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            let phase = reduceMotion ? 0.5 : (context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6)
            GeometryReader { proxy in
                Palette.surface2
                    .overlay {
                        LinearGradient(
                            colors: [.clear, Palette.surface3.opacity(0.9), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: proxy.size.width * 0.6)
                        .offset(x: (phase * 1.6 - 0.3) * proxy.size.width)
                    }
                    .clipped()
            }
        }
        .accessibilityHidden(true)
    }
}
