import { applyTransaction, makeTransaction, pages } from "@desyn/doc-ops";
import {
  createDesign,
  createFrame,
  createGroup,
  createImage,
  createPath,
  createRect,
  createText,
  type Design,
  defaultTextStyle,
  type Id,
  type Node,
  type Op,
  type TextNode,
  validateDesign,
  validateNode,
} from "@desyn/schema";
import { describe, expect, test } from "vitest";
import {
  applyBrandTransaction,
  brandColorMap,
  headingThreshold,
} from "../../src/panels/lib/brand-apply.ts";
import {
  CHART_TYPES,
  FRAMES,
  GRIDS,
  LINES,
  newChart,
  newQr,
  newTable,
  pairingBlock,
  SHAPES,
  TEXT_EFFECTS,
  TEXT_PRESETS,
  textFromPreset,
} from "../../src/panels/lib/catalog.ts";
import { positionOps, rotationOps, sizeOps } from "../../src/panels/lib/geometry.ts";
import { centeredBox, fitToPage, insertOps } from "../../src/panels/lib/insert.ts";
import { filterTree, layerTree, moveLayersTransaction } from "../../src/panels/lib/layers-model.ts";
import { common, updateEach } from "../../src/panels/lib/ops.ts";
import {
  documentColors,
  fillToPaint,
  paintToFill,
  resolveColor,
} from "../../src/panels/lib/paint.ts";
import {
  chartToGrid,
  gridToChart,
  parseClipboard,
  parseNumber,
  pasteInto,
} from "../../src/panels/lib/table-data.ts";
import { parseTemplateDesign, templateImportOps } from "../../src/panels/lib/template-import.ts";
import { pageIdOf, withNodes } from "../editor-helpers.ts";

function apply(design: Design, ops: Op[]): Design {
  const r = applyTransaction(design, makeTransaction(ops, "test"));
  expect(r.dropped).toEqual([]);
  return r.design;
}

function expectValid(design: Design) {
  const v = validateDesign(design);
  expect(v.errors ?? []).toEqual([]);
}

describe("catalog", () => {
  test("every element entry builds valid nodes with fresh ids", () => {
    for (const entry of [...SHAPES, ...LINES, ...FRAMES, ...GRIDS]) {
      const a = entry.build();
      const b = entry.build();
      expect(a.length).toBeGreaterThan(0);
      expect(a[0]?.id).not.toBe(b[0]?.id);
      for (const n of a) expect(validateNode(n), `${entry.id}: ${n.type}`).toEqual([]);
    }
  });

  test("elements insert into a page as valid subtrees (grids keep their cells)", () => {
    let design = createDesign("social-post");
    const page = pageIdOf(design);
    const subtrees = [...SHAPES, ...LINES, ...FRAMES, ...GRIDS].map((e) => e.build());
    design = apply(design, insertOps(design, page, subtrees));
    expectValid(design);
    const grid = Object.values(design.nodes).find(
      (n) => n.name === "Photo grid" && n.type === "frame",
    ) as Node & {
      children: Id[];
    };
    expect(grid.children.length).toBeGreaterThan(1);
  });

  test("charts, tables, QR, text presets and pairings are valid", () => {
    for (const t of CHART_TYPES) expect(validateNode(newChart(t.id))).toEqual([]);
    const table = newTable(4, 3);
    expect(validateNode(table)).toEqual([]);
    expect(table.cells).toHaveLength(12);
    expect(validateNode(newQr("https://desyn.app"))).toEqual([]);
    for (const p of TEXT_PRESETS) {
      const t = textFromPreset(p, "Inter", "#fafafa");
      expect(validateNode(t)).toEqual([]);
      expect(t.role).toBe(p.role);
    }
    const block = pairingBlock("Fraunces", 600, "Inter", 400);
    for (const n of block) expect(validateNode(n)).toEqual([]);
    expect((block[1] as TextNode).style.fontFamily).toBe("Fraunces");
  });

  test("text effects produce valid text layers and none clears them", () => {
    const base = createText({ text: "Hello" });
    for (const e of TEXT_EFFECTS) {
      const patched = { ...base, ...e.apply(base) } as TextNode;
      expect(validateNode(patched), e.id).toEqual([]);
    }
    const none = TEXT_EFFECTS.find((e) => e.id === "none")?.apply(base);
    expect(none).toMatchObject({ effects: [], strokes: [] });
  });

  test("path shapes are stored in local box coordinates", () => {
    const heart = SHAPES.find((s) => s.id === "heart")?.build()[0] as Node & {
      paths: { d: string }[];
    };
    const coords = heart.paths[0]?.d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    expect(Math.max(...coords)).toBeLessThanOrEqual(heart.width);
  });
});

describe("insertion geometry", () => {
  test("centers on the view and stays on the page when it fits", () => {
    expect(
      centeredBox({ width: 100, height: 50 }, { x: 500, y: 500 }, { width: 1080, height: 1080 }),
    ).toEqual({
      x: 450,
      y: 475,
    });
    expect(
      centeredBox({ width: 100, height: 100 }, { x: 10, y: 1075 }, { width: 1080, height: 1080 }),
    ).toEqual({
      x: 0,
      y: 980,
    });
  });

  test("fits large media to a fraction of the page without upscaling", () => {
    expect(fitToPage(4000, 2000, { width: 1000, height: 1000 }, 0.5)).toEqual({
      width: 500,
      height: 250,
    });
    expect(fitToPage(100, 80, { width: 1000, height: 1000 })).toEqual({ width: 100, height: 80 });
  });
});

function layersFixture() {
  let design = createDesign("social-post");
  const page = pageIdOf(design);
  const a = createRect({ parent: page, name: "A", x: 0, y: 0, width: 10, height: 10 });
  const b = createRect({ parent: page, name: "B", x: 20, y: 0, width: 10, height: 10 });
  const f = createFrame({ parent: page, name: "F", x: 100, y: 100, width: 200, height: 200 });
  const t = createText({ parent: f.id, name: "", text: "Big sale today", x: 10, y: 10 });
  const g = createGroup({ parent: page, name: "G", x: 400, y: 400, width: 50, height: 50 });
  const g1 = createRect({ parent: g.id, name: "G1", x: 0, y: 0, width: 50, height: 50 });
  design = withNodes(design, page, [a, b, f, g]);
  design = withNodes(design, f.id, [t]);
  design = withNodes(design, g.id, [g1]);
  return { design, page, a: a.id, b: b.id, f: f.id, t: t.id, g: g.id, g1: g1.id };
}

describe("layers model", () => {
  test("tree is front-most first, containers keep children arrays, text rows carry their text", () => {
    const x = layersFixture();
    const tree = layerTree(x.design, x.page);
    expect(tree.map((n) => n.id)).toEqual([x.g, x.f, x.b, x.a]);
    expect(tree[1]?.children?.[0]?.data?.text).toBe("Big sale today");
    expect(tree[2]?.children).toBeUndefined();
  });

  test("filters keep matching rows and the ancestors that lead to them", () => {
    const x = layersFixture();
    const { tree, expand } = filterTree(layerTree(x.design, x.page), { query: "sale", types: [] });
    expect(tree.map((n) => n.id)).toEqual([x.f]);
    expect(expand).toEqual([x.f]);
    const shapes = filterTree(layerTree(x.design, x.page), { query: "", types: ["rect"] });
    expect(shapes.tree.map((n) => n.id)).toEqual([x.g, x.b, x.a]);
  });

  test("reorders within the page (front-most-first indexes)", () => {
    const x = layersFixture();
    // Move A (back-most) to the very front.
    const tx = moveLayersTransaction(x.design, x.page, [x.a], null, 0);
    expect(tx).not.toBeNull();
    const d = applyTransaction(x.design, tx as NonNullable<typeof tx>).design;
    expect(layerTree(d, x.page).map((n) => n.id)).toEqual([x.a, x.g, x.f, x.b]);
    // Dropping where it already is changes nothing.
    expect(moveLayersTransaction(d, x.page, [x.a], null, 0)).toBeNull();
  });

  test("multi-layer moves keep the dragged order", () => {
    const x = layersFixture();
    const tx = moveLayersTransaction(x.design, x.page, [x.b, x.a], null, 1);
    const d = applyTransaction(x.design, tx as NonNullable<typeof tx>).design;
    expect(layerTree(d, x.page).map((n) => n.id)).toEqual([x.g, x.b, x.a, x.f]);
  });

  test("reparents into a frame keeping the page position, and refuses cycles", () => {
    const x = layersFixture();
    const tx = moveLayersTransaction(x.design, x.page, [x.b], x.f, 0);
    const d = applyTransaction(x.design, tx as NonNullable<typeof tx>).design;
    expectValid(d);
    expect(d.nodes[x.b]?.parent).toBe(x.f);
    // Frame at (100, 100): B at page (20, 0) is (-80, -100) inside it.
    expect(d.nodes[x.b]).toMatchObject({ x: -80, y: -100 });
    expect(moveLayersTransaction(x.design, x.page, [x.f], x.f, 0)).toBeNull();
  });

  test("moving out of a group refits the group", () => {
    const x = layersFixture();
    const tx = moveLayersTransaction(x.design, x.page, [x.g1], null, 0);
    const d = applyTransaction(x.design, tx as NonNullable<typeof tx>).design;
    expectValid(d);
    expect(d.nodes[x.g1]).toMatchObject({ parent: x.page, x: 400, y: 400 });
  });
});

describe("template import", () => {
  function template(): Design {
    let t = createDesign("social-post");
    const page = pageIdOf(t);
    const img = createImage({ parent: page, assetId: "tplasset0001", name: "Photo" });
    const title = createText({
      parent: page,
      text: "Hello",
      style: defaultTextStyle({ fills: [{ type: "solid", color: { $var: "brand.primary" } }] }),
    });
    t = withNodes(t, page, [img, title]);
    t = {
      ...t,
      assets: {
        tplasset0001: {
          id: "tplasset0001",
          kind: "image",
          mime: "image/jpeg",
          storageKey: "templates/x/a.jpg",
          url: "https://signed",
        },
      },
      styles: { ...t.styles, variables: { "brand.primary": "#ff6a1f" } },
    };
    return t;
  }

  test("replace swaps the current page in place, with assets and variables", () => {
    const design = createDesign("social-post");
    const current = pageIdOf(design);
    const t = parseTemplateDesign(JSON.stringify(template()));
    const { ops, pageIds } = templateImportOps(design, t, {
      mode: "replace",
      currentPageId: current,
    });
    const d = apply(design, ops);
    expectValid(d);
    const after = pages(d).map((p) => p.id);
    expect(after).toEqual(pageIds);
    expect(d.nodes[current]).toBeUndefined();
    expect(d.assets.tplasset0001?.storageKey).toBe("templates/x/a.jpg");
    expect(d.assets.tplasset0001?.url).toBeUndefined();
    expect(d.styles.variables["brand.primary"]).toBe("#ff6a1f");
    // Fresh ids: nothing of the template's ids besides the asset survives.
    const tIds = new Set(Object.keys(t.nodes).filter((id) => id !== "root"));
    expect(Object.keys(d.nodes).some((id) => tIds.has(id))).toBe(false);
  });

  test("add inserts after the current page and keeps existing variables", () => {
    let design = createDesign("social-post");
    design = apply(design, [
      { op: "styles", path: ["variables", "brand.primary"], value: "#000000" },
    ]);
    const current = pageIdOf(design);
    const { ops, pageIds } = templateImportOps(design, template(), {
      mode: "add",
      currentPageId: current,
    });
    const d = apply(design, ops);
    expect(pages(d).map((p) => p.id)).toEqual([current, ...pageIds]);
    expect(d.styles.variables["brand.primary"]).toBe("#000000");
  });

  test("rejects malformed template JSON", () => {
    expect(() => parseTemplateDesign(JSON.stringify({ nodes: 3 }))).toThrow();
  });
});

describe("brand apply", () => {
  function design() {
    let d = createDesign("poster");
    const page = pageIdOf(d);
    const title = createText({
      parent: page,
      text: "Title",
      role: "headline",
      style: defaultTextStyle({ fontSize: 80 }),
    });
    const big = createText({
      parent: page,
      text: "Big",
      style: defaultTextStyle({ fontSize: 64 }),
    });
    const body = createText({
      parent: page,
      text: "Body",
      style: defaultTextStyle({ fontSize: 18 }),
      runs: [{ text: "Body", style: { fontFamily: "Lora" } }],
    });
    const orange = createRect({ parent: page, fills: [{ type: "solid", color: "#ff7700" }] });
    const blue = createRect({ parent: page, fills: [{ type: "solid", color: "#2255ffcc" }] });
    const blue2 = createRect({ parent: page, fills: [{ type: "solid", color: "#2255ff" }] });
    d = withNodes(d, page, [title, big, body, orange, blue, blue2]);
    return {
      d,
      page,
      title: title.id,
      big: big.id,
      body: body.id,
      orange: orange.id,
      blue: blue.id,
    };
  }
  const spec = {
    colors: [
      { value: "#ffb02e", role: "primary" },
      { value: "#123456", role: "secondary" },
      { value: "#fafafa", role: "background" },
      { value: "#0a0a0a", role: "text" },
    ],
    fonts: {
      heading: { family: "Fraunces", weight: 600, style: "normal" as const },
      body: { family: "Inter", weight: 400, style: "normal" as const },
    },
  };

  test("maps chromatic colors by usage and neutrals by role, keeping alpha", () => {
    const x = design();
    const map = brandColorMap(x.d, Object.values(x.d.nodes), spec);
    expect(map.get("#2255ff")).toBe("#ffb02e");
    expect(map.get("#ff7700")).toBe("#123456");
    expect(map.get("#ffffff")).toBe("#fafafa");
    expect(map.get("#111111")).toBe("#0a0a0a");
    const tx = applyBrandTransaction(x.d, [x.page], spec, {
      colors: true,
      fonts: true,
      brandKitId: "kit1",
    });
    const d = applyTransaction(x.d, tx).design;
    expectValid(d);
    expect((d.nodes[x.blue] as Node & { fills: { color: string }[] }).fills[0]?.color).toBe(
      "#ffb02ecc",
    );
    expect(d.brandKitId).toBe("kit1");
  });

  test("fonts follow roles, then size; run font overrides are cleared", () => {
    const x = design();
    const tx = applyBrandTransaction(x.d, [x.page], spec, { colors: false, fonts: true });
    const d = applyTransaction(x.d, tx).design;
    expect((d.nodes[x.title] as TextNode).style.fontFamily).toBe("Fraunces");
    expect((d.nodes[x.big] as TextNode).style.fontFamily).toBe("Fraunces");
    const body = d.nodes[x.body] as TextNode;
    expect(body.style.fontFamily).toBe("Inter");
    expect(body.runs[0]?.style).toBeUndefined();
    expect(headingThreshold([body])).toBeCloseTo(25.2);
    expect(headingThreshold([])).toBe(24);
  });
});

describe("inspector geometry", () => {
  test("position and rotation keep groups fitted", () => {
    const x = layersFixture();
    const d = apply(x.design, positionOps(x.design, [x.g1], { x: 10 }));
    expect(d.nodes[x.g]).toMatchObject({ x: 410, width: 50 });
    const r = apply(d, rotationOps(d, [x.a], 90, true));
    expect(r.nodes[x.a]?.rotation).toBe(90);
    expect(apply(r, rotationOps(r, [x.a], 270, true)).nodes[x.a]?.rotation).toBe(0);
  });

  test("size keeps proportions when asked, scales group content and path data", () => {
    const x = layersFixture();
    const d = apply(x.design, sizeOps(x.design, [x.a], { width: 40 }, true));
    expect(d.nodes[x.a]).toMatchObject({ width: 40, height: 40 });
    const g = apply(x.design, sizeOps(x.design, [x.g], { width: 100 }, false));
    expect(g.nodes[x.g1]).toMatchObject({ width: 100, height: 50 });
    let p = createDesign("social-post");
    const path = createPath({ parent: pageIdOf(p), width: 100, height: 100 });
    p = withNodes(p, pageIdOf(p), [path]);
    const scaled = apply(p, sizeOps(p, [path.id], { width: 200 }, false));
    expect((scaled.nodes[path.id] as Node & { paths: { d: string }[] }).paths[0]?.d).toContain(
      "200",
    );
  });

  test("text width fixes auto-width text; height makes it fixed", () => {
    let d = createDesign("social-post");
    const t = createText({ parent: pageIdOf(d), autoResize: "width" });
    d = withNodes(d, pageIdOf(d), [t]);
    const w = apply(d, sizeOps(d, [t.id], { width: 500 }, false));
    expect(w.nodes[t.id]).toMatchObject({ width: 500, autoResize: "height" });
    const h = apply(d, sizeOps(d, [t.id], { height: 90 }, false));
    expect(h.nodes[t.id]).toMatchObject({ height: 90, autoResize: "none" });
  });

  test("updateEach skips unchanged values and unsets undefined ones; common reports mixed", () => {
    const x = layersFixture();
    expect(updateEach(x.design, [x.a], () => ({ opacity: 1 }))).toEqual([]);
    const ops = updateEach(x.design, [x.a], () => ({ opacity: 0.5, locked: undefined }));
    expect(ops).toEqual([{ op: "update", id: x.a, set: { opacity: 0.5 }, unset: ["locked"] }]);
    const nodes = [x.a, x.b].map((id) => x.design.nodes[id] as Node);
    expect(common(nodes, (n) => n.width)).toBe(10);
    expect(common(nodes, (n) => n.x)).toBeNull();
    expect(common([], (n) => n.x)).toBeUndefined();
  });
});

describe("paints and colors", () => {
  test("round-trips fills through picker paints, resolving color refs", () => {
    let d = createDesign("social-post");
    d = apply(d, [
      { op: "styles", path: ["variables", "brand.primary"], value: "#FFB02E" },
      { op: "styles", path: ["colors", "abcdefabcdef"], value: { name: "Ink", value: "#171717" } },
    ]);
    expect(resolveColor(d, { $var: "brand.primary" })).toBe("#ffb02e");
    expect(resolveColor(d, { $style: "abcdefabcdef" })).toBe("#171717");
    expect(resolveColor(d, { $var: "missing" }, "#123456")).toBe("#123456");
    const fill = {
      type: "linear" as const,
      angle: 45,
      stops: [
        { pos: 0, color: { $var: "brand.primary" } },
        { pos: 1, color: "#000000" },
      ],
      opacity: 0.5,
    };
    const paint = fillToPaint(d, fill);
    expect(paint).toEqual({
      type: "linear",
      angle: 45,
      stops: [
        { pos: 0, color: "#ffb02e" },
        { pos: 1, color: "#000000" },
      ],
    });
    expect(paintToFill(paint as NonNullable<typeof paint>, fill)).toMatchObject({
      type: "linear",
      opacity: 0.5,
    });
    expect(fillToPaint(d, { type: "image", assetId: "x", mode: "fill" })).toBeNull();
  });

  test("document colors are ordered by use", () => {
    const x = layersFixture();
    const colors = documentColors(x.design);
    expect(colors[0]).toBe("#d9d9d9");
    expect(colors).toContain("#ffffff");
  });
});

describe("chart data grid", () => {
  test("round-trips chart data and parses numbers leniently", () => {
    const chart = newChart("column");
    const grid = chartToGrid(chart.data);
    expect(grid[0]).toEqual(["", "Series 1"]);
    expect(gridToChart(grid, chart.data)).toEqual(chart.data);
    expect(parseNumber("1,234.5")).toBe(1234.5);
    expect(parseNumber("$12%")).toBe(12);
    expect(parseNumber("3,5")).toBe(3.5);
    expect(parseNumber("abc")).toBe(0);
  });

  test("pastes spreadsheet and CSV blocks, growing the grid", () => {
    expect(parseClipboard("a\tb\n1\t2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseClipboard('x,"y, z"\n1,"2"')).toEqual([
      ["x", "y, z"],
      ["1", "2"],
    ]);
    const grown = pasteInto(
      [
        ["", "S1"],
        ["Q1", "1"],
      ],
      1,
      0,
      [
        ["Q2", "5", "6"],
        ["Q3", "7", "8"],
      ],
    );
    expect(grown).toEqual([
      ["", "S1", ""],
      ["Q2", "5", "6"],
      ["Q3", "7", "8"],
    ]);
    const data = gridToChart(grown, { labels: [], series: [] });
    expect(data.series.map((s) => s.name)).toEqual(["S1", "Series 2"]);
    expect(data.labels).toEqual(["Q2", "Q3"]);
  });
});
