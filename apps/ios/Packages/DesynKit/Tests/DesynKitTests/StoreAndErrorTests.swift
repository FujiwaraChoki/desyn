import DesynKit
import XCTest

final class ErrorMappingTests: XCTestCase {
    func testConvexErrorData() {
        let error = DesynError(ClientError.ConvexError(data: #"{"code":"LIMIT_REACHED","message":"You reached the design limit.","limit":"designs"}"#))
        XCTAssertEqual(error, .server(code: "LIMIT_REACHED", message: "You reached the design limit."))
        XCTAssertFalse(error.isTransient)
        XCTAssertEqual(DesynError(ClientError.ConvexError(data: #"{"code":"UNAUTHENTICATED","message":"x"}"#)), .unauthenticated)
        XCTAssertEqual(
            DesynError(ClientError.ConvexError(data: #"{"code":"RATE_LIMITED","message":"x","retryAfterMs":2500}"#)),
            .rateLimited(retryAfter: 2.5)
        )
    }

    func testServerAndNetworkErrors() {
        let server = DesynError(ClientError.ServerError(msg: "[Request ID: 1] Server Error\nUncaught Error: Name is too long\n  at handler"))
        XCTAssertEqual(server, .server(code: "SERVER", message: "Name is too long"))
        XCTAssertTrue(DesynError(ClientError.InternalError(msg: "socket closed")).isTransient)
        XCTAssertTrue(DesynError(URLError(.notConnectedToInternet)).isTransient)
    }
}

final class OfflineStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("desyn-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testDesignRoundTripAndPendingIndex() throws {
        let store = OfflineStore(userId: "user|1", baseDirectory: directory, cacheDirectory: directory)
        let cached = CachedDesign(
            designId: "d1", key: "designaaaaaa", name: "Poster", kind: "poster", workspaceId: "w", permission: "edit",
            confirmedSeq: 4, designJSON: "{}", pending: [PendingTransaction(id: "t", transactionJSON: "{}", inverseJSON: "{}")],
            share: nil
        )
        try store.saveDesign(cached)
        XCTAssertEqual(store.loadDesign("d1")?.confirmedSeq, 4)
        XCTAssertEqual(store.designsWithPendingChanges(), ["d1"])
        store.removeDesign("d1")
        XCTAssertNil(store.loadDesign("d1"))
    }

    func testListsAndAssetEviction() {
        let store = OfflineStore(userId: "u", baseDirectory: directory, cacheDirectory: directory, assetBudgetBytes: 1500)
        store.saveList(["a", "b"], key: "recent/ws1")
        XCTAssertEqual(store.loadList([String].self, key: "recent/ws1"), ["a", "b"])
        store.storeAsset(Data(repeating: 1, count: 1000), key: "h-old")
        // Make the first file clearly older than the second.
        Thread.sleep(forTimeInterval: 1.1)
        store.storeAsset(Data(repeating: 2, count: 1000), key: "h-new")
        XCTAssertNil(store.assetData(key: "h-old"), "the oldest asset is evicted over budget")
        XCTAssertEqual(store.assetData(key: "h-new")?.count, 1000)
        store.clearAll()
        XCTAssertNil(store.assetData(key: "h-new"))
    }
}

/// Response shapes the Convex functions actually send (see the `convex/` view helpers named in each test).
final class ResponseDecodingTests: XCTestCase {
    /// `templates/templates.ts` `templateView`: `blobUrl` returns null without S3 (or for purged files), and a
    /// single null must not break the whole template list.
    func testTemplatesWithUnsignedThumbnailsDecode() throws {
        let json = #"""
        {"page":[{"id":"t1","slug":"s","title":"Poster","description":"","kind":"poster","category":"events",
        "categories":["events"],"tags":[],"premium":false,"pageCount":1,"width":1080,"height":1350,"popularity":3,
        "thumbnails":[{"url":null,"width":320,"height":400},{"url":"https://cdn.example/t1-640.webp","width":640,"height":800}],
        "favorite":false,"updatedAt":1}],"isDone":true,"continueCursor":"c"}
        """#
        let page = try JSONDecoder().decode(PaginatedResult<TemplateSummary>.self, from: Data(json.utf8))
        let template = try XCTUnwrap(page.page.first)
        XCTAssertEqual(template.thumbnail(near: 300)?.url, "https://cdn.example/t1-640.webp", "unsigned thumbnails are skipped")
        let none = try JSONDecoder().decode(
            TemplateSummary.Thumbnail.self, from: Data(#"{"url":null,"width":1,"height":1}"#.utf8)
        )
        XCTAssertNil(none.url)
    }
}
