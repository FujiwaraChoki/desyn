import { applyTransaction, getNode } from "@desyn/doc-ops";
import {
  createText,
  DescriptionSchema,
  type Design,
  defaultTextStyle,
  newId,
  type Op,
  type TextNode,
} from "@desyn/schema";
import { describe, expect, it } from "vitest";
import { brandOps } from "../src/design/brand";
import { describeDesign } from "../src/design/describe";
import { collectTexts, relayoutTranslations, translateTexts } from "../src/design/localize";
import { fitFontSize, lineWidth, measureText, wrapLines } from "../src/design/measure";
import { decodePng } from "../src/design/raster";
import { reflowPage } from "../src/design/reflow";
import type { BrandKit } from "../src/host";
import { MemoryHost } from "../src/memory-host";
import { sampleDesign, scriptedTextModel, solidPng } from "./helpers";

function apply(design: Design, ops: Op[]): Design {
  return applyTransaction(design, { id: newId(), label: "t", ops, source: "user", ts: 0 }).design;
}

describe("measure", () => {
  it("estimates widths, wraps and fits text", () => {
    const style = defaultTextStyle({ fontSize: 20 });
    expect(lineWidth("MMMM", style)).toBeGreaterThan(lineWidth("iiii", style) * 2);
    expect(lineWidth("abc", { ...style, textCase: "upper" })).toBeGreaterThan(
      lineWidth("abc", style),
    );
    const lines = wrapLines("The quick brown fox jumps over the lazy dog", style, 120);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((l) => lineWidth(l, style) <= 121)).toBe(true);
    const m = measureText({
      text: [{ text: "a\nb" }],
      style,
      paragraph: {
        align: "left",
        direction: "auto",
        lineHeight: { unit: "percent", value: 150 },
        spacing: 10,
        indent: 0,
        list: "none",
      },
    });
    expect(m).toMatchObject({ lines: 2, h: 70 });
    const size = fitFontSize(
      "A fairly long headline that must fit",
      style,
      {
        align: "left",
        direction: "auto",
        lineHeight: { unit: "auto", value: 0 },
        spacing: 0,
        indent: 0,
        list: "none",
      },
      { width: 200, height: 60 },
      { max: 48 },
    );
    expect(size).toBeLessThan(48);
    expect(size).toBeGreaterThan(8);
  });
});

describe("describe", () => {
  it("produces a schema-valid description with hierarchy, palette and fonts", () => {
    const { design, ids } = sampleDesign();
    const desc = describeDesign(design, { selection: [ids.headline, "missing"] });
    expect(DescriptionSchema.safeParse(desc).success).toBe(true);
    expect(desc.selection).toEqual([ids.headline]);
    expect(desc.tree.map((n) => n.id)).toEqual([
      ids.bg,
      ids.photo,
      ids.headline,
      ids.body,
      ids.logo,
    ]);
    expect(desc.tree.find((n) => n.id === ids.headline)?.font).toMatchObject({
      family: "Inter",
      size: 64,
      color: "#1a1a1a",
    });
    expect(desc.hierarchy[0]?.id).toBe(ids.photo);
    expect(desc.palette[0]?.color).toBe("#f5efe6");
    expect(desc.fonts).toEqual([{ family: "Inter", weights: [400, 700], usedBy: 2 }]);
    expect(desc.typography).toMatchObject({ headlineSize: 64, bodySize: 30 });
    expect(desc.grid.margins.l).toBe(80);
    expect(desc.issues.some((i) => i.code === "missing-alt" && i.ids.includes(ids.photo))).toBe(
      true,
    );
  });

  it("flags contrast, tiny text, overflow, off-page and overlaps with fixes", () => {
    const { design, pageId, ids } = sampleDesign();
    const grey = createText({
      id: newId(),
      name: "Fine print",
      text: "Terms apply",
      x: 80,
      y: 900,
      width: 300,
      height: 12,
      style: defaultTextStyle({ fontSize: 10, fills: [{ type: "solid", color: "#e9e4dc" }] }),
    });
    const fixed = createText({
      id: newId(),
      name: "Fixed",
      text: "A long paragraph that cannot fit inside a tiny fixed box at all",
      x: 600,
      y: 900,
      width: 120,
      height: 20,
      autoResize: "none",
      style: defaultTextStyle({ fontSize: 24 }),
    });
    const away = createText({
      id: newId(),
      name: "Away",
      text: "Lost",
      x: 2000,
      y: 2000,
      width: 100,
      height: 30,
    });
    const d = apply(design, [
      { op: "create", nodes: [grey], parent: pageId },
      { op: "create", nodes: [fixed], parent: pageId },
      { op: "create", nodes: [away], parent: pageId },
      { op: "update", id: ids.body, set: { y: 700 } },
    ]);
    const desc = describeDesign(d);
    const codes = (id: string) => desc.issues.filter((i) => i.ids.includes(id)).map((i) => i.code);
    expect(codes(grey.id)).toEqual(expect.arrayContaining(["tiny-text", "low-contrast"]));
    expect(codes(fixed.id)).toContain("text-overflow");
    expect(codes(away.id)).toContain("off-page");
    expect(codes(ids.body)).toContain("overlap");
    const contrast = desc.issues.find((i) => i.code === "low-contrast" && i.ids[0] === grey.id);
    const repaired = apply(d, contrast?.fix ?? []);
    expect(
      describeDesign(repaired).issues.some(
        (i) => i.code === "low-contrast" && i.ids[0] === grey.id,
      ),
    ).toBe(false);
  });
});

describe("MemoryHost", () => {
  it("applies transactions, keeps history and renders decodable PNG previews", async () => {
    const { design, ids, assetId } = sampleDesign();
    const host = new MemoryHost(design, {
      selection: [ids.headline],
      assetBytes: { [assetId]: { bytes: solidPng(4, 4), mime: "image/png" } },
    });
    expect(host.selection).toEqual([ids.headline]);
    const result = await host.apply({
      id: newId(),
      label: "x",
      ops: [{ op: "update", id: ids.headline, set: { x: 100 } }],
      source: "ai",
      ts: 0,
    });
    expect(result.applied).toHaveLength(1);
    expect(host.history).toHaveLength(1);
    expect((getNode(host.getDesign(), ids.headline) as TextNode).x).toBe(100);
    const render = await host.render({ maxSize: 200 });
    expect(render).toMatchObject({ mime: "image/png", width: 200, height: 200 });
    const px = await decodePng(render.bytes);
    // Top-left corner shows the background color #f5efe6.
    expect(Array.from(px.data.slice(0, 3))).toEqual([245, 239, 230]);
    // The photo placeholder covers the middle of the upper half.
    const mid = (60 * 200 + 100) * 4;
    expect(Array.from(px.data.slice(mid, mid + 3))).toEqual([154, 150, 142]);
    const [m] = await host.measure([
      {
        text: [{ text: "Hello" }],
        style: defaultTextStyle({ fontSize: 40 }),
        paragraph: (getNode(design, ids.headline) as TextNode).paragraph,
      },
    ]);
    expect(m?.lines).toBe(1);
    const uploaded = await host.assets.upload(solidPng(10, 20), "image/png", { name: "x" });
    expect(uploaded).toMatchObject({ kind: "image", width: 10, height: 20, mime: "image/png" });
    expect((await host.assets.read(uploaded.id)).bytes.length).toBeGreaterThan(0);
    await expect(host.assets.read("nope")).rejects.toThrow();
  });
});

describe("reflow", () => {
  it("restacks a side-by-side layout when going landscape -> portrait", async () => {
    const { design, pageId, ids } = sampleDesign();
    // Make it a landscape banner with photo left, text right.
    const d = apply(design, [
      { op: "update", id: pageId, set: { width: 1600, height: 900 } },
      { op: "update", id: ids.bg, set: { width: 1600, height: 900 } },
      { op: "update", id: ids.photo, set: { x: 80, y: 80, width: 700, height: 740 } },
      { op: "update", id: ids.headline, set: { x: 860, y: 300, width: 660 } },
      { op: "update", id: ids.body, set: { x: 860, y: 420, width: 660 } },
      { op: "update", id: ids.logo, set: { x: 860, y: 600 } },
    ]);
    const host = new MemoryHost(d);
    const r = await reflowPage(
      d,
      pageId,
      { width: 1080, height: 1920 },
      { measure: (items) => host.measure(items) },
    );
    expect(r.layout).toBe("restacked-vertical");
    const out = apply(d, r.ops);
    const photo = getNode(out, ids.photo);
    const headline = getNode(out, ids.headline);
    const bg = getNode(out, ids.bg);
    expect(bg).toMatchObject({ x: 0, y: 0, width: 1080, height: 1920 });
    expect((photo?.y ?? 0) + (photo?.height ?? 0)).toBeLessThanOrEqual((headline?.y ?? 0) + 1);
    for (const id of [ids.photo, ids.headline, ids.body, ids.logo]) {
      const n = getNode(out, id);
      expect(n && n.x >= 0 && n.x + n.width <= 1080.5 && n.y >= 0 && n.y + n.height <= 1920.5).toBe(
        true,
      );
    }
  });

  it("keeps corner-anchored elements in their corners and honours constraints", async () => {
    const { design, pageId, ids } = sampleDesign();
    const d = apply(design, [
      { op: "update", id: ids.photo, set: { constraints: { h: "stretch", v: "top" } } },
    ]);
    const host = new MemoryHost(d);
    const r = await reflowPage(
      d,
      pageId,
      { width: 1080, height: 1350 },
      { measure: (items) => host.measure(items) },
    );
    expect(r.layout).toBe("anchored");
    const out = apply(d, r.ops);
    const logo = getNode(out, ids.logo);
    expect(logo?.x).toBe(80);
    expect(1350 - ((logo?.y ?? 0) + (logo?.height ?? 0))).toBeCloseTo(72, 0);
    expect(getNode(out, ids.photo)?.y).toBe(80);
  });
});

describe("brand mapping", () => {
  const brand: BrandKit = {
    id: "brand_1",
    name: "Sunrise",
    colors: [
      { value: "#0a0a0a", role: "background" },
      { value: "#ffb02e", role: "accent" },
      { value: "#ededed", role: "text" },
      { value: "#1f1f1f", role: "surface" },
    ],
    fonts: [
      { family: "Instrument Serif", role: "heading" },
      { family: "Instrument Sans", role: "body" },
    ],
    logos: [{ assetId: "logoasset001", variant: "light", width: 300, height: 100 }],
  };

  it("maps colors, swaps fonts, replaces logos and repairs contrast", () => {
    const { design, ids } = sampleDesign();
    const report = brandOps(design, brand);
    const out = apply(design, report.ops);
    expect(report.colorMap["#f5efe6"]).toBeDefined();
    const headline = getNode(out, ids.headline) as TextNode;
    expect(headline.style.fontFamily).toBe("Instrument Serif");
    expect((getNode(out, ids.body) as TextNode).style.fontFamily).toBe("Instrument Sans");
    expect(getNode(out, ids.logo)).toMatchObject({ assetId: "logoasset001" });
    expect(out.brandKitId).toBe("brand_1");
    const issues = describeDesign(out).issues.filter((i) => i.code === "low-contrast");
    expect(issues).toEqual([]);
  });
});

describe("localization", () => {
  it("translates with budgets, shrinks to fit and mirrors RTL", async () => {
    const { design, pageId, ids } = sampleDesign();
    const items = collectTexts(design, { rootId: pageId });
    expect(items.map((i) => i.id)).toEqual([ids.headline, ids.body]);
    expect(items[0]?.maxChars).toBe(Math.ceil("Spring collection is here".length * 1.15));
    const model = scriptedTextModel([
      {
        items: [
          { id: ids.headline, text: "مجموعة الربيع وصلت الآن أخيرا وبكل الألوان" },
          { id: ids.body, text: "أنماط جديدة" },
        ],
      },
    ]);
    const translations = await translateTexts(model, items, "ar");
    expect(translations.size).toBe(2);
    const host = new MemoryHost(design);
    const page = getNode(design, pageId);
    if (page?.type !== "page") throw new Error("no page");
    const report = await relayoutTranslations(host, design, page, translations, { locale: "ar" });
    const out = apply(design, report.ops);
    const headline = getNode(out, ids.headline) as TextNode;
    expect(headline.paragraph).toMatchObject({ direction: "rtl", align: "right" });
    expect(headline.style.fontFamily).toBe("Noto Sans Arabic");
    expect(report.fontSwaps).toContain(ids.headline);
    expect(report.mirrored).toContain(ids.logo);
    expect(getNode(out, ids.logo)?.x).toBe(1080 - 80 - 160);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("untrusted");
  });
});
