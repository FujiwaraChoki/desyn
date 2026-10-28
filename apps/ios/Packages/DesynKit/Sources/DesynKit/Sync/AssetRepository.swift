import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Fetches the bytes of a design's assets: from the offline cache first, else through signed URLs from
/// `assets.designUrls` (refreshed when they expire), downloading a few at a time and caching the result.
public actor AssetRepository {
    private let api: DesynAPI
    private let store: OfflineStore
    private let designId: String
    private let share: ShareAccess?
    private let session: URLSession
    private var urls: [String: String] = [:]
    private var urlsExpireAt: Date = .distantPast
    private var inFlight: [String: Task<Data?, Never>] = [:]
    /// Ids the server could not sign in the current URL window (not retried until the window ends).
    private var unsigned: Set<String> = []

    public init(api: DesynAPI, store: OfflineStore, designId: String, share: ShareAccess?) {
        self.api = api
        self.store = store
        self.designId = designId
        self.share = share
        let configuration = URLSessionConfiguration.default
        configuration.httpMaximumConnectionsPerHost = 4
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        configuration.timeoutIntervalForRequest = 60
        session = URLSession(configuration: configuration)
    }

    /// Cache key of an asset: its content hash when known (shared across designs), else its ref id.
    public static func cacheKey(for ref: AssetRef?, id: String) -> String {
        if let hash = ref?.hash, !hash.isEmpty { return "h-\(hash)" }
        return "r-\(id)"
    }

    /// Bytes of asset `id` (nil when it cannot be fetched now; the engine keeps showing a placeholder).
    public func data(for id: String, ref: AssetRef?) async -> Data? {
        let key = Self.cacheKey(for: ref, id: id)
        if let cached = store.assetData(key: key) { return cached }
        if let running = inFlight[id] { return await running.value }
        let task = Task<Data?, Never> { await self.download(id: id, key: key) }
        inFlight[id] = task
        let data = await task.value
        inFlight[id] = nil
        return data
    }

    /// Stores bytes for an asset this device just uploaded (no download needed).
    public func remember(_ data: Data, id: String, ref: AssetRef?) {
        store.storeAsset(data, key: Self.cacheKey(for: ref, id: id))
    }

    private func download(id: String, key: String) async -> Data? {
        guard let url = await signedURL(for: id) else { return nil }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), !data.isEmpty else {
                // Expired or revoked signature: drop the URL so the next call signs again.
                urls[id] = nil
                return nil
            }
            store.storeAsset(data, key: key)
            return data
        } catch {
            return nil
        }
    }

    private func signedURL(for id: String) async -> URL? {
        if Date() >= urlsExpireAt.addingTimeInterval(-60) {
            urls.removeAll()
            unsigned.removeAll()
        }
        if urls[id] == nil, !unsigned.contains(id) {
            do {
                // Sign everything the design references in one call; later lookups are local.
                let result = try await api.assetURLs(designId: designId, refs: nil, share: share)
                urls.merge(result.urls) { _, new in new }
                urlsExpireAt = result.expiresAt.map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date().addingTimeInterval(3600)
                if urls[id] == nil { unsigned.insert(id) }
            } catch {
                return nil
            }
        }
        return urls[id].flatMap(URL.init(string:))
    }
}
