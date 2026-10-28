import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { VFile } from "vfile";
import { describe, expect, it } from "vitest";
import { resolveBasePath } from "../src/lib/base-path.ts";
import { escapeMdx, inlineCode, jsxAttr, table } from "../src/lib/markdown.ts";
import { remarkDesyn } from "../src/lib/remark-desyn.ts";
import { plainTitle } from "../src/lib/title.ts";

async function run(source: string) {
  const file = new VFile({ path: "test.mdx", value: source });
  const processor = unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkDesyn);
  const tree = (await processor.run(processor.parse(file), file)) as Root;
  const data = file.data.desyn;
  if (!data) throw new Error("no data");
  return { tree, data };
}

const FM = "---\ntitle: T\ndescription: D\n---\n\n";

describe("remark-desyn", () => {
  it("reads frontmatter and builds a TOC with GitHub-style unique slugs", async () => {
    const { data } = await run(
      `${FM}## Getting started\n\n### Getting started\n\n#### Deep\n\n## \`code\` & more`,
    );
    expect(data.frontmatter).toMatchObject({ title: "T", description: "D" });
    expect(data.toc).toEqual([
      { depth: 2, id: "getting-started", text: "Getting started" },
      { depth: 3, id: "getting-started-1", text: "Getting started" },
      { depth: 2, id: "code--more", text: "code & more" },
    ]);
    expect(data.anchors).toContain("deep");
  });

  it("requires frontmatter", async () => {
    await expect(run("# no frontmatter")).rejects.toThrow(/frontmatter/);
    await expect(run("---\ntitle: T\n---\n")).rejects.toThrow(/description/);
  });

  it("turns GitHub alerts into callouts", async () => {
    const { tree } = await run(`${FM}> [!WARNING]\n> Careful **now**.`);
    const node = tree.children[0] as {
      type: string;
      name?: string;
      attributes?: { value: string }[];
    };
    expect(node.type).toBe("mdxJsxFlowElement");
    expect(node.name).toBe("Callout");
    expect(node.attributes?.[0]?.value).toBe("warning");
  });

  it("expands generated blocks into real headings and anchors", async () => {
    const { data } = await run(`${FM}<Generated name="env-vars" />`);
    expect(data.toc.map((t) => t.text)).toContain("Object storage");
    expect(data.anchors).toContain("env-s3-endpoint");
  });

  it("collects links from markdown and component hrefs", async () => {
    const { data } = await run(`${FM}[a](/quickstart) <Card title="x" href="/editor" />`);
    expect(data.links.map((l) => l.url)).toEqual(["/quickstart", "/editor"]);
  });
});

describe("markdown helpers", () => {
  it("escapes JSX-significant characters outside code only", () => {
    expect(escapeMdx("a <b> {c} `<d>`")).toBe("a &#60;b&#62; &#123;c&#125; `<d>`");
  });

  it("wraps inline code containing backticks", () => {
    expect(inlineCode("a`b")).toBe("``a`b``");
    expect(inlineCode("x")).toBe("`x`");
  });

  it("encodes JSX attributes without relying on escapes", () => {
    expect(jsxAttr("mod+\\")).toBe('"mod+\\"');
    expect(jsxAttr('say "hi"')).toBe(`'say "hi"'`);
    expect(jsxAttr(`it's "x"`)).toBe('{"it\'s \\"x\\""}');
  });

  it("builds GFM tables", () => {
    expect(table(["A", "B"], [["1", "2"]])).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });
});

describe("site helpers", () => {
  it("normalizes the base path", () => {
    expect(resolveBasePath(undefined)).toBe("");
    expect(resolveBasePath("/")).toBe("");
    expect(resolveBasePath("/docs/")).toBe("/docs");
    expect(() => resolveBasePath("docs")).toThrow();
    expect(() => resolveBasePath("/a b")).toThrow();
  });

  it("strips accent markup from titles", () => {
    expect(plainTitle("design at the speed of *light*.")).toBe("design at the speed of light.");
  });
});
