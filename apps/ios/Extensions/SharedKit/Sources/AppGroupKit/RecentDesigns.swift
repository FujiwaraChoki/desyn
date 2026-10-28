import Foundation

/// One design in the widget's "recent designs" list.
public struct RecentDesign: Codable, Hashable, Sendable, Identifiable {
    /// Convex `designs` id (deep link `https://<app>/design/<id>`).
    public let id: String
    public let name: String
    /// `DesignKind` raw value.
    public let kind: String
    /// Human label of the kind ("Social post").
    public let kindLabel: String
    public let width: Double
    public let height: Double
    public let pageCount: Int
    public let updatedAt: Date
    /// File name of the thumbnail inside the snapshot directory (nil while it has none).
    public let thumbnailFile: String?

    public init(
        id: String, name: String, kind: String, kindLabel: String, width: Double, height: Double, pageCount: Int,
        updatedAt: Date, thumbnailFile: String?
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.kindLabel = kindLabel
        self.width = width
        self.height = height
        self.pageCount = pageCount
        self.updatedAt = updatedAt
        self.thumbnailFile = thumbnailFile
    }
}

/// What the widget shows: the signed-in person's most recent designs.
public struct RecentDesignsSnapshot: Codable, Hashable, Sendable {
    public static let currentVersion = 1

    public let version: Int
    /// First name for the greeting; nil when signed out.
    public let ownerName: String?
    public let signedIn: Bool
    public let designs: [RecentDesign]
    public let savedAt: Date
    /// The web app URL (deep links are universal links on this host).
    public let appURL: URL

    public init(ownerName: String?, signedIn: Bool, designs: [RecentDesign], savedAt: Date = Date(), appURL: URL) {
        version = Self.currentVersion
        self.ownerName = ownerName
        self.signedIn = signedIn
        self.designs = designs
        self.savedAt = savedAt
        self.appURL = appURL
    }

    /// The universal link that opens `designId` in the app (`DeepLink.design`).
    public func link(for designId: String) -> URL {
        Self.designLink(appURL: appURL, designId: designId)
    }

    public static func designLink(appURL: URL, designId: String) -> URL {
        appURL.appendingPathComponent("design").appendingPathComponent(designId)
    }

    /// `desyn://new` opens the create sheet (handled by the app's integration layer).
    public static let createLink = URL(string: "desyn://new")!
}

/// Reads and writes the snapshot plus thumbnails in a directory of the App Group container. Writes are atomic so
/// the widget never reads a half-written file; thumbnails no design references any more are deleted.
public struct RecentDesignsStore: Sendable {
    public let directory: URL
    private static let snapshotName = "recent-designs.json"
    private static let thumbnailPrefix = "thumb-"

    public init(directory: URL) {
        self.directory = directory
    }

    /// The store in the shared container.
    public static func shared(fileManager: FileManager = .default) -> RecentDesignsStore {
        let directory = AppGroup.sharedDirectory(fileManager: fileManager).appendingPathComponent("Widgets", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return RecentDesignsStore(directory: directory)
    }

    private var snapshotURL: URL { directory.appendingPathComponent(Self.snapshotName) }

    public func load() -> RecentDesignsSnapshot? {
        guard let data = try? Data(contentsOf: snapshotURL) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        guard let snapshot = try? decoder.decode(RecentDesignsSnapshot.self, from: data),
              snapshot.version == RecentDesignsSnapshot.currentVersion
        else { return nil }
        return snapshot
    }

    public func save(_ snapshot: RecentDesignsSnapshot) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(snapshot).write(to: snapshotURL, options: .atomic)
        pruneThumbnails(keeping: Set(snapshot.designs.compactMap(\.thumbnailFile)))
    }

    /// Thumbnail file name for a design and the version of its thumbnail (a new name when it changes, so the widget
    /// never shows a stale cached image).
    public static func thumbnailFileName(designId: String, version: Date) -> String {
        let safeId = designId.filter { $0.isLetter || $0.isNumber }
        return "\(thumbnailPrefix)\(safeId)-\(Int64(version.timeIntervalSince1970 * 1000)).img"
    }

    public func thumbnailURL(_ file: String) -> URL {
        directory.appendingPathComponent(file)
    }

    public func hasThumbnail(_ file: String) -> Bool {
        FileManager.default.fileExists(atPath: thumbnailURL(file).path)
    }

    public func writeThumbnail(_ data: Data, file: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: thumbnailURL(file), options: .atomic)
    }

    public func thumbnailData(_ file: String) -> Data? {
        try? Data(contentsOf: thumbnailURL(file))
    }

    /// Deletes thumbnails not in `keeping`.
    public func pruneThumbnails(keeping: Set<String>) {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for file in files where file.hasPrefix(Self.thumbnailPrefix) && !keeping.contains(file) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(file))
        }
    }

    /// Signed out: an empty snapshot and no thumbnails (nothing of the previous account stays on screen).
    public func clear(appURL: URL) {
        try? save(RecentDesignsSnapshot(ownerName: nil, signedIn: false, designs: [], appURL: appURL))
    }
}
