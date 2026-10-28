import AppGroupKit
import DesynKit
import XCTest
import SharedKit

final class BrandApplierTests: XCTestCase {
    private func kit(colors: [BrandKitDetail.BrandColor], heading: String? = "Playfair Display", body: String? = "Lato") -> BrandKitDetail {
        BrandKitDetail(
            id: "kit1",
            workspaceId: "ws1",
            name: "Acme",
            logos: [],
            colors: colors,
            fonts: BrandKitDetail.Fonts(
                heading: heading.map { BrandKitDetail.FontSlot(family: $0, weight: 700, style: "normal") },
                body: body.map { BrandKitDetail.FontSlot(family: $0, weight: 400, style: nil) },
                accent: nil
            ),
            voice: nil,
            isDefault: true
        )
    }

    func testMapsAccentsFontsBackgroundAndAttachesTheKit() {
        let accentA = Fixtures.rect("aaaaaaaaaaaa", color: "#ff0000")
        let accentA2 = Fixtures.rect("cccccccccccc", color: "#ff0000")
        let accentB = Fixtures.rect("bbbbbbbbbbbb", color: "#00ff00")
        let neutral = Fixtures.rect("dddddddddddd", color: "#d9d9d9")
        let headline = Fixtures.text("headaaaaaaaa", size: 64, role: "headline")
        let body = Fixtures.text("bodyaaaaaaaa", size: 18)
        let page = Fixtures.page(children: [accentA.id, accentA2.id, accentB.id, neutral.id, headline.id, body.id])
        let brand = kit(colors: [
            BrandKitDetail.BrandColor(id: nil, name: "Ink", value: "#1A1A2E", role: "text"),
            BrandKitDetail.BrandColor(id: nil, name: "Paper", value: "#FFF8F0", role: "background"),
            BrandKitDetail.BrandColor(id: nil, name: "Accent", value: "#E94560", role: "accent"),
            BrandKitDetail.BrandColor(id: nil, name: "Primary", value: "#0F3460", role: "primary"),
        ])
        let result = BrandApplier.apply(brand, page: page, nodes: [page, accentA, accentA2, accentB, neutral, headline, body], existingStyleColors: [(id: "x", name: "Paper", value: "#fff8f0")], brandKitId: "kit1")

        func set(_ id: String, _ key: String) -> JSONValue? {
            for op in result.ops {
                if case let .update(opId, set, _) = op, opId == id, let value = set[key] { return value }
            }
            return nil
        }
        func patch(_ id: String, _ key: String) -> JSONValue? {
            for op in result.ops {
                if case let .patch(opId, path, value) = op, opId == id, path == [.key("style"), .key(key)] { return value }
            }
            return nil
        }
        // Most used accent (red, twice) -> primary; green -> accent; neutral untouched.
        XCTAssertEqual(set(accentA.id, "fills")?[0]?["color"], "#0f3460")
        XCTAssertEqual(set(accentA2.id, "fills")?[0]?["color"], "#0f3460")
        XCTAssertEqual(set(accentB.id, "fills")?[0]?["color"], "#e94560")
        XCTAssertNil(set(neutral.id, "fills"))
        XCTAssertEqual(set(page.id, "background")?[0]?["color"], "#fff8f0")
        XCTAssertEqual(patch(headline.id, "fontFamily"), "Playfair Display")
        XCTAssertEqual(patch(headline.id, "fontWeight"), 700)
        XCTAssertEqual(patch(body.id, "fontFamily"), "Lato")
        XCTAssertEqual(patch(body.id, "fills")?[0]?["color"], "#1a1a2e")
        XCTAssertTrue(result.ops.contains(.doc(set: ["brandKitId": "kit1"], unset: [])))
        let addedColors = result.ops.filter { if case .styles = $0 { return true } else { return false } }
        XCTAssertEqual(addedColors.count, 3)
        XCTAssertEqual(result.refonted, 2)
    }

    func testTextKeepsContrastOnTheBackground() {
        let text = Fixtures.text("textaaaaaaaa", size: 20, color: "#111111")
        let page = Fixtures.page(children: [text.id])
        let dark = kit(colors: [
            BrandKitDetail.BrandColor(id: nil, name: "Night", value: "#0a0a0a", role: "background"),
            BrandKitDetail.BrandColor(id: nil, name: "Ink", value: "#222222", role: "text"),
        ], heading: nil, body: nil)
        let result = BrandApplier.apply(dark, page: page, nodes: [page, text], existingStyleColors: [], brandKitId: "kit2")
        let fills = result.ops.compactMap { op -> JSONValue? in
            if case let .patch(id, path, value) = op, id == text.id, path.last == .key("fills") { return value }
            return nil
        }
        XCTAssertEqual(fills.first?[0]?["color"], "#ffffff")
    }
}

final class ImportPlannerTests: XCTestCase {
    private func asset(_ id: String) -> AssetRef {
        AssetRef(json: ["id": .string(id), "kind": "image", "mime": "image/jpeg", "storageKey": "uploads/x", "url": "https://signed"])
    }

    func testPhotoPagesKeepAspectAtAWorkableSize() throws {
        let item = ImportPlanner.Item(asset: asset("assetaaaaaaa"), pixelWidth: 4032, pixelHeight: 3024, name: "IMG_1")
        XCTAssertEqual(ImportPlanner.pageSize(for: item).width, 1920)
        XCTAssertEqual(ImportPlanner.pageSize(for: item).height, 1440)
        let small = ImportPlanner.Item(asset: asset("assetbbbbbbb"), pixelWidth: 800, pixelHeight: 800, name: "x")
        XCTAssertEqual(ImportPlanner.pageSize(for: small).width, 800)
        XCTAssertEqual(ImportPlanner.kind(for: [small], isPDF: false), .socialPost)
        let design = ImportPlanner.design(name: "Holiday", items: [item, small], isPDF: false)
        XCTAssertEqual(design.pages.count, 2)
        XCTAssertNil(design.assets["assetaaaaaaa"]?.url)
        for page in design.pages {
            XCTAssertEqual(page.parent, Design.rootID)
            XCTAssertEqual(page.children.count, 1)
            let image = try XCTUnwrap(design.nodes[page.children[0]])
            XCTAssertEqual(image.parent, page.id)
            XCTAssertEqual(image.width, page.width)
            XCTAssertEqual(image.role, "photo")
        }
        // The JSON parses back into the same design.
        XCTAssertEqual(try Design(jsonString: design.serialized()), design)
    }

    func testPDFPagesUsePointSizes() {
        let page = ImportPlanner.Item(asset: asset("assetaaaaaaa"), pixelWidth: 1700, pixelHeight: 2200, pageWidth: 816, pageHeight: 1056, name: "Report")
        let design = ImportPlanner.design(name: "Report", items: [page, page], isPDF: true)
        XCTAssertEqual(design.kind.rawValue, "document")
        XCTAssertEqual(design.pages.first?.width, 816)
        XCTAssertEqual(design.pages.first?.unit, .pt)
        XCTAssertEqual(ImportPlanner.name(fromFileName: "Q3 report.final.pdf", fallback: "Import"), "Q3 report.final")
        XCTAssertEqual(ImportPlanner.name(fromFileName: nil, fallback: "Import"), "Import")
    }
}

final class FontsAndIconsTests: XCTestCase {
    func testGoogleFontsCSSURLAndParsing() {
        XCTAssertEqual(
            GoogleFontsClient.cssURL(family: "Playfair Display", weight: 700, italic: true).absoluteString,
            "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@1,700"
        )
        XCTAssertEqual(GoogleFontsClient.cssURL(family: "Inter", weight: 400, italic: false).absoluteString, "https://fonts.googleapis.com/css2?family=Inter:wght@400")
        let css = """
        @font-face { font-family: 'Lora'; src: url(https://fonts.gstatic.com/s/lora/v1/a.ttf) format('truetype'); }
        @font-face { src: url('https://fonts.gstatic.com/s/lora/v1/b.ttf'); }
        @font-face { src: url(https://fonts.gstatic.com/s/lora/v1/a.ttf); }
        @font-face { src: url(http://insecure.test/x.ttf); }
        """
        XCTAssertEqual(GoogleFontsClient.fontURLs(inCSS: css).map(\.absoluteString), [
            "https://fonts.gstatic.com/s/lora/v1/a.ttf", "https://fonts.gstatic.com/s/lora/v1/b.ttf",
        ])
        let client = GoogleFontsClient(cacheDirectory: URL(fileURLWithPath: "/tmp/fonts"))
        XCTAssertEqual(client.cacheURL(family: "Playfair Display", weight: 700, italic: true).lastPathComponent, "Playfair_Display-700i.ttf")
    }

    func testCatalogMirrorsTheSchema() throws {
        XCTAssertGreaterThan(FontFamily.catalog.count, 100)
        let inter = try XCTUnwrap(FontFamily.named("inter"))
        XCTAssertEqual(inter.variableWeights, 100...900)
        XCTAssertEqual(inter.nearestWeight(640), 600)
        XCTAssertTrue(inter.isBundled)
        let lato = try XCTUnwrap(FontFamily.named("Lato"))
        XCTAssertEqual(lato.nearestWeight(500), 400)
        XCTAssertEqual(lato.nearestWeight(550), 700)
        XCTAssertTrue(lato.matches("warm"))
        XCTAssertFalse(lato.matches("geometric"))
        XCTAssertFalse(FontPairing.all.isEmpty)
        // Every pairing references catalog families.
        for pairing in FontPairing.all {
            XCTAssertNotNil(FontFamily.named(pairing.heading), pairing.heading)
            XCTAssertNotNil(FontFamily.named(pairing.body), pairing.body)
        }
        XCTAssertEqual(FontFamily.weightName(600), "Semibold")
    }

    func testIconifyURLsAndParsing() {
        let client = IconifyClient()
        let url = client.searchURL("arrow right", limit: 10)
        XCTAssertTrue(url.absoluteString.hasPrefix("https://api.iconify.design/search?"))
        XCTAssertTrue(url.absoluteString.contains("limit=32"))
        XCTAssertTrue(url.absoluteString.contains("prefixes=lucide,tabler,ph"))
        let icons = IconifyClient.parseSearch(Data(#"{"icons":["lucide:sun","bad id","ph:arrow-right","x:Y"]}"#.utf8), limit: 10)
        XCTAssertEqual(icons.map(\.id), ["lucide:sun", "ph:arrow-right"])
        XCTAssertEqual(icons[1].title, "arrow right")
        XCTAssertEqual(client.svgURL(icons[0], color: "#ffb02e").absoluteString, "https://api.iconify.design/lucide/sun.svg?color=%23ffb02e")
    }
}

final class ExportPlanTests: XCTestCase {
    func testFileNames() {
        XCTAssertEqual(ExportPlan.fileName(designName: "Spring / sale: v2", page: 2, pageCount: 3, format: .png), "Spring - sale- v2 - 2.png")
        XCTAssertEqual(ExportPlan.fileName(designName: "Deck", page: 2, pageCount: 3, format: .pdf), "Deck.pdf")
        XCTAssertEqual(ExportPlan.fileName(designName: "  ", page: nil, pageCount: 1, format: .jpeg), "Desyn design.jpg")
    }

    func testNormalization() {
        var plan = ExportPlan()
        plan.format = .jpeg
        plan.transparent = true
        plan.scale = 8
        plan.quality = 150
        let normalized = plan.normalized(pageWidth: 4000, pageHeight: 4000)
        XCTAssertFalse(normalized.transparent)
        XCTAssertEqual(normalized.scale, 2, accuracy: 1e-9)
        XCTAssertEqual(normalized.quality, 100)
        XCTAssertEqual(plan.pixelSize(width: 1080, height: 1350).width, 8640)
        XCTAssertTrue(FileFormat.pdf.isMultiPageFile)
        XCTAssertTrue(FileFormat.mp4.rendersOnServer)
        XCTAssertFalse(FileFormat.svg.isPhotoLibraryCompatible)
    }
}

final class RecentDesignsStoreTests: XCTestCase {
    func testSaveLoadAndPruneThumbnails() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("recent-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = RecentDesignsStore(directory: directory)
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let file = RecentDesignsStore.thumbnailFileName(designId: "abc/123", version: date)
        XCTAssertEqual(file, "thumb-abc123-1700000000000.img")
        try store.writeThumbnail(Data([1, 2, 3]), file: file)
        try store.writeThumbnail(Data([4]), file: "thumb-old-1.img")
        let appURL = URL(string: "https://app.desyn.app")!
        let design = RecentDesign(id: "d1", name: "Poster", kind: "poster", kindLabel: "Poster", width: 1080, height: 1350, pageCount: 1, updatedAt: date, thumbnailFile: file)
        try store.save(RecentDesignsSnapshot(ownerName: "Sami", signedIn: true, designs: [design], savedAt: date, appURL: appURL))
        let loaded = try XCTUnwrap(store.load())
        XCTAssertEqual(loaded.designs, [design])
        XCTAssertEqual(loaded.link(for: "d1").absoluteString, "https://app.desyn.app/design/d1")
        XCTAssertEqual(store.thumbnailData(file), Data([1, 2, 3]))
        XCTAssertNil(store.thumbnailData("thumb-old-1.img"))
        store.clear(appURL: appURL)
        XCTAssertEqual(store.load()?.designs, [])
        XCTAssertFalse(store.hasThumbnail(file))
    }
}
