import Foundation

/// A local transaction that the server has not acknowledged yet (DOCUMENT_MODEL section 6 `pending`).
public struct PendingTransaction: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    /// The transaction to commit (JSON; its ops are the normalized ops the engine applied).
    public var transactionJSON: String
    /// Restores the state before this transaction (JSON transaction, applied without normalizing).
    public var inverseJSON: String

    public init(id: String, transactionJSON: String, inverseJSON: String) {
        self.id = id
        self.transactionJSON = transactionJSON
        self.inverseJSON = inverseJSON
    }
}

/// Everything needed to reopen a design offline and resume syncing.
public struct CachedDesign: Codable, Hashable, Sendable {
    public var designId: String
    public var key: String
    public var name: String
    public var kind: String
    public var workspaceId: String
    public var permission: String
    /// Last server seq included in the cached state.
    public var confirmedSeq: Int
    /// The design as shown: confirmed state with `pending` applied on top.
    public var designJSON: String
    public var pending: [PendingTransaction]
    public var share: ShareAccess?
    public var savedAt: Date
    /// `designJSON` is not exactly "server state at `confirmedSeq` + `pending`" any more (offline edits were
    /// flushed while the design was closed and the server refused or rewrote some of them): the next open
    /// replaces it with the server copy and re-applies `pending` on top.
    public var needsServerCopy: Bool

    public init(
        designId: String, key: String, name: String, kind: String, workspaceId: String, permission: String,
        confirmedSeq: Int, designJSON: String, pending: [PendingTransaction], share: ShareAccess?, savedAt: Date = Date(),
        needsServerCopy: Bool = false
    ) {
        self.designId = designId
        self.key = key
        self.name = name
        self.kind = kind
        self.workspaceId = workspaceId
        self.permission = permission
        self.confirmedSeq = confirmedSeq
        self.designJSON = designJSON
        self.pending = pending
        self.share = share
        self.savedAt = savedAt
        self.needsServerCopy = needsServerCopy
    }

    private enum CodingKeys: String, CodingKey {
        case designId, key, name, kind, workspaceId, permission, confirmedSeq, designJSON, pending, share, savedAt
        case needsServerCopy
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        designId = try c.decode(String.self, forKey: .designId)
        key = try c.decode(String.self, forKey: .key)
        name = try c.decode(String.self, forKey: .name)
        kind = try c.decode(String.self, forKey: .kind)
        workspaceId = try c.decode(String.self, forKey: .workspaceId)
        permission = try c.decode(String.self, forKey: .permission)
        confirmedSeq = try c.decode(Int.self, forKey: .confirmedSeq)
        designJSON = try c.decode(String.self, forKey: .designJSON)
        pending = try c.decode([PendingTransaction].self, forKey: .pending)
        share = try c.decodeIfPresent(ShareAccess.self, forKey: .share)
        savedAt = try c.decode(Date.self, forKey: .savedAt)
        // Absent in caches written before the flag existed.
        needsServerCopy = try c.decodeIfPresent(Bool.self, forKey: .needsServerCopy) ?? false
    }
}

/// On-disk cache of one account: opened designs (JSON + pending transactions), library lists and asset bytes.
/// Everything lives under `Application Support/Desyn/<userId>` (excluded from backups, protected until first
/// unlock) except asset bytes, which use the Caches directory and are evicted least-recently-used beyond
/// `assetBudgetBytes`.
public final class OfflineStore: @unchecked Sendable {
    public let userId: String
    public let assetBudgetBytes: Int
    private let root: URL
    private let assetsDir: URL
    private let fileManager = FileManager.default
    private let lock = NSLock()
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return encoder
    }()

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }()

    /// `baseDirectory` / `cacheDirectory` default to Application Support / Caches.
    public init(userId: String, baseDirectory: URL? = nil, cacheDirectory: URL? = nil, assetBudgetBytes: Int = 512 * 1024 * 1024) {
        self.userId = userId
        self.assetBudgetBytes = assetBudgetBytes
        let safeUser = OfflineStore.safeName(userId)
        let support = baseDirectory ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let caches = cacheDirectory ?? fileManager.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        root = support.appendingPathComponent("Desyn", isDirectory: true).appendingPathComponent(safeUser, isDirectory: true)
        assetsDir = caches.appendingPathComponent("DesynAssets", isDirectory: true).appendingPathComponent(safeUser, isDirectory: true)
        for dir in [root, root.appendingPathComponent("designs"), root.appendingPathComponent("lists"), assetsDir] {
            try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableRoot = root
        try? mutableRoot.setResourceValues(values)
    }

    // MARK: Designs

    public func saveDesign(_ design: CachedDesign) throws {
        try write(encoder.encode(design), to: designURL(design.designId))
    }

    public func loadDesign(_ designId: String) -> CachedDesign? {
        guard let data = read(designURL(designId)) else { return nil }
        return try? decoder.decode(CachedDesign.self, from: data)
    }

    public func removeDesign(_ designId: String) {
        _ = lock.withLock { try? fileManager.removeItem(at: designURL(designId)) }
    }

    /// Ids of designs with unsent changes (sync them when the app comes back online).
    public func designsWithPendingChanges() -> [String] {
        let dir = root.appendingPathComponent("designs")
        let files = (try? fileManager.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.compactMap { url in
            guard let data = read(url), let design = try? decoder.decode(CachedDesign.self, from: data) else { return nil }
            return design.pending.isEmpty ? nil : design.designId
        }
    }

    // MARK: Lists (library tabs)

    public func saveList<T: Encodable>(_ value: T, key: String) {
        guard let data = try? encoder.encode(value) else { return }
        try? write(data, to: root.appendingPathComponent("lists").appendingPathComponent(Self.safeName(key) + ".json"))
    }

    public func loadList<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = read(root.appendingPathComponent("lists").appendingPathComponent(Self.safeName(key) + ".json")) else { return nil }
        return try? decoder.decode(T.self, from: data)
    }

    // MARK: Assets

    /// Cached bytes of an asset (by `AssetRef.hash` when known, else its id). Touches the file for LRU.
    public func assetData(key: String) -> Data? {
        let url = assetsDir.appendingPathComponent(Self.safeName(key))
        guard let data = read(url) else { return nil }
        try? fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return data
    }

    public func storeAsset(_ data: Data, key: String) {
        let url = assetsDir.appendingPathComponent(Self.safeName(key))
        try? write(data, to: url)
        evictAssetsIfNeeded()
    }

    /// Removes the oldest assets until the cache fits its budget.
    func evictAssetsIfNeeded() {
        lock.withLock {
            let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
            guard let files = try? fileManager.contentsOfDirectory(at: assetsDir, includingPropertiesForKeys: keys) else { return }
            var entries: [(url: URL, size: Int, date: Date)] = files.compactMap { url in
                guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
                return (url: url, size: values.fileSize ?? 0, date: values.contentModificationDate ?? .distantPast)
            }
            var total = entries.reduce(0) { $0 + $1.size }
            guard total > assetBudgetBytes else { return }
            entries.sort { $0.date < $1.date }
            for entry in entries where total > assetBudgetBytes {
                try? fileManager.removeItem(at: entry.url)
                total -= entry.size
            }
        }
    }

    // MARK: Lifecycle

    /// Deletes everything cached for this account (sign out).
    public func clearAll() {
        lock.withLock {
            try? fileManager.removeItem(at: root)
            try? fileManager.removeItem(at: assetsDir)
        }
    }

    // MARK: Files

    private func designURL(_ designId: String) -> URL {
        root.appendingPathComponent("designs").appendingPathComponent(Self.safeName(designId) + ".json")
    }

    private func write(_ data: Data, to url: URL) throws {
        try lock.withLock {
            try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            #if os(iOS)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try data.write(to: url, options: [.atomic])
            #endif
        }
    }

    private func read(_ url: URL) -> Data? {
        lock.withLock { try? Data(contentsOf: url) }
    }

    /// File-system safe name (ids are `[a-z0-9]` / Convex ids, but keys may carry other characters).
    static func safeName(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        let mapped = value.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
        return mapped.isEmpty ? "_" : String(mapped.prefix(120))
    }
}
