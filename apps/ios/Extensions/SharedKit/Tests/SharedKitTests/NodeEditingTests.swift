import DesynKit
import XCTest
import SharedKit

final class NodeEditingTests: XCTestCase {
    func testSolidColorTargetsTheRightSlotPerType() throws {
        let rect = Fixtures.rect("rectaaaaaaaa")
        let text = Fixtures.text("textaaaaaaaa")
        let page = Fixtures.page()
        let line = NodeFactory.line(id: "lineaaaaaaaa", parent: Fixtures.pageId, from: PagePoint(x: 0, y: 0), length: 100)
        let ops = NodeEditing.setSolidColor("#FFB02E", on: [rect, text, page, line])
        XCTAssertEqual(ops.count, 4)
        guard case let .update(_, rectSet, _) = ops[0] else { return XCTFail() }
        XCTAssertEqual(rectSet["fills"]?[0]?["color"], "#ffb02e")
        guard case let .patch(_, path, value) = ops[1] else { return XCTFail() }
        XCTAssertEqual(path, [.key("style"), .key("fills")])
        XCTAssertEqual(value[0]?["color"], "#ffb02e")
        guard case let .update(_, pageSet, _) = ops[2] else { return XCTFail() }
        XCTAssertEqual(pageSet["background"]?[0]?["color"], "#ffb02e")
        guard case let .update(_, lineSet, _) = ops[3] else { return XCTFail() }
        XCTAssertEqual(lineSet["strokes"]?[0]?["fills"]?[0]?["color"], "#ffb02e")
        XCTAssertEqual(lineSet["strokes"]?[0]?["width"], 2)
    }

    func testSolidColorKeepsLayersAboveAndOpacity() {
        var rect = Fixtures.rect("rectaaaaaaaa")
        var first = Fill.solid(.hex("#000000"))
        first.opacity = 0.5
        rect.fills = [first, NodeEditing.linearGradient(angle: 90, stops: [(0, "#ffffff"), (1, "#000000")])]
        let ops = NodeEditing.setSolidColor("#ff0000", on: [rect])
        guard case let .update(_, set, _) = ops.first else { return XCTFail() }
        XCTAssertEqual(set["fills"]?[0]?["opacity"], 0.5)
        XCTAssertEqual(set["fills"]?[1]?["type"], "linear")
    }

    func testTextStyleDropsRunOverridesOfTheSameKeysOnce() {
        var text = Fixtures.text("textaaaaaaaa")
        text.runs = [
            TextRun(text: "He", style: ["fontFamily": "Lora", "fontWeight": 700, "highlight": "#ffff00"]),
            TextRun(text: "llo"),
        ]
        let ops = NodeEditing.setFont(family: "Inter", weight: 500, italic: true, on: [text])
        XCTAssertEqual(ops.count, 4)
        XCTAssertTrue(ops.contains(.patch(id: text.id, path: [.key("style"), .key("fontFamily")], value: "Inter")))
        XCTAssertTrue(ops.contains(.patch(id: text.id, path: [.key("style"), .key("fontStyle")], value: "italic")))
        guard case let .update(_, set, _) = ops.last else { return XCTFail() }
        XCTAssertEqual(set["runs"]?[0]?["style"], ["highlight": "#ffff00"])
        XCTAssertNil(set["runs"]?[1]?["style"])
    }

    func testTextStyleWithoutOverridesIsOnePatch() {
        let ops = NodeEditing.setTextStyle("letterSpacing", 0.1, on: [Fixtures.text("textaaaaaaaa")])
        XCTAssertEqual(ops, [.patch(id: "textaaaaaaaa", path: [.key("style"), .key("letterSpacing")], value: 0.1)])
    }

    func testStrokeCreateAndRemove() {
        let rect = Fixtures.rect("rectaaaaaaaa")
        let ops = NodeEditing.setStroke(color: "#FF0000", width: 4, dash: [6, 3], on: [rect])
        guard case let .update(_, set, _) = ops.first else { return XCTFail() }
        XCTAssertEqual(set["strokes"]?[0]?["width"], 4)
        XCTAssertEqual(set["strokes"]?[0]?["align"], "inside")
        XCTAssertEqual(set["strokes"]?[0]?["dash"], [6, 3])
        XCTAssertEqual(set["strokes"]?[0]?["fills"]?[0]?["color"], "#ff0000")
        var stroked = rect
        stroked.set("strokes", set["strokes"])
        XCTAssertEqual(NodeEditing.removeStrokes(on: [stroked]), [.update(id: rect.id, set: ["strokes": []], unset: [])])
        let line = NodeFactory.line(parent: Fixtures.pageId, from: PagePoint(x: 0, y: 0), length: 10)
        XCTAssertTrue(NodeEditing.removeStrokes(on: [line]).isEmpty)
    }

    func testEffects() {
        let rect = Fixtures.rect("rectaaaaaaaa")
        let added = NodeEditing.addEffect(.glow, on: [rect])
        guard case let .update(_, set, _) = added.first else { return XCTFail() }
        XCTAssertEqual(set["effects"]?[0]?["type"], "glow")
        var withEffect = rect
        withEffect.set("effects", set["effects"])
        XCTAssertEqual(
            NodeEditing.setEffect(index: 0, key: "radius", value: 12, on: [withEffect]),
            [.patch(id: rect.id, path: [.key("effects"), .index(0), .key("radius")], value: 12)]
        )
        XCTAssertTrue(NodeEditing.setEffect(index: 3, key: "radius", value: 12, on: [withEffect]).isEmpty)
        XCTAssertEqual(NodeEditing.removeEffect(index: 0, on: [withEffect]), [.update(id: rect.id, set: ["effects": []], unset: [])])
    }

    func testCornerRadiusClampsAndSkipsNodesWithout() {
        let rect = Fixtures.rect("rectaaaaaaaa")
        let ellipse = NodeFactory.ellipse(parent: Fixtures.pageId, frame: PageRect(x: 0, y: 0, width: 10, height: 10))
        var noRadius = ellipse
        noRadius.set("cornerRadius", nil)
        let ops = NodeEditing.setCornerRadius(.corners(4.4, -2, 8, 0), on: [rect, noRadius])
        XCTAssertEqual(ops, [.update(id: rect.id, set: ["cornerRadius": [4, 0, 8, 0]], unset: [])])
    }

    func testAnimationsAddEditRemove() {
        let rect = Fixtures.rect("rectaaaaaaaa")
        let added = NodeEditing.setAnimation(phase: "in", preset: "rise", on: [rect])
        guard case let .update(_, set, _) = added.first, let anim = set["anim"]?[0] else { return XCTFail() }
        XCTAssertEqual(anim["preset"], "rise")
        XCTAssertEqual(anim["phase"], "in")
        XCTAssertEqual(anim["durationMs"], 600)
        XCTAssertEqual(anim["id"]?.stringValue?.count, 12)
        var animated = rect
        animated.set("anim", set["anim"])
        let edited = NodeEditing.setAnimation(phase: "in", preset: "pop", durationMs: 900.4, easing: "spring", on: [animated])
        guard case let .update(_, editedSet, _) = edited.first, let editedAnim = editedSet["anim"]?[0] else { return XCTFail() }
        XCTAssertEqual(editedAnim["id"], anim["id"])
        XCTAssertEqual(editedAnim["preset"], "pop")
        XCTAssertEqual(editedAnim["durationMs"], 900)
        XCTAssertEqual(editedAnim["easing"], "spring")
        XCTAssertEqual(NodeEditing.setAnimation(phase: "in", preset: nil, on: [animated]), [.update(id: rect.id, set: [:], unset: ["anim"])])
    }

    func testImageAdjustmentsMergeDefaults() {
        var image = NodeFactory.image(parent: Fixtures.pageId, assetId: "assetaaaaaaa", frame: PageRect(x: 0, y: 0, width: 10, height: 10))
        image.set("adjust", ["contrast": 0.2])
        let ops = NodeEditing.setAdjustment("filter", "warm", on: [image])
        guard case let .update(_, set, _) = ops.first, let adjust = set["adjust"]?.objectValue else { return XCTFail() }
        XCTAssertEqual(adjust["contrast"], 0.2)
        XCTAssertEqual(adjust["brightness"], 0)
        XCTAssertEqual(adjust["filter"], "warm")
        XCTAssertEqual(adjust.count, 14)
        XCTAssertEqual(NodeEditing.resetAdjustments(on: [image]), [.update(id: image.id, set: [:], unset: ["adjust"])])
    }

    func testPageTransition() {
        let page = Fixtures.page()
        XCTAssertEqual(
            NodeEditing.setPageTransition(kind: "fade", durationMs: 20000, on: page),
            [.update(id: page.id, set: ["transition": ["kind": "fade", "durationMs": 5000]], unset: [])]
        )
        XCTAssertEqual(NodeEditing.setPageTransition(kind: "none", durationMs: 0, on: page), [.update(id: page.id, set: [:], unset: ["transition"])])
    }

    func testTextPresetAppliesStyleParagraphAndStyleRef() {
        var text = Fixtures.text("textaaaaaaaa")
        text.set("styleRef", "oldstyleaaaa")
        let ops = NodeEditing.applyTextStyle(["fontSize": 40], paragraph: ["align": "center"], on: [text])
        XCTAssertEqual(ops, [
            .patch(id: text.id, path: [.key("style"), .key("fontSize")], value: 40),
            .patch(id: text.id, path: [.key("paragraph"), .key("align")], value: "center"),
            .update(id: text.id, set: [:], unset: ["styleRef"]),
        ])
    }
}
