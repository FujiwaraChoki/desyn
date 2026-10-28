import { describe, expect, it } from "vitest";
import {
  extractDeclarations,
  getSection,
  getSubsection,
  readDocumentModel,
  splitSections,
} from "../src/lib/document-model.ts";

const model = readDocumentModel();

describe("document model includes", () => {
  it("splits the contract into its numbered sections", () => {
    const keys = splitSections(model).map((s) => s.key);
    for (const n of ["1", "2", "3", "4", "5", "6", "7", "8"]) expect(keys).toContain(n);
    expect(getSection(model, "5").title).toMatch(/Operations/);
  });

  it("ignores ## lines inside code fences", () => {
    const md = "## 1. A\n```ts\n## not a heading\n```\n## 2. B\ntext";
    expect(splitSections(md).map((s) => s.key)).toEqual(["1", "2"]);
    expect(getSection(md, "1").body).toContain("## not a heading");
  });

  it("extracts whole declarations, including multi-line unions and interfaces", () => {
    const op = extractDeclarations(model, ["Op"]);
    expect(op.startsWith("type Op =")).toBe(true);
    expect(op).toContain('op: "create"');
    expect(op).toContain('op: "doc"');
    const design = extractDeclarations(model, ["Design"]);
    expect(design.startsWith("interface Design {")).toBe(true);
    expect(design.trimEnd().endsWith("}")).toBe(true);
    expect(design).not.toContain("DesignKind =");
  });

  it("stops a one-line declaration at the next declaration", () => {
    const md = "```ts\ninterface A { a: string; }\ninterface B { b: number; }\n```";
    expect(extractDeclarations(md, ["A"])).toBe("interface A { a: string; }");
    expect(extractDeclarations(md, ["B"])).toBe("interface B { b: number; }");
  });

  it("finds every type the docs pages reference", () => {
    const names = [
      "Design",
      "DesignKind",
      "AssetRef",
      "DesignStyles",
      "BaseNode",
      "ContainerProps",
      "RootNode",
      "PageNode",
      "FrameNode",
      "GroupNode",
      "BooleanNode",
      "AutoLayout",
      "Shaped",
      "RectNode",
      "EllipseNode",
      "PolygonNode",
      "StarNode",
      "LineNode",
      "Cap",
      "PathNode",
      "TextNode",
      "TextRun",
      "TextStyle",
      "ParagraphStyle",
      "ImageNode",
      "SvgNode",
      "VideoNode",
      "AudioNode",
      "ChartNode",
      "TableNode",
      "QrNode",
      "Fill",
      "Stop",
      "ColorRef",
      "Stroke",
      "Effect",
      "ImageAdjust",
      "BlendMode",
      "Animation",
      "Op",
      "Transaction",
      "Description",
      "DNode",
      "Issue",
      "IssueCode",
    ];
    expect(() => extractDeclarations(model, names)).not.toThrow();
  });

  it("extracts the Role subsection without its heading", () => {
    const role = getSubsection(getSection(model, "3").body, "Role");
    expect(role).toContain("`headline`");
    expect(role).not.toMatch(/^### /m);
  });

  it("throws on unknown names so contract renames fail the build", () => {
    expect(() => extractDeclarations(model, ["DoesNotExist"])).toThrow(/DoesNotExist/);
    expect(() => getSection(model, "42")).toThrow();
  });
});
