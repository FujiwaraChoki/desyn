import DesignSystem
import DesynKit
import SwiftUI
import UIKit

/// Loads thumbnails (signed URLs change hourly, so images are cached by a stable key such as design id +
/// updatedAt): memory first, then the account's offline store, then the network.
actor ThumbnailLoader {
    static let shared = ThumbnailLoader()

    private let memory = NSCache<NSString, UIImage>()
    private var running: [String: Task<UIImage?, Never>] = [:]
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        return URLSession(configuration: configuration)
    }()

    init() {
        memory.countLimit = 300
    }

    func image(url: URL, key: String, store: OfflineStore?, maxPixel: CGFloat) async -> UIImage? {
        if let cached = memory.object(forKey: key as NSString) { return cached }
        if let running = running[key] { return await running.value }
        let task = Task<UIImage?, Never> {
            if let data = store?.assetData(key: "thumb-\(key)"), let image = Self.decode(data, maxPixel: maxPixel) {
                return image
            }
            guard let result = try? await session.data(from: url),
                  let http = result.1 as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let image = Self.decode(result.0, maxPixel: maxPixel)
            else { return nil }
            store?.storeAsset(result.0, key: "thumb-\(key)")
            return image
        }
        running[key] = task
        let image = await task.value
        running[key] = nil
        if let image { memory.setObject(image, forKey: key as NSString) }
        return image
    }

    /// Decodes and downsamples so large thumbnails never sit in memory at full size.
    private static func decode(_ data: Data, maxPixel: CGFloat) -> UIImage? {
        guard let image = UIImage(data: data) else { return nil }
        let longest = max(image.size.width * image.scale, image.size.height * image.scale)
        guard longest > maxPixel, longest > 0 else { return image.preparingForDisplay() ?? image }
        let factor = maxPixel / longest
        let size = CGSize(width: image.size.width * image.scale * factor, height: image.size.height * image.scale * factor)
        return image.preparingThumbnail(of: size) ?? image
    }
}

/// A design / template thumbnail with a calm placeholder (kind glyph on a warm gradient) while loading or when
/// the server has none yet.
struct ThumbnailView: View {
    let url: String?
    let cacheKey: String
    let aspectRatio: Double
    let placeholderSymbol: String
    var store: OfflineStore?

    @State private var image: UIImage?
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Color.clear
            .aspectRatio(CGFloat(max(0.2, min(5, aspectRatio))), contentMode: .fit)
            .overlay {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .transition(.opacity)
                } else {
                    ZStack {
                        LinearGradient(
                            colors: [Palette.surface2, Palette.surface3],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                        Image(systemName: placeholderSymbol)
                            .font(.system(size: 26, weight: .light))
                            .foregroundStyle(Palette.sun.opacity(0.7))
                    }
                }
            }
            .clipped()
            .animation(Motion.easeOut(0.35), value: image != nil)
            .task(id: "\(cacheKey)|\(url ?? "")") {
                guard let url, let parsed = URL(string: url) else { return }
                image = await ThumbnailLoader.shared.image(url: parsed, key: cacheKey, store: store, maxPixel: 900 * displayScale / 3)
            }
            .accessibilityHidden(true)
    }
}
