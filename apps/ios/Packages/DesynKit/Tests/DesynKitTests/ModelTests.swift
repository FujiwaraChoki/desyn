import DesynKit
import XCTest

final class JSONValueTests: XCTestCase {
    func testSerializationIsDeterministicAndIntegral() throws {
        let value: JSONValue = ["b": 1, "a": [1.5, true, "x"], "c": ["z": -0.0, "y": 6]]
        XCTAssertEqual(value.serialized(), #"{"a":[1.5,true,"x"],"b":1,"c":{"y":6,"z":0}}"#)
    }

    func testEscapesStrings() {
        let value = JSONValue.string("a\"b\\c\nd\u{01}é")
        XCTAssertEqual(value.serialized(), "\"a\\\"b\\\\c\\nd\\u0001é\"")
    }

    func testRoundTripPreservesBooleansAndNumbers() throws {
        let text = #"{"flag":false,"n":0.1,"big":12345678901,"nested":{"arr":[null,1,"s"]}}"#
        let parsed = try JSONValue.parse(text)
        XCTAssertEqual(parsed["flag"], .bool(false))
        XCTAssertEqual(parsed["n"], .number(0.1))
        XCTAssertEqual(parsed["big"]?.intValue, 12_345_678_901)
        XCTAssertEqual(try JSONValue.parse(parsed.serialized()), parsed)
    }

    func testNonFiniteNumbersBecomeNull() {
        XCTAssertEqual(JSONValue.number(.nan).serialized(), "null")
        XCTAssertEqual(JSONValue.format(number: 1e21), "1e+21")
    }
}

final class OperationTests: XCTestCase {
    func testOpsRoundTrip() throws {
        let rect = NodeFactory.rect(parent: "pageaaaaaaaa", frame: PageRect(x: 1, y: 2, width: 3, height: 4))
        let ops: [Op] = [
            .create(nodes: [rect], parent: "pageaaaaaaaa", index: 0),
            .update(id: rect.id, set: ["opacity": 0.5], unset: ["role"]),
            .patch(id: rect.id, path: [.key("fills"), .index(0), .key("color")], value: "#ff0000"),
            .move(id: rect.id, parent: "pageaaaaaaaa", index: nil),
            .delete(id: rect.id),
            .asset(set: [:], remove: ["assetaaaaaaa"]),
            .styles(path: [.key("variables"), .key("brand.primary")], value: "#ffb02e"),
            .doc(set: ["name": "Poster"], unset: ["brandKitId"]),
        ]
        let json = Op.serialize(ops)
        XCTAssertEqual(try Op.parseList(json), ops)
    }

    func testUnknownOpIsKept() throws {
        let raw: JSONValue = ["op": "future", "x": 1]
        let op = Op(json: raw)
        XCTAssertEqual(op, .unknown(raw))
        XCTAssertEqual(op.jsonValue, raw)
    }

    func testTransactionKeepsUnknownKeys() throws {
        let text = #"{"id":"abcdefabcdef","label":"Move","ops":[],"source":"ai","ts":1700000000000,"actor":{"runId":"r1"},"future":{"k":1}}"#
        let tx = try DesignTransaction(jsonString: text)
        XCTAssertEqual(tx.source, .ai)
        XCTAssertEqual(tx.runID, "r1")
        XCTAssertEqual(try JSONValue.parse(tx.serialized()), try JSONValue.parse(text))
    }

    func testIdsMatchTheSchemaFormat() {
        for _ in 0..<50 {
            XCTAssertTrue(DesynID.isValid(DesynID.new()))
        }
        XCTAssertTrue(DesynID.isValid("root"))
        XCTAssertFalse(DesynID.isValid("ABCDEFabcdef"))
        XCTAssertFalse(DesynID.isValid("short"))
    }
}

final class NodeFactoryTests: XCTestCase {
    private let baseKeys: Set<String> = [
        "id", "type", "name", "parent", "x", "y", "width", "height", "rotation", "opacity", "blend", "visible", "locked", "effects",
    ]

    func testShapesCarryEveryRequiredField() {
        let nodes = [
            NodeFactory.rect(parent: "p", frame: PageRect(x: 0, y: 0, width: 10, height: 10)),
            NodeFactory.ellipse(parent: "p", frame: PageRect(x: 0, y: 0, width: 10, height: 10)),
            NodeFactory.polygon(parent: "p", frame: PageRect(x: 0, y: 0, width: 10, height: 10)),
            NodeFactory.star(parent: "p", frame: PageRect(x: 0, y: 0, width: 10, height: 10)),
            NodeFactory.path(parent: "p", frame: PageRect(x: 0, y: 0, width: 10, height: 10), d: "M0 0L10 10Z", color: "#000000"),
        ]
        for node in nodes {
            XCTAssertTrue(baseKeys.isSubset(of: Set(node.json.keys)), "\(node.typeName) misses base keys")
            XCTAssertNotNil(node.json["fills"])
            XCTAssertNotNil(node.json["strokes"])
            XCTAssertNotNil(node.json["cornerRadius"])
            XCTAssertTrue(DesynID.isValid(node.id))
        }
    }

    func testTextAndPageDefaults() {
        let text = NodeFactory.text(parent: "p", text: "Hello", origin: PagePoint(x: 4, y: 5), fontSize: 40)
        XCTAssertEqual(text.type, .text)
        XCTAssertEqual(text.text, "Hello")
        XCTAssertEqual(text.height, 48)
        XCTAssertEqual(text.json["autoResize"], "height")
        XCTAssertEqual(text.textStyle?.fontSize, 40)
        XCTAssertEqual(text.paragraph?.align, "left")

        let page = NodeFactory.page(width: 1080, height: 1350)
        XCTAssertEqual(page.type, .page)
        XCTAssertEqual(page.parent, "root")
        XCTAssertEqual(page.json["clip"], .bool(true))
        XCTAssertEqual(page.background.first?.swatchHex, "#ffffff")
    }

    func testCloneSubtreeRemapsIds() {
        let group = Node(json: [
            "id": "groupaaaaaaa", "type": "group", "name": "G", "parent": "pageaaaaaaaa", "children": ["rectaaaaaaaa"],
            "x": 10, "y": 10, "width": 5, "height": 5,
        ])
        let child = NodeFactory.rect(id: "rectaaaaaaaa", parent: "groupaaaaaaa", frame: PageRect(x: 0, y: 0, width: 5, height: 5))
        let (cloned, ids) = NodeFactory.cloneSubtree([group, child], offset: PagePoint(x: 20, y: 0))
        XCTAssertEqual(cloned[0].x, 30)
        XCTAssertEqual(cloned[0].children, [ids["rectaaaaaaaa"]!])
        XCTAssertEqual(cloned[1].parent, ids["groupaaaaaaa"])
        XCTAssertNotEqual(cloned[1].id, "rectaaaaaaaa")
    }
}

final class TextRunsTests: XCTestCase {
    private let bold: [String: JSONValue] = ["fontWeight": 700]

    func testInsertAtBoundaryContinuesThePreviousRun() {
        let runs = [TextRun(text: "Hello", style: bold), TextRun(text: " world")]
        let result = TextRuns.replace(in: runs, range: 5..<5, with: "!")
        XCTAssertEqual(result.map(\.text), ["Hello!", " world"])
        XCTAssertEqual(result[0].style, bold)
    }

    func testDeleteAcrossRuns() {
        let runs = [TextRun(text: "Hello", style: bold), TextRun(text: " world")]
        let result = TextRuns.replace(in: runs, range: 3..<8, with: "")
        XCTAssertEqual(TextRuns.text(of: result), "Helrld")
        XCTAssertEqual(result.map(\.text), ["Hel", "rld"])
    }

    func testReplaceInsideARunAndAtStart() {
        let runs = [TextRun(text: "Hello")]
        XCTAssertEqual(TextRuns.text(of: TextRuns.replace(in: runs, range: 1..<3, with: "EY")), "HEYlo")
        XCTAssertEqual(TextRuns.text(of: TextRuns.replace(in: runs, range: 0..<0, with: ">")), ">Hello")
    }

    func testDeletingEverythingKeepsOneStyledRun() {
        let runs = [TextRun(text: "Hi", style: bold)]
        let result = TextRuns.replace(in: runs, range: 0..<2, with: "")
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].text, "")
        XCTAssertEqual(result[0].style, bold)
    }

    func testUTF16OffsetsWithEmoji() {
        let runs = [TextRun(text: "a😀b")]
        XCTAssertEqual(TextRuns.length(of: runs), 4)
        XCTAssertEqual(TextRuns.text(of: TextRuns.replace(in: runs, range: 1..<3, with: "")), "ab")
        XCTAssertEqual(TextRuns.substring(of: runs, range: 1..<3), "😀")
    }

    func testRangesAreClamped() {
        let runs = [TextRun(text: "abc")]
        XCTAssertEqual(TextRuns.text(of: TextRuns.replace(in: runs, range: 2..<99, with: "Z")), "abZ")
    }
}

final class InkStrokeTests: XCTestCase {
    func testOutlineCoversTheStrokeWithItsWidth() throws {
        let samples = (0...20).map { InkSample(x: 100 + Double($0) * 5, y: 200, pressure: 1) }
        let outline = try XCTUnwrap(InkStroke.outline(samples, width: 10))
        XCTAssertEqual(outline.frame.x, 95, accuracy: 0.6)
        XCTAssertEqual(outline.frame.y, 195, accuracy: 0.6)
        XCTAssertEqual(outline.frame.width, 110, accuracy: 1.2)
        XCTAssertEqual(outline.frame.height, 10, accuracy: 0.6)
        XCTAssertTrue(outline.d.hasPrefix("M"))
        XCTAssertTrue(outline.d.hasSuffix("Z"))
    }

    func testPressureNarrowsTheStroke() throws {
        let light = (0...10).map { InkSample(x: Double($0) * 4, y: 0, pressure: 0) }
        let outline = try XCTUnwrap(InkStroke.outline(light, width: 20))
        XCTAssertEqual(outline.frame.height, 7, accuracy: 0.6)
    }

    func testSingleTapIsADot() throws {
        let outline = try XCTUnwrap(InkStroke.outline([InkSample(x: 10, y: 10, pressure: 1)], width: 8))
        XCTAssertEqual(outline.frame.width, 8, accuracy: 0.5)
        XCTAssertNil(InkStroke.outline([], width: 8))
    }
}

final class PresetTests: XCTestCase {
    func testPresetsMirrorTheSchema() throws {
        XCTAssertEqual(PagePreset.all.count, 134)
        XCTAssertEqual(Set(PagePreset.all.map(\.id)).count, PagePreset.all.count, "preset ids are unique")
        let post = try XCTUnwrap(PagePreset.preset(id: "instagram-post"))
        XCTAssertEqual(post.width, 1080)
        XCTAssertEqual(post.kind, .socialPost)
        XCTAssertEqual(post.sizeLabel, "1080 x 1080 px")
        let a0 = try XCTUnwrap(PagePreset.preset(id: "poster-a0"))
        XCTAssertEqual(a0.sizeLabel, "841 x 1189 mm")
        XCTAssertNotNil(a0.bleed)
    }

    func testEveryKindHasInfoAndADefaultPreset() {
        XCTAssertEqual(DesignKindInfo.all.count, 24)
        for info in DesignKindInfo.all {
            XCTAssertNotNil(PagePreset.preset(id: info.defaultPreset), "\(info.kind) default preset")
        }
    }

    func testGroupingFiltersByQuery() {
        let groups = PagePreset.grouped(matching: "instagram")
        XCTAssertFalse(groups.isEmpty)
        XCTAssertTrue(groups.allSatisfy { group in group.presets.allSatisfy { $0.label.lowercased().contains("instagram") || $0.platform == "instagram" } })
    }
}

final class DesignTests: XCTestCase {
    func testAssembleFromLoadPages() throws {
        let page = NodeFactory.page(id: "pageaaaaaaaa", width: 100, height: 100)
        let root = Node(json: [
            "id": "root", "type": "root", "name": "Root", "parent": .null, "children": ["pageaaaaaaaa"],
            "x": 0, "y": 0, "width": 0, "height": 0,
        ])
        let header: JSONValue = [
            "designId": "convexid", "key": "designaaaaaa", "name": "Poster", "kind": "poster", "workspaceId": "ws",
            "pageCount": 1,
            "assets": .string(#"{"img1aaaaaaaa":{"id":"img1aaaaaaaa","kind":"image","mime":"image/png"}}"#),
            "styles": .string(##"{"colors":{},"text":{},"effects":{},"variables":{"brand.primary":"#ffb02e"}}"##),
            "meta": .string(#"{"locale":"en"}"#),
            "brandKitId": .null, "permission": "edit", "snapshot": .null,
        ]
        let first = try JSONDecoder().decode(LoadPage.self, from: Data(JSONValue.object([
            "header": header,
            "seq": 7,
            "nodes": .strings([root.serialized()]),
            "cursor": "c1",
            "isDone": false,
        ]).serialized().utf8))
        let second = try JSONDecoder().decode(LoadPage.self, from: Data(JSONValue.object([
            "header": .null, "seq": 8, "nodes": .strings([page.serialized()]), "cursor": "c2", "isDone": true,
        ]).serialized().utf8))
        let loaded = try DesignAssembler.assemble([first, second])
        XCTAssertEqual(loaded.seq, 7)
        XCTAssertFalse(loaded.consistent)
        XCTAssertEqual(loaded.design.id, "designaaaaaa")
        XCTAssertEqual(loaded.design.pages.map(\.id), ["pageaaaaaaaa"])
        XCTAssertEqual(loaded.design.assets["img1aaaaaaaa"]?.kind, "image")
        XCTAssertEqual(loaded.design.meta["locale"], "en")
        XCTAssertTrue(loaded.canEdit)
        // Serialized designs parse back to the same design.
        XCTAssertEqual(try Design(jsonString: loaded.design.serialized()), loaded.design)
    }

    func testDesignKeepsUnknownTopLevelKeys() throws {
        let text = #"{"schema":1,"id":"designaaaaaa","name":"X","kind":"custom","nodes":{},"assets":{},"styles":{"colors":{},"text":{},"effects":{},"variables":{}},"meta":{},"future":true}"#
        let design = try Design(jsonString: text)
        XCTAssertEqual(design.extra["future"], .bool(true))
        XCTAssertEqual(try JSONValue.parse(design.serialized()), try JSONValue.parse(text))
    }
}

final class JSONParserTests: XCTestCase {
    func testRejectsMalformedInput() {
        for text in ["", "{", "[1,]", "{\"a\" 1}", "01", "1.", "tru", "\"\u{01}\"", "{\"a\":1} x", "\"\\x\""] {
            XCTAssertThrowsError(try JSONValue.parse(text), "accepted \(text.debugDescription)")
        }
    }

    func testDecodesEscapesAndSurrogatePairs() throws {
        XCTAssertEqual(try JSONValue.parse(#""a\u00e9\ud83d\ude00\n\/""#), .string("aé😀\n/"))
        XCTAssertEqual(try JSONValue.parse(" [ -1.5e2 , 0 , 1E-2 ] "), [-150, 0, 0.01])
        XCTAssertEqual(try JSONValue.parse("true"), .bool(true))
        XCTAssertEqual(try JSONValue.parse("{\"k\":{}}"), ["k": [:]])
    }
}
