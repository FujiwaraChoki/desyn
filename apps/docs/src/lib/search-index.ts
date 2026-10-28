import type { Heading, Root, RootContent } from "mdast";
import type { MdxJsxFlowElement, MdxJsxTextElement } from "mdast-util-mdx";
import { analyzePage } from "./content.ts";
import { FLAT_NAV, hrefForSlug } from "./nav.ts";
import { jsxProps } from "./remark-desyn.ts";
import type { SearchIndexFile, SearchRecord } from "./search-engine.ts";
import { plainTitle } from "./title.ts";

const MAX_TEXT = 6000;
/** Long code samples are noise in results; short ones (commands, names) are worth indexing. */
const MAX_INDEXED_CODE = 280;

type AnyNode = Root | RootContent;

/** Plain text of a node, including the meaningful attributes of our components. */
export function nodeText(node: AnyNode): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "code":
      return node.value.length <= MAX_INDEXED_CODE ? node.value : "";
    case "yaml":
      return "";
    case "mdxJsxFlowElement":
    case "mdxJsxTextElement":
      return jsxText(node);
    case "mdxFlowExpression":
    case "mdxTextExpression":
    case "mdxjsEsm":
      return "";
    default:
      if ("children" in node)
        return (node.children as AnyNode[]).map(nodeText).join(isBlock(node) ? " " : "");
      return "";
  }
}

function isBlock(node: AnyNode): boolean {
  return ["root", "list", "listItem", "table", "tableRow", "blockquote"].includes(node.type);
}

function jsxText(node: MdxJsxFlowElement | MdxJsxTextElement): string {
  const props = jsxProps(node);
  const inner = (node.children as AnyNode[]).map(nodeText).join(" ");
  switch (node.name) {
    case "EnvVar":
      return `${props.name ?? ""} ${props.required ?? ""} ${inner}`;
    case "Param":
      return `${props.name ?? ""} ${props.type ?? ""} ${inner}`;
    case "Keys":
      return props.combo ?? "";
    case "Method":
      return props.method ?? "";
    case "Endpoint":
      return `${props.method ?? ""} ${props.path ?? ""} ${props.fn ?? ""} ${props.scope ?? ""}`;
    case "Card":
    case "Callout":
      return `${props.title ?? ""} ${inner}`;
    case "Tab":
      return `${props.label ?? ""} ${inner}`;
    default:
      return inner;
  }
}

function clean(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_TEXT ? `${collapsed.slice(0, MAX_TEXT)}…` : collapsed;
}

interface Section {
  heading: string;
  id: string | undefined;
  parts: string[];
  keys: string[];
}

/** Identifiers a node defines: env var rows and endpoint signatures. */
function collectKeys(node: AnyNode, out: string[]): void {
  if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
    const props = jsxProps(node);
    if (node.name === "EnvVar" && props.name) out.push(props.name);
    if (node.name === "Endpoint") {
      if (props.path) out.push(props.path);
      if (props.fn) out.push(...props.fn.split(/\s*·\s*/));
    }
  }
  if ("children" in node) for (const child of node.children as AnyNode[]) collectKeys(child, out);
}

/** Split a page into its intro and h2/h3 sections. */
export function pageSections(tree: Root, title: string, description: string): Section[] {
  const sections: Section[] = [{ heading: title, id: undefined, parts: [description], keys: [] }];
  const visitBlock = (node: RootContent) => {
    if (node.type === "heading" && (node.depth === 2 || node.depth === 3)) {
      const h = node as Heading;
      const id = (h.data?.hProperties as { id?: string } | undefined)?.id;
      sections.push({ heading: nodeText(h).trim(), id, parts: [], keys: [] });
      return;
    }
    // Headings inside components (e.g. steps or tabs) still start sections.
    if (node.type === "mdxJsxFlowElement" && node.children.some((c) => c.type === "heading")) {
      for (const child of node.children as RootContent[]) visitBlock(child);
      return;
    }
    const current = sections[sections.length - 1];
    current?.parts.push(nodeText(node));
    if (current) collectKeys(node, current.keys);
  };
  for (const node of tree.children) visitBlock(node);
  return sections;
}

export async function buildSearchIndex(): Promise<SearchIndexFile> {
  const records: SearchRecord[] = [];
  for (const item of FLAT_NAV) {
    const { tree, data } = await analyzePage(item.slug);
    const href = hrefForSlug(item.slug);
    const title = plainTitle(data.frontmatter.title);
    for (const section of pageSections(tree, title, data.frontmatter.description)) {
      records.push({
        id: records.length,
        href: section.id ? `${href}#${section.id}` : href,
        page: title,
        section: item.sectionTitle,
        heading: section.heading,
        keys: [...new Set(section.keys)],
        text: clean(section.parts.join(" ")),
      });
    }
  }
  return { version: 1, records };
}
