import DesynKit
import XCTest
import SharedKit

/// The typed calls send the argument shapes the Convex validators expect (floats, omitted optionals, explicit nulls)
/// and decode the views those functions return (shapes copied from convex/*).
final class APITests: XCTestCase {
    func testShareLinkArguments() async throws {
        let transport = RecordingTransport(responses: [
            "designs/designs:setShare": #"{"shareId":"s1","token":"t1","url":"https://app.desyn.app/share/t1"}"#,
        ])
        let api = DesynAPI(transport: transport)
        _ = try await api.setShareLink(designId: "d1", permission: "view")
        XCTAssertEqual(transport.lastArgs("designs/designs:setShare"), ["designId": "d1", "permission": "view"])
        _ = try await api.setShareLink(designId: "d1", shareId: "s1", permission: "edit", password: .some(nil), expiresAt: .some(Date(timeIntervalSince1970: 1000)))
        XCTAssertEqual(transport.lastArgs("designs/designs:setShare"), [
            "designId": "d1", "shareId": "s1", "permission": "edit", "password": .null, "expiresAt": 1_000_000,
        ])
        _ = try await api.setShareLink(designId: "d1", permission: "comment", password: .some("pw"), expiresAt: .some(nil))
        XCTAssertEqual(transport.lastArgs("designs/designs:setShare")?["password"], "pw")
        XCTAssertEqual(transport.lastArgs("designs/designs:setShare")?["expiresAt"], .null)
    }

    func testCommentsDecodeAndCreateArguments() async throws {
        let thread = #"""
        [{"id":"c1","threadId":null,"body":"Bigger logo?","deleted":false,"author":{"id":"u1","name":"Ann Lee","image":null},
          "mentions":[],"createdAt":1700000000000,"editedAt":null,"nodeId":"nodeaaaaaaaa","pageId":"pageaaaaaaaa","x":120,"y":40.5,
          "resolved":false,"resolvedBy":null,"resolvedAt":null,"lastActivityAt":1700000001000,
          "replies":[{"id":"c2","threadId":"c1","body":"Done","deleted":false,"author":{"id":"u2","name":"Bo","image":null},"mentions":["u1"],"createdAt":1700000000500,"editedAt":null}]}]
        """#
        let transport = RecordingTransport(responses: ["collab/comments:list": thread, "collab/comments:create": #""c9""#])
        let api = DesynAPI(transport: transport)
        var threads: [CommentThread] = []
        for try await value in api.commentUpdates(designId: "d1", includeResolved: false) { threads = value }
        XCTAssertEqual(threads.count, 1)
        XCTAssertEqual(threads[0].author.initials, "AL")
        XCTAssertEqual(threads[0].replies.first?.mentions, ["u1"])
        XCTAssertTrue(threads[0].hasPin)
        let id = try await api.createComment(designId: "d1", body: "Hi @Ann Lee", pageId: "pageaaaaaaaa", point: PagePoint(x: 10, y: 20), mentions: ["u1"])
        XCTAssertEqual(id, "c9")
        XCTAssertEqual(transport.lastArgs("collab/comments:create"), [
            "designId": "d1", "body": "Hi @Ann Lee", "pageId": "pageaaaaaaaa", "x": 10, "y": 20, "mentions": ["u1"],
        ])
    }

    func testAIRunEventsAndStart() async throws {
        let page = #"""
        {"run":{"id":"r1","kind":"agent","designId":"d1","status":"running","mode":"edit","goal":"Warmer","question":null,"result":null,
                "error":null,"costCredits":0,"steps":1,"createdAt":1,"updatedAt":2,"finishedAt":null,"model":"openrouter:m","billing":"platform",
                "creditsCharged":0,"transactions":0,"workflowId":null,"cancelRequested":false},
         "events":[{"index":0,"type":"progress","ts":1,"runId":"r1","label":"Queued"}],"next":0,"done":false}
        """#
        let transport = RecordingTransport(responses: ["ai/agent:runEvents": page, "ai/agent:startRun": #"{"runId":"r1"}"#])
        let api = DesynAPI(transport: transport)
        let runId = try await api.startAIRun(designId: "d1", goal: "Warmer", selection: ["nodeaaaaaaaa"])
        XCTAssertEqual(runId, "r1")
        XCTAssertEqual(transport.lastArgs("ai/agent:startRun"), ["designId": "d1", "goal": "Warmer", "mode": "edit", "selection": ["nodeaaaaaaaa"]])
        var received: AIRunEventsPage?
        for try await value in api.runEventUpdates(runId: "r1", afterSeq: 4) { received = value }
        XCTAssertEqual(received?.run.phase, .running)
        XCTAssertEqual(received?.events.count, 1)
        XCTAssertEqual(transport.lastArgs("ai/agent:runEvents"), ["runId": "r1", "afterSeq": 4, "limit": 200])
    }

    func testMediaAndBrandAndAssetsDecode() async throws {
        let media = #"{"runId":"r2","assets":[{"assetId":"a1","refId":"refaaaaaaaaa","mime":"image/png","width":1024,"height":1024,"provider":"fal","model":"m","costCredits":4,"url":"https://s3/x"}]}"#
        let kits = #"""
        [{"id":"k2","workspaceId":"w","name":"Zed","logos":[],"colors":[],"fonts":{},"voice":null,"rules":[],"guidelines":null,"extractedFrom":null,"isDefault":false,"createdBy":"u","createdAt":1,"updatedAt":1},
         {"id":"k1","workspaceId":"w","name":"Acme","logos":[{"id":"l1","assetId":"as1","name":"Mark","variant":"primary","refId":"reflogoaaaaa","mime":"image/svg+xml","width":64,"height":64,"url":"https://s3/l"}],
          "colors":[{"id":"c","name":"Sun","value":"#ffb02e","role":"primary"}],"fonts":{"heading":{"family":"Lora","weight":700,"style":"normal","url":null,"refId":null}},
          "voice":{"tone":"warm","description":"","keywords":[],"avoid":[]},"rules":[],"guidelines":null,"extractedFrom":null,"isDefault":true,"createdBy":"u","createdAt":1,"updatedAt":1}]
        """#
        let assets = #"""
        {"page":[{"id":"as1","refId":"refaaaaaaaaa","workspaceId":"w","kind":"image","name":"Photo","mime":"image/jpeg","bytes":2048,"width":800,"height":600,
                  "durationMs":null,"hash":"abc","status":"ready","source":"stock","storageKey":"uploads/w/x.jpg","family":null,"weight":null,"style":null,
                  "attribution":{"author":"Ann","license":"Unsplash License","url":"https://unsplash.com/x"},"ai":null,"url":"https://s3/a","createdAt":1,"updatedAt":1}],
         "isDone":true,"continueCursor":"","splitCursor":null,"pageStatus":null}
        """#
        let transport = RecordingTransport(responses: [
            "ai/media:removeBackground": media, "brand/brandKits:list": kits, "assets/assets:list": assets,
        ])
        let api = DesynAPI(transport: transport)
        let result = try await api.removeBackground(assetId: "a0", designId: "d1")
        XCTAssertEqual(result.assets.first?.refId, "refaaaaaaaaa")
        XCTAssertEqual(transport.lastArgs("ai/media:removeBackground"), ["assetId": "a0", "designId": "d1"])
        let loaded = try await api.brandKitDetails(workspaceId: "w")
        XCTAssertEqual(loaded.map(\.name), ["Acme", "Zed"])
        XCTAssertEqual(loaded[0].logos.first?.refId, "reflogoaaaaa")
        XCTAssertEqual(loaded[0].fonts.heading?.family, "Lora")
        let page = try await api.libraryAssets(workspaceId: "w", kind: "image", search: "  ")
        XCTAssertEqual(transport.lastArgs("assets/assets:list")?["search"], nil)
        XCTAssertEqual(transport.lastArgs("assets/assets:list")?["paginationOpts"]?["cursor"], .null)
        let ref = page.page[0].assetRef
        XCTAssertEqual(ref.id, "refaaaaaaaaa")
        XCTAssertEqual(ref.string("source"), "stock")
        XCTAssertNil(ref.url)
        XCTAssertEqual(ref.json["attribution"]?["license"], "Unsplash License")
    }

    func testVersionsExportsAndAccount() async throws {
        let transport = RecordingTransport(responses: [
            "designs/versions:list": #"[{"id":"v1","name":"Before launch","seq":42,"status":"ready","auto":false,"pageCount":2,"createdBy":"u","createdByName":"Ann","createdAt":1700000000000,"error":null}]"#,
            "exports/exports:request": #""e1""#,
            "billing/credits:balance": #"{"period":"2026-10","plan":"pro","granted":600,"used":150,"reserved":30,"overage":0,"remaining":420,"throttled":false}"#,
        ])
        let api = DesynAPI(transport: transport)
        var versions: [DesignVersion] = []
        for try await value in api.versionUpdates(designId: "d1") { versions = value }
        XCTAssertEqual(versions.first?.isReady, true)
        _ = try await api.requestServerExport(designId: "d1", format: "mp4", pageIds: nil, scale: 2, quality: nil, background: nil, pdf: nil)
        XCTAssertEqual(transport.lastArgs("exports/exports:request"), ["designId": "d1", "format": "mp4", "pages": "all", "scale": 2])
        var balance: CreditBalance?
        for try await value in api.creditBalanceUpdates() { balance = value }
        XCTAssertEqual(balance?.usedFraction ?? 0, 0.3, accuracy: 1e-9)
    }

    func testStockSearchAndTracking() async throws {
        let response = #"""
        {"photos":[{"id":"unsplash:abc","provider":"unsplash","description":"Sunset","width":4000,"height":3000,"thumbUrl":"https://images.unsplash.com/t",
          "url":"https://images.unsplash.com/full","color":"#ffaa00","author":"Ann Lee","authorUrl":"https://unsplash.com/@ann?utm_source=desyn",
          "sourceUrl":"https://unsplash.com/photos/abc?utm_source=desyn","license":"Unsplash License","downloadLocation":"https://api.unsplash.com/photos/abc/download"}],
         "hasMore":true}
        """#
        let transport = RecordingTransport(responses: ["stock/photos:search": response, "stock/photos:track": #"{"tracked":true}"#])
        let api = DesynAPI(transport: transport)
        let result = try await api.searchStock(query: "sunset", orientation: "landscape", count: 30)
        XCTAssertEqual(transport.lastArgs("stock/photos:search"), ["query": "sunset", "orientation": "landscape", "count": 30, "page": 1])
        XCTAssertTrue(result.hasMore)
        let photo = try XCTUnwrap(result.photos.first)
        XCTAssertEqual(photo.credit, "Photo by Ann Lee on Unsplash")
        XCTAssertEqual(photo.attribution["license"], "Unsplash License")
        try await api.trackStockUse(photo)
        XCTAssertEqual(transport.lastArgs("stock/photos:track"), ["id": "unsplash:abc", "downloadLocation": "https://api.unsplash.com/photos/abc/download"])
    }

    func testEditedCommentsReplaceTheirMentions() async throws {
        let transport = RecordingTransport(responses: ["collab/comments:edit": "null"])
        let api = DesynAPI(transport: transport)
        try await api.editComment(commentId: "c1", body: "cc @Ann", mentions: ["u1"])
        XCTAssertEqual(transport.lastArgs("collab/comments:edit"), ["commentId": "c1", "body": "cc @Ann", "mentions": ["u1"]])
        try await api.editComment(commentId: "c1", body: "no one", mentions: [])
        XCTAssertEqual(transport.lastArgs("collab/comments:edit"), ["commentId": "c1", "body": "no one", "mentions": []])
        try await api.editComment(commentId: "c1", body: "kept")
        XCTAssertEqual(transport.lastArgs("collab/comments:edit"), ["commentId": "c1", "body": "kept"])
    }

    func testMentions() {
        let members = [
            MentionableMember(id: "u1", name: "Ann", image: nil, role: "editor"),
            MentionableMember(id: "u2", name: "Ann Lee", image: nil, role: "admin"),
        ]
        XCTAssertEqual(CommentMentions.resolve(in: "thanks @ann lee and @Ann", members: members), ["u2", "u1"])
        XCTAssertEqual(CommentMentions.activeQuery(in: "hey @An"), "An")
        XCTAssertNil(CommentMentions.activeQuery(in: "mail me@x"))
        XCTAssertEqual(CommentMentions.complete("hey @An", with: members[1]), "hey @Ann Lee ")
    }
}
