import CoreGraphics
import Foundation
#if canImport(Metal)
import Metal
#endif
import Testing

import DesynEngine

/// A 400x300 page with a gray card (`recta0000001`) and a wrapping text box (`text00000001`).
let designJSON = #"""
{
  "assets": {},
  "id": "design000001",
  "kind": "social-post",
  "meta": {},
  "name": "Swift test",
  "nodes": {
    "page00000001": {
      "background": [
        {
          "color": "#ffffff",
          "type": "solid"
        }
      ],
      "bleed": 0,
      "blend": "normal",
      "children": [
        "recta0000001",
        "text00000001"
      ],
      "clip": true,
      "effects": [],
      "height": 300,
      "id": "page00000001",
      "locked": false,
      "name": "Page 1",
      "opacity": 1,
      "parent": "root",
      "rotation": 0,
      "type": "page",
      "unit": "px",
      "visible": true,
      "width": 400,
      "x": 0,
      "y": 0
    },
    "recta0000001": {
      "blend": "normal",
      "cornerRadius": 0,
      "effects": [],
      "fills": [
        {
          "color": "#d9d9d9",
          "type": "solid"
        }
      ],
      "height": 50,
      "id": "recta0000001",
      "locked": false,
      "name": "Card",
      "opacity": 1,
      "parent": "page00000001",
      "rotation": 0,
      "strokes": [],
      "type": "rect",
      "visible": true,
      "width": 100,
      "x": 20,
      "y": 20
    },
    "root": {
      "blend": "normal",
      "children": [
        "page00000001"
      ],
      "effects": [],
      "height": 0,
      "id": "root",
      "locked": false,
      "name": "Root",
      "opacity": 1,
      "parent": null,
      "rotation": 0,
      "type": "root",
      "visible": true,
      "width": 0,
      "x": 0,
      "y": 0
    },
    "text00000001": {
      "autoResize": "height",
      "blend": "normal",
      "effects": [],
      "height": 29,
      "id": "text00000001",
      "locked": false,
      "name": "Hello 👋",
      "opacity": 1,
      "paragraph": {
        "align": "left",
        "direction": "auto",
        "indent": 0,
        "lineHeight": {
          "unit": "percent",
          "value": 120
        },
        "list": "none",
        "spacing": 0
      },
      "parent": "page00000001",
      "rotation": 0,
      "runs": [
        {
          "text": "Hello 👋"
        }
      ],
      "style": {
        "decoration": "none",
        "fills": [
          {
            "color": "#111111",
            "type": "solid"
          }
        ],
        "fontFamily": "Inter",
        "fontSize": 24,
        "fontStyle": "normal",
        "fontWeight": 400,
        "letterSpacing": 0,
        "textCase": "none"
      },
      "type": "text",
      "verticalAlign": "top",
      "visible": true,
      "width": 150,
      "x": 200,
      "y": 40
    }
  },
  "schema": 1,
  "styles": {
    "colors": {},
    "effects": {},
    "text": {},
    "variables": {}
  }
}
"""#

private func viewport(_ w: UInt32 = 400, _ h: UInt32 = 300, zoom: Double = 1) -> Viewport {
    Viewport(x: 0, y: 0, zoom: zoom, width: w, height: h, deviceScale: 1)
}

private func loadedEngine() async throws -> DesynEngine {
    let engine = DesynEngine()
    let result = try await engine.load(designJSON: designJSON)
    #expect(result.pages.map(\.id) == ["page00000001"])
    return engine
}

@Suite("DesynEngine")
struct DesynEngineTests {
    @Test func versionIsReported() {
        #expect(!DesynEngine.version.isEmpty)
    }

    @Test func loadsRendersAndMakesAnImage() async throws {
        let engine = try await loadedEngine()
        let frame = try await engine.render(RenderRequest(viewport: viewport(), background: "#202020"))
        #expect(frame.width == 400 && frame.height == 300 && frame.stride == 1600)
        #expect(frame.pixels.count == 400 * 300 * 4)
        #expect(frame.info.full && frame.info.sequence == 1)
        // Inside the gray card (#d9d9d9, opaque).
        let i = (40 * 400 + 60) * 4
        #expect(Array(frame.pixels[i..<i + 4]) == [0xd9, 0xd9, 0xd9, 0xff])
        #if !os(Linux) // the Linux harness (scripts/build-ios-engine.sh --swift-linux) has no CoreGraphics images
        let image = try #require(frame.makeCGImage())
        #expect(image.width == 400 && image.height == 300)
        #expect(image.alphaInfo == .premultipliedLast)
        #endif
    }

    @Test func appliesTransactionsAndRendersDamage() async throws {
        let engine = try await loadedEngine()
        _ = try await engine.render(RenderRequest(viewport: viewport()))
        let (outcome, tx) = try await engine.apply(
            opsJSON: #"[{"op":"update","id":"recta0000001","set":{"x":60}}]"#,
            label: "Move card"
        )
        #expect(outcome.dropped.isEmpty)
        #expect(tx.contains(#""label":"Move card""#))
        let frame = try await engine.render(RenderRequest(viewport: viewport()))
        #expect(!frame.info.full)
        #expect(!frame.info.damage.isEmpty)
        // Undo restores the original pixels.
        try await engine.apply(transactionJSON: outcome.inverseJson, normalize: false)
        let undone = try await engine.render(RenderRequest(viewport: viewport(), fullRedraw: true))
        let original = try await DesynEngine().renderOnce()
        #expect(undone.pixels == original.pixels)
    }

    @Test func rendersIntoAFrameBuffer() async throws {
        let engine = try await loadedEngine()
        let buffer = FrameBuffer(width: 200, height: 150)
        #expect(buffer.bytesPerRow == 832)
        let first = try await engine.render(RenderRequest(viewport: viewport(200, 150, zoom: 0.5)), into: buffer)
        #expect(first.full)
        let reference = try await engine.render(RenderRequest(viewport: viewport(200, 150, zoom: 0.5)))
        buffer.withPixels { raw in
            for y in 0..<150 {
                let row = Array(raw[(y * 832)..<(y * 832 + 800)])
                #expect(row == Array(reference.pixels[(y * 800)..<((y + 1) * 800)]))
            }
        }
        #if !os(Linux)
        #expect(buffer.makeCGImage()?.bytesPerRow == 832)
        #endif
        await #expect(throws: EngineError.self) {
            try await engine.render(RenderRequest(viewport: viewport(10, 10)), into: buffer)
        }
    }

    @Test func picksHandlesAndTransformsSelections() async throws {
        let engine = try await loadedEngine()
        #expect(try await engine.hitTest(DesignPoint(x: 30, y: 30)) == "recta0000001")
        #expect(try await engine.hitTest(DesignPoint(x: 390, y: 290)) == nil)
        #expect(try await engine.marquee(DesignRect(x: 0, y: 0, width: 150, height: 100), mode: .contain) == ["recta0000001"])
        let ids = ["recta0000001"]
        let bounds = try #require(try await engine.selectionBounds(ids))
        let handles = try #require(try await engine.handles(for: ids, zoom: 1))
        #expect(handles.resize.count == 8)
        let resized = resizeBox(
            bounds: bounds.obb,
            handle: .bottomRight,
            pointer: DesignPoint(x: 170, y: 120),
            options: ResizeOptions()
        )
        let ops = try await engine.transformOps(for: ids, from: bounds.obb, to: resized.bounds)
        try await engine.apply(opsJSON: ops, label: "Resize")
        let after = try #require(try await engine.bounds(of: "recta0000001"))
        #expect(after.width == 150 && after.height == 100)
        let snap = try await engine.snapMove(DesignRect(x: 153, y: 40, width: 100, height: 50), excluding: ids)
        #expect(abs(snap.dx + 3) < 1e-9)
    }

    @Test func previewsGesturesAndCommitsOnPointerUp() async throws {
        let engine = try await loadedEngine()
        let ids = ["recta0000001"]
        let start = try #require(try await engine.selectionBounds(ids)).obb
        // Two drag steps: each is computed against the committed state and replaces the previous preview.
        for pointer in [DesignPoint(x: 140, y: 90), DesignPoint(x: 170, y: 120)] {
            let to = resizeBox(bounds: start, handle: .bottomRight, pointer: pointer, options: ResizeOptions())
            let ops = try await engine.transformOps(for: ids, from: start, to: to.bounds)
            try await engine.preview(opsJSON: ops, label: "Resize")
        }
        #expect(await engine.hasPreview)
        let previewed = try #require(try await engine.bounds(of: "recta0000001"))
        #expect(previewed.width == 150 && previewed.height == 100)
        let committed = try #require(await engine.commitPreview())
        #expect(committed.dropped.isEmpty)
        #expect(await !engine.hasPreview)
        // Undo with the inverse, then a cancelled gesture leaves the design untouched.
        try await engine.apply(transactionJSON: committed.inverseJson, normalize: false)
        try await engine.preview(opsJSON: #"[{"op":"update","id":"recta0000001","set":{"x":90}}]"#, label: "Move")
        #expect(await engine.cancelPreview())
        let after = try #require(try await engine.bounds(of: "recta0000001"))
        #expect(after.width == 100 && after.transform.tx == 20)
    }

    @Test func convertsTextToOutlines() async throws {
        let engine = try await loadedEngine()
        let outline = try await engine.textOutline("text00000001")
        #expect(outline.d.hasPrefix("M"))
        #expect(outline.fillRule == "nonzero")
        #expect((outline.bounds?.width ?? 0) > 20)
    }

    @Test func textGeometryUsesUTF16Offsets() async throws {
        let engine = try await loadedEngine()
        let layout = try await engine.textLayout("text00000001")
        #expect(layout.text == "Hello 👋")
        #expect(layout.length == UInt32(("Hello 👋" as NSString).length))
        let wave = UInt32(("Hello " as NSString).length)
        let next = try await engine.move(
            TextPosition(index: wave, affinity: .downstream),
            in: "text00000001",
            by: .graphemeForward
        )
        #expect(next.index == wave + 2)
        let caret = try await engine.caret(in: "text00000001", at: TextPosition(index: 0, affinity: .downstream))
        #expect(caret.height > 0)
    }

    @Test func describesAndExports() async throws {
        let engine = try await loadedEngine()
        let description = try await engine.describe()
        let object = try #require(try JSONSerialization.jsonObject(with: Data(description.utf8)) as? [String: Any])
        #expect(object["tree"] is [Any])
        let png = try await engine.export(ExportRequest(format: .png, pages: .first, background: .page))
        #expect(png.bytes.starts(with: [0x89, 0x50, 0x4e, 0x47]))
        #expect(png.fileName("card") == "card.png")
        let pdf = try await engine.export(ExportRequest(format: .pdf, pages: .all, background: .page))
        #expect(pdf.bytes.starts(with: Array("%PDF".utf8)))
    }

    @Test func reportsErrors() async throws {
        let engine = DesynEngine()
        await #expect(throws: EngineError.NoDesign) {
            try await engine.render(RenderRequest(viewport: viewport()))
        }
        do {
            try await engine.load(designJSON: "{")
            Issue.record("invalid JSON must throw")
        } catch let error as EngineError {
            #expect(error.message.hasPrefix("Invalid JSON"))
        }
    }

    #if canImport(Metal)
    @Test func uploadsFramesToMetal() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else { return }
        let engine = try await loadedEngine()
        let texture = MetalFrameTexture(device: device)
        let first = try await engine.render(RenderRequest(viewport: viewport()))
        #expect(texture.update(with: first).count == 1)
        #expect(texture.texture?.width == 400)
        try await engine.apply(opsJSON: #"[{"op":"update","id":"recta0000001","set":{"y":30}}]"#, label: "Nudge")
        let second = try await engine.render(RenderRequest(viewport: viewport()))
        let uploaded = texture.update(with: second)
        #expect(uploaded == second.info.damage)
        #expect(texture.sequence == second.info.sequence)
        // Same frame twice: nothing to upload.
        #expect(texture.update(with: second).isEmpty)
    }
    #endif
}

@Suite("Helpers")
struct HelperTests {
    @Test func idsMatchTheContract() {
        let id = DesynTransaction.newID()
        #expect(id.count == 12)
        #expect(id.allSatisfy { $0.isLowercase || $0.isNumber })
        #expect(DesynTransaction.newID() != id)
    }

    @Test func transactionsEmbedOpsVerbatim() throws {
        let json = try DesynTransaction.json(
            opsJSON: #"[{"op":"delete","id":"recta0000001"}]"#,
            label: "Delete",
            source: .ai,
            id: "txtest000001",
            actor: ["runId": "run1"],
            timestamp: Date(timeIntervalSince1970: 1)
        )
        let object = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        #expect(object["id"] as? String == "txtest000001")
        #expect(object["source"] as? String == "ai")
        #expect(object["ts"] as? Int == 1000)
        #expect((object["ops"] as? [Any])?.count == 1)
        #expect(throws: EngineError.self) {
            try DesynTransaction.json(opsJSON: "{}", label: "x")
        }
    }

    @Test func viewportMapsBetweenViewAndPage() {
        let fit = Viewport.fitting(pageWidth: 1080, pageHeight: 1080, in: CGSize(width: 400, height: 800), scale: 3, inset: 20)
        #expect(abs(fit.zoom - 360.0 / 1080.0) < 1e-9)
        #expect(fit.width == 1200 && fit.height == 2400)
        let center = fit.pagePoint(fromView: CGPoint(x: 200, y: 400))
        #expect(abs(center.x - 540) < 1e-9 && abs(center.y - 540) < 1e-9)
        let back = fit.viewPoint(fromPage: center)
        #expect(abs(back.x - 200) < 1e-9 && abs(back.y - 400) < 1e-9)
        let zoomed = fit.zoomed(by: 2, anchor: CGPoint(x: 100, y: 100))
        let anchor = zoomed.pagePoint(fromView: CGPoint(x: 100, y: 100))
        let before = fit.pagePoint(fromView: CGPoint(x: 100, y: 100))
        #expect(abs(anchor.x - before.x) < 1e-9 && abs(anchor.y - before.y) < 1e-9)
    }

    @Test func affineMatchesCoreGraphics() {
        let t = Affine(CGAffineTransform(rotationAngle: .pi / 2).translatedBy(x: 10, y: 0))
        let p = t.apply(DesignPoint(x: 1, y: 0))
        let q = CGPoint(x: 1, y: 0).applying(t.cgAffineTransform)
        #expect(abs(p.x - q.x) < 1e-9 && abs(p.y - q.y) < 1e-9)
        let round = t.inverted.apply(p)
        #expect(abs(round.x - 1) < 1e-9 && abs(round.y) < 1e-9)
        let box = OrientedBox(DesignRect(x: 10, y: 20, width: 30, height: 40))
        #expect(box.corners[2] == DesignPoint(x: 40, y: 60))
        #expect(box.corners == boxCorners(bounds: box))
    }
}

private extension DesynEngine {
    /// The untouched test design rendered once.
    func renderOnce() async throws -> RenderedFrame {
        try load(designJSON: designJSON)
        return try render(RenderRequest(viewport: Viewport(x: 0, y: 0, zoom: 1, width: 400, height: 300, deviceScale: 1)))
    }
}
