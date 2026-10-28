import DesynKit
import XCTest
import SharedKit

final class ElementFactoryTests: XCTestCase {
    private let center = PagePoint(x: 540, y: 540)

    func testEveryShapeIsAValidNodeCenteredOnThePoint() {
        for shape in ElementFactory.Shape.allCases {
            let node = ElementFactory.shape(shape, parent: Fixtures.pageId, center: center, side: 200, color: "#ffb02e")
            XCTAssertEqual(node.id.count, 12, "\(shape)")
            XCTAssertEqual(node.parent, Fixtures.pageId)
            XCTAssertEqual(node.x + node.width / 2, 540, accuracy: 1e-9, "\(shape)")
            if shape != .line, shape != .arrow {
                XCTAssertEqual(node.y + node.height / 2, 540, accuracy: 1e-9, "\(shape)")
                XCTAssertEqual(NodeEditing.paints(of: node).first?.color?.hex, "#ffb02e", "\(shape)")
            }
        }
        let arrow = ElementFactory.shape(.arrow, parent: Fixtures.pageId, center: center, side: 200, color: "#111111")
        XCTAssertEqual(arrow.string("endCap"), "arrow")
        XCTAssertEqual(arrow.strokes.first?.width, 5)
    }

    func testScaledPathKeepsArcFlags() {
        XCTAssertEqual(
            ElementFactory.scaledPath("M 0 100 L 0 50 A 50 50 0 0 1 100 50 Z", from: 100, to: 200),
            "M 0 200 L 0 100 A 100 100 0 0 1 200 100 Z"
        )
    }

    func testTextPresetSizesForThePage() throws {
        let display = try XCTUnwrap(ElementFactory.textPresets.first { $0.id == "display" })
        let node = ElementFactory.text(display, parent: Fixtures.pageId, center: center, pageWidth: 1080, pageHeight: 1920, color: "#ffffff")
        XCTAssertEqual(node.textStyle?.fontSize, 119)
        XCTAssertEqual(node.textStyle?.fontFamily, "Instrument Serif")
        XCTAssertEqual(node.text, "Make it shine")
        XCTAssertEqual(node.role, "headline")
        XCTAssertEqual(node.paragraph?.json["lineHeight"]?["value"], 100)
        let eyebrow = try XCTUnwrap(ElementFactory.textPresets.first { $0.id == "eyebrow" })
        let small = ElementFactory.text(eyebrow, parent: Fixtures.pageId, center: center, pageWidth: 300, pageHeight: 300, color: "#111111")
        XCTAssertEqual(small.textStyle?.fontSize, 11)
        XCTAssertEqual(small.textStyle?.json["textCase"], "upper")
    }

    func testChartsCarryStarterDataAndThePalette() {
        for kind in ElementFactory.ChartKind.allCases {
            let chart = ElementFactory.chart(kind, parent: Fixtures.pageId, center: center, width: 600, textColor: "#111111")
            XCTAssertEqual(chart.string("chart"), kind.rawValue)
            let data = ElementFactory.ChartData(node: chart)
            XCTAssertFalse(data.labels.isEmpty)
            XCTAssertTrue(data.series.allSatisfy { $0.values.count == data.labels.count }, "\(kind)")
            XCTAssertEqual(chart.object("options")?["palette"]?.arrayValue?.count, 7)
        }
    }

    func testChartDataPadsSeriesAndKeepsColors() {
        var chart = ElementFactory.chart(.column, parent: Fixtures.pageId, center: center, width: 600, textColor: "#111111")
        chart.set("data", ["labels": ["A"], "series": [["name": "S", "values": [1], "color": "#123456"]]])
        var data = ElementFactory.ChartData(node: chart)
        data.labels = ["A", "B", "C"]
        let json = data.jsonValue(keeping: chart)
        XCTAssertEqual(json["series"]?[0]?["values"], [1, 0, 0])
        XCTAssertEqual(json["series"]?[0]?["color"], "#123456")
    }

    func testTableHeaderCellsAndResize() {
        let table = ElementFactory.table(rows: 3, cols: 2, parent: Fixtures.pageId, center: center, width: 400, textColor: "#111111", accent: "#ffb02e")
        XCTAssertEqual(table.json["cells"]?.arrayValue?.count, 6)
        XCTAssertEqual(ElementFactory.tableTexts(table)[0], ["Heading 1", "Heading 2"])
        XCTAssertEqual(table.width, 400)
        let setOps = ElementFactory.setTableCell(row: 2, col: 1, text: "42", on: table)
        XCTAssertEqual(setOps, [.patch(id: table.id, path: [.key("cells"), .index(5), .key("text")], value: "42")])
        let resized = ElementFactory.resizeTable(rows: 2, cols: 3, on: table)
        guard case let .update(_, set, _) = resized.first else { return XCTFail() }
        XCTAssertEqual(set["rows"], 2)
        XCTAssertEqual(set["cols"], 3)
        XCTAssertEqual(set["colWidths"]?.arrayValue?.count, 3)
        XCTAssertEqual(set["cells"]?.arrayValue?.count, 4)
        XCTAssertEqual(set["width"], 600)
        XCTAssertTrue(ElementFactory.resizeTable(rows: 3, cols: 2, on: table).isEmpty)
    }

    func testQRPayloadNormalization() {
        XCTAssertEqual(ElementFactory.qrPayload("desyn.app"), "https://desyn.app")
        XCTAssertEqual(ElementFactory.qrPayload(" https://x.io/a "), "https://x.io/a")
        XCTAssertEqual(ElementFactory.qrPayload("hi@desyn.app"), "mailto:hi@desyn.app")
        XCTAssertEqual(ElementFactory.qrPayload("+1 (555) 010-2030"), "tel:+15550102030")
        XCTAssertEqual(ElementFactory.qrPayload("Hello there"), "Hello there")
        XCTAssertEqual(ElementFactory.qrPayload("WIFI:S:home;T:WPA;P:pw;;"), "WIFI:S:home;T:WPA;P:pw;;")
        let qr = ElementFactory.qr(data: "https://desyn.app", parent: Fixtures.pageId, center: center, side: 200)
        XCTAssertEqual(qr.string("errorCorrection"), "M")
        XCTAssertEqual(qr.width, 200)
    }

    func testSVGNodeKeepsTheViewBoxAspect() {
        let markup = #"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"><path d="M0 0h48v24z" fill="currentColor"/></svg>"#
        XCTAssertEqual(SVGMarkup.aspectRatio(markup), 2)
        let node = ElementFactory.svg(markup: SVGMarkup.tinted(markup, hex: "#ffb02e"), name: "lucide:x", parent: Fixtures.pageId, center: center, side: 200)
        XCTAssertEqual(node.width, 200)
        XCTAssertEqual(node.height, 100)
        XCTAssertTrue(node.string("markup")?.contains("#ffb02e") ?? false)
        XCTAssertFalse(SVGMarkup.isPlausiblySafe("<svg><script>alert(1)</script></svg>"))
        XCTAssertEqual(SVGMarkup.aspectRatio(#"<svg width="30px" height="10px"></svg>"#), 3)
    }

    func testImageFitsInsideMaxSide() {
        let node = ElementFactory.image(assetId: "assetaaaaaaa", pixelWidth: 4000, pixelHeight: 2000, parent: Fixtures.pageId, center: center, maxSide: 600, name: "Photo")
        XCTAssertEqual(node.width, 600)
        XCTAssertEqual(node.height, 300)
        XCTAssertEqual(node.assetId, "assetaaaaaaa")
    }
}

final class ColorMathTests: XCTestCase {
    func testHexRoundTrip() {
        XCTAssertEqual(RGBA(hex: "#FFB02E")?.hex, "#ffb02e")
        XCTAssertEqual(RGBA(hex: "abc")?.hex, "#aabbcc")
        XCTAssertEqual(RGBA(hex: "#ffb02e80")?.hex, "#ffb02e80")
        XCTAssertNil(RGBA(hex: "#ggg"))
        XCTAssertNil(RGBA(hex: "#12345"))
    }

    func testHSVRoundTrip() throws {
        for hex in ["#ffb02e", "#ff6a1f", "#5aa9ff", "#000000", "#ffffff", "#7a7468", "#00ff00"] {
            let rgba = try XCTUnwrap(RGBA(hex: hex))
            XCTAssertEqual(rgba.hsv.rgba.hex, hex)
        }
        XCTAssertEqual(HSV(h: 360, s: 1, v: 1).rgba.hex, "#ff0000")
    }

    func testContrast() throws {
        let white = try XCTUnwrap(RGBA(hex: "#ffffff"))
        let black = try XCTUnwrap(RGBA(hex: "#000000"))
        XCTAssertEqual(white.contrast(with: black), 21, accuracy: 0.01)
        XCTAssertEqual(try XCTUnwrap(RGBA(hex: "#ffb02e")).readableTextHex, "#111111")
        XCTAssertEqual(try XCTUnwrap(RGBA(hex: "#0a0a0a")).readableTextHex, "#ffffff")
    }

    func testRecentColors() {
        var recent = RecentColors(limit: 3)
        for hex in ["#AAAAAA", "#bbbbbb", "#cccccc", "#aaaaaa", "#dddddd"] { recent.add(hex) }
        XCTAssertEqual(recent.colors, ["#dddddd", "#aaaaaa", "#cccccc"])
    }
}
