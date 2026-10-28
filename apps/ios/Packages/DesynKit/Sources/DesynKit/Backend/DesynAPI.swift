import Foundation

/// Share-link access for designs reached through "shared with me".
public struct ShareAccess: Hashable, Sendable, Codable {
    public let token: String
    public let password: String?

    public init(token: String, password: String? = nil) {
        self.token = token
        self.password = password
    }

    var convexValue: ConvexEncodable {
        var value: ConvexArgs = ["token": token]
        if let password { value["password"] = password }
        return value
    }
}

/// Library filters of `designs/designs:list`.
public enum DesignFilter: String, Sendable, CaseIterable {
    case all, recent, mine, folder, shared, archived, trash
}

/// Typed calls to the Convex functions the iOS app uses. Function names are `module/path:export`.
public final class DesynAPI: Sendable {
    public let transport: ConvexTransport

    public init(transport: ConvexTransport) {
        self.transport = transport
    }

    // MARK: Accounts

    public func config() async throws -> BackendConfig {
        try await transport.query("accounts/config:get", args: [:], as: BackendConfig.self)
    }

    /// The signed-in profile (nil when the Convex identity is missing).
    public func profileUpdates() -> AsyncThrowingStream<Profile?, Error> {
        transport.subscribe("accounts/profiles:me", args: [:], as: Profile?.self)
    }

    public func me() async throws -> Profile? {
        try await transport.query("accounts/profiles:me", args: [:], as: Profile?.self)
    }

    /// Creates the profile and personal workspace when sign-up provisioning has not run yet.
    public func ensureProfile() async throws -> EnsureResult {
        try await transport.mutation("accounts/profiles:ensure", args: [:], as: EnsureResult.self)
    }

    public func workspaces() async throws -> [Workspace] {
        try await transport.query("accounts/workspaces:list", args: [:], as: [Workspace].self)
    }

    public func folders(workspaceId: String) -> AsyncThrowingStream<[Folder], Error> {
        transport.subscribe("accounts/folders:list", args: ["workspaceId": workspaceId], as: [Folder].self)
    }

    public func createFolder(workspaceId: String, name: String, parentId: String? = nil) async throws -> String {
        var args: ConvexArgs = ["workspaceId": workspaceId, "name": name]
        if let parentId { args["parentId"] = parentId }
        return try await transport.mutation("accounts/folders:create", args: args, as: String.self)
    }

    // MARK: Designs

    /// One page of designs. `workspaceId` is required for every filter except `.shared`.
    public func designs(
        workspaceId: String?,
        filter: DesignFilter,
        folderId: String? = nil,
        search: String? = nil,
        cursor: String? = nil,
        pageSize: Int = 40
    ) async throws -> PaginatedResult<DesignSummary> {
        try await transport.query(
            "designs/designs:list",
            args: Self.listArgs(workspaceId: workspaceId, filter: filter, folderId: folderId, search: search, cursor: cursor, pageSize: pageSize),
            as: PaginatedResult<DesignSummary>.self
        )
    }

    /// Live first page of designs (the library refreshes when another device edits).
    public func designUpdates(workspaceId: String?, filter: DesignFilter, folderId: String? = nil, search: String? = nil, pageSize: Int = 40) -> AsyncThrowingStream<PaginatedResult<DesignSummary>, Error> {
        transport.subscribe(
            "designs/designs:list",
            args: Self.listArgs(workspaceId: workspaceId, filter: filter, folderId: folderId, search: search, cursor: nil, pageSize: pageSize),
            as: PaginatedResult<DesignSummary>.self
        )
    }

    static func listArgs(workspaceId: String?, filter: DesignFilter, folderId: String?, search: String?, cursor: String?, pageSize: Int) -> ConvexArgs {
        var args: ConvexArgs = [
            "filter": filter.rawValue,
            "paginationOpts": ["numItems": Double(pageSize), "cursor": cursor] as ConvexArgs,
        ]
        if let workspaceId { args["workspaceId"] = workspaceId }
        if filter == .folder { args["folderId"] = folderId }
        if let search, !search.trimmingCharacters(in: .whitespaces).isEmpty {
            args["search"] = search.trimmingCharacters(in: .whitespaces)
        }
        return args
    }

    /// Creates a design from a page preset or a custom size.
    public func createDesign(
        workspaceId: String,
        kind: DesignKind,
        presetId: String?,
        size: (width: Double, height: Double, unit: PageUnit)? = nil,
        name: String? = nil,
        folderId: String? = nil
    ) async throws -> CreatedDesign {
        var args: ConvexArgs = ["workspaceId": workspaceId, "kind": kind.rawValue]
        if let presetId { args["presetId"] = presetId }
        if let size {
            args["size"] = ["width": size.width, "height": size.height, "unit": size.unit.rawValue] as ConvexArgs
        }
        if let name { args["name"] = name }
        if let folderId { args["folderId"] = folderId }
        return try await transport.mutation("designs/designs:create", args: args, as: CreatedDesign.self)
    }

    public func renameDesign(designId: String, name: String) async throws {
        _ = try await transport.mutation("designs/designs:rename", args: ["designId": designId, "name": name], as: JSONValue.self)
    }

    public func duplicateDesign(designId: String) async throws -> CreatedDesign {
        try await transport.mutation("designs/designs:duplicate", args: ["designId": designId], as: CreatedDesign.self)
    }

    /// Moves a design to the trash.
    public func trashDesign(designId: String) async throws {
        _ = try await transport.mutation("designs/designs:delete", args: ["designId": designId], as: JSONValue.self)
    }

    public func moveDesign(designId: String, folderId: String?) async throws {
        let args: ConvexArgs = ["designId": designId, "folderId": folderId]
        _ = try await transport.mutation("designs/designs:moveToFolder", args: args, as: JSONValue.self)
    }

    /// Opens a share link as the signed-in user (records it under "shared with me").
    public func joinShare(token: String, password: String? = nil) async throws -> JoinedShare {
        var args: ConvexArgs = ["token": token]
        if let password { args["password"] = password }
        return try await transport.mutation("designs/designs:joinShare", args: args, as: JoinedShare.self)
    }

    /// One page of `designs.load` (nodes in chunks; the first page carries the header).
    public func loadPage(designId: String, cursor: String?, share: ShareAccess?) async throws -> LoadPage {
        var args: ConvexArgs = ["designId": designId, "cursor": cursor]
        if let share { args["share"] = share.convexValue }
        return try await transport.query("designs/designs:load", args: args, as: LoadPage.self, timeout: .seconds(60))
    }

    /// Commits a transaction (JSON text, idempotent on its id).
    public func commit(designId: String, baseSeq: Int?, transactionJSON: String, share: ShareAccess?) async throws -> CommitResult {
        var args: ConvexArgs = ["designId": designId, "tx": transactionJSON]
        if let baseSeq { args["baseSeq"] = Double(baseSeq) }
        if let share { args["share"] = share.convexValue }
        return try await transport.mutation("designs/designs:commit", args: args, as: CommitResult.self)
    }

    /// Live transactions after `seq`.
    public func opsSince(designId: String, seq: Int, share: ShareAccess?) -> AsyncThrowingStream<OpsSince, Error> {
        var args: ConvexArgs = ["designId": designId, "seq": Double(seq)]
        if let share { args["share"] = share.convexValue }
        return transport.subscribe("designs/designOps:since", args: args, as: OpsSince.self)
    }

    // MARK: Assets

    /// Signed URLs for asset refs of a design (all refs when `refs` is nil).
    public func assetURLs(designId: String, refs: [String]?, share: ShareAccess?) async throws -> AssetURLs {
        var args: ConvexArgs = ["designId": designId]
        if let refs { args["refs"] = refs.map { $0 as ConvexEncodable? } }
        if let share { args["share"] = share.convexValue }
        return try await transport.query("assets/assets:designUrls", args: args, as: AssetURLs.self)
    }

    public func requestUpload(workspaceId: String, name: String, mime: String, bytes: Int, sha256: String) async throws -> UploadTicket {
        try await transport.mutation(
            "assets/assets:requestUpload",
            args: ["workspaceId": workspaceId, "name": name, "mime": mime, "bytes": Double(bytes), "sha256": sha256],
            as: UploadTicket.self
        )
    }

    public func finalizeUpload(assetId: String, width: Double?, height: Double?) async throws -> FinalizedAsset {
        var args: ConvexArgs = ["assetId": assetId]
        if width != nil || height != nil {
            var media: ConvexArgs = [:]
            if let width { media["width"] = width }
            if let height { media["height"] = height }
            args["media"] = media
        }
        return try await transport.action("assets/assets:finalize", args: args, as: FinalizedAsset.self)
    }

    public func asset(assetId: String) async throws -> AssetInfo {
        try await transport.query("assets/assets:get", args: ["assetId": assetId], as: AssetInfo.self)
    }

    // MARK: Templates and brand

    public func templates(category: String? = nil, kind: String? = nil, cursor: String? = nil, pageSize: Int = 30) async throws -> PaginatedResult<TemplateSummary> {
        var args: ConvexArgs = [
            "sort": "popular",
            "paginationOpts": ["numItems": Double(pageSize), "cursor": cursor] as ConvexArgs,
        ]
        if let category { args["category"] = category }
        if let kind { args["kind"] = kind }
        return try await transport.query("templates/templates:list", args: args, as: PaginatedResult<TemplateSummary>.self)
    }

    public func searchTemplates(query: String, cursor: String? = nil, pageSize: Int = 30) async throws -> PaginatedResult<TemplateSummary> {
        try await transport.query(
            "templates/templates:search",
            args: ["query": query, "paginationOpts": ["numItems": Double(pageSize), "cursor": cursor] as ConvexArgs],
            as: PaginatedResult<TemplateSummary>.self
        )
    }

    public func instantiateTemplate(templateId: String, workspaceId: String, folderId: String? = nil) async throws -> CreatedDesign {
        var args: ConvexArgs = ["templateId": templateId, "workspaceId": workspaceId]
        if let folderId { args["folderId"] = folderId }
        return try await transport.mutation("templates/templates:instantiate", args: args, as: CreatedDesign.self)
    }

    public func brandKits(workspaceId: String) async throws -> [BrandKit] {
        try await transport.query("brand/brandKits:list", args: ["workspaceId": workspaceId], as: [BrandKit].self)
    }
}
