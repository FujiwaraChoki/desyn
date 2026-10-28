import { applyTransaction, makeTransaction, pages } from "@desyn/doc-ops";
import {
  type AssetRef,
  createDesign,
  createImage,
  createText,
  type Design,
  type Id,
  type Node,
  validateDesign,
} from "@desyn/schema";
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import {
  assetEntryName,
  parseDesignFile,
  parseDesignJson,
} from "../../src/export/import/desyn-file.ts";
import { mergeDesignPages, remapAssetRefs } from "../../src/export/import/merge.ts";
import { parsePptx, resolveTarget } from "../../src/export/import/pptx.ts";
import { pptxToOps } from "../../src/export/import/pptx-design.ts";
import { importKindOf } from "../../src/export/import/run.ts";
import { pageIdOf, withNodes } from "../collab/fixtures.ts";
import { PNG, samplePptx } from "./pptx-sample.ts";

/** A two-page design with an image on page 1, a link from page 2 to page 1 and a named color. */
function sourceDesign(): Design {
  let d = createDesign("presentation");
  const p1 = pageIdOf(d);
  const p2 = "page2page2pp";
  const root = d.nodes.root as Node & { children: Id[] };
  const page2 = { ...(d.nodes[p1] as Node), id: p2, name: "Second", children: [] } as Node;
  d = {
    ...d,
    nodes: { ...d.nodes, root: { ...root, children: [p1, p2] } as Node, [p2]: page2 },
    assets: {
      img000000001: { id: "img000000001", kind: "image", mime: "image/png", width: 4, height: 4 },
    },
    styles: {
      ...d.styles,
      colors: { col000000001: { name: "Sun", value: "#ffb02e" } },
      variables: { "brand.primary": "#ffb02e" },
    },
  };
  const img = createImage({ parent: p1, assetId: "img000000001", name: "Photo" });
  const text = createText({ parent: p2, text: "Back", link: `page:${p1}` });
  d = withNodes(d, p1, [img]);
  d = withNodes(d, p2, [text]);
  return d;
}

describe("design files", () => {
  test("JSON and wrapped JSON parse; invalid designs explain why", () => {
    const d = sourceDesign();
    expect(parseDesignJson(JSON.stringify(d)).design.id).toBe(d.id);
    expect(parseDesignJson(JSON.stringify({ design: d })).design.id).toBe(d.id);
    expect(() => parseDesignJson("{")).toThrow(/not valid JSON/);
    expect(() => parseDesignJson(JSON.stringify({ schema: 2 }))).toThrow(/not a Desyn design/);
  });

  test(".desyn archives yield the design and asset bytes", () => {
    const d = sourceDesign();
    const zip = zipSync({
      mimetype: strToU8("application/x-desyn"),
      "manifest.json": strToU8("{}"),
      "design.json": strToU8(JSON.stringify(d)),
      [assetEntryName("img000000001", "image/png")]: PNG,
    });
    const parsed = parseDesignFile(zip);
    expect(parsed.design.name).toBe(d.name);
    expect(parsed.assets.get("img000000001")?.bytes).toEqual(PNG);
    expect(assetEntryName("x", "image/jpeg")).toBe("assets/x.jpg");
    expect(() => parseDesignFile(zipSync({ "other.txt": strToU8("hi") }))).toThrow(
      /no design.json/,
    );
  });

  test("merging appends pages with fresh ids, remapped links, assets and missing styles", () => {
    const source = sourceDesign();
    const target = createDesign("presentation");
    const uploaded: AssetRef = {
      id: "newasset0001",
      kind: "image",
      mime: "image/png",
      storageKey: "uploads/w/x.png",
    };
    let n = 0;
    const merged = mergeDesignPages(source, target, {
      assets: new Map([["img000000001", uploaded]]),
      newIds: () => `new${String(++n).padStart(9, "0")}`,
    });
    expect(merged.missingAssets).toEqual([]);
    const result = applyTransaction(target, makeTransaction(merged.ops, "Import"));
    expect(result.dropped).toEqual([]);
    const after = result.design;
    expect(validateDesign(after).ok).toBe(true);
    expect(pages(after).map((p) => p.id)).toEqual([pageIdOf(target), ...merged.pageIds]);
    const imported = Object.values(after.nodes);
    const img = imported.find((x) => x.type === "image") as Node & { assetId: string };
    expect(img.assetId).toBe("newasset0001");
    expect(after.assets.newasset0001).toEqual(uploaded);
    const text = imported.find((x) => x.type === "text") as Node & { link: string };
    expect(text.link).toBe(`page:${merged.pageIds[0]}`);
    expect(after.styles.colors.col000000001?.value).toBe("#ffb02e");
    expect(after.styles.variables["brand.primary"]).toBe("#ffb02e");
    // Without re-uploaded bytes the image asset is reported missing.
    expect(mergeDesignPages(source, target).missingAssets).toEqual(["img000000001"]);
    expect(
      remapAssetRefs(
        { fills: [{ type: "image", assetId: "a" }], maskAssetId: "a" },
        new Map([["a", "b"]]),
      ),
    ).toEqual({
      fills: [{ type: "image", assetId: "b" }],
      maskAssetId: "b",
    });
  });

  test("custom fonts of an imported file come along with the pages", () => {
    const source = sourceDesign();
    source.assets.fnt000000001 = {
      id: "fnt000000001",
      kind: "font",
      mime: "font/woff2",
      family: "Brand Sans",
      weight: 700,
      storageKey: "uploads/other/brand.woff2",
    };
    const target = createDesign("presentation");
    const font: AssetRef = {
      id: "newfont00001",
      kind: "font",
      mime: "font/woff2",
      family: "Brand Sans",
      weight: 700,
      storageKey: "uploads/w/brand.woff2",
    };
    const merged = mergeDesignPages(source, target, {
      assets: new Map([["fnt000000001", font]]),
    });
    const after = applyTransaction(target, makeTransaction(merged.ops, "Import")).design;
    expect(after.assets.newfont00001).toEqual(font);
    // The foreign font ref itself is never copied (its storage key belongs to another workspace).
    expect(after.assets.fnt000000001).toBeUndefined();
  });

  test("file kinds by MIME type and extension", () => {
    expect(importKindOf({ name: "deck.PPTX", type: "" })).toBe("pptx");
    expect(importKindOf({ name: "a.pdf", type: "application/pdf" })).toBe("pdf");
    expect(importKindOf({ name: "logo.svg", type: "" })).toBe("svg");
    expect(importKindOf({ name: "photo", type: "image/jpeg" })).toBe("image");
    expect(importKindOf({ name: "x.desyn", type: "" })).toBe("design");
    expect(importKindOf({ name: "x.json", type: "application/json" })).toBe("design");
    expect(importKindOf({ name: "x.docx", type: "" })).toBeNull();
  });
});

describe("PowerPoint import", () => {
  test("relationship targets resolve relative to their part", () => {
    expect(resolveTarget("ppt/slides/slide1.xml", "../media/a.png")).toBe("ppt/media/a.png");
    expect(resolveTarget("ppt/presentation.xml", "slides/slide2.xml")).toBe(
      "ppt/slides/slide2.xml",
    );
    expect(resolveTarget("ppt/slides/slide1.xml", "/ppt/media/b.png")).toBe("ppt/media/b.png");
  });

  test("parses size, background, placeholders, shapes, lines, pictures, groups and notes", () => {
    const doc = parsePptx(samplePptx());
    expect([doc.width, doc.height]).toEqual([1280, 720]);
    expect(doc.slides).toHaveLength(1);
    const s = doc.slides[0];
    expect(s?.name).toBe("Hello deck");
    expect(s?.background).toBe("#0a0a0a");
    expect(s?.notes).toBe("Say hello\nThen smile");
    const [title, card, line, pic, group] = s?.elements ?? [];
    // The title has no position of its own: it inherits the layout placeholder's.
    expect(title).toMatchObject({
      kind: "shape",
      anchor: "middle",
      box: { x: 80, y: 40, w: 1120, h: 160 },
    });
    if (title?.kind !== "shape") throw new Error("title");
    expect(title.paragraphs).toHaveLength(1);
    expect(title.paragraphs[0]).toMatchObject({ align: "center" });
    expect(title.paragraphs[0]?.runs[0]).toMatchObject({
      text: "Hello deck",
      sizePt: 40,
      bold: true,
      color: "#ffffff",
      font: "Inter",
    });
    expect(card).toMatchObject({
      kind: "shape",
      geometry: "roundRect",
      fill: "#ffb02e80",
      stroke: { color: "#111111", widthPx: 2 },
    });
    expect(card?.box.rotation).toBe(90);
    expect(line).toMatchObject({
      kind: "line",
      stroke: { color: "#ff0000", widthPx: 3 },
      box: { flipV: true },
    });
    expect(pic).toMatchObject({
      kind: "picture",
      media: "ppt/media/image1.png",
      alt: "A sunset",
      crop: { l: 0.1, r: 0.1, t: 0, b: 0 },
    });
    // Group children are mapped from the child space (400 x 200) into the group box (200 x 100).
    expect(group).toMatchObject({ kind: "group", box: { x: 600, y: 500, w: 200, h: 100 } });
    if (group?.kind !== "group") throw new Error("group");
    expect(group.children[0]?.box).toMatchObject({ x: 100, y: 50, w: 50, h: 50 });
    expect(doc.media.get("ppt/media/image1.png")?.mime).toBe("image/png");
  });

  test("converts slides into valid pages with editable layers", () => {
    const doc = parsePptx(samplePptx());
    const target = createDesign("presentation");
    const ref: AssetRef = { id: "pptximage001", kind: "image", mime: "image/png" };
    const { ops, pageIds } = pptxToOps(doc, new Map([["ppt/media/image1.png", ref]]), 1);
    const result = applyTransaction(target, makeTransaction(ops, "Import"));
    expect(result.dropped).toEqual([]);
    expect(validateDesign(result.design).ok).toBe(true);
    const page = result.design.nodes[pageIds[0] as Id] as Node & {
      children: Id[];
      notes?: string;
      background: unknown;
    };
    expect(page).toMatchObject({ width: 1280, height: 720, notes: "Say hello\nThen smile" });
    expect(page.background).toEqual([{ type: "solid", color: "#0a0a0a" }]);
    const kids = page.children.map(
      (id) => result.design.nodes[id] as Node & Record<string, unknown>,
    );
    expect(kids.map((k) => k.type)).toEqual(["text", "rect", "line", "image", "group"]);
    const text = kids[0] as Node & {
      runs: { text: string }[];
      style: { fontSize: number };
      paragraph: { align: string };
    };
    expect(text.runs.map((r) => r.text).join("")).toBe("Hello deck");
    expect(text.style.fontSize).toBeCloseTo(53.33, 1);
    expect(text.paragraph.align).toBe("center");
    expect(kids[1]).toMatchObject({
      rotation: 90,
      cornerRadius: 20,
      fills: [{ type: "solid", color: "#ffb02e", opacity: 0.502 }],
    });
    expect(kids[2]).toMatchObject({ width: 500 });
    expect((kids[2]?.rotation as number) ?? 0).toBeCloseTo(-53.13, 1);
    expect(kids[3]).toMatchObject({
      assetId: "pptximage001",
      fit: "crop",
      crop: { x: 0.1, w: 0.8 },
      alt: "A sunset",
    });
    expect(result.design.assets.pptximage001).toEqual(ref);
  });

  test("rejects files that are not presentations", () => {
    expect(() => parsePptx(zipSync({ "word/document.xml": strToU8("<x/>") }))).toThrow(
      /not a PowerPoint/,
    );
  });
});
