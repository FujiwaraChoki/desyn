import { applyTransaction } from "@desyn/doc-ops";
import type { ImageNode, TextStyle } from "@desyn/schema";
import { defaultTextStyle } from "@desyn/schema";
import { describe, expect, it } from "vitest";
import { cropFor, cropOps, imageRectFor, visibleCrop } from "../../src/canvas/crop.ts";
import { dropKind, droppedUrl } from "../../src/canvas/drop.ts";
import { tickStep, unitScale } from "../../src/canvas/rulers.tsx";
import {
  htmlToRuns,
  parseRunsPayload,
  runsToHtml,
  sliceRuns,
} from "../../src/canvas/text/rich-text.ts";
import { easeOut, interpolateView } from "../../src/canvas/view-animation.ts";
import { defaultFontSize } from "../../src/tools/text.ts";
import { createDesign, createImage, makeTx } from "./fixtures.ts";

describe("rich text clipboard", () => {
  const runs = [
    { text: "Hello " },
    { text: "bold", style: { fontWeight: 700 } as Partial<TextStyle> },
    { text: " world" },
  ];

  it("slices runs by UTF-16 offsets", () => {
    expect(sliceRuns(runs, 3, 8)).toEqual([
      { text: "lo " },
      { text: "bo", style: { fontWeight: 700 } },
    ]);
  });

  it("writes styled HTML", () => {
    const html = runsToHtml(runs, defaultTextStyle({ fontFamily: "Inter" }));
    expect(html).toContain("font-weight:700");
    expect(html).toContain("font-family:'Inter'");
    expect(html).toContain(">bold</span>");
  });

  it("reads emphasis from foreign HTML only", () => {
    const pasted = htmlToRuns(
      '<p>One <b>two</b> <span style="font-style:italic;color:red;font-size:40px">three</span></p><p><s>four</s></p>',
    );
    expect(pasted).toEqual([
      { text: "One ", style: {} },
      { text: "two", style: { fontWeight: 700 } },
      { text: " ", style: {} },
      { text: "three", style: { fontStyle: "italic" } },
      { text: "\n", style: {} },
      { text: "four", style: { decoration: "strikethrough" } },
    ]);
  });

  it("parses the Desyn runs flavour and rejects garbage", () => {
    expect(parseRunsPayload(JSON.stringify([{ text: "a", style: { fontSize: 12 } }]))).toEqual([
      { text: "a", style: { fontSize: 12 } },
    ]);
    expect(parseRunsPayload("{")).toBeNull();
    expect(parseRunsPayload(JSON.stringify([{ nope: 1 }]))).toBeNull();
  });

  it("keeps only valid, known style keys from a pasted runs payload", () => {
    const payload = JSON.stringify([
      { text: "a", style: { fontWeight: 700, evil: "x", __proto__: { polluted: true } } },
      { text: "b", style: { fontSize: "huge" } },
      { text: "c", style: [1, 2] },
    ]);
    expect(parseRunsPayload(payload)).toEqual([
      { text: "a", style: { fontWeight: 700 } },
      { text: "b", style: {} },
      { text: "c", style: {} },
    ]);
  });

  it("sizes new text for the page", () => {
    expect(defaultFontSize(1080, 1080)).toBe(60);
    expect(defaultFontSize(200, 100)).toBe(16);
    expect(defaultFontSize(5000, 5000)).toBe(120);
  });
});

describe("crop", () => {
  it("derives the visible part of a filled image", () => {
    const node = createImage({ assetId: "aaaaaaaaaaaa", width: 100, height: 100, fit: "fill" });
    // A 200×100 source fills a square box by cropping the sides.
    expect(visibleCrop(node, 200, 100)).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
    const cropped = { ...node, fit: "crop", crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } } as ImageNode;
    expect(visibleCrop(cropped, 200, 100)).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
  });

  it("round-trips crop rectangles through the image rect", () => {
    const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.25 };
    const image = imageRectFor(100, 50, crop);
    expect(cropFor({ x: 0, y: 0, w: 100, h: 50 }, image)).toEqual(crop);
  });

  it("moves and resizes the layer when the frame changes", () => {
    const { design, page } = createDesign();
    const img = createImage({
      assetId: "aaaaaaaaaaaa",
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      fit: "fill",
    });
    let d = applyTransaction(design, makeTx([{ op: "create", nodes: [img], parent: page }])).design;
    const image = { x: 0, y: -50, w: 200, h: 200 };
    d = applyTransaction(
      d,
      makeTx(cropOps(d, img.id, { x: 50, y: 0, w: 100, h: 100 }, image)),
    ).design;
    const n = d.nodes[img.id] as ImageNode;
    expect(n.x).toBeCloseTo(150);
    expect(n.width).toBeCloseTo(100);
    expect(n.fit).toBe("crop");
    expect(n.crop).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  });
});

describe("drag and drop", () => {
  it("classifies drags by their types", () => {
    expect(dropKind(["Files"])).toBe("files");
    expect(dropKind(["text/uri-list", "text/plain"])).toBe("url");
    expect(dropKind(["text/plain"])).toBe("text");
    expect(dropKind(["application/x-other"])).toBeNull();
  });

  it("prefers the dragged image over the page link", () => {
    expect(
      droppedUrl(
        "https://example.com/page",
        '<a href="/x"><img src="https://cdn.example.com/a.jpg"></a>',
      ),
    ).toBe("https://cdn.example.com/a.jpg");
    expect(droppedUrl("# comment\nhttps://example.com/b.png", "")).toBe(
      "https://example.com/b.png",
    );
    expect(droppedUrl("javascript:alert(1)", "")).toBeNull();
  });
});

describe("view animation and rulers", () => {
  it("eases out between 0 and 1", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.25)).toBeGreaterThan(0.5);
  });

  it("keeps the anchored point still while zooming", () => {
    // Zooming 1 -> 4 about screen point (200, 100): page point (200, 100) must stay under it.
    const from = { x: 0, y: 0, zoom: 1 };
    const to = { x: 150, y: 75, zoom: 4 };
    for (const t of [0.1, 0.5, 0.9]) {
      const v = interpolateView(from, to, t);
      expect(v.x + 200 / v.zoom).toBeCloseTo(200, 6);
      expect(v.y + 100 / v.zoom).toBeCloseTo(100, 6);
    }
  });

  it("picks readable ruler steps per unit", () => {
    expect(tickStep(1, 1)).toBe(100);
    expect(tickStep(10, 1)).toBe(10);
    expect(tickStep(0.1, 1)).toBe(1000);
    expect(unitScale({ unit: "in" } as never)).toBe(96);
    expect(tickStep(1, 96)).toBe(1);
  });
});
