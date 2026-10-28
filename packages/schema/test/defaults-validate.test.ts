import { describe, expect, test } from "vitest";
import type { Design, Node } from "../src";
import * as S from "../src";

const factories: [string, () => Node][] = [
  ["page", () => S.createPage()],
  ["frame", () => S.createFrame()],
  ["group", () => S.createGroup()],
  ["boolean", () => S.createBoolean()],
  ["rect", () => S.createRect()],
  ["ellipse", () => S.createEllipse()],
  ["polygon", () => S.createPolygon()],
  ["star", () => S.createStar()],
  ["line", () => S.createLine()],
  ["path", () => S.createPath()],
  ["text", () => S.createText({ text: "Hi" })],
  ["image", () => S.createImage({ assetId: "asset0000001" })],
  ["svg", () => S.createSvg({ markup: "<svg/>" })],
  ["video", () => S.createVideo({ assetId: "asset0000001" })],
  ["audio", () => S.createAudio({ assetId: "asset0000001" })],
  ["chart", () => S.createChart()],
  ["table", () => S.createTable({ rows: 2, cols: 4 })],
  ["qr", () => S.createQr()],
];

describe("factories", () => {
  test.each(factories)("create %s produces a valid node", (type, make) => {
    const node = make();
    expect(node.type).toBe(type);
    expect(S.isId(node.id)).toBe(true);
    expect(S.validateNode(node)).toEqual([]);
  });

  test("root", () => {
    const root = S.createRoot();
    expect(root.id).toBe("root");
    expect(root.parent).toBeNull();
    expect(S.validateNode(root)).toEqual([]);
  });

  test("overrides win but type is fixed", () => {
    const r = S.createRect({ id: "abcabcabcabc", width: 5, type: "ellipse" } as never);
    expect(r.type).toBe("rect");
    expect(r.width).toBe(5);
    expect(r.id).toBe("abcabcabcabc");
  });

  test("table cells match rows x cols", () => {
    const t = S.createTable({ rows: 3, cols: 2 });
    expect(t.cells).toHaveLength(6);
    expect(t.colWidths).toHaveLength(2);
    expect(t.rowHeights).toHaveLength(3);
  });

  test("defaultTextStyle / defaultParagraph", () => {
    expect(S.TextStyleSchema.safeParse(S.defaultTextStyle()).success).toBe(true);
    expect(S.defaultTextStyle({ fontSize: 10 }).fontSize).toBe(10);
    expect(S.ParagraphStyleSchema.safeParse(S.defaultParagraph()).success).toBe(true);
  });
});

describe("createDesign", () => {
  test.each(S.DESIGN_KINDS.map((k) => [k]))("kind %s", (kind) => {
    const d = S.createDesign(kind, undefined, { now: 1 });
    const r = S.validateDesign(d);
    expect(r.errors).toEqual([]);
    expect(d.kind).toBe(kind);
    expect(d.nodes.root?.type).toBe("root");
    const pageId = (d.nodes.root as S.RootNode).children[0] as string;
    const preset = S.getPreset(S.DESIGN_KIND_INFO[kind].defaultPreset);
    expect(d.nodes[pageId]?.width).toBe(preset?.width);
    expect(d.meta.createdAt).toBe(1);
  });

  test("preset by id or object; unknown throws", () => {
    const d = S.createDesign("poster", "poster-a4", {
      id: "dsndsndsndsn",
      name: "P",
      pageId: "pagepagepage",
    });
    expect(d.id).toBe("dsndsndsndsn");
    expect(d.nodes.pagepagepage?.width).toBeCloseTo(793.7, 1);
    expect((d.nodes.pagepagepage as S.PageNode).unit).toBe("mm");
    expect((d.nodes.pagepagepage as S.PageNode).bleed).toBeCloseTo(11.34, 2);
    const preset = S.getPreset("x-header") as S.PagePreset;
    expect(S.createDesign("banner", preset).nodes.root).toBeDefined();
    expect(() => S.createDesign("poster", "nope")).toThrow(/unknown page preset/);
  });
});

function sample(): Design {
  return S.createDesign("social-post", "instagram-post", {
    id: "dsndsndsndsn",
    pageId: "pagepagepage",
    now: 0,
  });
}

function codes(d: unknown) {
  return S.validateDesign(d).errors.map((e) => e.code);
}

describe("validateDesign", () => {
  test("a fresh design is valid", () => {
    expect(S.validateDesign(sample())).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test("shape errors", () => {
    const d = sample() as unknown as Record<string, unknown>;
    d.schema = 2;
    expect(codes(d)).toContain("shape");
    expect(S.validateDesign(null).ok).toBe(false);
    expect(S.validateDesign({ nodes: 5 }).ok).toBe(false);
  });

  test("missing root", () => {
    const d = sample();
    delete d.nodes.root;
    expect(codes(d)).toContain("missing-root");
  });

  test("key mismatch", () => {
    const d = sample();
    const rect = S.createRect({ id: "rectrectrect", parent: "pagepagepage" });
    d.nodes.otherotherxx = rect;
    expect(codes(d)).toContain("key-mismatch");
  });

  test("child not listed by parent", () => {
    const d = sample();
    d.nodes.rectrectrect = S.createRect({ id: "rectrectrect", parent: "pagepagepage" });
    expect(codes(d)).toEqual(["not-in-parent-children", "unreachable"]);
  });

  test("listed child with wrong parent / missing child / duplicate", () => {
    const d = sample();
    const page = d.nodes.pagepagepage as S.PageNode;
    d.nodes.rectrectrect = S.createRect({ id: "rectrectrect", parent: "root" });
    page.children.push("rectrectrect", "rectrectrect", "missingmissi");
    const c = codes(d);
    expect(c).toContain("child-parent-mismatch");
    expect(c).toContain("duplicate-child");
    expect(c).toContain("missing-child");
  });

  test("page nesting both ways", () => {
    const d = sample();
    const page = d.nodes.pagepagepage as S.PageNode;
    d.nodes.rectrectrect = S.createRect({ id: "rectrectrect", parent: "root" });
    (d.nodes.root as S.RootNode).children.push("rectrectrect");
    d.nodes.page2page2pa = S.createPage({ id: "page2page2pa", parent: "pagepagepage" as "root" });
    page.children.push("page2page2pa");
    expect(codes(d).filter((c) => c === "page-nesting").length).toBeGreaterThanOrEqual(2);
  });

  test("parent not container / missing parent", () => {
    const d = sample();
    const page = d.nodes.pagepagepage as S.PageNode;
    d.nodes.rectrectrect = S.createRect({ id: "rectrectrect", parent: "pagepagepage" });
    page.children.push("rectrectrect");
    d.nodes.innerinnerin = S.createRect({ id: "innerinnerin", parent: "rectrectrect" });
    d.nodes.orphanorphan = S.createRect({ id: "orphanorphan", parent: "nonexistent1" });
    const c = codes(d);
    expect(c).toContain("parent-not-container");
    expect(c).toContain("missing-parent");
  });

  test("detached cycle is unreachable", () => {
    const d = sample();
    d.nodes.aaaaaaaaaaaa = S.createFrame({
      id: "aaaaaaaaaaaa",
      parent: "bbbbbbbbbbbb",
      children: ["bbbbbbbbbbbb"],
    });
    d.nodes.bbbbbbbbbbbb = S.createFrame({
      id: "bbbbbbbbbbbb",
      parent: "aaaaaaaaaaaa",
      children: ["aaaaaaaaaaaa"],
    });
    expect(codes(d)).toContain("unreachable");
  });

  test("assets are validated; dangling references are warnings", () => {
    const d = sample();
    const page = d.nodes.pagepagepage as S.PageNode;
    d.nodes.imgimgimgimg = S.createImage({
      id: "imgimgimgimg",
      parent: "pagepagepage",
      assetId: "assetmissing",
    });
    d.nodes.texttexttext = S.createText({
      id: "texttexttext",
      parent: "pagepagepage",
      styleRef: "stylemissing",
      style: S.defaultTextStyle({ fills: [{ type: "solid", color: { $var: "nope" } }] }),
    });
    d.nodes.rectrectrect = S.createRect({
      id: "rectrectrect",
      parent: "pagepagepage",
      fills: [{ type: "solid", color: { $style: "colormissing" } }],
    });
    page.children.push("imgimgimgimg", "texttexttext", "rectrectrect");
    const r = S.validateDesign(d);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code).sort()).toEqual([
      "dangling-asset",
      "dangling-style",
      "dangling-style",
      "dangling-variable",
    ]);
    d.assets.assetassetaa = { id: "assetassetab", kind: "image", mime: "image/png" };
    expect(codes(d)).toContain("key-mismatch");
    d.assets.assetassetaa = { id: "assetassetaa", kind: "image" } as never;
    expect(codes(d)).toContain("shape");
  });

  test("assertValidDesign throws with a summary", () => {
    const d = sample();
    delete d.nodes.root;
    expect(() => S.assertValidDesign(d)).toThrow(/invalid design/);
    expect(() => S.assertValidDesign(sample())).not.toThrow();
  });
});
